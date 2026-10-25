/** Local-only synthetic wire server for manual browser QA. Never starts a worker or reads a save. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { initialEmpire, MANAGER_NAMES, type EmpireAction, type SupervisionState } from '../src/shared/empire.js';
import { newCity, normalizeCity } from '../src/shared/city.js';
import { applyCityAction, type CityActionText } from '../src/shared/economy-rules.js';
import type { ServerMsg, WorkerInfo, QueueTask } from '../src/shared/protocol.js';
import { sanitizeOutfit } from '../src/shared/outfit.js';
import { HOSTED_FREE, KEY_NAMES, MODEL_CATALOGUE, OLLAMA_INSTALL_URL, engineOptions, pickEngine, recommendModels, sanitizeEngine, type EnginesState, type PullState, type WorkerEngine } from '../src/shared/engines.js';
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
import { VoiceError, VoiceRuntime } from '../src/server/voice.js';
import { routeChief, ruleBasedBriefing } from '../src/server/chief-briefing.js';
import { ConsultancyError } from '../src/server/consultancy.js';
import { MAX_AUDIO_BYTES } from '../src/shared/voice.js';
import { ChiefBrain, ChiefError, chiefActions } from '../src/server/chief.js';
import { LessonMemory } from '../src/server/memory.js';
import { fixtureChat } from './chief-fixture.js';
import { onboardingFixture } from './onboarding-fixture.js';
import { ArchitectError, ArchitectService } from '../src/server/architect.js';
import { WORLD_CAPS, applyChanges, emptyWorld } from '../src/shared/world.js';
import { generateGrowth } from '../src/shared/world-generator.js';

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
  const brain = chief?.status();
  return projectOrg({ now: Date.now(), ...(brain?.ready && brain.model ? { chiefBrain: { model: brain.model } } : {}), supervision: state.supervision, workers, queue: { tasks, maxWorkers: 3 }, jobs, approvals: inbox?.state().items, outreach: fxOutreach?.summary(), research: research?.state(), usage: { total: { ...zero, cost: 7.9 }, today: { ...zero, cost: 1.2 }, day: '2026-10-08', budget: 10, pauseHiring: false } });
}

const port = Number(process.env.FIXTURE_PORT || 4613);
// FREE-08: FIXTURE_ONBOARDING=new (offered after founding) | legacy (an old install: never offered) serves onboarding over
// the real OnboardingService with fake Telegram/ntfy/SMTP servers on loopback (tools/onboarding-fixture.ts).
const FX_ONBOARDING = process.env.FIXTURE_ONBOARDING === 'new' || process.env.FIXTURE_ONBOARDING === 'legacy' ? await onboardingFixture(process.env.FIXTURE_ONBOARDING, () => true) : undefined;
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
/**
 * FREE-02 (FIXTURE_CHIEF=1): a real ChiefBrain over the fixture journal with a fake model (tools/chief-fixture.ts; no
 * network). The free brain proposes a plan (pending approval), reviews one finished item, and raises one chief proposal
 * for an item that failed twice. Nothing runs: the fake queue never seats anything.
 */
