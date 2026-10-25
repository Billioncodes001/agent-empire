/**
 * CITY-10: the world journal, the architect's memory (`<dataDir>/world/journal.json`, exported as `journal.md`).
 * A style guide seeded from the shipped districts, what was built (when and why), an ideas backlog and owner feedback
 * as avoid-rules. Bounded: old runs are summarised by month and the file never passes JOURNAL_LIMITS.bytes. It reaches
 * a model only as delimited data (server/architect.ts), like FREE-10 lessons.
 */
import {
  ANCHORS, CATALOG, LOTS, WORLD_CAPS, catalogEntry, changeLabel, footprintOf, hasHiddenText,
  type AppliedChange, type ArchitectEngine, type AvoidRule, type WorldDocument,
} from './world.js';

export const JOURNAL_LIMITS = { entries: 30, summaries: 24, ideas: 20, idea: 160, avoid: 40, avoidText: 160, note: 200, bytes: 64 * 1024, recentForModel: 7 } as const;

export interface StyleDistrict { theme: string; palette: string[]; density: number; prefer: string[] }
export interface JournalChange { id: string; op: AppliedChange['op']; additionId: string; model: string; lot?: string; anchor?: string; reason: string; repair: boolean }
export interface JournalEntry { day: string; runId: string; engine: ArchitectEngine; engineLabel: string; costLabel: string; status: 'applied' | 'no_changes' | 'rejected' | 'interrupted' | 'reverted'; changes: JournalChange[]; note?: string }
export interface JournalSummary { period: string; runs: number; built: number; moved: number; removed: number; text: string }
export interface JournalIdea { id: string; text: string; at: number; source: 'seed' | 'model' | 'rules' }
export interface WorldJournal {
  version: 1;
  seededAt: number;
  styleGuide: { districts: { business: StyleDistrict; harbour: StyleDistrict }; rules: string[] };
  entries: JournalEntry[];
  summaries: JournalSummary[];
  ideas: JournalIdea[];
  avoid: AvoidRule[];
  nextIdea: number;
  nextAvoid: number;
}

const STYLE: WorldJournal['styleGuide'] = {
  districts: {
    business: { theme: 'Meridian business district: glass towers, café terraces under parasols, warm lamps and tidy street trees.', palette: ['#d6d4cf warm stone', '#32685c deep green', '#e2d6a8 lamp gold', '#1d2a2e slate'], density: 0.03, prefer: ['flora/tree-round', 'streets/light-curved-double', 'commercial/detail-parasol-a', 'commercial/building-g'] },
    harbour: { theme: 'Harbour works: containers, storage tanks, workshop sheds, sturdy lamps and hardy shrubs by the quay.', palette: ['#9aa3a3 galvanised steel', '#2b3134 bollard black', '#c9774a container rust', '#d1c8a5 road paint'], density: 0.035, prefer: ['industrial/shipping-container-a', 'streets/light-square', 'flora/shrub', 'industrial/building-k'] },
  },
  rules: [
    'Small changes: a few additions a day, never a rebuild.',
    'Never on roads, kerbs, plots, the garage, its staircase or helipad, and never in the founding district.',
    'Buildings and signs face the nearest street; lamps light paths people walk.',
    'Leave room to walk: keep at least a body-width between additions.',
  ],
};

export function seedJournal(doc: WorldDocument, at: number): WorldJournal {
  const ideas: JournalIdea[] = [
    'Plant street trees along the Meridian north verge.',
    'Light the Harbour works yard for night shifts.',
    'Give the café pavilion façade an awning.',
  ].map((text, i) => ({ id: `I${i + 1}`, text, at, source: 'seed' as const }));
  const summaries: JournalSummary[] = doc.additions.length ? [{ period: 'before the journal', runs: 0, built: doc.additions.length, moved: 0, removed: 0, text: `${doc.additions.length} additions were already in the world when the journal began.` }] : [];
  return { version: 1, seededAt: at, styleGuide: structuredClone(STYLE), entries: [], summaries, ideas, avoid: [], nextIdea: ideas.length + 1, nextAvoid: 1 };
}

const summaryText = (s: Omit<JournalSummary, 'text'>) => `${s.period}: ${s.runs} run${s.runs === 1 ? '' : 's'}, ${s.built + s.moved + s.removed} changes (${s.built} built, ${s.moved} moved, ${s.removed} removed).`;

