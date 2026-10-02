/**
 * CLOUD-04 / CLOUD-05: the app's cloud adapter against a fake api.github.com, with the real coordinator tick in the
 * loop (FakeProvider; no network, no paid calls).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, GitHubStateStore } from '../src/cloud/store';
import { installStateRepository } from '../src/cloud/installer';
import { parseIntent } from '../src/cloud/intents';
import { runCoordinatorTick } from '../src/cloud/tick';
import { TASK_ID } from '../src/server/execution-validation';
import { CloudRepo, RepoError } from '../src/client/cloud/repo';
import { uuidv7, uuidv7Time } from '../src/client/cloud/uuid';
import { cloudManagerView, cloudStatus, jobCounts, shortAge, toQueue, toUsage } from '../src/client/cloud/map';
import { CloudNet } from '../src/client/cloud/net';
import { forgetSavedSnapshots, loadSavedSnapshot, saveSnapshot } from '../src/client/cloud/session';
import { store } from '../src/client/state';
import { connectionView } from '../src/client/ui/continuity';
import { EXECUTION, FakeProvider, T0 } from './cloud-fixtures';
import { FakeGitHub } from './fake-github';

const FULL = 'founder/agent-empire-state';
const REPO = { owner: 'founder', name: 'agent-empire-state' };
const encrypt = async (key: string, value: string) => `sealed(${key}):${Buffer.from(value).toString('base64').split('').reverse().join('')}`;

async function empire(opts: { execution?: boolean } = {}) {
  const gh = new FakeGitHub();
  await installStateRepository(new GitHubClient('ghu_user', { fetch: gh.fetch }), {
    secrets: { ANTHROPIC_API_KEY: 'sk-ant-fixture' }, limits: { maxConcurrent: 1, perTaskBudgetCents: 100, dailyBudgetCents: 500 },
    ...(opts.execution === false ? {} : { execution: EXECUTION }), coordinatorBundle: '// bundle\n', now: T0, sleep: async () => {},
  }, encrypt);
  const coordinator = new GitHubStateStore(new GitHubClient('ghs_actions', { fetch: gh.fetch }), { owner: 'founder', repo: 'agent-empire-state', branch: 'main', workflowFile: 'agent-empire.yml' });
  const provider = new FakeProvider();
  let run = 0;
  const tick = (now: number) => runCoordinatorTick({ store: coordinator, provider, now: () => now, runId: `run-${++run}`, allowSelfDisable: false, retry: { sleep: async () => {} } });
  return { gh, provider, tick, repo: new CloudRepo(REPO, 'ghu_user', gh.fetch) };
}
const memoryStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, m };
};

test('uuidv7: time-ordered ids that the coordinator accepts as intent and job ids', () => {
  const a = uuidv7(T0), b = uuidv7(T0 + 1);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(TASK_ID.test(a));
  assert.equal(uuidv7Time(a), T0);
  assert.ok(a < b, 'path order follows time order');
  const fixed = uuidv7(T0, (bytes) => bytes.fill(0xff));
  assert.equal(fixed.slice(14, 15), '7');
  assert.ok(['8', '9', 'a', 'b'].includes(fixed[19]));
  assert.throws(() => uuidv7(-1));
});

test('cloud adapter: reads the snapshot, then polls with ETag (304) and downloads only changed state files', async () => {
  const { gh, repo, tick } = await empire();
  const first = await repo.poll(() => T0 + 1000);
  assert.equal(first.changed, true);
  if (!first.changed) return;
  assert.equal(first.snapshot.state.meta.lifecycle.status, 'running');
  assert.deepEqual(first.snapshot.pending, []);
  const before = gh.requests.length;
  const again = await repo.poll(() => T0 + 2000);
  assert.deepEqual(again, { changed: false, checkedAt: T0 + 2000 });
  const conditional = gh.requests.slice(before);
  assert.equal(conditional.length, 1, 'an unchanged head is one conditional request');
  assert.ok(conditional[0].ifNoneMatch && conditional[0].status === 304);
  // The coordinator commits (heartbeat): only the changed files are fetched again.
  await tick(T0 + 60_000);
  const blobsBefore = gh.blobReads.length;
  const moved = await repo.poll(() => T0 + 61_000);
  assert.equal(moved.changed, true);
  const fetched = gh.blobReads.length - blobsBefore;
  assert.ok(fetched >= 1 && fetched < 8, `only changed blobs are downloaded (${fetched} of 8)`);
  for (const r of gh.requests) assert.ok(['Bearer ghu_user', 'Bearer ghs_actions'].includes(r.auth!), 'only the user token (app) and the Actions token (coordinator)');
});

test('cloud adapter: errors are classified; a public repository, a missing Empire and a newer schema are refused honestly', async () => {
  const gh = new FakeGitHub();
  gh.create(FULL, false);
  await assert.rejects(new CloudRepo(REPO, 't', gh.fetch).poll(), (e: unknown) => e instanceof RepoError && e.code === 'invalid_state' && /not private/.test(e.message));
  const empty = new FakeGitHub();
  empty.create(FULL, true);
  await assert.rejects(new CloudRepo(REPO, 't', empty.fetch).poll(), (e: unknown) => e instanceof RepoError && e.code === 'invalid_state' && /no Empire yet/.test(e.message));
  const { gh: newer, repo } = await empire();
  newer.commitOnBranch(FULL, { 'state/meta.json': newer.files(FULL)['state/meta.json'].replace('"schemaVersion": 1', '"schemaVersion": 2') });
  await assert.rejects(repo.poll(), (e: unknown) => e instanceof RepoError && /newer coordinator/.test(e.message));
  const unauthorized = new CloudRepo(REPO, 't', (async () => new Response('{"message":"Bad credentials"}', { status: 401 })) as unknown as typeof fetch);
  await assert.rejects(unauthorized.poll(), (e: unknown) => e instanceof RepoError && e.code === 'unauthorized' && !/\bt\b/.test(e.message.replace(/[^ ]*t[^ ]*/g, '')));
  const offline = new CloudRepo(REPO, 't', (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch);
  await assert.rejects(offline.poll(), (e: unknown) => e instanceof RepoError && e.code === 'offline');
  const limited = new CloudRepo(REPO, 't', (async () => new Response('{"message":"API rate limit exceeded for user"}', { status: 403 })) as unknown as typeof fetch);
  await assert.rejects(limited.poll(), (e: unknown) => e instanceof RepoError && e.code === 'rate_limited');
});

