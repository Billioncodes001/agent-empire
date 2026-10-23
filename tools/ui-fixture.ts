/** Local-only synthetic wire server for manual browser QA. Never starts a worker or reads a save. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { initialEmpire, MANAGER_NAMES, type SupervisionState } from '../src/shared/empire.js';
import type { ServerMsg, WorkerInfo, QueueTask } from '../src/shared/protocol.js';
import { sanitizeOutfit } from '../src/shared/outfit.js';
import { projectWaitingOn, withWaitingOn } from '../src/server/waiting.js';
import { projectOrg } from '../src/server/org.js';
import type { ConsultancyJob } from '../src/shared/consultancy.js';
import type { OrgState } from '../src/shared/org.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { Outreach } from '../src/server/outreach.js';
import { tmpdir } from 'node:os';
import { Consultancy } from '../src/server/consultancy.js';
import { ApprovalError, ApprovalInbox } from '../src/server/approvals.js';
import { estimateJob } from '../src/server/estimate.js';
import { ResearchDesk, ResearchError } from '../src/server/research.js';
import { parseArtifact } from '../src/server/artifacts.js';
import { SYNTHETIC_REPORT, UNSOURCED_REPORT } from './research-fixture.js';

/**
 * ORG-03: a real approval inbox over a real consultancy journal in a throwaway temp directory, with a fake queue that
 * never starts anything. One client plan waits for approval, and one approved job reached its $3 budget, so finance
 * raised a budget increase and its second item is held. FIXTURE_APPROVALS=none starts with an empty inbox.
 */
const inboxDir = mkdtempSync(resolve(tmpdir(), 'empire-fixture-inbox-'));
const fxTasks: QueueTask[] = [];
const fxCosts: Record<string, number> = {};
let inbox: ApprovalInbox | undefined;
const fxOffice = new Consultancy(inboxDir, {
  state: () => ({ tasks: fxTasks.map((t) => ({ ...t })), maxWorkers: 0 }),
  add: (prompt, by, title, _issue, jobKey, dependsOn) => {
    if (!fxTasks.some((t) => t.jobKey === jobKey)) fxTasks.push({ id: `fx-q${fxTasks.length + 1}`, jobKey, prompt, title: title ?? 'task', addedBy: by, addedAt: Date.now(), status: 'queued', ...(dependsOn?.length ? { dependsOn: [...dependsOn] } : {}) });
    return undefined;
  },
}, () => { inbox?.reconcile(); research?.reconcile(); }, { itemIssue: (key) => research?.issue(key), estimate: (items) => estimateJob(items, [], { maxWorkers: 2, now: Date.now() }), taskCost: (id) => fxCosts[id] });
inbox = new ApprovalInbox(inboxDir, fxOffice, () => { research?.reconcile(); for (const ws of sockets.clients) send(ws, { t: 'approvals', state: inbox!.state() }); });
/**
 * ORG-05: a real ResearchDesk over the same journal. Reports are synthetic markdown "read" from memory (no worktree, no
 * worker). FIXTURE_RESEARCH=seed adds one imported report with two tool proposals, one question awaiting approval and
 * one report rejected for missing sources.
 */