/** Moves the oldest entry into its month's summary. */
function summariseOldest(j: WorldJournal) {
  const e = j.entries.shift();
  if (!e) return;
  const period = e.day.slice(0, 7);
  let s = j.summaries.find((x) => x.period === period);
  if (!s) { s = { period, runs: 0, built: 0, moved: 0, removed: 0, text: '' }; j.summaries.push(s); }
  s.runs += 1;
  for (const c of e.changes) { if (c.op === 'place') s.built++; else if (c.op === 'move') s.moved++; else s.removed++; }
  s.text = summaryText(s);
  while (j.summaries.length > JOURNAL_LIMITS.summaries) j.summaries.shift();
}

function fit(j: WorldJournal): WorldJournal {
  while (j.entries.length > JOURNAL_LIMITS.entries) summariseOldest(j);
  while (j.ideas.length > JOURNAL_LIMITS.ideas) j.ideas.shift();
  while (j.avoid.length > JOURNAL_LIMITS.avoid) {
    const i = j.avoid.findIndex((r) => r.source === 'undo');
    j.avoid.splice(i >= 0 ? i : 0, 1);
  }
  while (new TextEncoder().encode(JSON.stringify(j)).length > JOURNAL_LIMITS.bytes && j.entries.length > 1) summariseOldest(j);
  return j;
}

export function recordRun(input: WorldJournal, run: { day: string; runId: string; engine: ArchitectEngine; engineLabel: string; costLabel: string; changes: AppliedChange[]; note?: string; status?: JournalEntry['status'] }): WorldJournal {
  const j = structuredClone(input);
  j.entries.push({
    day: run.day, runId: run.runId, engine: run.engine, engineLabel: run.engineLabel.slice(0, 120), costLabel: run.costLabel.slice(0, 80),
    status: run.status ?? (run.changes.length ? 'applied' : 'no_changes'),
    changes: run.changes.map((c) => ({ id: c.id, op: c.op, additionId: c.additionId, model: c.model, ...(c.lot ? { lot: c.lot } : {}), ...(c.anchor ? { anchor: c.anchor } : {}), reason: c.reason.slice(0, WORLD_CAPS.reason), repair: c.repair })),
    ...(run.note ? { note: run.note.slice(0, JOURNAL_LIMITS.note) } : {}),
  });
  return fit(j);
}

/** Marks a run's entry as reverted (a whole day undone by the owner). */
export function markReverted(input: WorldJournal, runId: string): WorldJournal {
  const j = structuredClone(input);
  const e = j.entries.find((x) => x.runId === runId);
  if (e) e.status = 'reverted';
  return j;
}

/** Adds ideas (already validated when they come from a model); each is capped, the list keeps the newest. */
export function addIdeas(input: WorldJournal, texts: readonly string[], source: JournalIdea['source'], at: number): WorldJournal {
  const j = structuredClone(input);
  for (const raw of texts) {
    const text = raw.trim().slice(0, JOURNAL_LIMITS.idea);
    if (!text || hasHiddenText(text) || j.ideas.some((i) => i.text.toLowerCase() === text.toLowerCase())) continue;
    j.ideas.push({ id: `I${j.nextIdea++}`, text, at, source });
  }
  return fit(j);
}

/** Undoing a placement means "not this here": an avoid-rule for that model in that lot. Other undos teach nothing. */
export function avoidFromUndo(c: Pick<AppliedChange, 'op' | 'model' | 'lot' | 'anchor' | 'additionId'>, at: number): Omit<AvoidRule, 'id'> | undefined {
  if (c.op !== 'place') return undefined;
  const e = catalogEntry(c.model);
  const where = c.lot ? LOTS.find((l) => l.id === c.lot)?.name : c.anchor ? ANCHORS.find((a) => a.id === c.anchor)?.name : undefined;
  return { model: c.model, ...(c.lot ? { lot: c.lot } : {}), ...(c.anchor ? { anchor: c.anchor } : {}), text: `The owner undid a ${e?.label ?? c.model}${where ? ` on the ${where}` : ''}`.slice(0, JOURNAL_LIMITS.avoidText), at, source: 'undo' };
}