test('intents: new jobs are UUIDv7 files, schema-valid with confirmPaid and the current configRevision, then the coordinator is woken', async () => {
  const { gh, repo, tick, provider } = await empire();
  const snap = await repo.poll();
  assert.ok(snap.changed);
  const rev = snap.changed ? snap.snapshot.state.meta.configRevision : -1;
  const jobId = uuidv7(T0 + 5);
  const mark = gh.requests.length;
  const { id, dispatched } = await repo.submit({ kind: 'new_job', job: { id: jobId, title: 'Fix rounding', prompt: 'Fix the rounding in checkout totals.', site: 'hq', configRevision: rev, confirmPaid: true } }, 'agent-empire-intent', T0 + 5);
  assert.equal(dispatched, true);
  assert.equal(uuidv7Time(id), T0 + 5);
  const path = `intents/${id}.json`;
  const text = gh.files(FULL)[path];
  assert.ok(text, 'one file per intent, named by its id');
  const parsed = parseIntent(path, text);
  assert.equal(parsed.kind, 'new_job');
  assert.deepEqual(parsed.kind === 'new_job' && { confirmPaid: parsed.job.confirmPaid, configRevision: parsed.job.configRevision, id: parsed.job.id }, { confirmPaid: true, configRevision: rev, id: jobId });
  assert.deepEqual(gh.repos.get(FULL)!.dispatches, ['agent-empire-intent']);
  const clientWrites = gh.requests.slice(mark).filter((r) => r.method !== 'GET');
  assert.deepEqual(clientWrites.map((r) => `${r.method} ${r.path}`), [`PUT /repos/${FULL}/contents/intents/${id}.json`, `POST /repos/${FULL}/dispatches`], 'a client writes one intent file and a wake-up, never state/');
  // Pending until the coordinator runs; then it is consumed and the job is recorded and dispatched to the fake provider.
  const pending = await repo.poll();
  assert.ok(pending.changed && pending.snapshot.pending.includes(id));
  await tick(T0 + 120_000);
  const after = await repo.poll(() => T0 + 121_000);
  assert.ok(after.changed);
  if (!after.changed) return;
  assert.deepEqual(after.snapshot.pending, []);
  const job = after.snapshot.state.jobs.jobs.find((j) => j.id === jobId)!;
  assert.ok(job && ['running', 'dispatching', 'queued'].includes(job.status), `job recorded (${job?.status})`);
  assert.equal(provider.sessions.size, 1, 'the fake provider received exactly one dispatch');
  assert.equal(after.snapshot.state.processed.entries.find((e) => e.id === id)?.outcome, 'applied');
  // A paid job without the explicit confirmation never leaves the device.
  const writes = gh.writes.length;
  await assert.rejects(repo.submit({ kind: 'new_job', job: { id: uuidv7(), title: 'x', prompt: 'y', configRevision: rev, confirmPaid: false as unknown as true } }), (e: unknown) => e instanceof RepoError && e.code === 'invalid');
  assert.equal(gh.writes.length, writes);
});

