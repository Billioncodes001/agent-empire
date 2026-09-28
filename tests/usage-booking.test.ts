import test from 'node:test';
import assert from 'node:assert/strict';
import { bookGrowth, newTracker, restoreTracker, switchTranscript, trackerUsage, zeroUsage } from '../src/server/usage';
import type { Usage } from '../src/shared/protocol';

const cost = (n: number): Usage => ({ ...zeroUsage(), cost: n });
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !== ${b}`);

test('a lower Claude tally after our estimate is neither refunded nor booked twice', () => {
  const t = newTracker();
  let booked = 0;
  booked += bookGrowth(t, cost(3.0)).cost; // our running estimate
  booked += bookGrowth(t, cost(2.4)).cost; // cost-state comes in lower
  booked += bookGrowth(t, cost(2.9)).cost; // more spend, still under the high-water mark
  close(booked, 3.0);
  booked += bookGrowth(t, cost(3.5)).cost; // past it: only the excess is new
  close(booked, 3.5);
});

test('usage only grows across a transcript switch', () => {
  const t = newTracker();
  t.transcript = '/a.jsonl';
  t.since = cost(1.25);
  let booked = bookGrowth(t, trackerUsage(t)).cost;
  switchTranscript(t, '/b.jsonl');
  t.base = { ...cost(0.5), at: 1 }; // the new session's own tally covers only itself
  booked += bookGrowth(t, trackerUsage(t)).cost;
  close(trackerUsage(t).cost, 1.75);
  close(booked, 1.75);
});

test('saves from before the high-water mark treat restored usage as already booked', () => {
  const old = restoreTracker({ transcript: '/a.jsonl', files: {}, since: cost(2) });
  close(bookGrowth(old, trackerUsage(old)).cost, 0);
  const again = restoreTracker(JSON.parse(JSON.stringify(old)));
  close(bookGrowth(again, cost(2.5)).cost, 0.5);
});