/** Adds a validated avoid-rule (throws with the reason otherwise). An identical model/lot rule is not repeated. */
export function addAvoid(input: WorldJournal, rule: Omit<AvoidRule, 'id'> & { id?: string }): WorldJournal {
  if (rule.model === undefined && rule.lot === undefined) throw new Error('an avoid-rule needs a model or a lot');
  if (rule.model !== undefined && !catalogEntry(rule.model)) throw new Error(`unknown model "${String(rule.model).slice(0, 60)}"`);
  if (rule.lot !== undefined && !LOTS.some((l) => l.id === rule.lot)) throw new Error(`unknown lot "${String(rule.lot).slice(0, 40)}"`);
  if (rule.anchor !== undefined && !ANCHORS.some((a) => a.id === rule.anchor)) throw new Error(`unknown anchor "${String(rule.anchor).slice(0, 40)}"`);
  if (typeof rule.text !== 'string' || !rule.text.trim()) throw new Error('an avoid-rule needs its text');
  if (rule.text.length > JOURNAL_LIMITS.avoidText) throw new Error(`the avoid-rule text is longer than ${JOURNAL_LIMITS.avoidText} characters`);
  if (hasHiddenText(rule.text)) throw new Error('the avoid-rule text contains invisible or control characters');
  const j = structuredClone(input);
  if (j.avoid.some((r) => r.model === rule.model && r.lot === rule.lot && r.anchor === rule.anchor)) return j;
  j.avoid.push({ id: `V${j.nextAvoid++}`, ...(rule.model ? { model: rule.model } : {}), ...(rule.lot ? { lot: rule.lot } : {}), ...(rule.anchor ? { anchor: rule.anchor } : {}), text: rule.text.trim(), at: rule.at, source: rule.source });
  return fit(j);
}

export function removeAvoid(input: WorldJournal, id: string): WorldJournal {
  const j = structuredClone(input);
  j.avoid = j.avoid.filter((r) => r.id !== id);
  return j;
}

// ---- Validation ---------------------------------------------------------------------------------------------------

const isStr = (v: unknown, max = 2000) => typeof v === 'string' && v.length <= max && !hasHiddenText(v);
export function validateJournal(raw: unknown): { ok: WorldJournal } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'the journal must be an object' };
  const j = raw as WorldJournal;
  if (j.version !== 1) return { error: 'unsupported journal version' };
  if (!Number.isFinite(j.seededAt) || !Number.isSafeInteger(j.nextIdea) || !Number.isSafeInteger(j.nextAvoid)) return { error: 'the journal counters are invalid' };
  const d = j.styleGuide?.districts;
  if (!d || typeof d !== 'object') return { error: 'the style guide is missing' };
  for (const k of ['business', 'harbour'] as const) {
    const s = d[k];
    if (!s || !isStr(s.theme, 400) || !Array.isArray(s.palette) || !s.palette.every((p) => isStr(p, 60)) || typeof s.density !== 'number' || !(s.density > 0 && s.density < 1) || !Array.isArray(s.prefer) || !s.prefer.every((p) => catalogEntry(p))) return { error: `the ${k} style is invalid` };
  }
  if (!Array.isArray(j.styleGuide.rules) || !j.styleGuide.rules.every((r) => isStr(r, 300))) return { error: 'the style rules are invalid' };
  if (!Array.isArray(j.entries) || !j.entries.every((e) => e && isStr(e.day, 10) && isStr(e.runId, 12) && Array.isArray(e.changes) && e.changes.every((c) => c && isStr(c.reason, WORLD_CAPS.reason) && isStr(c.additionId, 10)))) return { error: 'the journal entries are invalid' };
  if (!Array.isArray(j.summaries) || !j.summaries.every((s) => s && isStr(s.period, 40) && isStr(s.text, 300))) return { error: 'the journal summaries are invalid' };
  if (!Array.isArray(j.ideas) || !j.ideas.every((i) => i && isStr(i.id, 12) && isStr(i.text, JOURNAL_LIMITS.idea) && Number.isFinite(i.at) && ['seed', 'model', 'rules'].includes(i.source))) return { error: 'the ideas are invalid' };
  if (!Array.isArray(j.avoid) || !j.avoid.every((r) => r && isStr(r.id, 12) && isStr(r.text, JOURNAL_LIMITS.avoidText) && Number.isFinite(r.at) && ['undo', 'owner'].includes(r.source) && (r.model === undefined || catalogEntry(r.model)) && (r.lot === undefined || LOTS.some((l) => l.id === r.lot)) && (r.anchor === undefined || ANCHORS.some((a) => a.id === r.anchor)))) return { error: 'the avoid-rules are invalid' };
  return { ok: j };
}

