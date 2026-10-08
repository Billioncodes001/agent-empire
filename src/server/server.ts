import { Consultancy, ConsultancyError } from './consultancy.js';
import { ApprovalError, ApprovalInbox } from './approvals.js';
import { EmailNotifier, NOT_CONFIGURED, emailConfig, smtpTransport, type MailTransport } from './email.js';
import { TelegramBridge, telegramConfig, type TelegramConfig, type TelegramTransport } from './telegram.js';
import { chiefCommands } from './chief-commands.js';
import { Outreach, OutreachError, outreachConfig, type OutreachConfig } from './outreach.js';
import { Empire } from './empire.js';
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { Config } from './config.js';
import { Auth } from './auth.js';
import { DeviceStore, type DeviceInfo } from './devices.js';
import { WorkerManager, type WorkerRuntime } from './workers.js';
import { GitHub } from './github.js';
import { Team } from './team.js';
import { Upgrader } from './upgrade.js';
import { Services } from './services.js';
import { Decor, ImageProxy } from './decor.js';
import { Ledger, taskCostObservations } from './usage.js';
import { estimateJob, historyFromTaskCosts } from './estimate.js';
import { orgSignature, projectOrg } from './org.js';
import { TaskQueue } from './queue.js';
import { projectWaitingOn, withWaitingOn } from './waiting.js';
import { Changes } from './changes.js';
import { RELAY_LOGIN, relayRequest, relayUpgrade, signInPage, stoppedPage, tunneledPort } from './relay.js';
import type { ChatLine, ClientMsg, PeerInfo, ProjectInfo, ServerMsg, ServicesState } from '../shared/protocol.js';
import { SPAWN } from '../shared/layout.js';
import { lookFromSeed, sanitizeLook } from '../shared/avatar.js';
import { sanitizeOutfit } from '../shared/outfit.js';
import { Continuity } from './continuity.js';
import { SyncArtifacts } from './sync-artifacts.js';
import { acquireHostLock } from './host-lock.js';
import { ExecutionManager, ExecutionError, type ExecutionOptions } from './execution.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

const CLEANUPS = new Set(['keep', 'worktree', 'all']);

interface Client {
  id: string;
  ws: WebSocket;
  /** Set when the connection signed in with a device token, so revoking the device closes it. */
  deviceId?: string;
  peer: PeerInfo;
  attached: Set<string>;
  /** Terminals whose output was skipped because this client fell behind; re-snapshotted later. */
  stale: Set<string>;
  lastMoveAt: number;
  lastActAt: number;
}

const SLOW_CLIENT_BYTES = 8 * 1024 * 1024;

function findPublicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../../public'), path.resolve(here, '../../dist/public')];
  for (const c of candidates) if (existsSync(path.join(c, 'index.html'))) return c;
  throw new Error(`Client bundle not found (looked in ${candidates.join(', ')}). Run \`npm run build\`.`);
}

function projectInfo(cfg: Config): ProjectInfo {
  const git = (args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: cfg.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return undefined;
    }
  };
  return {
    name: path.basename(cfg.dir),
    dir: cfg.dir,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    remote: git(['remote', 'get-url', 'origin']),
    agentCmd: [cfg.agentCmd, ...cfg.agentArgs].join(' '),
  };
}

function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    // The rightmost hop is the one our proxy appended; anything left of it is client-controlled.
    if (typeof fwd === 'string' && fwd) return fwd.split(',').pop()!.trim();
  }
  return req.socket.remoteAddress ?? '?';
}

function isSecure(req: http.IncomingMessage, cfg: Config): boolean {
  if (cfg.tls) return true;
  return cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https';
}