test('intents: review, cancel and limits are validated; a stale configRevision is rejected by the coordinator and reported', async () => {
  const { gh, repo, tick } = await empire();
  const s = await repo.poll();
  const rev = s.changed ? s.snapshot.state.meta.configRevision : 0;
  const { id: limitsId } = await repo.submit({ kind: 'limits', limits: { maxConcurrent: 2, perTaskBudgetCents: 200, dailyBudgetCents: 1000 }, configRevision: rev });
  const staleJob = uuidv7();
  await tick(T0 + 60_000);
  const { id: jobIntent } = await repo.submit({ kind: 'new_job', job: { id: staleJob, title: 'Stale', prompt: 'Confirmed under the old limits.', configRevision: rev, confirmPaid: true } });
  await tick(T0 + 120_000);
  const snap = await repo.poll();
  assert.ok(snap.changed);
  if (!snap.changed) return;
  assert.equal(snap.snapshot.state.meta.limits.maxConcurrent, 2);
  assert.equal(snap.snapshot.state.processed.entries.find((e) => e.id === limitsId)?.outcome, 'applied');
  assert.equal(snap.snapshot.state.processed.entries.find((e) => e.id === jobIntent)?.outcome, 'rejected');
  assert.ok(!snap.snapshot.state.jobs.jobs.some((j) => j.id === staleJob), 'nothing paid starts under limits the user did not see');
  await assert.rejects(repo.submit({ kind: 'review', jobId: 'not-a-uuid', decision: 'accept' }), (e: unknown) => e instanceof RepoError && e.code === 'invalid');
  await assert.rejects(repo.submit({ kind: 'cancel', jobId: '../x' }), (e: unknown) => e instanceof RepoError);
  const ok = await repo.submit({ kind: 'cancel', jobId: uuidv7() });
  assert.ok(parseIntent(`intents/${ok.id}.json`, gh.files(FULL)[`intents/${ok.id}.json`]));
});

