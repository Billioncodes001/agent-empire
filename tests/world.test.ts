/**
 * CITY-10: the shared world-additions rules (src/shared/world.ts) and the rule-based generator. Pure; no rendering,
 * no model, no network. The district layout is the game's own pure layout, so "clear of the world" is the same check
 * the game makes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { districtLayout, footprint as layoutFootprint, PLOT_PAD, ROADS, plotSign } from '../src/client/world/district-layout';
import { DISTRICTS, GARAGE, PLOTS, districtAt } from '../src/shared/city';
import { CITY } from '../src/shared/empire';
import {
  ANCHORS, CATALOG, KEEP_CLEAR, LOTS, WORLD_CAPS, applyChanges, catalogEntry, emptyWorld, footprintOf, hasHiddenText,
  invalidAdditions, placementProblem, sanitizeSignText, undoChange, validateDocument,
  type ProposedChange, type WorldAddition, type WorldDocument,
} from '../src/shared/world';
import { generateGrowth } from '../src/shared/world-generator';
import { hasHiddenChars } from '../src/server/chief';

type R = { minX: number; maxX: number; minZ: number; maxZ: number };
const overlaps = (a: R, b: R) => a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
const rect = (x: number, z: number, w: number, d: number): R => ({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
const META = { day: '2026-10-25', runId: 'R1', engine: 'rules' as const, at: 1_790_000_000_000, maxChanges: 5 };
const layout = districtLayout();
const obstacles = layout.colliders;

/** Everything the district already occupies: roads with kerbs, plots with signs, garage, stairs, kerb slots, quay. */
function worldBlocks(): R[] {
  const out: R[] = [...layout.colliders, ...layout.placements.map((p) => layoutFootprint(p))];
  for (const r of ROADS) { const along = r.w > r.d; out.push(rect(r.x, r.z, r.w + (along ? 0 : 4.6), r.d + (along ? 4.6 : 0))); }
  for (const p of PLOTS) { out.push(rect(p.x, p.z, PLOT_PAD.w, PLOT_PAD.d)); const s = plotSign(p.id); out.push(rect(s.x, s.z, 7.4, 1)); }
  out.push(rect(GARAGE.x, GARAGE.z, GARAGE.width + 0.4, GARAGE.depth + 0.4));
  for (const a of GARAGE.apron) out.push(rect(a.x, a.z, 4.8, 2.2));
  out.push({ minX: 55, maxX: 150, minZ: 212, maxZ: 218 });
  return out;
}

function lotPlacement(model: string, lot: string, dx = 0.5, dz = 0.5, yaw: 0 | 1 | 2 | 3 = 0) {
  const l = LOTS.find((x) => x.id === lot)!;
  const f = footprintOf(model, 0, 0, yaw);
  return { model, lot, x: Math.round((l.minX - f.minX + dx) * 4) / 4, z: Math.round((l.minZ - f.minZ + dz) * 4) / 4, yaw };
}
const add = (doc: WorldDocument, changes: ProposedChange[], meta = META) => {
  const r = applyChanges(doc, changes, meta);
  if ('error' in r) throw new Error(r.error);
  return r.ok;
};

// ---- Catalogue, lots and anchors -------------------------------------------------------------------------------

test('the catalogue is only shipped kit models (footprints copied exactly from the manifest) plus procedural plants', () => {
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../src/client/public/models/city/manifest.json'), 'utf8'));
  assert.ok(CATALOG.length >= 12 && CATALOG.length <= 20);
  for (const e of CATALOG) {
    if (e.kit === 'flora') { assert.match(e.model, /^(tree-round|shrub)$/); continue; }
    const m = manifest.kits[e.kit]?.models[e.model];
    assert.ok(m, `${e.id} is not shipped`);
    assert.deepEqual([e.min, e.max], [[m.min[0], m.min[2]], [m.max[0], m.max[2]]], `${e.id} footprint drifted from the manifest`);
    assert.equal(e.top, m.max[1], `${e.id} height`);
    assert.equal(e.id, `${e.kit}/${e.model}`);
  }
  assert.ok(!CATALOG.some((e) => e.kit === ('vehicles' as never)), 'no vehicles: those are owned with city credits');
  for (const kind of ['building', 'decor', 'landscape', 'light', 'sign'] as const) assert.ok(CATALOG.some((e) => e.kind === kind), kind);
});