function readBody(req: http.IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sameOrigin(req: http.IncomingMessage, cfg: Config): boolean {
  const host = (cfg.trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
  try {
    return !!req.headers.origin && new URL(req.headers.origin).origin === `${isSecure(req, cfg) ? 'https' : 'http'}://${host}`;
  } catch { return false; }
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(json);
}

/** The bundled game apps' page origins (iOS WKURLSchemeHandler, Android WebViewAssetLoader). They get CORS, never cookies. */
export const APP_ORIGINS: ReadonlySet<string> = new Set(['empire-app://game', 'https://appassets.androidplatform.net']);
/** The one WebSocket subprotocol the server speaks; the bearer token rides alongside as `bearer.<token>`. */
export const WS_PROTOCOL = 'empire.v1';
const WS_BEARER_PREFIX = 'bearer.';

const hasBearer = (req: http.IncomingMessage) => /^Bearer(\s|$)/i.test(req.headers.authorization ?? '');

/** A device token from `Authorization: Bearer …` (never from the query string or a cookie). */
function bearerFrom(req: http.IncomingMessage): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  return m?.[1];
}

/** Offered WebSocket subprotocols; the bearer token (if any) is taken from a `bearer.<token>` entry. */
function wsProtocols(req: http.IncomingMessage): { offered: string[]; token?: string } {
  const header = req.headers['sec-websocket-protocol'];
  const offered = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  const bearer = offered.filter((v) => v.startsWith(WS_BEARER_PREFIX));
  // Exactly one token, or none; several is ambiguous and refused by the caller.
  return { offered, token: bearer.length === 1 ? bearer[0].slice(WS_BEARER_PREFIX.length) : bearer.length ? '' : undefined };
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Internal injection points let integration tests use fake processes and no external polling. */
export interface ServerRuntime {
  workers?: WorkerRuntime;
  publicDir?: string;
  backgroundServices?: boolean;
  execution?: ExecutionOptions;
  /** Explicit test injection; false prevents use of host Telegram environment. */
  telegram?: { config: TelegramConfig; transport?: TelegramTransport } | false;
  /** Explicit test injection (a fake transport); false prevents use of the host email environment. */
  email?: { transport: MailTransport; to: string; from: string } | false;
  /** ORG-04a outreach: explicit config and (fake) transport for tests and previews; false disables host settings. */
  outreach?: { config: OutreachConfig; transport?: MailTransport; now?: () => number; schedule?: (fn: () => void, ms: number) => () => void } | false;
  /** Packaged first-run desktops require an explicit execution choice before any local process. */
  requireExecutionSetup?: boolean;
}
export async function startServer(cfg: Config, runtime: ServerRuntime = {}) {
  const releaseHost = acquireHostLock(cfg.dataDir);
  const startupCleanup: (() => void)[] = [releaseHost];
  try {
    return await startOwnedServer(cfg, runtime, releaseHost, startupCleanup);
  } catch (error) {
    for (const cleanup of startupCleanup.reverse()) { try { cleanup(); } catch { /* preserve the original startup error */ } }
    throw error;
  }
}

async function startOwnedServer(cfg: Config, runtime: ServerRuntime, releaseHost: () => void, startupCleanup: (() => void)[]) {
  const publicDir = runtime.publicDir ?? findPublicDir();
  const auth = new Auth(cfg.verifier, cfg.salt, cfg.secret);
  const devices = new DeviceStore(cfg.dataDir, cfg.secret, cfg.verifier);
  startupCleanup.push(() => devices.flush());
  const clients = new Map<string, Client>();
  const chat: ChatLine[] = [];
  const project = projectInfo(cfg);
  const continuity = new Continuity(cfg.dataDir);
  const artifacts = new SyncArtifacts(cfg.dir, cfg.dataDir, continuity.serverId);
  const execution = new ExecutionManager(cfg.dataDir, runtime.execution);
  startupCleanup.push(() => execution.stop());
  let localQueueApproved = !runtime.requireExecutionSetup;
  const localExecutionBlocker = () => {
    const setup = execution.setup();
    if (setup.storageError) return setup.storageError;
    if (setup.config.mode === 'anthropic_cloud') return 'Provider cloud is selected. Use Cloud tasks in Execution settings; local queue work stays paused.';
    if (runtime.requireExecutionSetup && !setup.config.completed) return 'Choose where workers run in Execution setup before starting local work.';
    return undefined;
  };

  const sendTo = (c: Client, msg: ServerMsg) => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMsg, except?: string, droppable = false) => {
    const json = JSON.stringify(msg);
    for (const c of clients.values()) {
      if (c.id === except || c.ws.readyState !== WebSocket.OPEN) continue;
      if (droppable && c.ws.bufferedAmount > 4 * 1024 * 1024) continue;
      c.ws.send(json);
    }
  };

  let workers!: WorkerManager;
  let queue!: TaskQueue;
  // LIFE-04: waitingOn is projected from the queue, never stored on the worker. Remember what each client last got so a
  // queue change re-sends exactly the workers whose waitingOn appeared, changed or cleared.
  const waitingSent = new Map<string, string>();
  const currentWaits = () => (queue ? projectWaitingOn(queue.state().tasks, workers.list()) : new Map());
  const workersForClients = () => { const waits = currentWaits(); return workers.list().map((w) => withWaitingOn(w, waits)); };
  const syncWaiting = (skip?: string) => {
    const waits = currentWaits();
    for (const w of workers.list()) {
      const key = JSON.stringify(waits.get(w.id) ?? null);
      if ((waitingSent.get(w.id) ?? 'null') === key) continue;
      waitingSent.set(w.id, key);
      if (w.id !== skip) broadcast({ t: 'worker.update', worker: withWaitingOn(w, waits) });
    }
  };
  let changes!: Changes;
  let consultancy: Consultancy | undefined;
  let inbox: ApprovalInbox | undefined;
  let outreach: Outreach | undefined;
  let observing = false;
  const storageError = () => [workers?.recoveryError, queue?.recoveryError, consultancy?.recoveryError].filter(Boolean).join(' ') || undefined;
  const observeContinuity = () => {
    if (!workers || !queue || observing) return;
    observing = true;
    try { continuity.observe({ empire: empire.state, queue: queue.state(), workers: workers.list() }); }
    finally { observing = false; }
    broadcast({ t: 'continuity.status', status: continuity.status(storageError()) });
  };
  let publishOrg = () => {};
  const empire = new Empire(cfg.dataDir, state => { broadcast({ t: 'empire', state }); observeContinuity(); publishOrg(); });

  // --- Loopback-only endpoint that Claude Code hooks POST to --------------------------------
  const hookServer = http.createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return send(res, 400, {});
    }
    if (req.method !== 'POST' || url.pathname !== '/hooks/claude') return send(res, 404, { ok: false });
    let payload: unknown = {};
    try {
      const body = await readBody(req);
      payload = body ? JSON.parse(body) : {};
    } catch {
      // permissive: a bad payload still counts as the event
    }
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const ok = workers.handleHook(url.searchParams.get('worker') ?? '', token, url.searchParams.get('event') ?? '', payload);
    send(res, ok ? 200 : 401, {});
  });
  await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
  startupCleanup.push(() => hookServer.close());
  const hookPort = (hookServer.address() as { port: number }).port;

  // What the workers spend, all time and today, with the optional daily budget.
  const ledger = new Ledger(
    cfg.dataDir,
    { budget: cfg.budget, pauseHiring: cfg.budgetPause },
    (state) => { broadcast({ t: 'usage', state }); publishOrg(); },
    (text, level) => broadcast({ t: 'toast', text, level }),
  );

  workers = new WorkerManager(
    cfg.dir,
    cfg.dataDir,
    cfg.agentCmd,
    cfg.agentArgs,
    { url: `http://127.0.0.1:${hookPort}`, token: '' },
    {
      update: (worker) => {
        const waits = currentWaits();
        waitingSent.set(worker.id, JSON.stringify(waits.get(worker.id) ?? null));
        broadcast({ t: 'worker.update', worker: withWaitingOn(worker, waits) });
        queue?.onWorker(worker);
        syncWaiting();
        if (queue) empire.tick(workers.list(), queue.state(), 0);
      },
      remove: (workerId) => {
        changes?.forget(workerId);
        waitingSent.delete(workerId);
        broadcast({ t: 'worker.remove', workerId });
        queue?.onWorkerGone(workerId);
        if (queue) empire.tick(workers.list(), queue.state(), 0);
      },
      data: (workerId, data, viewers) => {
        const json = JSON.stringify({ t: 'term.data', workerId, data } satisfies ServerMsg);
        for (const id of viewers) {
          const c = clients.get(id);
          if (!c || c.ws.readyState !== WebSocket.OPEN) continue;
          // A viewer on a slow link skips output and gets a fresh snapshot once it catches up,
          // instead of queueing unbounded data in server memory.
          if (c.stale.has(workerId) || c.ws.bufferedAmount > SLOW_CLIENT_BYTES) c.stale.add(workerId);
          else c.ws.send(json);
        }
      },
      screen: (workerId, frame) => broadcast({ t: 'screen', workerId, ...frame }, undefined, true),
      toast: (text, level) => broadcast({ t: 'toast', text, level }),
    },
    ledger,
    () => empire.state.office.workstations,
    runtime.workers,
    localExecutionBlocker,
  );

  startupCleanup.push(() => workers.shutdown());
  const github = new GitHub(
    cfg.dir,
    (state) => broadcast({ t: 'gh.issues', state }),
    (state) => {
      broadcast({ t: 'gh.pulls', state });
      queue?.onPulls(state.items);
    },
  );
  // The 📋 task queue seats workers by itself: it watches the workers and links PRs from GitHub.
  queue = new TaskQueue(cfg.dataDir, workers, !!project.branch, {
    update: (state) => { broadcast({ t: 'queue', state }); syncWaiting(); empire.tick(workers.list(), state, 0); },
    toast: (text, level) => broadcast({ t: 'toast', text, level }),
    claimIssue: (issue) => github.claim(issue),
    refreshGitHub: () => void github.refresh(),
    hiringPaused: () => localExecutionBlocker() || (!localQueueApproved ? 'Choose queue concurrency explicitly to start pending local tasks.' : undefined) || ledger.hiringPaused,
    retryAllowed: task => empire.managerTaskRetryBlocker(task),
    // ORG-02: a client job that reached its approved budget keeps its unstarted items queued.
    // Record the latest worker spend once per seating pass, so a task that just finished over budget holds the next item.
    beforeSeat: () => { if (queue) ledger.recordTaskCosts(taskCostObservations(queue.state().tasks, workers.list())); },
    // Side-effect free, and free for non-client tasks.
    taskHold: task => (task.jobKey?.startsWith('consultancy:') ? consultancy?.holdReason(task) : undefined),
  }, runtime.requireExecutionSetup);
  // Saved appointment flags are historical until worker/queue evidence has been reconciled.
  startupCleanup.push(() => queue.shutdown());
  empire.tick(workers.list(), queue.state(), 0);
  if (runtime.backgroundServices !== false) github.start();

  // ORG-02: estimates come from finished tasks with recorded provider spend; nothing is called to make them.
  const phaseOfJobKey = (jobKey?: string) => {
    const [, jobId] = jobKey?.match(/^consultancy:([^:]+):/) ?? [];
    return jobId ? consultancy?.snapshot().jobs.find((j) => j.id === jobId)?.items.find((i) => i.jobKey === jobKey)?.phase : undefined;
  };
  consultancy = new Consultancy(cfg.dataDir, {
    state: () => ({ ...queue.state(), storageError: queue.recoveryError }),
    // dependsOn carries LIFE-04's item order into the queue.
    add: (prompt, by, title, issue, jobKey, dependsOn) => queue.add(prompt, by, title, issue, jobKey, dependsOn),
  }, () => { inbox?.reconcile(); outreach?.reconcile(); publishOrg(); }, {
    estimate: (items) => estimateJob(items, historyFromTaskCosts(ledger.taskCosts(), phaseOfJobKey), { maxWorkers: queue.limit }),
    taskCost: (taskId) => ledger.taskCost(taskId),
    // Round 2: a finished internal job whose artifact is missing or invalid needs attention, with the reason.
    itemAttention: (jobId) => outreach?.itemAttention(jobId),
  });
  const office = consultancy;
  // ORG-03: the CEO approval inbox, reconciled from consultancy state and re-sent only when an item changes.
  let approvalsSent = '';
  const publishApprovals = () => {
    if (!inbox) return;
    const state = inbox.state();
    const sig = JSON.stringify([state.items, state.storageError]);
    if (sig === approvalsSent) return;
    approvalsSent = sig;
    broadcast({ t: 'approvals', state });
    email?.observe(state.items);
    publishOrg();
  };
  // ORG-03: optional email, one per new pending approval. Never blocks; the URL and password are never logged.
  let email: EmailNotifier | undefined;
  let emailError: string | undefined;
  try {
    const setup = runtime.email === false || runtime.backgroundServices === false && !runtime.email ? undefined
      : runtime.email ? runtime.email : (() => { const c = emailConfig(process.env); return c && { transport: smtpTransport(c.smtp), to: c.to, from: c.from }; })();
    if (setup) email = new EmailNotifier(cfg.dataDir, setup.transport, { to: setup.to, from: setup.from });
  } catch (error) { emailError = (error as Error).message; }
  startupCleanup.push(() => email?.stop());
  inbox = new ApprovalInbox(cfg.dataDir, office, publishApprovals);
  approvalsSent = JSON.stringify([inbox.state().items, inbox.state().storageError]);
  email?.observe(inbox.state().items);
  // ORG-04a: email outreach. Off (and saying why) unless the owner set the outreach and SMTP variables on this host.
  {
    const hostOff = runtime.outreach === false || (runtime.backgroundServices === false && !runtime.outreach);
    const config = runtime.outreach ? runtime.outreach.config : outreachConfig(hostOff ? {} : process.env);
    const transport = runtime.outreach ? runtime.outreach.transport : config.smtp && !config.problems.length ? smtpTransport(config.smtp) : undefined;
    outreach = new Outreach(cfg.dataDir, {
      projectDir: cfg.dir, office, queue: () => queue.state(), config, transport,
      ...(runtime.outreach && runtime.outreach.now ? { now: runtime.outreach.now } : {}),
      ...(runtime.outreach && runtime.outreach.schedule ? { schedule: runtime.outreach.schedule } : {}),
      onChange: () => publishOrg(),
    });
    outreach.setInbox(inbox);
    inbox.setExternal(outreach);
    startupCleanup.push(() => outreach?.stop());
  }
  const outreachService = outreach!;
  // ORG-01: the executive roster is a pure projection, re-sent only when a summary or attention count changes.
  let orgSent = '';
  const currentOrg = () => projectOrg({
    now: Date.now(), supervision: empire.state.supervision, workers: workersForClients(), queue: queue.state(),
    jobs: (() => { try { return office.snapshot().jobs; } catch { return []; } })(), usage: ledger.state(),
    approvals: inbox?.state().items,
    outreach: outreach?.summary(),
  });
  publishOrg = () => {
    if (!queue || !consultancy) return;
    ledger.recordTaskCosts(taskCostObservations(queue.state().tasks, workers.list()));
    const org = currentOrg();
    const sig = orgSignature(org);
    if (sig === orgSent) return;
    orgSent = sig;
    broadcast({ t: 'org', state: org });
  };
  const capacityReport = () => ({
    workstations: empire.state.office.workstations,
    workers: workers.list().filter(w => w.processState === 'running').length,
    attention: workers.list().filter(w => w.status === 'needs_input').length,
    concurrency: queue.limit,
    queued: queue.recoveryError ? null : queue.state().tasks.filter(t => t.status === 'queued').length,
    blocker: storageError() || localExecutionBlocker() || (!localQueueApproved || queue.limit === 0 ? 'The local task queue is paused. Set concurrency in the game’s Queue panel to start approved work.' : undefined) || ledger.hiringPaused,
    mode: execution.setup().config.mode,
  });
  const chief = chiefCommands(office, () => {
    const r = capacityReport();
    return `${r.workstations} funded workstations · ${r.workers} running workers · concurrency ${r.concurrency} · ${r.queued === null ? 'queue count unavailable' : `${r.queued} tasks queued`} · ${r.attention} workers need input.${r.blocker ? ` Waiting: ${r.blocker}` : ''} This coordinator requires the execution host to remain running.`;
  }, inbox, () => { queue.pump(); publishApprovals(); }, outreachService);
  let telegram: TelegramBridge | undefined;
  let telegramError: string | undefined;
  try {
    const config = runtime.telegram === false || runtime.backgroundServices === false && !runtime.telegram
      ? undefined : runtime.telegram?.config ?? telegramConfig(process.env);
    if (config) telegram = new TelegramBridge(cfg.dataDir, config, chief, runtime.telegram ? runtime.telegram.transport : undefined);
  } catch (error) { telegramError = (error as Error).message; }
  startupCleanup.push(() => telegram?.stop());

  // What each worker changed, for the Changes window at its desk (see changes.ts).
  changes = new Changes(
    cfg.dir,
    project.branch,
    (workerId) => {
      const w = workers.get(workerId);
      if (!w) return undefined;
      return { name: w.name, cwd: w.worktree ? path.join(cfg.dir, w.worktree.path) : cfg.dir, rel: w.worktree?.path ?? '', worktreeBase: w.worktree?.base };
    },
    (branch) => {
      const pr = github.pulls.items.find((p) => p.state === 'OPEN' && p.headRefName === branch);
      return pr ? { number: pr.number, url: pr.url } : undefined;
    },
    {
      state: (state, ids) => {
        for (const id of ids) {
          const c = clients.get(id);
          if (c) sendTo(c, { t: 'changes', state });
        }
      },
      toast: (text, level) => broadcast({ t: 'toast', text, level }),
      refreshGitHub: () => void github.refresh(),
    },
  );

  const team = new Team(cfg.publicHost, cfg.port);

  // Web servers the workers start, for the Services board and service tunnels (see relay.ts).
  const servicesState = (items = services.list()): ServicesState => ({ items, port: cfg.port, ssh: team.ssh });
  const services = new Services(
    cfg.dir,
    () => workers.owners(),
    (items) => broadcast({ t: 'services', state: servicesState(items) }),
  );

  const decor = new Decor(cfg.dataDir);
  const images = new ImageProxy();

  const upgrader = new Upgrader(
    (state) => broadcast({ t: 'upgrade', state }),
    () => {
      // cli.ts shuts down gracefully; recovered tasks remain interrupted after restart.
      process.kill(process.pid, 'SIGTERM');
    },
    runtime.backgroundServices !== false,
  );

  // --- HTTP ------------------------------------------------------------------------------------
  const serveFile = (res: http.ServerResponse, file: string, cache: boolean) => {
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': cache ? 'public, max-age=31536000, immutable' : 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });
    createReadStream(file).pipe(res);
  };

  const login = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const ip = clientIp(req, cfg.trustProxy);
    // Counted before the body is read, so parallel guesses can't all slip under the limit.
    if (!auth.allowAttempt(ip)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    let pw = '';
    try {
      pw = str(JSON.parse(await readBody(req, 4096)).password, 512);
    } catch {
      return send(res, 400, { error: 'Bad request' });
    }
    if (!(await auth.checkPassword(pw))) return send(res, 401, { error: 'Wrong password' });
    auth.recordSuccess(ip);
    return send(res, 200, { ok: true }, { 'set-cookie': auth.cookie(req, auth.issue(), isSecure(req, cfg)) });
  };

  /** Same password check and the same per-client attempt budget as the cookie login. */
  const deviceLogin = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const ip = clientIp(req, cfg.trustProxy);
    if (!auth.allowAttempt(ip)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    let pw = '';
    let deviceName: unknown;
    try {
      const body = JSON.parse(await readBody(req, 4096));
      pw = str(body?.password, 512);
      deviceName = body?.deviceName;
    } catch {
      return send(res, 400, { error: 'Bad request' });
    }
    if (!(await auth.checkPassword(pw))) return send(res, 401, { error: 'Wrong password' });
    auth.recordSuccess(ip);
    let issued: ReturnType<DeviceStore['issue']>;
    try { issued = devices.issue(deviceName); }
    catch (err) {
      console.error('[devices] could not save a new device sign-in:', (err as Error).message);
      return send(res, 500, { error: 'Could not save the device sign-in. Try again.' });
    }
    if (!issued) return send(res, 409, { error: 'Too many signed-in devices. Remove one in Settings first.' });
    return send(res, 200, issued);
  };

  /**
   * How a request is signed in: a device token (when a Bearer Authorization header is sent, only that
   * counts) or the session cookie. Other schemes (a proxy's Basic auth, say) leave cookie auth as it was.
   */
  const authenticate = (req: http.IncomingMessage): { via: 'bearer'; device: DeviceInfo } | { via: 'cookie' } | undefined => {
    if (hasBearer(req)) {
      const device = devices.verify(bearerFrom(req));
      return device ? { via: 'bearer', device } : undefined;
    }
    return auth.fromRequest(req) ? { via: 'cookie' } : undefined;
  };

  /**
   * Closes a device's WebSockets. close() only starts the closing handshake, and a peer that ignores
   * it could hold the socket open; messages are already dropped once it is CLOSING (see onConnection),
   * and the socket is cut off outright shortly after.
   */
  const disconnectDevice = (deviceId: string) => {
    for (const c of clients.values()) {
      if (c.deviceId !== deviceId) continue;
      c.ws.close(4401, 'Device signed out');
      setTimeout(() => { if (c.ws.readyState !== WebSocket.CLOSED) c.ws.terminate(); }, 1000).unref();
    }
  };

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      // A service tunnel (localhost:5173 -> the office): relay to that worker's server.
      const tunneled = tunneledPort(req, cfg.port);
      const svc = tunneled ? services.lookup(tunneled) : undefined;
      if (tunneled && svc) {
        if (req.method === 'POST' && req.url === RELAY_LOGIN) return await login(req, res);
        if (!auth.fromAnyCookie(req)) return signInPage(res, tunneled);
        if (svc === 'gone') return stoppedPage(res, tunneled);
        return relayRequest(req, res, svc);
      }
      let p: string;
      try {
        p = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      } catch {
        return send(res, 400, { error: 'Bad request' });
      }
      // CORS, only for the bundled apps' own origins and never with credentials (no cookies cross-origin).
      // Preflights, sign-in and health are answered for them; anything else only when a bearer token is sent.
      const appOrigin = typeof req.headers.origin === 'string' && APP_ORIGINS.has(req.headers.origin) ? req.headers.origin : undefined;
      if (appOrigin) {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'access-control-allow-origin': appOrigin,
            'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'access-control-allow-headers': 'Authorization, Content-Type',
            'access-control-max-age': '600',
            vary: 'Origin',
            'cache-control': 'no-store',
          });
          res.end();
          return;
        }
        if (hasBearer(req) || p === '/api/device/login' || p === '/api/health') {
          res.setHeader('access-control-allow-origin', appOrigin);
          res.setHeader('vary', 'Origin');
        }
      }
      if (p === '/api/login' && req.method === 'POST') return await login(req, res);
      if (p === '/api/device/login' && req.method === 'POST') return await deviceLogin(req, res);
      // One-time reveal of the generated password. After this the plaintext is gone for good.
      const claimable = !!cfg.claimToken && !cfg.claimed && !!cfg.password;
      if (p === '/api/claim' && req.method === 'GET') return send(res, 200, { claimable });
      if (p === '/api/claim' && req.method === 'POST') {
        const ip = clientIp(req, cfg.trustProxy);
        if (!auth.allowAttempt(ip)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
        let token = '';
        try {
          token = str(JSON.parse(await readBody(req, 4096)).token, 256);
        } catch {
          return send(res, 400, { error: 'Bad request' });
        }
        if (!claimable) return send(res, 410, { error: 'This office has already been claimed. Sign in with the password you saved.' });
        if (!auth.checkToken(token, cfg.claimToken!)) return send(res, 403, { error: 'That claim link is not valid.' });
        const password = cfg.password!;
        cfg.markClaimed();
        auth.recordSuccess(ip);
        console.log('  the office password was claimed — it will not be shown again');
        return send(res, 200, { password }, { 'set-cookie': auth.cookie(req, auth.issue(), isSecure(req, cfg)) });
      }
      if (p === '/api/logout' && req.method === 'POST') {
        return send(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie(req) });
      }
      if (p === '/api/health') return send(res, 200, { ok: true });

      if (req.method === 'GET' && (p === '/sw.js' || p === '/manifest.webmanifest')) {
        const file = path.join(publicDir, p.slice(1));
        if (!existsSync(file)) return send(res, 404, { error: 'Not found' });
        return serveFile(res, file, false);
      }

      if (p.startsWith('/assets/')) {
        const file = path.join(publicDir, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
        if (file.startsWith(publicDir) && existsSync(file) && statSync(file).isFile()) return serveFile(res, file, true);
        res.writeHead(404).end();
        return;
      }
      if (p === '/login' || p === '/login.html') return serveFile(res, path.join(publicDir, 'login.html'), false);
      if (p === '/claim' || p === '/claim.html') return serveFile(res, path.join(publicDir, 'claim.html'), false);
      if (p === '/favicon.svg') return serveFile(res, path.join(publicDir, 'favicon.svg'), false);

      const signedIn = authenticate(req);
      if (!signedIn) {
        if (p.startsWith('/api/') || hasBearer(req)) return send(res, 401, { error: 'Not logged in' });
        res.writeHead(302, { location: '/login' }).end();
        return;
      }
      // A bearer token is never sent by a browser on its own, so a bearer request can't be a forgery;
      // cookie requests keep the same-origin Origin check exactly as before.
      const trusted = () => signedIn.via === 'bearer' || sameOrigin(req, cfg);
      if (p === '/api/whoami') return send(res, 200, signedIn.via === 'bearer' ? { ok: true, deviceId: signedIn.device.id } : { ok: true });
      if (p === '/api/devices' && req.method === 'GET') {
        const current = signedIn.via === 'bearer' ? signedIn.device.id : undefined;
        return send(res, 200, { devices: devices.list().map((d) => ({ ...d, current: d.id === current })) });
      }
      const deviceRoute = /^\/api\/devices\/([A-Za-z0-9_-]{1,32})$/.exec(p);
      if (deviceRoute && req.method === 'DELETE') {
        if (!trusted()) return send(res, 403, { error: 'A same-origin Origin header is required' });
        let revoked: boolean;
        try {
          revoked = devices.revoke(deviceRoute[1]);
        } catch (err) {
          console.error('[devices] could not save a device revocation:', (err as Error).message);
          return send(res, 500, { error: 'Could not save the revocation, so the device is still signed in. Its connections were closed; try again.' });
        } finally {
          // Whatever happened on disk, the device's live connections go now.
          disconnectDevice(deviceRoute[1]);
        }
        if (!revoked) return send(res, 404, { error: 'No such device' });
        return send(res, 200, { ok: true });
      }
      if (p.startsWith('/api/consultancy/')) {
        if (req.method !== 'GET' && !trusted()) return send(res, 403, { error: 'A same-origin Origin header is required' });
        try {
          office.reconcile();
          if (p === '/api/consultancy/jobs' && req.method === 'GET') return send(res, 200, office.snapshot());
          if (p === '/api/consultancy/status' && req.method === 'GET') return send(res, 200, {
            mode: 'rule_based', observedAt: Date.now(), repository: project.name,
            resources: capacityReport(), telegram: telegram?.status() ?? { configured: false, running: false, error: telegramError },
            email: email?.status() ?? (emailError ? { ...NOT_CONFIGURED, error: emailError } : NOT_CONFIGURED),
            hostRequired: true,
          });
          if (p === '/api/consultancy/jobs' && req.method === 'POST') {
            let value: unknown;
            try { value = JSON.parse(await readBody(req, 180_000)); }
            catch { return send(res, 400, { error: 'Expected a JSON client brief.' }); }
            return send(res, 200, office.create(value, 'CEO'));
          }
          const action = /^\/api\/consultancy\/jobs\/([a-zA-Z0-9_-]{1,80})\/(approve|reject)$/.exec(p);
          if (action && req.method === 'POST') {
            if (action[2] === 'reject') return send(res, 200, office.reject(action[1], 'CEO'));
            // ORG-02: the CEO may edit the budget at approval; an empty body keeps the estimate's default.
            let body: { budgetUsd?: unknown } = {};
            try { const raw = await readBody(req, 4_000); body = raw.trim() ? JSON.parse(raw) : {}; }
            catch { return send(res, 400, { error: 'Expected a JSON approval.' }); }
            if (!body || typeof body !== 'object') return send(res, 400, { error: 'Expected a JSON approval.' });
            return send(res, 200, office.approve(action[1], 'CEO', body.budgetUsd === undefined || body.budgetUsd === null ? {} : { budgetUsd: body.budgetUsd as number }));
          }
          return send(res, 404, { error: 'Unknown consultancy endpoint.' });
        } catch (error) {
          if (error instanceof ConsultancyError) return send(res, error.status, { error: error.message });
          return send(res, 500, { error: 'Consultancy service could not complete this request.' });
        }
      }
      if (p === '/api/approvals' || p.startsWith('/api/approvals/')) {
        if (req.method !== 'GET' && !trusted()) return send(res, 403, { error: 'A same-origin Origin header is required' });
        const approvals = inbox!;
        try {
          office.reconcile();
          approvals.reconcile();
          if (p === '/api/approvals' && req.method === 'GET') return send(res, 200, approvals.state());
          const action = /^\/api\/approvals\/(A[1-9]\d{0,8})\/(approve|reject)$/.exec(p);
          if (action && req.method === 'POST') {
            // The body may carry budgetUsd (validated as in ORG-02) and a requestId; an empty body is fine.
            let body: { budgetUsd?: unknown; requestId?: unknown } = {};
            try { const raw = await readBody(req, 4_000); body = raw.trim() ? JSON.parse(raw) : {}; }
            catch { return send(res, 400, { error: 'Expected a JSON decision.' }); }
            if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'Expected a JSON decision.' });
            const options = { budgetUsd: body.budgetUsd, requestId: body.requestId };
            const item = action[2] === 'approve' ? approvals.approve(action[1], 'CEO', options) : approvals.reject(action[1], 'CEO', options);
            // A raised budget releases held items: let the queue seat them now rather than on its next tick.
            queue.pump();
            publishApprovals();
            return send(res, 200, item);
          }
          return send(res, 404, { error: 'Unknown approval endpoint.' });
        } catch (error) {
          if (error instanceof ApprovalError || error instanceof ConsultancyError) return send(res, error.status, { error: error.message });
          return send(res, 500, { error: 'The approval inbox could not complete this request.' });
        }
      }
      if (p === '/api/outreach' || p.startsWith('/api/outreach/')) {
        if (req.method !== 'GET' && !trusted()) return send(res, 403, { error: 'A same-origin Origin header is required' });
        try {
          if (p === '/api/outreach' && req.method === 'GET') { office.reconcile(); outreachService.reconcile(); return send(res, 200, outreachService.state()); }
          if (req.method !== 'POST') return send(res, 404, { error: 'Unknown outreach endpoint.' });
          let body: Record<string, unknown>;
          try { const raw = await readBody(req, 1_200_000); body = raw.trim() ? JSON.parse(raw) : {}; }
          catch { return send(res, 400, { error: 'Expected a JSON request.' }); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'Expected a JSON request.' });
          const done = (value: unknown) => { publishApprovals(); publishOrg(); return send(res, 200, value); };
          if (p === '/api/outreach/leads/import') return done(outreachService.importCsv(body.csv, 'CEO'));
          if (p === '/api/outreach/suppression') {
            if (body.reason !== 'opt_out' && body.reason !== 'blocked') return send(res, 400, { error: 'reason must be opt_out or blocked' });
            return done(outreachService.suppress(body.email, body.reason, 'CEO', typeof body.note === 'string' ? body.note : undefined));
          }
          if (p === '/api/outreach/campaigns') return done(outreachService.createCampaign(body, 'CEO'));
          const lead = /^\/api\/outreach\/leads\/(L[1-9]\d{0,8})\/(accept|decline)$/.exec(p);
          if (lead) return lead[2] === 'accept' ? done(outreachService.acceptLead(lead[1], 'CEO')) : (outreachService.rejectLead(lead[1]), done({ ok: true }));
          const action = /^\/api\/outreach\/campaigns\/(C[1-9]\d{0,8})\/(pause|resume|cancel)$/.exec(p);
          if (action) return done(action[2] === 'pause' ? outreachService.pause(action[1], 'CEO') : action[2] === 'resume' ? outreachService.resume(action[1], 'CEO') : outreachService.cancel(action[1], 'CEO'));
          return send(res, 404, { error: 'Unknown outreach endpoint.' });
        } catch (error) {
          if (error instanceof OutreachError || error instanceof ConsultancyError) return send(res, error.status, { error: error.message });
          return send(res, 500, { error: 'Outreach could not complete this request.' });
        }
      }
      if (p.startsWith('/api/execution/')) {
        if (req.method !== 'GET' && !trusted()) return send(res, 403, {error:'A same-origin Origin header is required'});
        try {
          const body = async () => { try { return JSON.parse(await readBody(req, 32768)); } catch { throw new ExecutionError(400, 'invalid_json', 'Expected a JSON request.'); } };
          if (p === '/api/execution/setup' && req.method === 'GET') return send(res, 200, execution.setup());
          if (p === '/api/execution/setup' && req.method === 'PUT') {
            const value = await body();
            if (value?.mode !== execution.setup().config.mode && workers.list().some(w => w.processState === 'running' || w.processState === 'unknown'))
              return send(res, 409, {error:'Stop or reconcile existing local workers before changing execution mode.'});
            return send(res, 200, execution.updateSetup(value));
          }
          if (p === '/api/execution/check' && req.method === 'POST') return send(res, 200, await execution.check());
          if (p === '/api/execution/tasks' && req.method === 'GET') return send(res, 200, {tasks:execution.tasks()});
          if (p === '/api/execution/tasks' && req.method === 'POST') return send(res, 200, await execution.submit(await body()));
          const stopping = /^\/api\/execution\/tasks\/([a-zA-Z0-9-]{1,80})\/stop$/.exec(p);
          if (stopping && req.method === 'POST') return send(res, 200, await execution.stopTask(stopping[1]));
          const refresh = /^\/api\/execution\/tasks\/([a-zA-Z0-9-]{1,80})\/refresh$/.exec(p);
          if (refresh && req.method === 'POST') return send(res, 200, await execution.refresh(refresh[1]));
          return send(res, 404, {error:'Unknown execution endpoint.'});
        } catch (error) {
          if (error instanceof ExecutionError) return send(res, error.status, {error:error.message,code:error.code});
          return send(res, 500, {error:'Execution service could not complete this request.'});
        }
      }

      if (p === '/api/continuity/status' && req.method === 'GET') return send(res, 200, continuity.status(storageError()));
      if (p === '/api/continuity/events' && req.method === 'GET') {
        const params = new URL(req.url ?? '/', 'http://x').searchParams;
        const after = params.has('after') && /^\d+$/.test(params.get('after')!) ? Number(params.get('after')) : undefined;
        return send(res, 200, continuity.feed(params.get('serverId') ?? undefined, after, storageError()));
      }
      if (p === '/api/sync/artifacts' && req.method === 'GET') return send(res, 200, { serverId: continuity.serverId, artifacts: await artifacts.list() });
      if (p === '/api/sync/artifacts' && req.method === 'POST') {
        if (!trusted()) return send(res, 403, { error: 'A same-origin Origin header is required' });
        let body: unknown;
        try { body = JSON.parse(await readBody(req, 4096)); }
        catch { return send(res, 400, { error: 'Expected JSON with workerId' }); }
        const workerId = body && typeof body === 'object' && 'workerId' in body ? body.workerId : undefined;
        if (typeof workerId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(workerId)) return send(res, 400, { error: 'Invalid workerId' });
        if (changes.isBusy(workerId)) return send(res, 409, { error: 'Worker has a Git operation in progress' });
        try {
          const manifest = await artifacts.publish(workerId, publish => workers.publishArtifact(workerId, publish));
          return send(res, 200, manifest);
        } catch (error) { return send(res, 409, { error: (error as Error).message }); }
      }
      const artifactRoute = /^\/api\/sync\/artifacts\/([a-f0-9]{64})\/(manifest|bundle)$/.exec(p);
      if (artifactRoute && req.method === 'GET') {
        try {
          if (artifactRoute[2] === 'manifest') return send(res, 200, artifacts.manifest(artifactRoute[1]));
          const { file, manifest } = await artifacts.bundle(artifactRoute[1]);
          res.writeHead(200, {
            'content-type': 'application/octet-stream', 'content-length': String(manifest.bundle.bytes),
            'content-disposition': `attachment; filename="${manifest.artifactId}.bundle"`,
            'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
          });
          createReadStream(file).on('error', () => res.destroy()).pipe(res);
          return;
        } catch (error) { return send(res, 404, { error: (error as Error).message }); }
      }
      if (p.startsWith('/api/continuity/') || p.startsWith('/api/sync/')) return send(res, 404, { error: 'Not found' });
      if (p === '/api/image' && req.method === 'GET') {
        // A picture on the wall, fetched by the office so the 3D view can draw it (see decor.ts).
        const r = await images.get(new URL(req.url ?? '/', 'http://x').searchParams.get('url') ?? '');
        if ('error' in r) return send(res, r.status, { error: r.error });
        res.writeHead(200, {
          'content-type': r.type,
          'content-length': String(r.body.length),
          'cache-control': 'private, max-age=3600',
          'x-content-type-options': 'nosniff',
          // Opened on its own (an SVG, say), it still can't run anything on the office's origin.
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          'cross-origin-resource-policy': 'same-origin',
        });
        res.end(r.body);
        return;
      }
      if (p.startsWith('/api/gh/') && req.method === 'GET') {
        // What the issue and PR windows show beyond the board cards (see github.ts).
        const n = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('number'));
        if (!Number.isSafeInteger(n) || n <= 0) return send(res, 400, { error: 'Bad number' });
        try {
          if (p === '/api/gh/pull') return send(res, 200, await github.pullDetail(n));
          if (p === '/api/gh/issue') return send(res, 200, await github.issueDetail(n));
          if (p === '/api/gh/pull/diff') {
            const diff = await github.pullDiff(n);
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
            res.end(diff);
            return;
          }
        } catch (err) {
          return send(res, 502, { error: (err as Error).message });
        }
        return send(res, 404, { error: 'Not found' });
      }
      if (p === '/' || p === '/index.html') return serveFile(res, path.join(publicDir, 'index.html'), false);
      const file = path.join(publicDir, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (file.startsWith(publicDir + path.sep) && existsSync(file) && statSync(file).isFile()) return serveFile(res, file, false);
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    }
  };

  const server = cfg.tls ? https.createServer({ cert: cfg.tls.cert, key: cfg.tls.key }, handler) : http.createServer(handler);
  server.once('close', releaseHost);
  startupCleanup.push(() => server.close());

  // --- WebSocket -------------------------------------------------------------------------------
  // Only ever agree to empire.v1: the bearer.<token> entry must never be echoed back in the handshake.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, handleProtocols: (offered) => (offered.has(WS_PROTOCOL) ? WS_PROTOCOL : false) });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const tunneled = tunneledPort(req, cfg.port);
    const svc = tunneled ? services.lookup(tunneled) : undefined;
    if (tunneled && svc) {
      if (svc !== 'gone' && auth.fromAnyCookie(req)) return relayUpgrade(req, socket, head, svc);
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://x');
    } catch {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    const host = (cfg.trustProxy && (req.headers['x-forwarded-host'] as string)) || req.headers.host;
    let sameOrigin = false;
    try {
      sameOrigin = !!origin && new URL(origin).host === host;
    } catch {
      sameOrigin = false;
    }
    const reject = () => {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    };
    const protocols = wsProtocols(req);
    if (protocols.token !== undefined) {
      // Device token: it has to come with empire.v1, from no browser origin, this origin or a bundled app.
      const allowedOrigin = !origin || sameOrigin || APP_ORIGINS.has(origin);
      const device = allowedOrigin && protocols.offered.includes(WS_PROTOCOL) ? devices.verify(protocols.token) : undefined;
      if (url.pathname !== '/ws' || !device) return reject();
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, url, device.id));
      return;
    }
    if (url.pathname !== '/ws' || !auth.fromRequest(req) || !sameOrigin) return reject();
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, url));
  });

  const onConnection = (ws: WebSocket, url: URL, deviceId?: string) => {
    const id = randomBytes(5).toString('hex');
    const name = str(url.searchParams.get('name'), 24).trim() || `Guest ${id.slice(0, 3)}`;
    const colorParam = url.searchParams.get('color') ?? '';
    const intParam = (k: string) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : undefined);
    const client: Client = {
      id,
      ws,
      deviceId,
      attached: new Set(),
      stale: new Set(),
      lastMoveAt: 0,
      lastActAt: 0,
      peer: {
        id,
        name,
        color: COLOR_RE.test(colorParam) ? colorParam : '#4f86f7',
        look: sanitizeLook({ skin: intParam('skin'), hair: intParam('hair'), style: intParam('style') }, lookFromSeed(id)),
        x: SPAWN.x + (Math.random() - 0.5) * 3,
        y: 0,
        z: SPAWN.z + (Math.random() - 0.5) * 2,
        rotY: Math.PI,
        moving: false,
        voice: false,
        muted: true,
        sharing: false,
      },
    };
    empire.tick(workers.list(), queue.state(), 0);
    clients.set(id, client);
    (ws as any).isAlive = true;
    ws.on('pong', () => ((ws as any).isAlive = true));

    sendTo(client, {
      t: 'welcome',
      you: id,
      peers: [...clients.values()].map((c) => c.peer),
      workers: workersForClients(),
      project,
      issues: github.issues,
      pulls: github.pulls,
      ice: cfg.iceServers,
      chat: chat.slice(-50),
      invites: team.available,
      version: upgrader.version,
      appVersion: upgrader.packageVersion,
      upgrade: upgrader.state,
      services: servicesState(),
      decor: decor.list(),
      usage: ledger.state(),
      org: currentOrg(),
      approvals: inbox?.state(),
      queue: queue.state(),
    });
    sendTo(client, { t: 'empire', state: empire.state });
    sendTo(client, { t: 'continuity.status', status: continuity.status(storageError()) });
    for (const { workerId, frame } of workers.fullScreens()) sendTo(client, { t: 'screen', workerId, ...frame, full: true });
    broadcast({ t: 'peer.join', peer: client.peer }, id);
    for (const error of [workers.recoveryError, queue.recoveryError])
      if (error) sendTo(client, { t: 'toast', text: error, level: 'error' });

    ws.on('message', (raw) => {
      // A socket being closed (a revoked device, say) gets no further say, even if its peer keeps talking.
      if (ws.readyState !== WebSocket.OPEN) return;
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      // One malformed message must never take the office (and every worker's PTY) down with it.
      try {
        handleMessage(client, msg);
      } catch (err) {
        console.error(`[ws] bad ${String((msg as { t?: unknown }).t)} message from ${client.peer.name}:`, err);
      }
    });
    ws.on('close', () => {
      clients.delete(id);
      workers.detachAll(id);
      changes.unwatchAll(id);
      broadcast({ t: 'peer.leave', id });
    });
    ws.on('error', () => ws.terminate());
  };

  const handleMessage = (c: Client, msg: ClientMsg) => {
    const who = c.peer.name;
    if ((msg.t === 'changes.commit' || msg.t === 'changes.discard' || msg.t === 'changes.pr') && workers.artifactPublishing(msg.workerId)) {
      sendTo(c, { t: 'toast', text: 'This worker is publishing a sync artifact; wait for it to finish', level: 'warn' });
      return;
    }
    switch (msg.t) {
      case 'empire.action': {
        if (!msg.action || typeof msg.action !== 'object') break;
        if (Date.now() - c.lastActAt < 250) break;
        c.lastActAt = Date.now();
        const error = empire.action(msg.action, queue);
        if (error) sendTo(c, { t: 'toast', text: error, level: 'error' });
        else empire.dispatchManagers(queue, who);
        empire.tick(workers.list(), queue.state(), 0);
        break;
      }
      case 'move': {
        const p = c.peer;
        p.x = num(msg.x);
        p.y = num(msg.y);
        p.z = num(msg.z);
        p.rotY = num(msg.rotY);
        p.moving = !!msg.moving;
        broadcast({ t: 'peer.move', id: c.id, x: p.x, y: p.y, z: p.z, rotY: p.rotY, moving: p.moving }, c.id, true);
        break;
      }
      case 'act': {
        const now = Date.now();
        if (now - c.lastActAt < 100) break;
        c.lastActAt = now;
        broadcast({ t: 'peer.act', id: c.id }, c.id, true);
        break;
      }
      case 'profile': {
        const name = str(msg.name, 24).trim();
        if (name) c.peer.name = name;
        if (typeof msg.color === 'string' && COLOR_RE.test(msg.color)) c.peer.color = msg.color;
        c.peer.look = sanitizeLook(msg.look, c.peer.look);
        broadcast({ t: 'peer.update', peer: c.peer });
        break;
      }
      case 'voice':
        c.peer.voice = !!msg.voice;
        c.peer.muted = !!msg.muted;
        c.peer.sharing = !!msg.sharing;
        broadcast({ t: 'peer.update', peer: c.peer });
        break;
      case 'rtc': {
        const target = clients.get(str(msg.to, 32));
        if (target) sendTo(target, { t: 'rtc', from: c.id, data: msg.data });
        break;
      }
      case 'chat': {
        const text = str(msg.text, 500).trim();
        if (!text) break;
        const line: ChatLine = { from: c.id, name: who, color: c.peer.color, text, at: Date.now() };
        chat.push(line);
        if (chat.length > 200) chat.splice(0, chat.length - 200);
        broadcast({ t: 'chat', ...line });
        break;
      }
      case 'worker.spawn': {
        const kind = msg.kind === 'shell' ? 'shell' : 'agent';
        const r = workers.spawn(str(msg.deskId, 32), who, str(msg.prompt, 20000) || undefined, msg.worktree === true, kind, false, sanitizeOutfit(msg.outfit));
        if (typeof r === 'string') sendTo(c, { t: 'toast', text: r, level: 'warn' });
        else broadcast({ t: 'toast', text: kind === 'shell' ? `${who} opened a shell at a desk` : `${who} hired ${r.name}${r.prompt ? ' with a task' : ''}`, level: 'info' });
        break;
      }
      case 'worker.resume': {
        const err = workers.resume(str(msg.workerId, 32));
        if (err) sendTo(c, { t: 'toast', text: err, level: 'warn' });
        break;
      }
      case 'worker.kill': {
        const w = workers.get(str(msg.workerId, 32));
        if (!w) break;
        // Removal is announced only after the process has actually stopped.
        const done = workers.kill(w.id, typeof msg.cleanup === 'string' && CLEANUPS.has(msg.cleanup) ? msg.cleanup : undefined);
        void done.then(({ note, error }) => {
          if (!error) broadcast({ t: 'toast', text: `${who} sent ${w.name} home`, level: 'info' });
          if (note) broadcast({ t: 'toast', text: note, level: 'info' });
          if (error) broadcast({ t: 'toast', text: error, level: 'warn' });
        });
        break;
      }
      case 'worker.worktree': {
        const wid = str(msg.workerId, 32);
        void workers.inspectWorktree(wid).then((state) => {
          if (state) sendTo(c, { t: 'worker.worktree', workerId: wid, state });
        });
        break;
      }
      case 'worker.attach': {
        const wid = str(msg.workerId, 32);
        const snap = workers.attach(wid, c.id, who);
        if (snap) {
          c.attached.add(wid);
          sendTo(c, { t: 'term.snapshot', workerId: wid, ...snap });
        }
        break;
      }
      case 'worker.detach': {
        const wid = str(msg.workerId, 32);
        c.attached.delete(wid);
        workers.detach(wid, c.id);
        break;
      }
      case 'worker.prompt': {
        const err = workers.prompt(str(msg.workerId, 32), str(msg.prompt, 20000));
        if (err) sendTo(c, { t: 'toast', text: err, level: 'warn' });
        break;
      }
      case 'worker.pr': {
        const wid = str(msg.workerId, 32);
        void workers.openPr(wid, who).then((r) => {
          if (typeof r === 'string') return sendTo(c, { t: 'toast', text: r, level: 'warn' });
          const name = workers.get(wid)?.name ?? 'the worker';
          broadcast({ t: 'toast', text: r.existed ? `${name}'s branch already has PR #${r.number}` : `${who} opened PR #${r.number} for ${name}`, level: 'info' });
          if (r.dirty) sendTo(c, { t: 'toast', text: `${name} still has uncommitted changes in its worktree — they are not in the PR`, level: 'warn' });
          // Put it on the board now rather than at the next poll. A refresh already in flight
          // returns at once and can miss it, so look again shortly after.
          void github.refresh().then(() => {
            if (!github.pulls.items.some((p) => p.number === r.number)) setTimeout(() => void github.refresh(), 3000);
          });
        });
        break;
      }
      case 'term.input':
        if (c.attached.has(msg.workerId)) workers.write(msg.workerId, str(msg.data, 64 * 1024));
        break;
      case 'term.resize':
        if (c.attached.has(msg.workerId)) workers.resize(msg.workerId, num(msg.cols), num(msg.rows));
        break;
      case 'gh.refresh':
        void github.refresh();
        break;
      case 'gh.merge': {
        const n = num(msg.number);
        const method = (['squash', 'merge', 'rebase'] as const).find((m) => m === msg.method);
        if (!Number.isSafeInteger(n) || n <= 0 || !method) break;
        void github.merge(n, method, msg.deleteBranch === true, msg.auto === true).then((error) => {
          sendTo(c, { t: 'gh.merged', number: n, error });
          if (!error) broadcast({ t: 'toast', text: msg.auto ? `${who} set PR #${n} to merge once its checks pass` : `🎉 ${who} merged PR #${n}`, level: 'info' });
        });
        break;
      }
      case 'queue.add': {
        const issue = Number.isInteger(msg.issue) && (msg.issue as number) > 0 ? (msg.issue as number) : undefined;
        const err = queue.add(str(msg.prompt, 20000), who, str(msg.title, 200), issue);
        if (err) sendTo(c, { t: 'toast', text: err, level: 'warn' });
        else broadcast({ t: 'toast', text: `📋 ${who} queued ${issue !== undefined ? `issue #${issue}` : 'a task'}`, level: 'info' });
        break;
      }
      case 'queue.remove': {
        const err = queue.remove(str(msg.taskId, 32));
        if (err) sendTo(c, { t: 'toast', text: err, level: 'warn' });
        break;
      }
      case 'queue.move':
        queue.move(str(msg.taskId, 32), num(msg.delta) < 0 ? -1 : 1);
        break;
      case 'queue.retry': {
        const err = queue.retry(str(msg.taskId, 32));
        if (err) sendTo(c, { t: 'toast', text: err, level: 'warn' });
        break;
      }
      case 'queue.clear':
        queue.clear();
        break;
      case 'queue.limit': {
        const blocker = localExecutionBlocker();
        if (num(msg.maxWorkers) > 0 && blocker) {
          sendTo(c, { t: 'toast', text: blocker, level: 'warn' });
          break;
        }
        localQueueApproved = num(msg.maxWorkers) > 0;
        queue.setLimit(num(msg.maxWorkers));
        break;
      }
      case 'changes.watch':
        if (workers.get(str(msg.workerId, 32))) changes.watch(str(msg.workerId, 32), c.id);
        break;
      case 'changes.unwatch':
        changes.unwatch(str(msg.workerId, 32), c.id);
        break;
      case 'changes.diff': {
        const workerId = str(msg.workerId, 32);
        const file = str(msg.path, 4096);
        void changes.diff(workerId, file).then((r) => {
          if (typeof r === 'string') sendTo(c, { t: 'changes.diff', workerId, path: file, diff: '', truncated: false, error: r });
          else sendTo(c, { t: 'changes.diff', workerId, path: file, ...r });
        });
        break;
      }
      case 'changes.commit':
        void changes.commit(str(msg.workerId, 32), str(msg.message, 5000), who).then((err) => {
          if (err) sendTo(c, { t: 'toast', text: err, level: 'warn' });
        });
        break;
      case 'changes.discard':
        void changes.discard(str(msg.workerId, 32), typeof msg.path === 'string' ? str(msg.path, 4096) : undefined, who).then((err) => {
          if (err) sendTo(c, { t: 'toast', text: err, level: 'warn' });
        });
        break;
      case 'changes.pr':
        void changes.pullRequest(str(msg.workerId, 32), str(msg.title, 300), str(msg.body, 20000), who).then((err) => {
          if (err) sendTo(c, { t: 'toast', text: err, level: 'warn' });
        });
        break;
      case 'upgrade.check':
        void upgrader.check();
        break;
      case 'upgrade.start':
        void upgrader.start(who).then((err) => {
          if (err) sendTo(c, { t: 'toast', text: err, level: 'warn' });
          else broadcast({ t: 'toast', text: `${who} is upgrading the office — it restarts when the new version is built`, level: 'info' });
        });
        break;
      case 'team.get':
        void team.state().then((state) => sendTo(c, { t: 'team', state }));
        break;
      case 'team.invite': {
        const github = str(msg.github, 64);
        void team.invite(github).then(async (r) => {
          sendTo(c, { t: 'team.invited', github, ...r });
          if ('error' in r) return;
          broadcast({ t: 'toast', text: `${who} invited ${r.name} to the office`, level: 'info' });
          broadcast({ t: 'team', state: await team.state() });
        });
        break;
      }
      case 'team.remove': {
        const name = str(msg.name, 64);
        void team.remove(name).then(async (err) => {
          if (err) return sendTo(c, { t: 'toast', text: err, level: 'warn' });
          broadcast({ t: 'toast', text: `${who} removed ${name}'s access`, level: 'info' });
          broadcast({ t: 'team', state: await team.state() });
        });
        break;
      }
      case 'decor.add': {
        const d = decor.add(msg.decor, who);
        if (typeof d === 'string') return sendTo(c, { t: 'toast', text: d, level: 'warn' });
        broadcast({ t: 'decor', items: decor.list() });
        broadcast({ t: 'toast', text: `🖼️ ${who} hung ${d.title ? `“${d.title}”` : 'a picture'}`, level: 'info' });
        break;
      }
      case 'decor.update': {
        const d = decor.update(str(msg.id, 32), msg.decor);
        if (typeof d === 'string') return sendTo(c, { t: 'toast', text: d, level: 'warn' });
        broadcast({ t: 'decor', items: decor.list() });
        break;
      }
      case 'decor.remove': {
        const d = decor.remove(str(msg.id, 32));
        if (!d) break;
        broadcast({ t: 'decor', items: decor.list() });
        broadcast({ t: 'toast', text: `${who} took down ${d.title ? `“${d.title}”` : 'a picture'}`, level: 'info' });
        break;
      }
      case 'ping':
        sendTo(c, { t: 'pong', at: num(msg.at) });
        break;
    }
  };

  const resync = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.stale.size || c.ws.bufferedAmount > SLOW_CLIENT_BYTES / 8) continue;
      for (const wid of c.stale) {
        const snap = c.attached.has(wid) ? workers.attach(wid, c.id, c.peer.name) : undefined;
        if (snap) sendTo(c, { t: 'term.snapshot', workerId: wid, ...snap });
      }
      c.stale.clear();
    }
  }, 1000);

  // Drop dead connections so ghosts don't linger in the office.
  empire.dispatchManagers(queue, 'Chief of staff');
  const empireTimer = setInterval(() => { empire.tick(workers.list(), queue.state()); try { office.reconcile(); inbox?.reconcile(); outreach?.reconcile(); } catch { /* Durable service exposes recovery errors through its snapshot. */ } }, 5000);
  const heartbeat = setInterval(() => {
    for (const c of clients.values()) {
      if ((c.ws as any).isAlive === false) {
        c.ws.terminate();
        continue;
      }
      (c.ws as any).isAlive = false;
      c.ws.ping();
    }
  }, 20_000);
  startupCleanup.push(() => { clearInterval(empireTimer); clearInterval(heartbeat); clearInterval(resync); github.stop(); upgrader.stop(); services.stop(); changes.stop(); });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => resolve());
  });
  if (runtime.backgroundServices !== false) services.start();
  execution.start();
  office.reconcile();
  telegram?.start();

  const shutdown = () => {
    telegram?.stop();
    email?.stop();
    outreach?.stop();
    execution.stop();
    clearInterval(empireTimer);
    empire.flush();
    clearInterval(heartbeat);
    clearInterval(resync);
    github.stop();
    upgrader.stop();
    services.stop();
    queue.shutdown();
    changes.stop();
    workers.shutdown();
    ledger.flush();
    devices.flush();
    for (const c of clients.values()) c.ws.close();
    server.close();
    hookServer.close();
  };

  return { server, shutdown, workers, publicDir, hookPort, execution, consultancy: office, outreach: outreachService, inbox };
}
