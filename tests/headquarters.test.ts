import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Empire } from '../src/server/empire';
import { TaskQueue } from '../src/server/queue';
import { WorkerManager } from '../src/server/workers';
import { fundedDesk, deskDefinition, FLOOR_RISE } from '../src/shared/layout';
import { initialEmpire } from '../src/shared/empire';
import { sanitizeQuality, GRAPHICS } from '../src/client/graphics';
import type { WorkerInfo } from '../src/shared/protocol';

const fixture = () => { const dir = mkdtempSync(path.join(tmpdir(), 'empire-hq-')); return { dir, empire: new Empire(dir, () => {}), close: () => rmSync(dir, { recursive: true, force: true }) }; };
test('funded desks gate employment; buying a floor alone does not grant computer workstations', () => {
 const f = fixture(); try {
  assert.deepEqual(f.empire.state.office, { floors: 1, workstations: 4 });
  assert.equal(f.empire.action({ kind: 'office-workstation' }), 'Complete founding setup first');
  f.empire.action({ kind: 'found', sites: [] });
  assert.ok(f.empire.deskAvailable('desk-4')); assert.ok(!f.empire.deskAvailable('desk-5'));
  assert.equal(f.empire.action({ kind: 'office-workstation' }), undefined);
  assert.equal(f.empire.state.funds, 98500); assert.ok(f.empire.deskAvailable('desk-5'));
  for (let i = 5; i < 16; i++) f.empire.action({ kind: 'office-workstation' });
  const funds = f.empire.state.funds;
  assert.equal(f.empire.action({ kind: 'office-workstation' }), 'Build another floor before adding workstations');
  assert.equal(f.empire.state.funds, funds);
  assert.equal(f.empire.action({ kind: 'office-floor' }), undefined);
  assert.equal(f.empire.state.funds, funds - 25000);
  assert.ok(!f.empire.deskAvailable('desk-17'));
  assert.equal(f.empire.action({ kind: 'office-workstation' }), undefined);
  assert.ok(f.empire.deskAvailable('desk-17'));
  assert.equal(f.empire.state.funds, funds - 26750);
  assert.deepEqual(new Empire(f.dir, () => {}).state, f.empire.state);
  assert.equal(f.empire.state.economy.capital, 100000 - f.empire.state.funds);
  f.empire.state.funds = 0;
  assert.equal(f.empire.action({ kind: 'office-floor' }), 'Insufficient simulation credits');
  assert.equal(f.empire.action({ kind: 'office-workstation' }), 'Insufficient simulation credits');
  assert.deepEqual(f.empire.state.office, { floors: 2, workstations: 17 });
 } finally { f.close(); }
});
test('old saves preserve sixteen seats and receive a recoverable capacity-migration backup', () => {
 const f = fixture(); try {
  const old: any = initialEmpire(); delete old.office;
  writeFileSync(path.join(f.dir, 'empire.json'), JSON.stringify(old));
  const upgraded = new Empire(f.dir, () => {});
  assert.deepEqual(upgraded.state.office, { floors: 1, workstations: 16 });
  assert.ok(existsSync(path.join(f.dir, 'empire.json.v2-office-backup')));
  assert.equal(upgraded.state.funds, old.funds);
  old.office = { floors: 1, workstations: 1000 };
  writeFileSync(path.join(f.dir, 'empire.json'), JSON.stringify(old));
  assert.throws(() => new Empire(f.dir, () => {}), /capacity/);
 } finally { f.close(); }
});
test('desk addresses continue across floors without accepting malformed or unfunded addresses', () => {
 assert.equal(deskDefinition('desk-17')!.y, FLOOR_RISE);
 assert.equal(deskDefinition('desk-16001')!.floor, 1000);
 assert.equal(deskDefinition('desk-16001')!.x, deskDefinition('desk-1')!.x);
 for (const id of ['desk-0', 'desk-01', 'desk--1', 'desk-1.1', 'desk-Infinity', 'desk-9007199254740992']) assert.equal(deskDefinition(id), undefined);
 assert.equal(fundedDesk('desk-17', 16), false);
 // Exercise the actual spawn boundary without creating a process or worktree.
 assert.match(WorkerManager.prototype.spawn.call({ capacity: () => 4 } as any, 'desk-5', 'QA') as string, /workstation/);
});
test('queue concurrency and allocation grow beyond the old sixteen-desk limit', () => {
 const f = fixture(); let queue: TaskQueue | undefined; try {
  writeFileSync(path.join(f.dir, 'queue.json'), JSON.stringify({ maxWorkers: 0, tasks: [] }));
  const workers = Array.from({ length: 16 }, (_, i) => ({ id: String(i), deskId: `desk-${i + 1}`, kind: 'agent', status: 'working' } as WorkerInfo));
  const seats: string[] = [];
  queue = new TaskQueue(f.dir, { workstationCapacity: () => 17, list: () => workers, deskOccupied: id => workers.some(w => w.deskId === id), spawn: id => { seats.push(id); const w = { id: '17', deskId: id, kind: 'agent', status: 'working' } as WorkerInfo; workers.push(w); return w; }, kill: async () => ({}) }, false, { update() {}, toast() {}, hiringPaused: () => undefined, claimIssue: async () => undefined, refreshGitHub() {} });
  queue.add('Document the new floor', 'QA');
  queue.setLimit(1000);
  assert.equal(queue.limit, 17);
  assert.deepEqual(seats, ['desk-17']);
 } finally { queue?.shutdown(); f.close(); }
});
test('graphics presets restore invalid saves to balanced settings and scale GPU work', () => {
 assert.equal(sanitizeQuality('low'), 'low'); assert.equal(sanitizeQuality('high'), 'high');
 for (const value of [null, 'ultra', 1, {}]) assert.equal(sanitizeQuality(value), 'medium');
 assert.equal(GRAPHICS.low.shadows, 0); assert.equal(GRAPHICS.low.ao, false);
 assert.ok(GRAPHICS.high.pixelRatio > GRAPHICS.medium.pixelRatio);
 assert.equal(GRAPHICS.high.reflections, true);
});