test('every lot is inside the business district or Harbour works and clear of roads, kerbs, plots, garage, stairs, helipad, colliders and placements', () => {
  assert.ok(LOTS.length >= 5);
  const blocks = worldBlocks();
  for (const l of LOTS) {
    assert.ok(l.minX < l.maxX && l.minZ < l.maxZ, l.id);
    for (const [x, z] of [[l.minX, l.minZ], [l.maxX - 0.01, l.maxZ - 0.01]]) assert.equal(districtAt(x, z), l.district, `${l.id} corner in ${l.district}`);
    assert.notEqual(l.district, 'founding' as never);
    assert.ok(l.minX >= CITY.minX && l.maxX <= CITY.maxX && l.minZ >= CITY.minZ && l.maxZ <= CITY.maxZ, `${l.id} in the city`);
    for (const b of blocks) assert.ok(!overlaps(l, b), `${l.id} overlaps ${JSON.stringify(b)}`);
    for (const k of KEEP_CLEAR) assert.ok(!overlaps(l, k), `${l.id} overlaps keep-clear ${k.label}`);
    for (const m of LOTS) if (m !== l) assert.ok(!overlaps(l, m), `${l.id} overlaps ${m.id}`);
  }
});

test('keep-clear boxes mirror the shipped roads, plots and garage exactly', () => {
  for (const r of ROADS) assert.ok(KEEP_CLEAR.some((k) => k.label.startsWith('road') && Math.abs(k.minX - (r.x - r.w / 2 - (r.w > r.d ? 0 : 2.3))) < 1e-6 && Math.abs(k.maxZ - (r.z + r.d / 2 + (r.w > r.d ? 2.3 : 0))) < 1e-6), `road at ${r.x},${r.z}`);
  for (const p of PLOTS) assert.ok(KEEP_CLEAR.some((k) => k.label === `plot ${p.id}`), p.id);
  assert.ok(KEEP_CLEAR.some((k) => k.label === 'garage, stairs and helipad'));
  assert.ok(KEEP_CLEAR.some((k) => k.label === 'founding district (spawn and headquarters)' && k.maxX >= 55));
});

test('anchors are clear of every district placement and collider, and each allows only decor', () => {
  for (const a of ANCHORS) {
    assert.ok(DISTRICTS.some((d) => d.id === a.district));
    for (const id of a.models) {
      const e = catalogEntry(id)!;
      assert.equal(e.kind, 'decor', `${a.id} allows ${id}`);
      const f = footprintOf(id, a.x, a.z, a.yaw);
      for (const p of layout.placements) assert.ok(!overlaps(f, layoutFootprint(p)), `${a.id} overlaps ${p.model} at ${p.x},${p.z}`);
      for (const c of obstacles) assert.ok(!overlaps(f, c), `${a.id} overlaps a collider`);
    }
  }
});

test('the FREE-02 hidden-character filter is the same in the shared rules', () => {
  for (const s of ['plain', 'zero​width', 'bidi‮over', 'tag\u{E0041}', 'soft­hyphen', 'bell\u0007', 'line sep', 'ok\nnewline'])
    assert.equal(hasHiddenText(s), hasHiddenChars(s), JSON.stringify(s));
});

// ---- Document validation ---------------------------------------------------------------------------------------