let chief: ChiefBrain | undefined;
if (process.env.FIXTURE_CHIEF === '1') {
  const fxQueue = { state: () => ({ tasks: fxTasks.map((t) => ({ ...t })), maxWorkers: 0 }), retry: () => 'Fixture only: nothing is retried.' };
  // FREE-10: organizational memory over the same throwaway directory. One approved CEO lesson the plans can cite; the
  // review below proposes another, which waits in the inbox.
  const memory = new LessonMemory(inboxDir);
  memory.setInbox({ raise: (f) => inbox!.raiseLesson(f), resolve: (id, note) => inbox!.resolveLesson(id, note), get: (id) => inbox!.get(id) });
  inbox!.setLessons(memory.actions());
  if (!memory.state().lessons.length) {
    const seed = memory.addNote({ text: 'Booking work always includes a double-booking test for one slot.', scope: 'company' }, 'Fixture CEO');
    const item = inbox!.state().items.find((i) => i.kind === 'lesson' && i.lesson?.lessonId === seed.id);
    if (item) inbox!.approve(item.id, 'Fixture CEO');
  }
  const brain = new ChiefBrain(inboxDir, { keys: () => ({}), chat: fixtureChat, office: fxOffice, queue: fxQueue.state, raise: (f) => inbox!.raiseChief(f), memory,
    onChange: () => { for (const ws of sockets.clients) { send(ws, { t: 'chief', state: brain.state() }); send(ws, { t: 'approvals', state: inbox!.state() }); } } });
  chief = brain;
  inbox!.setChief(chiefActions(fxQueue), (jobId) => (brain.planFor(jobId) ? brain.label() : undefined));
  brain.updateSettings({ mode: 'free', freeModel: 'gpt-oss:20b' });
  brain.requestPlan({ requestId: 'fx-chief-reviewed', client: 'Harbour Dental', title: 'Online booking', brief: 'Synthetic fixture brief: patients book and cancel appointments online.' }, 'Fixture CEO', 'founder_desk');
  await brain.idle();
  const reviewed = brain.state().plans[0].jobId!;
  fxOffice.approve(reviewed, 'Fixture CEO', { budgetUsd: 12 });
  const t1 = fxTasks.find((t) => t.jobKey === `consultancy:${reviewed}:item-1`)!;
  Object.assign(t1, { status: 'done', outcome: 'done', finishedAt: Date.now(), workerName: 'Bea', branch: 'office/bea-fx' });
  fxOffice.reconcile();
  fxTasks.push({ id: 'fx-q-form', jobKey: `consultancy:${reviewed}:item-x`, title: 'Build the booking form', prompt: 'Synthetic', addedBy: 'Fixture', addedAt: Date.now(), status: 'done', outcome: 'failed', attempt: 2, error: 'worker exited: missing BOOKING_API_URL', finishedAt: Date.now(), workerName: 'Cyrus' });
  brain.reconcile();
  await brain.idle();
  brain.requestPlan({ requestId: 'fx-chief-plan', client: 'Northstar Studio', title: 'Customer booking portal', brief: 'Synthetic fixture brief: clients book studio sessions online with accessible forms.' }, 'Fixture CEO', 'founder_desk');
  brain.requestPlan({ requestId: 'fx-chief-bad', client: 'Atlas Commerce', title: 'Storefront review', brief: 'MALFORMED synthetic brief.' }, 'Fixture CEO', 'telegram');
  await brain.idle();
  inbox!.reconcile();
}
/** FREE-09: garage/plot actions go through the shared rules against the fixture's synthetic treasury. */
let fixtureCity = newCity(), fixtureSpent = 0;
function fixtureCityAction(action: EmpireAction): string | undefined {
  const { state } = snapshot();
  const before = state.funds;
  const error = applyCityAction(state, action, Date.now(), new Proxy({}, { get: () => () => '' }) as CityActionText, () => {});
  if (!error) { fixtureCity = normalizeCity(state.city); fixtureSpent += before - state.funds; }
  return error;
}
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
  // FREE-09: plots and garage vehicles bought in this fixture session (memory only, never a save).
  state.city = structuredClone(fixtureCity);
  state.funds -= fixtureSpent;
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
function seatFixtureWorker(deskId: string, outfit?: unknown, engine?: WorkerEngine): WorkerInfo {
  const n = extraWorkers.size;
  const w: WorkerInfo = { id: `fixture-staff-${n + 1}`, kind: 'agent', deskId, name: `${FIXTURE_NAMES[n % FIXTURE_NAMES.length]} · fixture`, color: '#8ecae6', status: 'working',
    processState: 'running', acked: true, createdBy: 'Fixture', createdAt: Date.now(), cols: 90, rows: 25, viewers: [], outfit: sanitizeOutfit(outfit),
    task: { name: 'Synthetic desk', summary: 'Display-only fixture worker — nothing runs' },
    ...(engine ? { engine, ...(engine.id === 'codex' ? { statusKnown: false } : {}) } : {}) };
  extraWorkers.set(w.id, w);
  return w;
}
// FREE-01: FIXTURE_ENGINES=free|premium|none seats engine-labelled staff and serves a synthetic /api/engines.
const FX_ENGINES = process.env.FIXTURE_ENGINES as 'free' | 'premium' | 'none' | undefined;
const FX_STAFF_ENGINES: (WorkerEngine | undefined)[] = FX_ENGINES ? [{ id: 'qwen-code', auth: 'local', model: 'gpt-oss:20b' }, { id: 'codex', auth: 'local', model: 'gpt-oss:20b' }, { id: 'claude-code', auth: 'subscription' }] : [];
for (let i = 0, n = Math.min(18, Number(process.env.FIXTURE_WORKERS) || 0), desk = 2; i < n && desk <= 20; desk++)
  if (!WAITING_DESKS.includes(`desk-${desk}`) || process.env.FIXTURE_SCENARIO !== 'waiting') { seatFixtureWorker(`desk-${desk}`, undefined, FX_STAFF_ENGINES[i]); i++; }
