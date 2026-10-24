import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialEmpire, type EmpireAction } from '../src/shared/empire';
import { applyCityAction, type CityActionText } from '../src/shared/economy-rules';
import { applyEmpireAction } from '../src/cloud/economy';
import { PurchaseTracker } from '../src/client/ui/purchase-tracker';

const text = new Proxy({}, { get: () => () => '' }) as CityActionText;
let n = 0;
const makeNonce = () => `client-nonce-${++n}`;

test('re-review 1: two cloud clicks before the coordinator applies them buy once', () => {
  const state = initialEmpire(1000);
  applyCityAction(state, { kind: 'found', sites: ['cafe'] }, 1000, text, () => {});
  const tracker = new PurchaseTracker(makeNonce, state.city);
  const queued: EmpireAction[] = [];
  queued.push({ kind: 'buy-vehicle', model: 'suv', nonce: tracker.click('vehicle:suv') });
  // The cloud client publishes an unrelated empire update (new snapshot sha) and the 8 s timer fires.
  assert.equal(tracker.update(structuredClone(state.city)), false);
  assert.equal(tracker.pending, true, 'an unrelated empire event does not re-enable Buy');
  tracker.timedOut();
  queued.push({ kind: 'buy-vehicle', model: 'suv', nonce: tracker.click('vehicle:suv') });
  // Minutes later the coordinator applies both intents.
  const results = queued.map((a) => applyEmpireAction(state, a, 3000));
  assert.deepEqual(results, [undefined, 'This purchase was already made']);
  assert.equal(state.city!.vehicles.length, 1);
  // Once the purchase shows up, the next click is a new purchase with a new nonce.
  assert.equal(tracker.update(state.city), true);
  assert.equal(tracker.pending, false);
  assert.notEqual(tracker.click('vehicle:suv'), queued[0].nonce);
});

test('re-review 1: a refusal frees the nonce for a later retry, except a duplicate refusal', () => {
  const tracker = new PurchaseTracker(makeNonce);
  const first = tracker.click('plot:harbour-yard');
  tracker.refused('Insufficient simulation credits');
  assert.equal(tracker.pending, false);
  assert.notEqual(tracker.click('plot:harbour-yard'), first, 'after a refusal a retry is a new purchase');
  const second = tracker.click('plot:harbour-yard');
  tracker.refused('This purchase was already made');
  assert.equal(tracker.click('plot:harbour-yard'), second, 'a duplicate refusal keeps the nonce');
  assert.notEqual(tracker.click('vehicle:van'), second, 'each target has its own nonce');
});
