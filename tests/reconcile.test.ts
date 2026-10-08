/**
 * reconcile.ts: the pure matching step of morphChildren. Live panels re-render every few seconds; a button the user is
 * pressing or focused on must never be reused for a different action.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPlan, type Desc } from '../src/client/ui/reconcile.ts';

const btn = (key: string): Desc => ({ key: `BUTTON|data-key=${key}`, kind: '1:BUTTON' });

test('a finished row losing its Terminal button never hands the Terminal element to Requeue', () => {
  // [🖥️ Terminal, ↻ Requeue, ✕] → [↻ Requeue, ✕] once the worker has gone home.
  const plan = matchPlan([btn('terminal'), btn('requeue'), btn('remove')], [btn('requeue'), btn('remove')]);
  assert.deepEqual(plan, [1, 2]);
  assert.ok(!plan.includes(0), 'the old Terminal element is not reused');
});

test('a Terminal button appearing is a new element; the others keep theirs', () => {
  assert.deepEqual(matchPlan([btn('requeue'), btn('remove')], [btn('terminal'), btn('requeue'), btn('remove')]), [null, 0, 1]);
});

test('a key that changes (Requeue → Retry once the task is held) is a new element', () => {
  assert.deepEqual(matchPlan([btn('requeue'), btn('remove')], [btn('retry'), btn('remove')]), [null, 1]);
});

test('keyed rows are matched across moves', () => {
  const row = (id: string): Desc => ({ key: `LI|data-task=${id}`, kind: '1:LI' });
  assert.deepEqual(matchPlan([row('a'), row('b'), row('c')], [row('c'), row('a')]), [2, 0]);
});

test('a key never matches a node of another kind, and each old node is used once', () => {
  assert.deepEqual(matchPlan([btn('pr')], [{ key: 'BUTTON|data-key=pr', kind: '1:A' }]), [null]);
  assert.deepEqual(matchPlan([btn('x')], [btn('x'), btn('x')]), [0, null]);
});

test('unkeyed nodes match in order by kind only', () => {
  const text: Desc = { key: null, kind: '3:#text' };
  const div: Desc = { key: null, kind: '1:DIV' };
  assert.deepEqual(matchPlan([text, div], [text, div]), [0, 1]);
  assert.deepEqual(matchPlan([div], [text, div]), [null, 0]);
  assert.deepEqual(matchPlan([text, btn('x'), div], [text, div]), [0, 2]);
});