let fxDefault: 'auto' | WorkerEngine = 'auto';
let fxPull: PullState | undefined;
let fxPullTimer: NodeJS.Timeout | undefined;
function fxEngines(): EnginesState {
  const premium = FX_ENGINES === 'premium';
  const none = FX_ENGINES === 'none';
  const ram = recommendModels((none ? 16 : 32) * 2 ** 30);
  const base = {
    claude: none ? { installed: false, loggedIn: null, detail: 'Claude Code is not installed on this computer.' } : premium ? { installed: true, loggedIn: true, method: 'claude.ai', plan: 'max', expiresAt: new Date(Date.now() + 3 * 864e5).toISOString(), expiringSoon: true, detail: `Signed in via claude.ai (max). Expires ${new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10)}: sign in again soon.` } : { installed: true, loggedIn: false, detail: 'Not signed in on this computer.' },
    codex: { installed: !none, loggedIn: none ? null : false, detail: none ? 'Optional: Codex CLI is not installed.' : 'Not signed in. Run `codex login` yourself in a terminal.' },
    qwen: { installed: !none, detail: none ? 'Not installed. Free: npm install -g @qwen-code/qwen-code' : 'Qwen Code is installed.' },
    ollama: none ? { running: false, models: [], url: 'http://127.0.0.1:11434', installUrl: OLLAMA_INSTALL_URL, detail: 'Ollama is not running on http://127.0.0.1:11434. Install it from https://ollama.com/download (not bundled), then start it.' }
      : { running: true, version: '0.40.10', models: [{ name: 'gpt-oss:20b', sizeBytes: 14e9 }], url: 'http://127.0.0.1:11434', installUrl: OLLAMA_INSTALL_URL, detail: 'Running (v0.40.10) with 1 model.', pull: fxPull },
    ram: { totalGb: ram.ramGb, note: ram.note, models: ram.models },
    keys: KEY_NAMES.map((name) => ({ name, present: premium && name === 'ANTHROPIC_API_KEY' })),
  } satisfies Partial<EnginesState>;
  const options = engineOptions(base);
  const picked = pickEngine(options, fxDefault);
  return { ...base, hosted: HOSTED_FREE, defaultEngine: fxDefault, options, recommended: picked.engine, help: picked.help, checkedAt: Date.now() };
}
/**
 * FREE-05 (FIXTURE_VOICE=1): the real VoiceRuntime and chief routing over a throwaway directory, with fake speech
 * engines (fixed transcript, a synthetic tone for speech) and a fake release server that streams zeros slowly and
 * never completes. Moonshine Tiny and Kokoro int8 are marked installed (marker files only; no model exists).
 */