test('a missing or empty document is an empty world; a malformed one is refused, never repaired', () => {
  assert.deepEqual(emptyWorld(), { schema: 1, revision: 0, additions: [] });
  const ok = validateDocument({ schema: 1, revision: 0, additions: [] });
  assert.ok('ok' in ok);
  const doc = add(emptyWorld(), [{ op: 'place', ...lotPlacement('streets/light-square', 'meridian-north-verge'), reason: 'A lamp' }]).doc;
  assert.ok('ok' in validateDocument(JSON.parse(JSON.stringify(doc))));
  const a = doc.additions[0];
  const bad: [unknown, RegExp][] = [
    [null, /object/], [[], /object/], [{ schema: 2, revision: 0, additions: [] }, /schema/],
    [{ schema: 1, revision: -1, additions: [] }, /revision/], [{ schema: 1, revision: 0, additions: {} }, /additions/],
    [{ ...doc, extra: 1 }, /unexpected field/],
    [{ ...doc, additions: [{ ...a, extra: true }] }, /unexpected field/],
    [{ ...doc, additions: [a, { ...a }] }, /duplicate/],
    [{ ...doc, additions: [{ ...a, id: 'X1' }] }, /id/],
    [{ ...doc, additions: [{ ...a, model: 'commercial/building-skyscraper-d' }] }, /unknown model/],
    [{ ...doc, additions: [{ ...a, model: 'vehicles/taxi' }] }, /unknown model/],
    [{ ...doc, additions: [{ ...a, yaw: 0.5 }] }, /yaw/],
    [{ ...doc, additions: [{ ...a, x: a.x + 0.1 }] }, /grid/],
    [{ ...doc, additions: [{ ...a, x: Number.NaN }] }, /position/],
    [{ ...doc, additions: [{ ...a, text: 'HELLO' }] }, /text/],
    [{ ...doc, additions: [{ ...a, reason: 'x'.repeat(WORLD_CAPS.reason + 1) }] }, /reason/],
    [{ ...doc, additions: [{ ...a, reason: 'hidden​text' }] }, /invisible/],
    [{ ...doc, additions: [{ ...a, lot: undefined }] }, /lot or an anchor/],
    [{ ...doc, additions: [{ ...a, anchor: 'awning-g' }] }, /lot or an anchor/],
    [{ ...doc, additions: [{ ...a, engine: 'claude-p' }] }, /engine/],
    [{ ...doc, additions: [{ ...a, day: '25/10/2026' }] }, /day/],
  ];
  for (const [raw, why] of bad) {
    const r = validateDocument(raw);
    assert.ok('error' in r, `accepted ${JSON.stringify(raw)?.slice(0, 120)}`);
    assert.match((r as { error: string }).error, why);
  }
  const tooMany = { ...doc, additions: Array.from({ length: WORLD_CAPS.total + 1 }, (_, i) => ({ ...a, id: `W${i + 1}` })) };
  assert.match((validateDocument(tooMany) as { error: string }).error, /at most/);
});

test('sign text is sanitised and length-capped; anything else is refused, never cleaned into shape', () => {
  assert.deepEqual(sanitizeSignText('  Quay walk  '), { ok: 'QUAY WALK' });
  assert.deepEqual(sanitizeSignText("Meridian Café"), { error: 'sign text may only use letters A–Z, digits, spaces and . , \' & -' });
  for (const t of ['', '   ', 'x'.repeat(WORLD_CAPS.signText + 1), 'hi​there', '<script>', 'line\nbreak', 'emoji 🚀', 42])
    assert.ok('error' in sanitizeSignText(t), JSON.stringify(t));
});

// ---- Placement rules --------------------------------------------------------------------------------------------