const fxReports = new Map<string, string>();
let research: ResearchDesk | undefined;
research = new ResearchDesk(inboxDir, {
  create: (input, actor) => fxOffice.create(input, actor),
  snapshot: () => fxOffice.snapshot(),
  queue: () => ({ tasks: fxTasks.map((t) => ({ ...t })), maxWorkers: 0 }),
  readArtifact: (_task, jobId) => { const text = fxReports.get(jobId); return text ? parseArtifact(Buffer.from(text)) : { ok: false, reason: `The worker did not write docs/empire/research/${jobId}.md.` }; },
  raiseTool: ({ source, jobId, tool, question }) => inbox!.raise({ source, kind: 'tool_proposal', jobId, tool, title: `Tool: ${tool.name}`, detail: `Proposed in research on “${question}”. Licence ${tool.licence}. Approving records your decision only; nothing is installed.` }),
  decision: (id) => inbox!.get(id),
}, () => { for (const ws of sockets.clients) send(ws, { t: 'research', state: research!.state() }); });
if (process.env.FIXTURE_APPROVALS !== 'none') {
  fxOffice.create({ requestId: 'fx-plan', client: 'Northwind', title: 'Booking portal', brief: 'Synthetic fixture brief', tasks: [{ title: 'Build the booking API', prompt: 'Synthetic' }, { title: 'Iterate on the UI', prompt: 'Synthetic', phase: 'iteration' }] }, 'Fixture CEO');
  const audit = fxOffice.create({ requestId: 'fx-audit', client: 'Harbor Labs', title: 'Security audit', brief: 'Synthetic fixture brief', tasks: [{ title: 'First pass', prompt: 'Synthetic' }, { title: 'Second pass', prompt: 'Synthetic', phase: 'iteration' }] }, 'Fixture CEO');
  fxOffice.approve(audit.id, 'Fixture CEO', { budgetUsd: 3 });
  const first = fxTasks.find((t) => t.jobKey?.endsWith(':item-1'))!;
  Object.assign(first, { status: 'done', outcome: 'done', finishedAt: Date.now() - 60_000 });
  fxCosts[first.id] = 3.2;
  fxOffice.reconcile();
}
if (process.env.FIXTURE_RESEARCH === 'seed') {
  const finishResearch = (question: string, text: string, worker: string, n: number) => {
    const { job } = research!.ask(question, 'Fixture CEO', `fx-research-${n}`);
    fxOffice.approve(job.id, 'Fixture CEO', { budgetUsd: 2 });
    fxReports.set(job.id, text);
    const task = fxTasks.find((t) => t.jobKey === `consultancy:${job.id}:item-1`)!;
    Object.assign(task, { status: 'done', outcome: 'done', workerName: worker, branch: `office/${worker.toLowerCase()}-fx`, finishedAt: Date.now() - 3_600_000 });
    fxCosts[task.id] = 0.84 + n / 10;
  };
  finishResearch('Can we offer appointment booking for dental practices?', SYNTHETIC_REPORT, 'Bea', 1);
  finishResearch('Could we resell cloud GPUs?', UNSOURCED_REPORT, 'Cyrus', 2);
  fxOffice.reconcile();
  research.reconcile();
  research.ask('Is there an open-source way to transcribe client calls on our own server?', 'Fixture CEO', 'fx-research-3');
}

/**
 * ORG-04a (FIXTURE_OUTREACH=1): a real Outreach over the same fixture inbox, with a fake transport that only records.
 * Synthetic leads, one drafted campaign whose artifact sits in the temp project folder, so marketing & sales raised a
 * campaign send (external_action) with the exact samples and recipient list. No message ever leaves this process.
 */
let fxOutreach: Outreach | undefined;
if (process.env.FIXTURE_OUTREACH === '1') {
  const fakeSent: string[] = [];
  fxOutreach = new Outreach(inboxDir, {
    projectDir: inboxDir, office: fxOffice, queue: () => ({ tasks: fxTasks.map((t) => ({ ...t })), maxWorkers: 0 }),
    config: { from: 'hello@northwind-fixture.example', fromName: 'Northwind Studio', address: 'Northwind Studio Ltd, 14 Harbour Row, Bristol BS1 4XX, United Kingdom', dailyCap: 200, intervalMs: 3_600_000, problems: [] },
    transport: { send: async (m) => { fakeSent.push(m.to); } },
    log: () => undefined,
    onChange: () => { for (const ws of sockets.clients) send(ws, { t: 'approvals', state: inbox!.state() }); },
  });
  fxOutreach.setInbox(inbox!);
  inbox!.setExternal(fxOutreach);
  fxOutreach.importCsv(['name,email,company,source,basis,tags',
    'Ann Lee,ann.lee@client-fixture.example,Harbor Labs,inbound inquiry,existing customer,customers',
    'Bob Ray,bob.ray@client-fixture.example,Atlas Commerce,conference contact,legitimate interest,customers',
    'Cleo Park,cleo@client-fixture.example,Orbit Health,referral,existing customer,customers',
    'Dev Shah,dev@client-fixture.example,Kite Labs,inbound inquiry,consent,customers',
    'Eli Moss,eli@client-fixture.example,Fjord Bank,existing customer,existing customer,customers'].join('\n'), 'Fixture CEO');
  fxOutreach.suppress('dev@client-fixture.example', 'opt_out', 'Fixture CEO', 'Replied STOP');
  const jobId = fxOffice.newJobId();
  const c = fxOutreach.createCampaign({ requestId: 'fx-campaign', title: 'Autumn studio open day', brief: 'Invite existing customers to the autumn open day. Synthetic fixture.' }, 'Fixture CEO', { jobId });
  inbox!.approve(inbox!.state().items.find((i) => i.kind === 'job_plan' && i.jobId === c.jobId)!.id, 'Fixture CEO');
  fxOffice.reconcile();
  Object.assign(fxTasks.find((t) => t.jobKey === `consultancy:${jobId}:item-1`)!, { status: 'done', outcome: 'done', workerName: 'Wren', finishedAt: Date.now() - 120_000 });
  const file = resolve(inboxDir, 'docs/empire/campaigns', `${jobId}.md`);
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, '---\nsubject: You are invited, {{name}} — autumn open day\naudience: [customers]\nproposedLeads:\n  - Fay Lin | fay@client-fixture.example | Zed Works | trade show | met at stand 12\n---\n\nHi {{name}},\n\nWe are opening the studio on 24 October for customers like {{company}}: short demos, the new booking tools, and coffee.\n\nReply to this email to save a place.\n\nThe Northwind team\n');
  fxOffice.reconcile();
  fxOutreach.reconcile();
}