const FX_VOICE = process.env.FIXTURE_VOICE === '1';
const fxVoiceDir = mkdtempSync(resolve(tmpdir(), 'empire-fixture-voice-'));
for (const id of ['moonshine-tiny-en', 'kokoro-en-int8']) { mkdirSync(resolve(fxVoiceDir, 'voice', 'models', id), { recursive: true }); writeFileSync(resolve(fxVoiceDir, 'voice', 'models', id, 'installed.json'), '{"fixture":true}'); }
const fxVoice = new VoiceRuntime({
  dataDir: fxVoiceDir,
  engines: {
    detect: async () => ({ available: true, detail: 'Fixture: fake speech engines (no sherpa-onnx, no models).' }),
    stt: async () => ({ transcribe: async () => process.env.FIXTURE_VOICE_HEARD || 'How much did we spend today?' }),
    tts: async () => ({ synthesize: async () => { const s = new Float32Array(4800); for (let i = 0; i < s.length; i++) s[i] = Math.sin(i / 6) * 0.05; return { samples: s, sampleRate: 24000 }; } }),
  },
  fetch: (async (_u: string, init?: RequestInit) => new Response(new ReadableStream({
    async pull(c) { await new Promise((r) => setTimeout(r, 120)); if (init?.signal?.aborted) return c.close(); c.enqueue(new Uint8Array(4_000_000)); },
  }))) as unknown as typeof fetch,
  extract: async () => { throw new Error('Fixture never unpacks'); },
});
async function fxVoiceRoute(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, p: string) {
  try {
    if (p === '/api/voice' && req.method === 'GET') return json(res, 200, await fxVoice.state());
    if (req.method !== 'POST') return json(res, 404, { error: 'Unknown voice endpoint.' });
    const chunks: Buffer[] = []; let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > MAX_AUDIO_BYTES) return json(res, 413, { error: 'Recordings are limited to 30 seconds.' }); chunks.push(c as Buffer); }
    const raw = Buffer.concat(chunks);
    if (p === '/api/voice/transcribe') return json(res, 200, await fxVoice.transcribe(raw));
    const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    const callChief = (text: unknown, rid: string) => routeChief(text, {
      briefing: (q) => { const { state, worker, tasks, jobWorkers } = snapshot(); return ruleBasedBriefing({ now: Date.now(), org: fixtureOrg(state, [worker, ...jobWorkers], tasks), approvals: inbox!.state().items, capacity: 'Fixture: 4 funded workstations · synthetic workers only' }, q); },
      createJob: (title, brief, requestId) => { const job = fxOffice.create({ requestId, client: 'Your company', title, brief }, 'Fixture CEO by phone'); inbox!.reconcile(); for (const ws of sockets.clients) send(ws, { t: 'approvals', state: inbox!.state() }); return { jobId: job.id, approvalId: inbox!.state().items.find((i) => i.jobId === job.id)?.id }; },
    }, rid);
    if (p === '/api/phone/chief') return json(res, 200, await callChief(body.text, `phone-${String(body.requestId ?? Date.now()).slice(0, 60)}`));
    const tr = /^\/api\/voice\/transcripts\/(T[\w-]{6,40})\/(send|cancel)$/.exec(p);
    if (tr) { if (tr[2] === 'cancel') return json(res, 200, fxVoice.cancelTranscript(tr[1])); const t = fxVoice.takeTranscript(tr[1]); return json(res, 200, { ...(await callChief(t.text, `voice-${t.id}`)), transcript: t }); }
    if (p === '/api/voice/speak') { const wav = await fxVoice.speak(body.text); res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(wav); }
    if (p === '/api/voice/download') { const r = fxVoice.startDownload(body.model, body.confirm, body.confirmUnverified); return r.error ? json(res, 400, { error: r.error }) : json(res, 202, await fxVoice.state()); }
    if (p === '/api/voice/cancel') { fxVoice.cancelDownload(); return json(res, 200, await fxVoice.state()); }
    if (p === '/api/voice/select') { fxVoice.select(body.kind, body.id); return json(res, 200, await fxVoice.state()); }
    if (p === '/api/voice/settings') { fxVoice.setKeepRecordings(body.keepRecordings); return json(res, 200, await fxVoice.state()); }
    if (p === '/api/voice/recordings/delete') { fxVoice.deleteRecordings(); return json(res, 200, await fxVoice.state()); }
    return json(res, 404, { error: 'Unknown voice endpoint.' });
  } catch (e) { return json(res, e instanceof VoiceError || e instanceof ConsultancyError ? e.status : 500, { error: (e as Error).message }); }
}
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
/**
 * CITY-10 (FIXTURE_ARCHITECT=1): a real ArchitectService over the throwaway directory, as an own-server host. It starts
 * off; rule-based growth runs on "Run now" (no model, no network). FIXTURE_ARCHITECT=max seeds a world with as many
 * additions as the rules allow (for the perf method), then turns the architect on. FIXTURE_ARCHITECT_FAKE=premium uses a
 * fake premium model instead (US$0.0042 reported per call; nothing is billed).
 */
