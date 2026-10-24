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

test('final review: an ambiguous cloud submit failure keeps the nonce, so a retry cannot buy twice', () => {
  const state = initialEmpire(1000);
  applyCityAction(state, { kind: 'found', sites: ['cafe'] }, 1000, text, () => {});
  const tracker = new PurchaseTracker(makeNonce, state.city);
  const first = tracker.click('vehicle:suv');
  // The GitHub write landed but its response was lost: the client shows an error toast.
  tracker.refused();
  assert.equal(tracker.pending, false, 'the buttons come back');
  const retry = tracker.click('vehicle:suv');
  assert.equal(retry, first, 'the retry resends the same nonce');
  const results = [first, retry].map((nonce) => applyEmpireAction(state, { kind: 'buy-vehicle', model: 'suv', nonce }, 3000));
  assert.deepEqual(results, [undefined, 'This purchase was already made']);
  assert.equal(state.city!.vehicles.length, 1);
});

test('final review: a nonce from a real refusal is accepted later, so no target becomes unbuyable', () => {
  const state = initialEmpire(1000);
  applyCityAction(state, { kind: 'found', sites: ['cafe'] }, 1000, text, () => {});
  state.funds = 1000;
  const tracker = new PurchaseTracker(makeNonce, state.city);
  const nonce = tracker.click('plot:harbour-yard');
  assert.ok(applyEmpireAction(state, { kind: 'buy-plot', plot: 'harbour-yard', nonce }, 2000), 'refused: too few credits');
  tracker.refused();
  state.funds = 100_000;
  assert.equal(tracker.click('plot:harbour-yard'), nonce);
  assert.equal(applyEmpireAction(state, { kind: 'buy-plot', plot: 'harbour-yard', nonce }, 3000), undefined, 'the same nonce now buys');
  assert.notEqual(tracker.click('vehicle:van'), nonce, 'each target has its own nonce');
});