// ---- Export and the model's data block ---------------------------------------------------------------------------

export function journalMarkdown(j: WorldJournal, doc: WorldDocument, now: number): string {
  const lines = [
    '# City architect journal', '',
    `Exported ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC. The world holds ${doc.additions.length} of at most ${WORLD_CAPS.total} additions. All of them are labelled “Built by the city architect” in the city; none of them is agent work or a verified outcome.`, '',
    '## Style guide', '',
    ...(['business', 'harbour'] as const).flatMap((k) => { const s = j.styleGuide.districts[k]; return [`- **${k === 'business' ? 'Meridian business district' : 'Harbour works'}**: ${s.theme} Palette: ${s.palette.join(', ')}. Density: about one addition per ${Math.round(1 / s.density)} m².`]; }),
    ...j.styleGuide.rules.map((r) => `- ${r}`), '',
    '## Recent runs', '',
    ...(j.entries.length ? [...j.entries].reverse().flatMap((e) => [`### ${e.day} · ${e.runId} · ${e.status.replace('_', ' ')}`, '', `${e.engineLabel} · ${e.costLabel}${e.note ? ` · ${e.note}` : ''}`, '', ...(e.changes.length ? e.changes.map((c) => `- ${changeLabel(c)}: ${c.reason}`) : ['- No changes.']), '']) : ['No runs yet.', '']),
    ...(j.summaries.length ? ['## Earlier', '', ...j.summaries.map((s) => `- ${s.text}`), ''] : []),
    '## Ideas', '', ...(j.ideas.length ? j.ideas.map((i) => `- ${i.text} (${i.source})`) : ['- None.']), '',
    '## Avoid', '', ...(j.avoid.length ? j.avoid.map((r) => `- ${r.text}${r.model ? ` · ${catalogEntry(r.model)?.label ?? r.model}` : ''}${r.lot ? ` · ${LOTS.find((l) => l.id === r.lot)?.name ?? r.lot}` : ''} (${r.source === 'undo' ? 'from an undo' : 'owner'})`) : ['- None.']), '',
  ];
  return lines.join('\n');
}

/** Everything a model needs to propose changes, as compact JSON. Data, never instructions. */
export function journalPromptData(j: WorldJournal, doc: WorldDocument): string {
  const r = (n: number) => Math.round(n * 100) / 100;
  return JSON.stringify({
    styleGuide: j.styleGuide,
    recent: j.entries.slice(-JOURNAL_LIMITS.recentForModel).map((e) => ({ day: e.day, status: e.status, changes: e.changes.map((c) => `${c.op} ${c.model}${c.lot ? ` in ${c.lot}` : ''}: ${c.reason}`) })),
    earlier: j.summaries.slice(-6).map((s) => s.text),
    ideas: j.ideas.map((i) => i.text),
    avoid: j.avoid.map((a) => ({ model: a.model, lot: a.lot, anchor: a.anchor, why: a.text })),
    additions: doc.additions.map((a) => ({ id: a.id, model: a.model, lot: a.lot, anchor: a.anchor, x: a.x, z: a.z, yaw: a.yaw })),
    lots: LOTS.map((l) => ({ id: l.id, name: l.name, district: l.district, minX: l.minX, maxX: l.maxX, minZ: l.minZ, maxZ: l.maxZ, kinds: l.kinds, face: l.face })),
    anchors: ANCHORS.map((a) => ({ id: a.id, name: a.name, x: a.x, z: a.z, yaw: a.yaw, models: a.models, taken: doc.additions.some((x) => x.anchor === a.id) })),
    catalog: CATALOG.map((e) => { const f = footprintOf(e, 0, 0, 0); return { id: e.id, kind: e.kind, label: e.label, size: [r(f.maxX - f.minX), r(f.maxZ - f.minZ)], districts: e.districts, ...(e.anchorOnly ? { anchorOnly: true } : {}) }; }),
  });
}
