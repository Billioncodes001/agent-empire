import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Empire } from '../src/server/empire';
import { TaskQueue } from '../src/server/queue';
import { initialEmpire, hourlyRates } from '../src/shared/empire';
import { entranceAccess } from '../src/client/navigation';
import type { QueueTask, WorkerInfo } from '../src/shared/protocol';
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-economy-'));
  return {
    dir,
    empire: new Empire(dir, () => {}),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const empty = { tasks: [], maxWorkers: 0 };
const job = (patch: Partial<QueueTask> = {}): QueueTask => ({
  id: 'task-1',
  title: 'Real project task',
  prompt: 'Sector: Hospitality / Common Ground café\n\nDocument project',
  addedBy: 'Founder',
  addedAt: 1,
  status: 'done',
  outcome: 'done',
  finishedAt: Date.now() + 1000,
  workerId: 'worker-1',
  workerName: 'Worker',
  ...patch,
});
const worker = {
  id: 'worker-1',
  kind: 'agent',
  status: 'working',
} as WorkerInfo;
function reconcile(e: Empire) {
  const s = e.state,
    a = s.economy;
  assert.equal(s.funds, 100000 + a.revenue - a.wages - a.upkeep - a.dividends - a.capital);
  assert.equal(
    Object.values(a.employees).reduce((n, x) => n + x.earned, 0),
    a.wages,
  );
  assert.ok(s.funds >= 0);
}
test('founding grants chosen buildings once and always appoints the chief of staff', () => {
  const f = fixture();
  try {
    assert.equal(
      f.empire.action({
        kind: 'found',
        sites: ['hospital', 'cafe', 'recreation'],
      }),
      undefined,
    );
    assert.equal(f.empire.state.sectors.filter((s) => s.built).length, 5);
    assert.equal(f.empire.state.sectors.filter((s) => s.manager).length, 4);
    assert.equal(f.empire.state.funds, 100000);
    assert.equal(f.empire.state.delegated, true);
    assert.equal(f.empire.state.sectors.find((s) => s.id === 'cafe')!.staff, 1);
    const snapshot = JSON.stringify(f.empire.state);
    assert.equal(f.empire.action({ kind: 'found', sites: ['school'] }), 'Founding setup is already complete');
    assert.equal(JSON.stringify(f.empire.state), snapshot);
    assert.deepEqual(new Empire(f.dir, () => {}).state, f.empire.state);
  } finally {
    f.close();
  }
});
test('founding validates every selection before changing the city', () => {
  const f = fixture();
  try {
    for (const sites of [['cafe', 'cafe'], ['studio'], ['hq'], ['missing'], null]) {
      const before = JSON.stringify(f.empire.state);
      assert.equal(f.empire.action({ kind: 'found', sites } as any), 'Choose valid starting buildings');
      assert.equal(JSON.stringify(f.empire.state), before);
    }
  } finally {
    f.close();
  }
});
test('manager queue keys survive a restart and prevent duplicate startup work', () => {
  const f = fixture();
  let q: TaskQueue | undefined;
  try {
    f.empire.action({ kind: 'found', sites: ['cafe'] });
    writeFileSync(path.join(f.dir, 'queue.json'), JSON.stringify({ maxWorkers: 0, tasks: [] }));
    q = new TaskQueue(
      f.dir,
      {
        list: () => [],
        deskOccupied: () => false,
        spawn: () => {
          throw Error('Paused queue must not spawn');
        },
        kill: async () => ({}),
      },
      false,
      {
        update: () => {},
        toast: () => {},
        claimIssue: async () => undefined,
        refreshGitHub: () => {},
        hiringPaused: () => undefined,
      },
    );
    f.empire.dispatchManagers(q, 'Founder');
    assert.equal(q.state().tasks.length, 2);
    assert.equal(entranceAccess('cafe', f.empire.state, []).allowed, false);
    f.empire.state.sectors.forEach((s) => {
      if (s.manager) s.manager.status = 'pending';
    });
    f.empire.flush();
    q.shutdown();
    q = new TaskQueue(
      f.dir,
      {
        list: () => [],
        deskOccupied: () => false,
        spawn: () => {
          throw Error('No spawn');
        },
        kill: async () => ({}),
      },
      false,
      {
        update: () => {},
        toast: () => {},
        claimIssue: async () => undefined,
        refreshGitHub: () => {},
        hiringPaused: () => undefined,
      },
    );
    const restored = new Empire(f.dir, () => {});
    restored.dispatchManagers(q, 'Founder');
    assert.equal(q.state().tasks.length, 2);
    assert.ok(q.state().tasks.every((t) => t.jobKey));
  } finally {
    q?.shutdown();
    f.close();
  }
});
test('actual manager startup opens a building, completion leaves a durable assignment', () => {
  const f = fixture();
  try {
    f.empire.action({ kind: 'found', sites: ['cafe'] });
    const m = f.empire.state.sectors.find((s) => s.id === 'cafe')!.manager!;
    const t = job({ jobKey: m.jobKey, status: 'queued', outcome: undefined });
    f.empire.tick([], { tasks: [t], maxWorkers: 0 }, 0);
    assert.equal(m.status, 'queued');
    assert.equal(entranceAccess('cafe', f.empire.state, []).allowed, false);
    t.status = 'running';
    f.empire.tick([worker], { tasks: [t], maxWorkers: 1 }, 0);
    assert.equal(m.status, 'working');
    assert.equal(entranceAccess('cafe', f.empire.state, []).allowed, true);
    t.status = 'done';
    t.outcome = 'done';
    f.empire.tick([], { tasks: [t], maxWorkers: 1 }, 0);
    assert.equal(m.status, 'ready');
    f.empire.tick([], empty, 0);
    assert.equal(entranceAccess('cafe', new Empire(f.dir, () => {}).state, []).allowed, true);
  } finally {
    f.close();
  }
});
test('completed real tasks pay once across ticks, retries and restarts; failures and historic tasks do not pay', () => {
  const f = fixture();
  try {
    f.empire.action({ kind: 'found', sites: [] });
    const tasks = [
      job(),
      job({ id: 'failure', outcome: 'failed' }),
      job({ id: 'historic', finishedAt: 1 }),
      job({ id: 'no-worker', workerId: undefined }),
    ];
    f.empire.tick([], { tasks, maxWorkers: 0 }, 0);
    assert.equal(f.empire.state.economy.revenue, 500);
    assert.equal(f.empire.state.economy.wages, 50);
    assert.equal(f.empire.state.economy.ownerBalance, 90);
    assert.equal(f.empire.state.funds, 100360);
    const restarted = new Empire(f.dir, () => {});
    restarted.tick([], { tasks, maxWorkers: 0 }, 0);
    restarted.tick([], { tasks, maxWorkers: 0 }, 0);
    assert.equal(restarted.state.economy.revenue, 500);
    reconcile(restarted);
  } finally {
    f.close();
  }
});
test('hourly income pays individual wages, upkeep and founder dividends with balanced capital spending', () => {
  const f = fixture();
  try {
    f.empire.action({ kind: 'found', sites: ['cafe'] });
    for (const s of f.empire.state.sectors) if (s.manager) s.manager.status = 'ready';
    const cafe = f.empire.state.sectors.find((s) => s.id === 'cafe')!;
    assert.deepEqual(hourlyRates(cafe), {
      revenue: 128,
      wages: 58,
      upkeep: 20,
    });
    f.empire.tick([], empty, 60);
    assert.equal(f.empire.state.economy.revenue, 128);
    assert.equal(f.empire.state.economy.wages, 118);
    assert.equal(f.empire.state.economy.upkeep, 30);
    f.empire.action({ kind: 'hire', site: 'cafe' });
    f.empire.action({ kind: 'upgrade', site: 'cafe' });
    f.empire.tick([], empty, 60);
    assert.ok(f.empire.state.economy.ownerBalance > 0);
    assert.equal(f.empire.action({ kind: 'reinvest' }), undefined);
    assert.equal(f.empire.state.economy.ownerBalance, 0);
    assert.equal(f.empire.action({ kind: 'build', site: 'studio' }), 'Buy this land first');
    assert.equal(f.empire.action({ kind: 'buy-land', site: 'studio' }), undefined);
    assert.equal(f.empire.action({ kind: 'buy-land', site: 'studio' }), 'Land already owned');
    assert.equal(f.empire.action({ kind: 'build', site: 'studio' }), undefined);
    reconcile(f.empire);
  } finally {
    f.close();
  }
});
test('queued managers earn no operating revenue and unfunded payroll cannot create negative cash', () => {
  const f = fixture();
  try {
    f.empire.action({ kind: 'found', sites: ['cafe'] });
    f.empire.tick([], empty, 60);
    assert.equal(f.empire.state.economy.revenue, 0);
    assert.equal(f.empire.state.economy.wages, 0);
    f.empire.state.funds = 0;
    f.empire.state.sectors.find((s) => s.id === 'hq')!.manager!.status = 'ready';
    f.empire.tick([], empty, 60);
    assert.equal(f.empire.state.funds, 0);
    assert.equal(f.empire.state.economy.wages, 0);
    assert.ok(f.empire.state.reports.some((r) => r.text.includes('payroll cannot be funded')));
  } finally {
    f.close();
  }
});
test('version one migration preserves the district and saves a backup without retroactive income', () => {
  const f = fixture();
  try {
    const old: any = initialEmpire(1);
    old.version = 1;
    old.funds = 42700;
    old.minutes = 2340;
    delete old.setup;
    delete old.economy;
    old.sectors = old.sectors
      .filter((s: any) => !['recreation', 'studio'].includes(s.id))
      .map((s: any) => ({
        id: s.id,
        built: s.id === 'hq' || s.id === 'home' || s.id === 'school',
        staff: s.id === 'school' ? 3 : 0,
        service: 0,
      }));
    writeFileSync(path.join(f.dir, 'empire.json'), JSON.stringify(old));
    const e = new Empire(f.dir, () => {});
    assert.equal(e.state.funds, 42700);
    assert.equal(e.state.sectors.find((s) => s.id === 'school')!.staff, 3);
    assert.equal(e.state.setup.completed, false);
    assert.equal(e.state.economy.lastHour, 39);
    assert.ok(existsSync(path.join(f.dir, 'empire.json.v1-backup')));
    e.tick([], empty, 0);
    assert.equal(e.state.funds, 42700);
  } finally {
    f.close();
  }
});

test('failed manager startup stays locked and retry receives a new appointment job key', () => {
  const f=fixture();
  try {
    f.empire.action({kind:'found',sites:['cafe']});
    const m=f.empire.state.sectors.find(s=>s.id==='cafe')!.manager!;
    const key=m.jobKey;
    f.empire.tick([], {tasks:[job({jobKey:key,outcome:'failed',error:'Provider unavailable'})],maxWorkers:1},0);
    assert.equal(m.status,'offline');
    assert.equal(entranceAccess('cafe',f.empire.state,[]).allowed,false);
    assert.equal(f.empire.state.economy.revenue,0);
    assert.equal(f.empire.action({kind:'retry-manager',site:'cafe'}),undefined);
    assert.equal(m.status,'pending');assert.notEqual(m.jobKey,key);
    assert.equal(m.error,undefined);
  } finally {f.close();}
});
