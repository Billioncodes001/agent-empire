/** CITY-09: the world journal (memory): seeding, size limits, summaries, owner feedback, export and prompt block. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOTS, applyChanges, emptyWorld, type AppliedChange } from '../src/shared/world';
import { generateGrowth } from '../src/shared/world-generator';
import {
  JOURNAL_LIMITS, addAvoid, addIdeas, avoidFromUndo, journalMarkdown, journalPromptData, recordRun, removeAvoid, seedJournal, validateJournal,
} from '../src/shared/world-journal';

const AT = Date.UTC(2026, 9, 25, 3);

test('a new install seeds the journal from the current world: a style guide per district, density targets and starter ideas', () => {
  const j = seedJournal(emptyWorld(), AT);
  assert.equal(j.version, 1);
  assert.deepEqual(Object.keys(j.styleGuide.districts).sort(), ['business', 'harbour']);
  for (const d of Object.values(j.styleGuide.districts)) {
    assert.ok(d.theme.length > 10 && d.palette.length >= 3 && d.prefer.length >= 3);
    assert.ok(d.density > 0 && d.density < 1);
  }
  assert.ok(j.ideas.length >= 3 && j.ideas.every((i) => i.source === 'seed'));
  assert.deepEqual(j.entries, []);
  assert.deepEqual(j.avoid, []);
  assert.ok('ok' in validateJournal(JSON.parse(JSON.stringify(j))));
  // A world that already has additions is summarised into the seed.
  const grown = applyChanges(emptyWorld(), generateGrowth(emptyWorld(), { seed: 'x', maxChanges: 3, avoid: [] }), { day: '2026-10-24', runId: 'R1', engine: 'rules', at: AT, maxChanges: 3 });
  assert.ok('ok' in grown);
  assert.match(seedJournal(grown.ok.doc, AT).summaries[0].text, /3 additions/);
});

test('entries are capped; older ones are summarised by month; the file stays under its byte limit', () => {
  let j = seedJournal(emptyWorld(), AT);
  for (let i = 0; i < 400; i++) {
    const day = new Date(AT + i * 86_400_000).toISOString().slice(0, 10);
    const changes: AppliedChange[] = Array.from({ length: 5 }, (_, k) => ({ id: `C${i * 5 + k + 1}`, op: 'place', additionId: `W${i * 5 + k + 1}`, model: 'flora/shrub', lot: 'harbour-yard-west', reason: 'r'.repeat(140), repair: false, after: undefined }));
    j = recordRun(j, { day, runId: `R${i + 1}`, engine: i % 2 ? 'premium' : 'rules', engineLabel: 'Rule-based growth · US$0', costLabel: 'US$0', changes, note: 'n'.repeat(400) });
    j = addIdeas(j, [`Idea ${i} `.padEnd(200, 'x')], 'model', AT);
  }
  assert.equal(j.entries.length, JOURNAL_LIMITS.entries);
  assert.ok(j.summaries.length > 0 && j.summaries.length <= JOURNAL_LIMITS.summaries);
  assert.ok(j.ideas.length <= JOURNAL_LIMITS.ideas);
  assert.ok(j.ideas.every((i) => i.text.length <= JOURNAL_LIMITS.idea));
  assert.ok(Buffer.byteLength(JSON.stringify(j)) <= JOURNAL_LIMITS.bytes, `${Buffer.byteLength(JSON.stringify(j))} bytes`);
  assert.equal(j.entries.at(-1)!.runId, 'R400', 'the newest entries are kept');
  assert.match(j.summaries.at(-1)!.text, /changes/);
  assert.ok('ok' in validateJournal(JSON.parse(JSON.stringify(j))));
});

test('owner feedback: an undone placement becomes an avoid-rule; "don\'t build X" is validated; rules are capped and removable', () => {
  let j = seedJournal(emptyWorld(), AT);
  const undone: AppliedChange = { id: 'C1', op: 'place', additionId: 'W1', model: 'streets/dumpster', lot: 'harbour-yard-east', reason: 'Bins', repair: false };
  const rule = avoidFromUndo(undone, AT);
  assert.ok(rule);
  assert.equal(rule!.model, 'streets/dumpster');
  assert.equal(rule!.lot, 'harbour-yard-east');
  assert.equal(rule!.source, 'undo');
  assert.equal(avoidFromUndo({ ...undone, op: 'move' }, AT), undefined, 'undoing a move is not a "do not build"');
  j = addAvoid(j, rule!);
  j = addAvoid(j, rule!);
  assert.equal(j.avoid.length, 1, 'identical rules are not repeated');
  const owner = addAvoid(j, { model: 'flora/tree-round', text: 'No trees please', source: 'owner', at: AT });
  assert.equal(owner.avoid.length, 2);
  assert.throws(() => addAvoid(j, { model: 'nope/nope' as never, text: 'x', source: 'owner', at: AT }), /unknown model/);
  assert.throws(() => addAvoid(j, { lot: 'nowhere' as never, text: 'x', source: 'owner', at: AT }), /unknown lot/);
  assert.throws(() => addAvoid(j, { model: 'flora/shrub', text: 'bad‮text', source: 'owner', at: AT }), /invisible/);
  assert.throws(() => addAvoid(j, { text: 'nothing', source: 'owner', at: AT }), /model or a lot/);
  for (let i = 0; i < 100; i++) j = addAvoid(j, { model: 'flora/shrub', lot: LOTS[i % LOTS.length].id, text: `undo ${i}`, source: i % 3 ? 'undo' : 'owner', at: AT + i });
  assert.ok(j.avoid.length <= JOURNAL_LIMITS.avoid);
  const id = j.avoid[0].id;
  assert.ok(!removeAvoid(j, id).avoid.some((r) => r.id === id));
});

test('the readable export and the model data block', () => {
  let j = seedJournal(emptyWorld(), AT);
  j = recordRun(j, { day: '2026-10-25', runId: 'R1', engine: 'rules', engineLabel: 'Rule-based growth · US$0', costLabel: 'US$0', changes: [{ id: 'C1', op: 'place', additionId: 'W1', model: 'flora/tree-round', lot: 'harbour-works-yard', reason: 'Shade for the works yard', repair: false }] });
  const md = journalMarkdown(j, emptyWorld(), AT);
  for (const s of ['# City architect journal', '## Style guide', '## Recent runs', '## Ideas', '## Avoid', 'Shade for the works yard', 'Built by the city architect'])
    assert.ok(md.includes(s), s);
  const data = journalPromptData(j, emptyWorld());
  const parsed = JSON.parse(data);
  assert.ok(parsed.styleGuide && Array.isArray(parsed.recent) && Array.isArray(parsed.ideas) && Array.isArray(parsed.avoid) && Array.isArray(parsed.lots) && Array.isArray(parsed.catalog));
  assert.ok(data.length < 16_000, `${data.length} characters`);
});

test('a malformed journal is refused, not repaired', () => {
  const j = seedJournal(emptyWorld(), AT);
  for (const bad of [null, { ...j, version: 2 }, { ...j, entries: {} }, { ...j, avoid: [{ id: 'V1', text: 5 }] }, { ...j, ideas: [{ id: 'I1', text: 'x​', at: 1, source: 'seed' }] }])
    assert.ok('error' in validateJournal(bad), JSON.stringify(bad)?.slice(0, 80));
});