let architect: ArchitectService | undefined;
const architectMode = process.env.FIXTURE_ARCHITECT;
if (architectMode === '1' || architectMode === 'max') {
  if (architectMode === 'max') {
    let doc = emptyWorld();
    for (let i = 0; i < 400 && doc.additions.length < WORLD_CAPS.total; i++) {
      const r = applyChanges(doc, generateGrowth(doc, { seed: `fixture-max-${i}`, maxChanges: 5, avoid: [], density: { business: 0.2, harbour: 0.2 } }), { day: '2026-10-24', runId: `R${i + 1}`, engine: 'rules', at: Date.now(), maxChanges: 5 });
      if ('ok' in r) doc = r.ok.doc;
    }
    mkdirSync(resolve(inboxDir, 'world'), { recursive: true });
    writeFileSync(resolve(inboxDir, 'world', 'additions.json'), JSON.stringify(doc));
    console.log(`architect fixture: seeded ${doc.additions.length} additions (cap ${WORLD_CAPS.total})`);
  }
  const fakePremium = process.env.FIXTURE_ARCHITECT_FAKE === 'premium';
  const service: ArchitectService = new ArchitectService(inboxDir, {
    host: 'server', keys: () => (fakePremium ? { ANTHROPIC_API_KEY: 'fixture-not-a-key' } : {}),
    chiefSettings: () => ({ mode: 'off', freeModel: 'gpt-oss:20b', premiumProvider: 'anthropic', premiumModel: fakePremium ? 'fixture-model' : '', dailyCapUsd: 2, ...(fakePremium ? { premiumPrice: [3, 15] as [number, number] } : {}) }),
    chat: async (p) => ({ text: '{"changes": []}', model: p.model, usage: { input: 1200, output: 200 }, cost: { usd: 0.0042, kind: 'paid-estimate', label: '≈ US$0.0042 (estimate)' } }),
    probe: async () => ({ running: false, models: [] }),
    inbox: { raise: (f) => inbox!.raiseArchitect(f), resolve: (id, note) => inbox!.resolveArchitect(id, note) },
    onChange: () => { for (const ws of sockets.clients) { send(ws, { t: 'architect', state: service.state() }); send(ws, { t: 'approvals', state: inbox!.state() }); } },
  });
  architect = service;
  inbox!.setArchitect({ revert: (runId, actor) => service.revertRun(runId, actor) });
  if (architectMode === 'max') service.updateSettings({ enabled: true });
}
async function architectRoute(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, path: string) {
  const a = architect!;
  try {
    if (path === '/api/architect' && req.method === 'GET') return json(res, 200, a.state());
    if (path === '/api/architect/journal.md' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' }); return res.end(a.journalMarkdown()); }
    if (req.method !== 'POST') return json(res, 404, { error: 'Unknown architect endpoint.' });
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}') as Record<string, unknown>;
    let out: unknown;
    if (path === '/api/architect/settings') out = a.updateSettings(body);
    else if (path === '/api/architect/run') out = await a.runNow('Fixture CEO');
    else if (path === '/api/architect/undo') out = a.undo(body.changeId, 'Fixture CEO');
    else if (path === '/api/architect/revert') out = { note: a.revertRun(body.runId, 'Fixture CEO'), state: a.state() };
    else if (path === '/api/architect/avoid') out = a.addAvoid(body);
    else if (path === '/api/architect/avoid/remove') out = a.removeAvoid(body.id);
    else return json(res, 404, { error: 'Unknown architect endpoint.' });
    for (const ws of sockets.clients) { send(ws, { t: 'architect', state: a.state() }); send(ws, { t: 'approvals', state: inbox!.state() }); }
    return json(res, path === '/api/architect/run' ? 202 : 200, out);
  } catch (error) {
    return json(res, error instanceof ArchitectError ? error.status : 400, { error: (error as Error).message });
  }
}

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
  // As on the real server (`trusted()`), a signed-in device's bearer request is trusted: a browser never sends one on its own.
  if (FX_ONBOARDING && await FX_ONBOARDING.route(req, res, url.pathname, sameOrigin || !!device)) return;
  if (url.pathname === '/__fixture/jobs') return json(res, 200, fxOffice.snapshot());
  if (FX_VOICE && (url.pathname === '/api/voice' || url.pathname.startsWith('/api/voice/') || url.pathname === '/api/phone/chief')) return fxVoiceRoute(req, res, url.pathname);
  if (FX_ENGINES && url.pathname === '/api/engines' && req.method === 'GET') return json(res, 200, fxEngines());
  if (FX_ENGINES && url.pathname.startsWith('/api/engines/') && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    let body: Record<string, unknown> = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { return json(res, 400, { error: 'Expected JSON.' }); }
    if (url.pathname === '/api/engines/default') { const e = body.engine === 'auto' ? 'auto' : sanitizeEngine(body.engine); if (!e) return json(res, 400, { error: 'Unknown engine.' }); fxDefault = e; return json(res, 200, fxEngines()); }
    if (url.pathname === '/api/engines/ollama/pull') {
      // Synthetic progress only: the fixture never contacts Ollama or downloads anything.
      if (body.confirm !== true) return json(res, 400, { error: 'A model download needs explicit confirmation of its name, size and licence.' });
      const m = MODEL_CATALOGUE.find((x) => x.tag === body.model); if (!m) return json(res, 400, { error: 'Only the listed models can be downloaded from here.' });
      fxPull = { model: m.tag, status: 'downloading (synthetic)', completed: 0, total: m.sizeGb * 1e9, done: false };
      clearInterval(fxPullTimer);
      fxPullTimer = setInterval(() => { if (!fxPull || fxPull.done) return clearInterval(fxPullTimer); fxPull.completed = Math.min(fxPull.total * 0.42, fxPull.completed + fxPull.total * 0.07); }, 400);
      return json(res, 202, { pull: fxPull });
    }
    if (url.pathname === '/api/engines/ollama/cancel') { if (fxPull && !fxPull.done) Object.assign(fxPull, { done: true, cancelled: true, status: 'cancelled' }); clearInterval(fxPullTimer); return json(res, 200, { cancelled: true, pull: fxPull }); }
    return json(res, 404, { error: 'Unknown engines endpoint.' });
  }
  if (chief && url.pathname === '/api/chief' && req.method === 'GET') return json(res, 200, chief.state());
  if (chief && url.pathname === '/api/chief/settings' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    try { return json(res, 200, chief.updateSettings(JSON.parse(raw || '{}'))); } catch (error) { return json(res, error instanceof ChiefError ? error.status : 400, { error: (error as Error).message }); }
  }
  if (architect && (url.pathname === '/api/architect' || url.pathname.startsWith('/api/architect/'))) return architectRoute(req, res, url.pathname);
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
    services: { items: [], port }, decor: [], usage: { total: zero, today: zero, day: '2026-09-27', pauseHiring: false }, queue: { tasks, maxWorkers: jobWorkers.length ? 3 : 1 }, org: fixtureOrg(state, [worker, ...jobWorkers], tasks), approvals: inbox!.state(), research: research!.state(), ...(chief ? { chief: chief.state() } : {}), ...(architect ? { architect: architect.state() } : {}) });
  publish(ws);
  ws.on('message', raw => {
    let msg: any; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'worker.attach') send(ws, { t: 'term.snapshot', workerId: 'fixture-chief', cols: 90, rows: 25, data: 'SYNTHETIC TERMINAL — no commands execute.\r\nType to test keyboard routing: ' });
    else if (msg.t === 'term.input' && typeof msg.data === 'string') send(ws, { t: 'term.data', workerId: 'fixture-chief', data: msg.data.replace(/\r/g, '\r\n') });
    else if (msg.t === 'ping') send(ws, { t: 'pong', at: msg.at });
    else if (msg.t === 'empire.action' && ['buy-plot', 'buy-vehicle', 'vehicle-spawn', 'vehicle-store', 'buy-helicopter'].includes(msg.action?.kind)) {
      const error = fixtureCityAction(msg.action);
      if (error) send(ws, { t: 'toast', text: error, level: 'error' });
      else for (const client of sockets.clients) publish(client);
    }
    else if (msg.t === 'worker.spawn' && typeof msg.deskId === 'string' && /^desk-([2-9]|1[0-9]|20)$/.test(msg.deskId) && msg.kind !== 'shell' && ![...extraWorkers.values()].some((w) => w.deskId === msg.deskId) && !(scenario === 'waiting' && WAITING_DESKS.includes(msg.deskId))) {
      const w = seatFixtureWorker(msg.deskId, msg.outfit, msg.login ? { id: 'claude-code', auth: 'subscription' } : sanitizeEngine(msg.engine));
      for (const client of sockets.clients) send(client, { t: 'worker.update', worker: w });
      send(ws, { t: 'toast', level: 'info', text: `Fixture only: ${w.name} sat down for display; no agent runs.` });
    }
    else if (!['move', 'act', 'profile', 'term.resize', 'worker.detach'].includes(msg.t)) send(ws, { t: 'toast', level: 'info', text: 'Fixture only: this action does not change real data.' });
  });
});
const timer = setInterval(() => { if (!['stale', 'disconnected'].includes(scenario)) for (const ws of sockets.clients) publish(ws); }, 3000);
server.listen(port, '127.0.0.1', () => console.log(`UI fixture: http://localhost:${port}/ — controls: http://localhost:${port}/__fixture`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { clearInterval(timer); FX_ONBOARDING?.close(); for (const ws of sockets.clients) ws.terminate(); sockets.close(); server.close(); });