test('every rejection rule names its reason', () => {
  const base = add(emptyWorld(), [{ op: 'place', ...lotPlacement('flora/tree-round', 'harbour-works-yard'), reason: 'Shade' }]).doc;
  const tree = base.additions[0];
  const p = (over: Partial<WorldAddition>) => ({ ...lotPlacement('streets/light-square', 'meridian-north-verge'), ...over });
  const cases: [Record<string, unknown>, RegExp][] = [
    [p({ model: 'industrial/chimney-large' as never }), /unknown model/],
    [p({ lot: 'nowhere' as never }), /unknown lot/],
    [p({ x: 10, z: 60 }), /outside the lot/],
    [{ ...lotPlacement('commercial/building-a', 'meridian-plaza-east-strip') }, /does not allow building/],
    [{ ...lotPlacement('industrial/shipping-container-a', 'meridian-north-verge') }, /not used in the Meridian business district/],
    [{ model: 'flora/shrub', lot: 'harbour-works-yard', x: tree.x, z: tree.z, yaw: 0 }, /overlaps W1/],
    [{ model: 'commercial/detail-awning-wide', lot: 'meridian-north-verge', x: 60, z: 34, yaw: 0 }, /only on an anchor/],
    [{ model: 'commercial/detail-awning-wide', anchor: 'nope', x: 0, z: 0, yaw: 0 }, /unknown anchor/],
    [{ model: 'streets/dumpster', anchor: 'awning-g', x: ANCHORS[0].x, z: ANCHORS[0].z, yaw: ANCHORS[0].yaw }, /anchor .* does not allow/],
    [{ model: 'commercial/detail-awning-wide', anchor: 'awning-g', x: ANCHORS[0].x + 1, z: ANCHORS[0].z, yaw: ANCHORS[0].yaw }, /exact anchor/],
    [p({ text: 'HELLO' }), /only signs carry text/],
    [{ ...lotPlacement('streets/road-sign-street', 'meridian-north-verge') }, /needs its text/],
  ];
  for (const [placement, why] of cases) {
    const problem = placementProblem(placement as never, base.additions);
    assert.ok(problem, `accepted ${JSON.stringify(placement)}`);
    assert.match(problem!, why);
  }
  assert.equal(placementProblem(p({}), base.additions), undefined);
  assert.match(placementProblem(p({}), base.additions, { avoid: [{ id: 'V1', model: 'streets/light-square', text: 'no lamps', at: 1, source: 'owner' }] })!, /asked not to build/);
  assert.match(placementProblem(p({}), base.additions, { avoid: [{ id: 'V1', model: 'streets/light-square', lot: 'meridian-north-verge', text: 'x', at: 1, source: 'undo' }] })!, /asked not to build/);
  assert.equal(placementProblem(p({}), base.additions, { avoid: [{ id: 'V1', model: 'streets/light-square', lot: 'harbour-yard-west', text: 'x', at: 1, source: 'undo' }] }), undefined);
  // A keep-clear box always wins, even if a lot constant were edited to reach into a road.
  assert.match(placementProblem(p({}), [], { extraKeepClear: [{ ...rect(p({}).x, p({}).z, 4, 4), label: 'test road' }] })!, /test road/);
  // The game also checks the live district colliders.
  assert.match(placementProblem(p({}), [], { obstacles: [{ ...rect(p({}).x, p({}).z, 2, 2), top: 3 }] })!, /district/);
});

test('caps: per kind, total instances and changes per run are enforced; the whole run is refused, never partly applied', () => {
  // Kind cap: signs.
  let doc = emptyWorld();
  const lot = LOTS.find((l) => l.id === 'harbour-works-yard')!;
  const signs: ProposedChange[] = Array.from({ length: WORLD_CAPS.perKind.sign + 1 }, (_, i) => ({ op: 'place', model: 'streets/road-sign-street', lot: lot.id, x: lot.minX + 2 + i * 2.5, z: lot.minZ + 2, yaw: 0, text: `YARD ${i}`, reason: 'Wayfinding' }));
  const r = applyChanges(doc, signs, { ...META, maxChanges: 10 });
  assert.ok('error' in r);
  assert.match(r.error, /at most 4 signs/);
  // Changes per run.
  const four = signs.slice(0, 4);
  const capped = applyChanges(doc, four, { ...META, maxChanges: 3 });
  assert.ok('error' in capped);
  assert.match(capped.error, /at most 3 changes/);
  // Per day (a second batch the same day counts what was already applied).
  const day = applyChanges(doc, four, { ...META, maxChanges: 5, appliedToday: 2 });
  assert.ok('error' in day);
  assert.match(day.error, /at most 5 changes a day/);
  // Atomic: a valid change followed by an invalid one changes nothing.
  const mixed = applyChanges(doc, [four[0], { op: 'place', model: 'nope/nope', lot: lot.id, x: 130, z: 150, yaw: 0, reason: 'x' }], META);
  assert.ok('error' in mixed);
  assert.match(mixed.error, /change 2/);
  assert.deepEqual(doc, emptyWorld());
  // Total cap: fill to the cap by many days of growth, then one more placement is refused.
  for (let i = 0; i < 80 && doc.additions.length < WORLD_CAPS.total; i++) {
    const changes = generateGrowth(doc, { seed: `cap-${i}`, maxChanges: 5, avoid: [] });
    if (!changes.length) break;
    doc = add(doc, changes, { ...META, day: `2026-11-${String((i % 28) + 1).padStart(2, '0')}`, runId: `R${i + 2}` }).doc;
  }
  assert.ok(doc.additions.length <= WORLD_CAPS.total);
  for (const [kind, max] of Object.entries(WORLD_CAPS.perKind)) assert.ok(doc.additions.filter((a) => catalogEntry(a.model)!.kind === kind).length <= max, kind);
  if (doc.additions.length === WORLD_CAPS.total) {
    const extra = applyChanges(doc, [{ op: 'place', ...lotPlacement('flora/shrub', 'meridian-plaza-east-strip'), reason: 'x' }], META);
    assert.ok('error' in extra);
  }
});

