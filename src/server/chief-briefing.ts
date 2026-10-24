/**
 * FREE-05 (CITY-02): what the chief of staff says on a phone call.
 *
 * `ChiefBriefingFn` is the seam FREE-02 can back with the model "brain": it takes an optional question and returns
 * text with its source. Today the only implementation is `ruleBasedBriefing`, a pure projection of the executive
 * roster (ORG-01), the approval inbox (ORG-03) and the capacity report the Telegram /status command already uses.
 * Nothing here calls a model, invents status or writes state; `routeChief` only creates a *pending* plan through the
 * existing consultancy path, which never starts before the CEO approves it.
 */
import type { Approval } from '../shared/approvals.js';
import type { ExecutiveRole, OrgState } from '../shared/org.js';
import { parseChiefRequest, sourceLabel, type ChiefBriefing, type ChiefReply } from '../shared/voice.js';
import { approvalLine } from './approvals.js';

export type ChiefBriefingFn = (question?: string) => Promise<ChiefBriefing> | ChiefBriefing;

export interface BriefingInput {
  now: number;
  org: OrgState;
  approvals?: Approval[];
  /** The plain capacity line (workstations, running workers, queue, blockers). */
  capacity?: string;
}

const TOPICS: { role: ExecutiveRole | 'approvals' | 'capacity'; words: RegExp }[] = [
  { role: 'finance', words: /\b(spend|spent|spending|budget|cost|costs|money|dollars?|usd|bill|paid|pay)\b/i },
  { role: 'operations', words: /\b(queue|queued|task|tasks|running|blocked|work|working|progress|done|stuck)\b/i },
  { role: 'approvals', words: /\b(approv\w*|pending|inbox|decide|decision|waiting)\b/i },
  { role: 'research', words: /\b(research|report|reports|question|proposal|tool)\b/i },
  { role: 'marketing_sales', words: /\b(marketing|sales|campaign|outreach|email|leads?)\b/i },
  { role: 'capacity', words: /\b(workers?|desks?|workstations?|capacity|staff|team|hire)\b/i },
  { role: 'chief_of_staff', words: /\b(status|update|overview|brief\w*|summary|how are|what'?s (new|up|happening)|report)\b/i },
];

/** Pure: the rule-based briefing. A focused question gets the matching sections; an unknown one says what it can't do. */
export function ruleBasedBriefing(input: BriefingInput, question?: string): ChiefBriefing {
  const time = new Date(input.now).toISOString().slice(11, 16);
  const exec = (role: ExecutiveRole) => input.org.executives.find((e) => e.role === role);
  const pending = (input.approvals ?? []).filter((a) => a.status === 'pending');
  const section: Record<string, () => string | undefined> = {
    chief_of_staff: () => { const e = exec('chief_of_staff'); return e && `Chief of staff: ${e.summary}.`; },
    operations: () => { const e = exec('operations'); return e && `Operations: ${e.summary}.`; },
    finance: () => { const e = exec('finance'); return e && `Finance: ${e.summary}.`; },
    research: () => { const e = exec('research'); return e?.active ? `Research: ${e.summary}.` : undefined; },
    marketing_sales: () => { const e = exec('marketing_sales'); return e?.active ? `Marketing and sales: ${e.summary}.` : undefined; },
    approvals: () => pending.length
      ? `Waiting for your approval: ${pending.length}. ${pending.slice(0, 3).map(approvalLine).join('; ')}${pending.length > 3 ? `; and ${pending.length - 3} more` : ''}.`
      : 'Nothing is waiting for your approval.',
    capacity: () => input.capacity && `Capacity: ${input.capacity.replace(/\.$/, '')}.`,
  };
  const q = question?.trim();
  let roles = q ? TOPICS.filter((t) => t.words.test(q)).map((t) => t.role) : [];
  const unknown = !!q && roles.length === 0;
  if (!q || unknown || (roles.length === 1 && roles[0] === 'chief_of_staff')) roles = ['chief_of_staff', 'operations', 'finance', 'approvals', 'capacity', 'research', 'marketing_sales'];
  const lines = [...new Set(roles)].map((r) => section[r]()).filter((l): l is string => !!l);
  const head = `Rule-based report at ${time} UTC, from the office records.`;
  const tail = unknown ? 'I can only report what the office records show; free-form answers need a model-backed chief.' : '';
  return { text: [head, ...lines, tail].filter(Boolean).join('\n'), source: 'rule_based', observedAt: input.now };
}

export interface ChiefRouteDeps {
  briefing: ChiefBriefingFn;
  /** Creates a pending plan through the consultancy path. Must never approve or start it. */
  createJob(title: string, brief: string, requestId: string): { jobId: string; approvalId?: string };
}

/** Routes one confirmed utterance (typed, or a transcript sent once). */
export async function routeChief(text: unknown, deps: ChiefRouteDeps, requestId: string): Promise<ChiefReply> {
  const req = parseChiefRequest(text);
  if (req.kind === 'needs_text') return { kind: 'needs_text', text: req.reason, source: 'rule_based', label: sourceLabel('rule_based'), observedAt: Date.now() };
  if (req.kind === 'new_job') {
    const { jobId, approvalId } = deps.createJob(req.title, req.brief, requestId);
    return {
      kind: 'new_job', source: 'rule_based', label: sourceLabel('rule_based'), observedAt: Date.now(), jobId, approvalId,
      text: `Saved “${req.title}” as plan ${jobId}${approvalId ? `, approval ${approvalId} in your inbox` : ''}. Nothing starts before you approve it.`,
    };
  }
  const b = await deps.briefing(req.question);
  return { ...b, kind: 'briefing', label: sourceLabel(b.source) };
}