/** ORG-01: synthetic client jobs so each executive has something real-shaped to compute from (the real projection). */
function fixtureOrg(state: ReturnType<typeof initialEmpire>, workers: WorkerInfo[], tasks: QueueTask[]): OrgState {
  const zero = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, calls: 0 };
  const job = (id: string, extra: Partial<ConsultancyJob>): ConsultancyJob => ({ id, requestId: id, client: 'Fixture client', title: id, brief: 'Synthetic', decision: 'approved', status: 'queued', createdAt: 1, createdBy: 'Fixture', items: [], ...extra });
  const jobs = [
    job('fixture-plan', { decision: 'pending_approval', status: 'awaiting_approval' }),
    job('fixture-portal', { approvedBudgetUsd: 12, actualSpendUsd: 4.8 }),
    job('fixture-audit', { approvedBudgetUsd: 3, actualSpendUsd: 3.1, budgetHold: { reachedAt: 1, spentUsd: 3.1, approvedBudgetUsd: 3 }, items: [{ id: 'item-2', title: 'Second pass', prompt: 'Synthetic', jobKey: 'fixture', status: 'queued', phase: 'iteration', held: true }] }),
  ];
  return projectOrg({ now: Date.now(), supervision: state.supervision, workers, queue: { tasks, maxWorkers: 3 }, jobs, approvals: inbox?.state().items, outreach: fxOutreach?.summary(), research: research?.state(), usage: { total: { ...zero, cost: 7.9 }, today: { ...zero, cost: 1.2 }, day: '2026-10-08', budget: 10, pauseHiring: false } });
}