test('move and remove: unknown ids and anchors are refused; ids are never reused', () => {
  let { doc, applied } = add(emptyWorld(), [{ op: 'place', ...lotPlacement('flora/shrub', 'harbour-yard-west'), reason: 'Green' }]);
  assert.equal(applied[0].op, 'place');
  assert.equal(doc.additions[0].id, 'W1');
  const moved = add(doc, [{ op: 'move', id: 'W1', x: doc.additions[0].x + 1, z: doc.additions[0].z + 2, yaw: 1, reason: 'Better spot' }]);
  assert.equal(moved.doc.additions[0].x, doc.additions[0].x + 1);
  assert.equal(moved.applied[0].before?.x, doc.additions[0].x);
  assert.match((applyChanges(doc, [{ op: 'remove', id: 'W9', reason: 'x' }], META) as { error: string }).error, /no addition W9/);
  assert.match((applyChanges(doc, [{ op: 'move', id: 'W1', x: 10, z: 60, yaw: 0, reason: 'x' }], META) as { error: string }).error, /outside the lot/);
  doc = add(doc, [{ op: 'remove', id: 'W1', reason: 'Clutter' }]).doc;
  doc = add(doc, [{ op: 'place', ...lotPlacement('flora/shrub', 'harbour-yard-west'), reason: 'Again' }]).doc;
  assert.equal(doc.additions[0].id, 'W2', 'ids keep counting after a removal');
  const anchored = add(doc, [{ op: 'place', model: 'commercial/detail-awning-wide', anchor: 'awning-g', x: ANCHORS[0].x, z: ANCHORS[0].z, yaw: ANCHORS[0].yaw, reason: 'Shade the café' }]).doc;
  assert.match((applyChanges(anchored, [{ op: 'move', id: 'W3', x: 1, z: 1, yaw: 0, reason: 'x' }], META) as { error: string }).error, /anchored/);
  assert.match((applyChanges(anchored, [{ op: 'place', model: 'commercial/detail-awning-wide', anchor: 'awning-g', x: ANCHORS[0].x, z: ANCHORS[0].z, yaw: ANCHORS[0].yaw, reason: 'x' }], META) as { error: string }).error, /anchor awning-g is taken/);
});