test('intents: a commit landing at the same moment (409) is retried with the same new id', async () => {
  const { gh, repo } = await empire();
  await repo.poll();
  gh.failures.push({ method: 'PUT', path: /\/contents\/intents\//, status: 409, times: 1, message: 'is at abc but expected def' });
  const { id } = await repo.submit({ kind: 'shutdown' });
  assert.equal(gh.requests.filter((r) => r.method === 'PUT' && r.path.includes('/contents/intents/')).length, 2);
  assert.ok(gh.files(FULL)[`intents/${id}.json`]);
});

test('map: snapshot → queue, usage, counts and honest staleness labels', async () => {
  const { repo, tick } = await empire();
  const fresh = await repo.poll();
  assert.ok(fresh.changed);
  if (!fresh.changed) return;
  let view = cloudStatus({ snapshot: fresh.snapshot, source: 'github', checkedAt: T0, now: T0 + 5 * 60_000 });
  assert.equal(view.label, 'Waiting for first run');
  assert.match(view.detail, /hasn’t committed yet/);
  await tick(T0 + 60_000);
  const r = await repo.poll();
  assert.ok(r.changed);
  if (!r.changed) return;
  const snap = r.snapshot;
  view = cloudStatus({ snapshot: snap, source: 'github', checkedAt: T0 + 70_000, now: T0 + 12 * 60_000 });
  assert.equal(view.label, 'Snapshot 11 min ago');
  assert.match(view.detail, /Not live/);
  view = cloudStatus({ snapshot: snap, source: 'saved', now: T0 + 12 * 60_000 });
  assert.match(view.detail, /Saved on this device .* not yet re-read from GitHub/);
  view = cloudStatus({ snapshot: snap, source: 'github', now: T0 + 3 * 3600_000 });
  assert.equal(view.label, 'Coordinator overdue');
  assert.equal(view.tone, 'attention');
  const shut = structuredClone(snap);
  shut.state.meta.lifecycle.status = 'shutdown';
  assert.equal(cloudStatus({ snapshot: shut, source: 'github', now: T0 + 3 * 3600_000 }).label, 'Empire shut down', 'a shut-down Empire is never “overdue”');
  shut.state.meta.lifecycle.status = 'shutting_down';
  assert.equal(cloudStatus({ snapshot: shut, source: 'github', now: T0 }).label, 'Shutting down');
  assert.equal(cloudStatus({ snapshot: null, source: null, error: { code: 'offline', message: 'Can’t reach GitHub.' }, now: T0 }).detail, 'Can’t reach GitHub.');
  // Jobs → the office queue board (previews only), counts and spend.
  const s = structuredClone(snap.state);
  const base = { title: 'T', promptPreview: 'p', promptHash: '0', intentId: uuidv7(), createdAt: T0, updatedAt: T0, configRevision: 0, authorizedCents: 100, message: '', provider: 'anthropic' as const, repository: EXECUTION.repository, branch: 'agent-empire/task-x', outputs: 'unverified' as const };
  s.jobs.jobs = [
    { ...base, id: uuidv7(T0), status: 'queued' },
    { ...base, id: uuidv7(T0 + 1), status: 'running', sessionId: 'sesn_aaaaaaaaaa', reservation: { cents: 100, day: '2026-09-30', basis: 'per_job_allowance_estimate' } },
    { ...base, id: uuidv7(T0 + 2), status: 'awaiting_review' },
    { ...base, id: uuidv7(T0 + 3), status: 'failed', message: 'Provider refused' },
    { ...base, id: uuidv7(T0 + 4), status: 'waiting_for_approval', sessionId: 'sesn_bbbbbbbbbb', reservation: { cents: 100, day: '2026-09-30', basis: 'per_job_allowance_estimate' } },
  ] as typeof s.jobs.jobs;
  assert.deepEqual(jobCounts(s), { active: 1, attention: 2, queued: 1, review: 1 });
  const q = toQueue(s);
  assert.deepEqual(q.tasks.map((t) => t.status), ['queued', 'running', 'done', 'done', 'running']);
  assert.equal(q.tasks[3].error, 'Provider refused');
  assert.equal(q.maxWorkers, 1);
  s.ledger.days['2026-09-30'] = { reservedCents: 200, observedCostCents: 37 };
  s.ledger.days['2026-09-29'] = { reservedCents: 100, observedCostCents: 63 };
  const u = toUsage(s, T0);
  assert.deepEqual([u.today.cost, u.total.cost, u.budget, u.day], [0.37, 1, 5, '2026-09-30']);
  const hq = s.empire.sectors.find((x) => x.id === 'hq')!;
  hq.manager = { name: 'Alex', status: 'working', jobKey: 'k' } as typeof hq.manager;
  assert.deepEqual(cloudManagerView(hq, '12 min'), { tone: 'active', label: 'Recorded: Startup job running', detail: 'As of the cloud snapshot 12 min ago; not live.' });
  assert.deepEqual([shortAge(40_000), shortAge(12 * 60_000), shortAge(3 * 3600_000), shortAge(3 * 86400_000)], ['40 s', '12 min', '3 h', '3 d']);
  assert.equal(connectionView({ online: true, connected: false, cloud: true }).label, 'Can’t reach GitHub');
});

test('CloudNet: a relaunch shows the saved snapshot first (labelled saved), then GitHub’s; actions become intents; server-only actions explain themselves', async () => {
  const { gh, tick } = await empire();
  await tick(T0 + 60_000);
  const storage = memoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  try {
    const notes: string[] = [];
    const net = new CloudNet({ repo: REPO, token: 'ghu_user' }, () => ({ name: 'Ada', color: '#fff', look: { skin: 0, hair: 0, style: 0 } as never }), { fetch: gh.fetch, now: () => T0 + 61_000, visible: () => true, notify: (t) => notes.push(t) });
    const messages: string[] = [];
    net.onMessage((m) => messages.push(m.t));
    net.connect();
    await net.pollNow();
    assert.equal(store.cloud?.source, 'github');
    assert.ok(messages.includes('welcome') && messages.includes('empire') && messages.includes('queue') && messages.includes('usage'));
    assert.equal(store.evidence().fresh, false, 'cloud data is never live');
    assert.equal(store.evidence().reason, 'snapshot');
    assert.ok(loadSavedSnapshot(REPO, storage), 'the snapshot is saved for the next launch');
    net.stop();
    // Relaunch while GitHub is unreachable: the saved snapshot is shown, labelled saved, with the error.
    const offline = (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
    const relaunch = new CloudNet({ repo: REPO, token: 'ghu_user' }, () => ({ name: 'Ada', color: '#fff', look: {} as never }), { fetch: offline, now: () => T0 + 600_000, visible: () => true, notify: () => {} });
    const statuses: boolean[] = [];
    relaunch.onStatus((up) => statuses.push(up));
    relaunch.connect();
    assert.equal(store.cloud?.source, 'saved', 'shown immediately, before GitHub answers');
    await relaunch.pollNow();
    assert.equal(store.cloud?.source, 'saved');
    assert.equal(store.cloud?.error?.code, 'offline');
    assert.match(cloudStatus({ snapshot: store.cloud!.snapshot, source: 'saved', error: store.cloud!.error, now: T0 + 600_000 }).detail, /Saved on this device/);
    relaunch.stop();
    // Actions: a city action becomes an empire_action intent; server-only ones never reach GitHub.
    const explained: string[] = [];
    const jobs: unknown[] = [];
    net.hooks.serverOnly = (f) => explained.push(f);
    net.hooks.newJob = (r) => jobs.push(r);
    const writes = gh.writes.length;
    net.send({ t: 'worker.spawn', deskId: 'desk-1' });
    net.send({ t: 'chat', text: 'hi' });
    net.send({ t: 'move', x: 0, y: 0, z: 0, rotY: 0, moving: false });
    net.send({ t: 'empire.action', action: { kind: 'retry-manager', site: 'hq' } });
    assert.deepEqual(explained, ['Workers at office desks and their live terminals', 'Office chat']);
    assert.equal(gh.writes.length, writes, 'nothing server-only is written');
    net.send({ t: 'queue.add', title: '[Health] Triage', prompt: 'Sector: Health / Hospital\n\nTriage the backlog.' });
    assert.equal(jobs.length, 1, 'a paid job always goes through the confirmation');
    const id = await net.submit({ kind: 'empire_action', action: { kind: 'build', site: 'cafe' } }, 'Construction');
    assert.ok(id && gh.files(FULL)[`intents/${id}.json`]);
    assert.ok(net.info.sent.some((s) => s.id === id));
    await tick(T0 + 120_000);
    await net.pollNow();
    assert.ok(!net.info.sent.some((s) => s.id === id), 'consumed actions leave the waiting list');
    assert.ok(notes.some((n) => /Construction: (applied|not applied)/.test(n)), `the coordinator's verdict is reported (${notes.join(' | ')})`);
    net.stop();
    forgetSavedSnapshots(storage as unknown as Storage);
    assert.equal(loadSavedSnapshot(REPO, storage), null, '“Forget this device” removes the saved snapshot');
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('shutdown and start: intents, wake-ups, workflow control, and the app finishing a requested disable', async () => {
  const { gh, tick, provider } = await empire();
  const notes: string[] = [];
  const net = new CloudNet({ repo: REPO, token: 'ghu_user' }, () => ({ name: 'A', color: '#fff', look: {} as never }), { fetch: gh.fetch, now: () => T0 + 1000, visible: () => true, notify: (t) => notes.push(t) });
  await net.pollNow();
  const shutdownId = await net.shutdown();
  assert.ok(shutdownId);
  assert.equal(parseIntent(`intents/${shutdownId}.json`, gh.files(FULL)[`intents/${shutdownId}.json`]).kind, 'shutdown');
  assert.deepEqual(gh.repos.get(FULL)!.dispatches, ['agent-empire-shutdown']);
  // The coordinator here may not disable itself (allowSelfDisable false): it records disable_requested for the app.
  await tick(T0 + 60_000);
  await tick(T0 + 120_000);
  await net.pollNow();
  const meta = net.info.snapshot!.state.meta;
  assert.equal(meta.lifecycle.status, 'shutdown');
  assert.equal(gh.repos.get(FULL)!.workflow, 'disabled_manually', 'the app disabled the workflow the coordinator asked it to');
  assert.ok(notes.some((n) => /workflow is disabled/.test(n)));
  assert.equal(cloudStatus({ snapshot: net.info.snapshot, source: 'github', now: T0 + 10 * 3600_000 }).label, 'Empire shut down');
  // Start: enable first, then the start intent and its wake-up.
  const startId = await net.start();
  assert.ok(startId);
  assert.equal(gh.repos.get(FULL)!.workflow, 'active');
  assert.deepEqual(gh.repos.get(FULL)!.dispatches, ['agent-empire-shutdown', 'agent-empire-start']);
  const enableAt = gh.requests.findIndex((r) => r.path.endsWith('/actions/workflows/agent-empire.yml/enable'));
  const intentAt = gh.requests.findIndex((r) => r.path.endsWith(`/contents/intents/${startId}.json`));
  assert.ok(enableAt >= 0 && enableAt < intentAt, 'the workflow is enabled before the start intent is written');
  await tick(T0 + 4 * 3600_000);
  await net.pollNow();
  assert.equal(net.info.snapshot!.state.meta.lifecycle.status, 'running');
  assert.equal(net.info.snapshot!.state.meta.coordinator.economyClockAt, T0 + 4 * 3600_000, 'no catch-up: the city clock restarts at start');
  // A start whose workflow cannot be enabled writes nothing.
  gh.failures.push({ method: 'PUT', path: /\/enable$/, status: 403, times: 1, message: 'Resource not accessible by personal access token' });
  const writes = gh.writes.length;
  assert.equal(await net.start(), null);
  assert.equal(gh.writes.length, writes + 1, 'only the refused enable call; no start intent');
  assert.equal(provider.sessions.size, 0, 'no paid work at any point');
  net.stop();
});

test('saved snapshot storage ignores malformed or foreign data', () => {
  const s = memoryStorage();
  saveSnapshot(REPO, { sha: 'a'.repeat(40), files: { 'state/meta.json': '{}' }, pending: [], readAt: T0 }, s);
  assert.equal(loadSavedSnapshot(REPO, s)!.sha, 'a'.repeat(40));
  assert.equal(loadSavedSnapshot({ owner: 'other', name: 'x' }, s), null);
  s.setItem('agent-empire.cloud.snapshot.v1:founder/agent-empire-state', '{"sha":1}');
  assert.equal(loadSavedSnapshot(REPO, s), null);
  assert.equal(loadSavedSnapshot(REPO, null), null);
});