const port = Number(process.env.FIXTURE_PORT || 4613);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 4610) throw new Error('Use an isolated fixture port (not 4610).');
const root = resolve(import.meta.dirname, '../dist/public');
const scenarios = ['working', 'idle', 'needs_input', 'turn_ended', 'interrupted', 'unknown', 'missing', 'stale', 'disconnected', 'waiting'] as const;
// FIXTURE_SCENARIO picks the starting scenario (e.g. waiting for LIFE-04: one job, one worker working, one waiting on it).
let scenario: typeof scenarios[number] = (scenarios as readonly string[]).includes(process.env.FIXTURE_SCENARIO ?? '') ? process.env.FIXTURE_SCENARIO as typeof scenarios[number] : 'needs_input';
// Like the real server, only ever agree to empire.v1 so a bearer.<token> entry is never echoed back.
const sockets = new WebSocketServer({ noServer: true, handleProtocols: (offered) => (offered.has('empire.v1') ? 'empire.v1' : false) });
// Fixture-only device sign-in for the bundled apps: any password works (or only FIXTURE_PASSWORD when set, so the
// setup's wrong-password path can be shown), tokens live in memory, nothing is saved.
const APP_ORIGINS = new Set(['empire-app://game', 'https://appassets.androidplatform.net']); // iOS and Android bundled games, as on the real server
const fixturePassword = process.env.FIXTURE_PASSWORD || '';
const devices = new Map<string, { id: string; name: string; createdAt: number }>();
const socketToken = new Map<WebSocket, string>();
// FIXTURE_DEVICES=1 seeds two signed-in app devices (synthetic tokens nobody holds) for the Settings device list.
if (process.env.FIXTURE_DEVICES === '1') {
  devices.set(randomBytes(32).toString('base64url'), { id: 'fx-iphone', name: 'iPhone', createdAt: Date.now() - 6 * 86_400_000 });
  devices.set(randomBytes(32).toString('base64url'), { id: 'fx-android', name: 'Android device', createdAt: Date.now() - 2 * 86_400_000 });
}
const bearer = (req: import('node:http').IncomingMessage) => /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '')?.[1];
const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const send = (ws: WebSocket, msg: ServerMsg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
function snapshot() {
  const now = Date.now();
  const phase: SupervisionState['chief']['phase'] = ['missing', 'stale', 'disconnected', 'waiting'].includes(scenario) ? 'working' : scenario as SupervisionState['chief']['phase'];
  const status: WorkerInfo['status'] = phase === 'turn_ended' ? 'done' : phase === 'interrupted' || phase === 'unknown' ? 'offline' : phase as WorkerInfo['status'];
  const worker: WorkerInfo = { id: 'fixture-chief', kind: 'agent', deskId: 'desk-1', name: 'Alex · fixture', color: '#54bab6', status,
    processState: phase === 'interrupted' ? 'stopped' : phase === 'unknown' ? 'unknown' : 'running',
    acked: false, createdBy: 'Fixture', createdAt: now, cols: 90, rows: 25, viewers: [],
    task: { name: 'Review district operations', summary: 'Synthetic browser fixture — no AI provider is running' } };
  const task: QueueTask = { id: 'fixture-task', jobKey: 'fixture-chief-job', title: 'Prepare district brief', prompt: 'Synthetic fixture',
    addedBy: 'Fixture', addedAt: now, status: phase === 'turn_ended' || phase === 'interrupted' ? 'done' : 'running', attempt: 1,
    workerId: worker.id, ...(phase === 'interrupted' ? { interruption: { reason: 'server_restart' as const, at: now }, outcome: 'exited' as const } : {}),
    ...(phase === 'turn_ended' ? { outcome: 'done' as const } : {}) };
  const state = initialEmpire(now);
  state.setup = { completed: true, selected: ['hospital', 'cafe'], completedAt: now };
  state.office = { floors: 2, workstations: 20 };
  for (const sector of state.sectors) if (['hq', 'hospital', 'cafe'].includes(sector.id)) {
    sector.built = true; sector.staff = 1;
    sector.manager = { id: `fixture-${sector.id}`, name: MANAGER_NAMES[sector.id], status: sector.id === 'hq' ? phase === 'working' ? 'working' : phase === 'needs_input' ? 'needs_input' : phase === 'turn_ended' || phase === 'idle' ? 'ready' : 'offline' : 'pending',
      attempt: 1, jobKey: sector.id === 'hq' ? task.jobKey! : `fixture-${sector.id}`, ...(sector.id === 'hq' ? { taskId: task.id, workerId: worker.id } : {}) };
  }
  state.reports = [{ at: now, sector: 'Fixture', text: 'Synthetic district for interface testing. No provider jobs or real city data.' }];
  state.supervision = { schemaVersion: 1, serverRunId: 'fixture-run', observedAt: now, delegationRequested: true,
    monitor: { mode: 'rule_based', lastCheckAt: now }, chief: { phase, managerId: 'fixture-hq', taskId: task.id, workerId: worker.id,
      reason: phase === 'needs_input' ? 'Waiting for a permission decision in the terminal.' : phase === 'interrupted' ? 'The server restarted; this attempt was interrupted.' : phase === 'unknown' ? 'Prior process state cannot be established. Diagnose it before retrying.' : 'Synthetic observed state.' },
    workforce: { active: phase === 'working' ? 1 : 0, attention: phase === 'needs_input' ? 1 : 0, queued: 0 } };
  if (scenario === 'missing') delete state.supervision;
  const job = scenario === 'waiting' ? waitingJob(now) : { workers: [], tasks: [] };
  const tasks = [task, ...job.tasks];
  // The real server projection (src/server/waiting.ts) decides who is waiting on whom; nothing is hand-set here.
  const waits = projectWaitingOn(tasks, [worker, ...job.workers]);
  return { state, worker, task, tasks, jobWorkers: job.workers.map((w) => withWaitingOn(w, waits)) };
}
/**
 * LIFE-04 scenario: one client job with three ordered items. Cyrus finished item 1, Bea is working on item 2, and item 3
 * depends on both, so it stays queued and Cyrus waits on Bea at an amenity. A second job shows a held task whose
 * dependency stopped before finishing. Display-only: no process, no provider.
 */
const WAITING_DESKS = ['desk-2', 'desk-3'];
function waitingJob(now: number): { workers: WorkerInfo[]; tasks: QueueTask[] } {
  const base = { kind: 'agent' as const, acked: true, createdBy: 'Fixture', cols: 90, rows: 25, viewers: [] as string[] };
  const bea: WorkerInfo = { ...base, id: 'fixture-bea', deskId: WAITING_DESKS[0], name: 'Bea', color: '#f7aef8', status: 'working', processState: 'running', createdAt: now - 600_000,
    task: { name: 'Build checkout API', summary: 'Synthetic fixture — no agent runs' } };
  const cyrus: WorkerInfo = { ...base, id: 'fixture-cyrus', deskId: WAITING_DESKS[1], name: 'Cyrus', color: '#5bc0eb', status: 'done', processState: 'running', createdAt: now - 1_200_000,
    task: { name: 'Design checkout schema', summary: 'Finished — synthetic fixture' } };
  const item = (n: number, title: string, extra: Partial<QueueTask>): QueueTask => ({ id: `fixture-job-${n}`, jobKey: `consultancy:consultancy-fixture00000:item-${n}`, title, prompt: 'Synthetic fixture',
    addedBy: 'Fixture CEO', addedAt: now - 1_300_000, status: 'queued', attempt: 1, ...extra });
  const tasks: QueueTask[] = [
    item(1, 'Design checkout schema', { status: 'done', outcome: 'done', workerId: cyrus.id, workerName: 'Cyrus', deskId: cyrus.deskId, startedAt: now - 1_200_000, finishedAt: now - 300_000 }),
    item(2, 'Build checkout API', { status: 'running', workerId: bea.id, workerName: 'Bea', deskId: bea.deskId, startedAt: now - 600_000 }),
    item(3, 'Wire checkout into the storefront', { dependsOn: ['fixture-job-1', 'fixture-job-2'], blockedBy: ['fixture-job-2'] }),
    { id: 'fixture-held-1', title: 'Draft launch email copy', prompt: 'Synthetic fixture', addedBy: 'Fixture CEO', addedAt: now - 900_000, status: 'done', attempt: 1, outcome: 'exited', error: 'stopped before finishing', finishedAt: now - 500_000 },
    { id: 'fixture-held-2', title: 'Send launch emails', prompt: 'Synthetic fixture', addedBy: 'Fixture CEO', addedAt: now - 900_000, status: 'done', attempt: 1, outcome: 'failed', error: 'dependency fixture-held-1 did not finish', dependsOn: ['fixture-held-1'], finishedAt: now - 499_000 },
  ];
  return { workers: [bea, cyrus], tasks };
}
// Synthetic desk staff for attire checks: FIXTURE_WORKERS=n seats n extra idle workers in default attire, and a hire
// from the desk dialog seats one more with the chosen outfit. They are display-only: no process, no provider.
const extraWorkers = new Map<string, WorkerInfo>();
const FIXTURE_NAMES = ['Bea', 'Cyrus', 'Dana', 'Eli', 'Fatima', 'Gus', 'Hana', 'Ivo', 'Jun', 'Kai', 'Lena'];
function seatFixtureWorker(deskId: string, outfit?: unknown): WorkerInfo {
  const n = extraWorkers.size;
  const w: WorkerInfo = { id: `fixture-staff-${n + 1}`, kind: 'agent', deskId, name: `${FIXTURE_NAMES[n % FIXTURE_NAMES.length]} · fixture`, color: '#8ecae6', status: 'working',
    processState: 'running', acked: true, createdBy: 'Fixture', createdAt: Date.now(), cols: 90, rows: 25, viewers: [], outfit: sanitizeOutfit(outfit),
    task: { name: 'Synthetic desk', summary: 'Display-only fixture worker — nothing runs' } };
  extraWorkers.set(w.id, w);
  return w;
}
for (let i = 0, n = Math.min(18, Number(process.env.FIXTURE_WORKERS) || 0), desk = 2; i < n && desk <= 20; desk++)
  if (!WAITING_DESKS.includes(`desk-${desk}`) || process.env.FIXTURE_SCENARIO !== 'waiting') { seatFixtureWorker(`desk-${desk}`); i++; }
function publish(ws: WebSocket) {
  const {state, worker, tasks, jobWorkers} = snapshot();
  send(ws, { t: 'worker.update', worker });
  for (const w of extraWorkers.values()) send(ws, { t: 'worker.update', worker: w });
  for (const w of jobWorkers) send(ws, { t: 'worker.update', worker: w });
  // Leaving the waiting scenario sends its job workers home again.
  if (!jobWorkers.length) for (const id of ['fixture-bea', 'fixture-cyrus']) send(ws, { t: 'worker.remove', workerId: id });
  send(ws, { t: 'queue', state: { tasks, maxWorkers: jobWorkers.length ? 3 : 1 } });
  send(ws, { t: 'empire', state });
  send(ws, { t: 'org', state: fixtureOrg(state, [worker, ...jobWorkers], tasks) });
}
const controls = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Agent Empire QA controls</title>
<style>body{font:17px system-ui;background:#101923;color:#e7eef6;max-width:760px;margin:4rem auto;padding:1rem}button,a{font:inherit;margin:.4rem;padding:.6rem;color:inherit}button{background:#22374a;border:1px solid #8194a9;border-radius:8px}a{display:block}</style>
<h1>Isolated UI fixture</h1><p>Only synthetic protocol messages. No workers, providers, saved city, or live server access.</p>
<a href="/" target="_blank">Open simulation fixture</a><p>Choose a scenario, then inspect the simulation. Stale stops updates; disconnected closes and refuses sockets.</p>
${scenarios.map(s => `<button type="button" data-scenario="${s}">${s}</button>`).join('')}<p role="status" id="status"></p>
<script>for(const b of document.querySelectorAll('button'))b.onclick=async()=>{const r=await fetch('/__fixture/scenario/'+b.dataset.scenario,{method:'POST'});document.querySelector('#status').textContent=await r.text()};fetch('/__fixture/state').then(r=>r.text()).then(t=>document.querySelector('#status').textContent=t)</script></html>`;
const mime: Record<string,string> = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml', '.glb':'model/gltf-binary', '.hdr':'application/octet-stream', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.ogg':'audio/ogg', '.woff2':'font/woff2' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/__fixture') { res.setHeader('Content-Type', 'text/html'); return res.end(controls); }
  if (url.pathname === '/__fixture/state') return res.end(`Scenario: ${scenario}`);
  if (url.pathname === '/__fixture/revoke-devices' && req.method === 'POST') {
    if (req.headers.origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(req.headers.origin)) { res.writeHead(403); return res.end(); }
    const n = devices.size; devices.clear();
    for (const ws of socketToken.keys()) ws.close(4401, 'Device signed out');
    return res.end(`Revoked ${n} fixture device(s)`);
  }
  if (url.pathname.startsWith('/__fixture/scenario/') && req.method === 'POST') {
    if (req.headers.origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(req.headers.origin)) { res.writeHead(403); return res.end(); }
    const next = url.pathname.split('/').at(-1);
    if (!scenarios.includes(next as any)) { res.writeHead(400); return res.end('Unknown fixture scenario'); }
    scenario = next as typeof scenario;
    for (const ws of sockets.clients) scenario === 'disconnected' ? ws.close() : publish(ws);
    return res.end(`Scenario: ${scenario}`);
  }
  const appOrigin = req.headers.origin && APP_ORIGINS.has(req.headers.origin) ? req.headers.origin : undefined;
  if (appOrigin) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': appOrigin, 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type', vary: 'Origin' });
      return res.end();
    }
    if (bearer(req) || url.pathname === '/api/device/login' || url.pathname === '/api/health') { res.setHeader('access-control-allow-origin', appOrigin); res.setHeader('vary', 'Origin'); }
  }
  if (url.pathname === '/api/health') return json(res, 200, { ok: true });
  if (url.pathname === '/api/device/login' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    let body: { password?: unknown; deviceName?: unknown } = {}; try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Bad request' }); }
    if (typeof body.password !== 'string' || !body.password || (fixturePassword && body.password !== fixturePassword)) return json(res, 401, { error: 'Wrong password' });
    const token = randomBytes(32).toString('base64url'), id = randomBytes(6).toString('base64url');
    devices.set(token, { id, name: typeof body.deviceName === 'string' ? body.deviceName.slice(0, 64) : 'Device', createdAt: Date.now() });
    console.log(`fixture device signed in: ${id}`);
    return json(res, 200, { token, deviceId: id });
  }
  const auth = bearer(req);
  const device = auth ? devices.get(auth) : undefined;
  if (auth && !device && url.pathname.startsWith('/api/')) return json(res, 401, { error: 'Signed out' });
  if (url.pathname === '/api/whoami') return json(res, 200, device ? { ok: true, deviceId: device.id } : { ok: true });
  // A browser page (no bearer) stands for a cookie session, as on the real server: it sees every device, none current.
  const sameOrigin = !req.headers.origin || [`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(req.headers.origin);
  if (url.pathname === '/api/devices' && req.method === 'GET' && !auth)
    return json(res, 200, { devices: [...devices.values()].map((d) => ({ ...d, lastUsedAt: d.createdAt + 3_600_000, current: false })) });
  if (url.pathname === '/api/devices' && req.method === 'GET' && device)
    return json(res, 200, { devices: [...devices.values()].map((d) => ({ ...d, lastUsedAt: Date.now(), current: d === device })) });
  if (url.pathname.startsWith('/api/devices/') && req.method === 'DELETE' && (device || (!auth && sameOrigin))) {
    const id = decodeURIComponent(url.pathname.slice('/api/devices/'.length));
    const entry = [...devices].find(([, d]) => d.id === id);
    if (!entry) return json(res, 404, { error: 'Not found' });
    devices.delete(entry[0]);
    console.log(`fixture device revoked by DELETE: ${id}`);
    for (const [ws, token] of socketToken) if (token === entry[0]) ws.close(4401, 'Device signed out');
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/__fixture/jobs') return json(res, 200, fxOffice.snapshot());
  if (url.pathname === '/api/approvals' && req.method === 'GET') return json(res, 200, inbox!.state());
  if (url.pathname === '/api/research' && req.method === 'GET') return json(res, 200, research!.state());
  const reportRoute = /^\/api\/research\/reports\/([a-zA-Z0-9_-]{1,80})$/.exec(url.pathname);
  if (reportRoute && req.method === 'GET') { const r = research!.report(reportRoute[1]); return r ? json(res, 200, r) : json(res, 404, { error: 'Unknown research report.' }); }
  if (url.pathname === '/api/research' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    let body: { question?: unknown; requestId?: unknown } = {}; try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'Expected a JSON question.' }); }
    try {
      const asked = research!.ask(body.question, 'Fixture CEO', String(body.requestId ?? ''));
      inbox!.reconcile();
      for (const ws of sockets.clients) { send(ws, { t: 'approvals', state: inbox!.state() }); send(ws, { t: 'research', state: research!.state() }); publish(ws); }
      return json(res, 200, asked);
    } catch (error) { return json(res, error instanceof ResearchError ? error.status : 500, { error: (error as Error).message }); }
  }
  const decision = /^\/api\/approvals\/(A[1-9]\d{0,8})\/(approve|reject)$/.exec(url.pathname);
  if (decision && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    let body: { budgetUsd?: unknown } = {}; try { body = raw.trim() ? JSON.parse(raw) : {}; } catch { return json(res, 400, { error: 'Expected a JSON decision.' }); }
    try {
      const item = decision[2] === 'approve' ? inbox!.approve(decision[1], 'Fixture CEO', { budgetUsd: body.budgetUsd }) : inbox!.reject(decision[1], 'Fixture CEO');
      for (const ws of sockets.clients) publish(ws);
      return json(res, 200, item);
    } catch (error) { return json(res, error instanceof ApprovalError ? error.status : 500, { error: (error as Error).message }); }
  }
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  try {
    const file = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
    const data = await readFile(file); res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream'); res.end(data);
  } catch { res.writeHead(404); res.end('Fixture asset not found. Run npm run build:client first.'); }
});
server.on('upgrade', (req, socket, head) => {
  if (scenario === 'disconnected' || new URL(req.url || '/', `http://localhost:${port}`).pathname !== '/ws') { socket.destroy(); return; }
  // App sockets: empire.v1 plus exactly one bearer.<token>, from no origin, this fixture, or an app origin (iOS, Android).
  const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  const tokens = offered.filter((v) => v.startsWith('bearer.'));
  let token: string | undefined;
  if (tokens.length || APP_ORIGINS.has(req.headers.origin ?? '')) {
    token = tokens.length === 1 ? tokens[0].slice('bearer.'.length) : undefined;
    const origin = req.headers.origin;
    const originOk = !origin || APP_ORIGINS.has(origin) || [`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(origin);
    if (!originOk || !offered.includes('empire.v1') || !token || !devices.has(token)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  }
  sockets.handleUpgrade(req, socket, head, ws => { if (token) socketToken.set(ws, token); ws.on('close', () => socketToken.delete(ws)); sockets.emit('connection', ws); });
});
sockets.on('connection', ws => {
  const {state, worker, tasks, jobWorkers} = snapshot();
  const empty = { items: [], fetchedAt: Date.now(), loading: false };
  const zero = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, calls: 0 };
  send(ws, { t: 'welcome', you: 'fixture-ceo', peers: [], workers: [worker, ...jobWorkers], project: { name: 'UI fixture · synthetic data', dir: '[isolated fixture]', agentCmd: 'disabled' },
    issues: empty, pulls: empty, ice: [], chat: [], invites: false, version: 'fixture', upgrade: { available: false, phase: 'idle' },
    services: { items: [], port }, decor: [], usage: { total: zero, today: zero, day: '2026-09-27', pauseHiring: false }, queue: { tasks, maxWorkers: jobWorkers.length ? 3 : 1 }, org: fixtureOrg(state, [worker, ...jobWorkers], tasks), approvals: inbox!.state(), research: research!.state() });
  publish(ws);
  ws.on('message', raw => {
    let msg: any; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'worker.attach') send(ws, { t: 'term.snapshot', workerId: 'fixture-chief', cols: 90, rows: 25, data: 'SYNTHETIC TERMINAL — no commands execute.\r\nType to test keyboard routing: ' });
    else if (msg.t === 'term.input' && typeof msg.data === 'string') send(ws, { t: 'term.data', workerId: 'fixture-chief', data: msg.data.replace(/\r/g, '\r\n') });
    else if (msg.t === 'ping') send(ws, { t: 'pong', at: msg.at });
    else if (msg.t === 'worker.spawn' && typeof msg.deskId === 'string' && /^desk-([2-9]|1[0-9]|20)$/.test(msg.deskId) && msg.kind !== 'shell' && ![...extraWorkers.values()].some((w) => w.deskId === msg.deskId) && !(scenario === 'waiting' && WAITING_DESKS.includes(msg.deskId))) {
      const w = seatFixtureWorker(msg.deskId, msg.outfit);
      for (const client of sockets.clients) send(client, { t: 'worker.update', worker: w });
      send(ws, { t: 'toast', level: 'info', text: `Fixture only: ${w.name} sat down for display; no agent runs.` });
    }
    else if (!['move', 'act', 'profile', 'term.resize', 'worker.detach'].includes(msg.t)) send(ws, { t: 'toast', level: 'info', text: 'Fixture only: this action does not change real data.' });
  });
});
const timer = setInterval(() => { if (!['stale', 'disconnected'].includes(scenario)) for (const ws of sockets.clients) publish(ws); }, 3000);
server.listen(port, '127.0.0.1', () => console.log(`UI fixture: http://localhost:${port}/ — controls: http://localhost:${port}/__fixture`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { clearInterval(timer); for (const ws of sockets.clients) ws.terminate(); sockets.close(); server.close(); });