test('undo one change and revert a run restore the exact previous world; a stale undo is refused', () => {
  const first = add(emptyWorld(), [
    { op: 'place', ...lotPlacement('flora/tree-round', 'harbour-works-yard'), reason: 'Shade' },
    { op: 'place', ...lotPlacement('streets/light-square', 'harbour-works-yard', 10), reason: 'Light' },
  ]);
  const second = add(first.doc, [{ op: 'move', id: 'W1', x: first.doc.additions[0].x + 4, z: first.doc.additions[0].z, yaw: 0, reason: 'Spread out' }], { ...META, runId: 'R2' });
  // Undo the place of W1 while the later move stands: refused.
  const stale = undoChange(second.doc, first.applied[0]);
  assert.ok('error' in stale);
  assert.match(stale.error, /changed since/);
  const undoMove = undoChange(second.doc, second.applied[0]);
  assert.ok('ok' in undoMove);
  assert.deepEqual(undoMove.ok.additions, first.doc.additions);
  const undoPlace = undoChange(undoMove.ok, first.applied[1]);
  assert.ok('ok' in undoPlace);
  assert.deepEqual(undoPlace.ok.additions.map((a) => a.id), ['W1']);
  // Undoing a removal puts back the exact addition, if it is still valid.
  const removed = add(first.doc, [{ op: 'remove', id: 'W2', reason: 'x' }], { ...META, runId: 'R3' });
  const back = undoChange(removed.doc, removed.applied[0]);
  assert.ok('ok' in back);
  assert.deepEqual(back.ok.additions, first.doc.additions);
  assert.ok(back.ok.revision > removed.doc.revision);
});

test('invalidAdditions finds additions the current rules or the live colliders no longer accept', () => {
  const doc = add(emptyWorld(), [{ op: 'place', ...lotPlacement('flora/shrub', 'harbour-yard-east'), reason: 'Green' }]).doc;
  assert.deepEqual(invalidAdditions(doc, { obstacles }), []);
  const a = doc.additions[0];
  assert.deepEqual(invalidAdditions(doc, { obstacles: [{ ...rect(a.x, a.z, 1, 1), top: 2 }] }).map((x) => x.id), ['W1']);
});

// ---- The rule-based generator ------------------------------------------------------------------------------------

test('rule-based growth: across 120 seeds and 30 days, every run applies cleanly, stays valid against the live district colliders and within caps', () => {
  for (let s = 0; s < 120; s++) {
    let doc = emptyWorld();
    const avoid = s % 7 === 0 ? [{ id: 'V1', model: 'flora/tree-round' as const, text: 'no trees', at: 1, source: 'owner' as const }] : [];
    for (let d = 0; d < 30; d++) {
      const max = 1 + ((s + d) % 5);
      const changes = generateGrowth(doc, { seed: `seed-${s}-day-${d}`, maxChanges: max, avoid });
      assert.ok(changes.length <= max, 'at most N changes');
      const r = applyChanges(doc, changes, { ...META, maxChanges: max, runId: `R${d + 1}`, avoid });
      assert.ok('ok' in r, `seed ${s} day ${d}: ${'error' in r ? r.error : ''}`);
      doc = r.ok.doc;
      assert.deepEqual(invalidAdditions(doc, { obstacles }), [], `seed ${s} day ${d}`);
      if (avoid.length) assert.ok(!doc.additions.some((a) => a.model === 'flora/tree-round'), 'avoid-rule honoured');
    }
    assert.ok(doc.additions.length > 0 && doc.additions.length <= WORLD_CAPS.total);
    assert.ok('ok' in validateDocument(JSON.parse(JSON.stringify(doc))));
  }
});

test('rule-based growth is deterministic per seed, and repairs an addition that became invalid before growing', () => {
  const a = generateGrowth(emptyWorld(), { seed: 'same', maxChanges: 3, avoid: [] });
  const b = generateGrowth(emptyWorld(), { seed: 'same', maxChanges: 3, avoid: [] });
  assert.deepEqual(a, b);
  assert.ok(a.length > 0);
  // A hand-edited, now invalid addition (overlapping another) is repaired first.
  const doc = add(emptyWorld(), [{ op: 'place', ...lotPlacement('flora/tree-round', 'harbour-works-yard'), reason: 'One' }]).doc;
  const broken: WorldDocument = { ...doc, additions: [...doc.additions, { ...doc.additions[0], id: 'W2', model: 'flora/shrub' }] };
  const changes = generateGrowth(broken, { seed: 'fix', maxChanges: 3, avoid: [] });
  assert.ok(changes[0].op === 'move' || changes[0].op === 'remove');
  assert.match(changes[0].reason, /^Repair/);
});
