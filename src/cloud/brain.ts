/**
 * FREE-11: the chief's planning brain in cloud mode, kept in `state/brain.json` of the state repository.
 *
 * Pure and browser-safe (the game reads the same file to show settings, spend and requests). The coordinator is the only
 * writer. Money safety follows the office server's chief (FREE-02) and the city architect's guard (CITY-10):
 *
 * - The worst case of a call (an input-token bound plus max_tokens, at the CEO's configured price) is charged and COMMITTED
 *   before the call. The coordinator calls only for charges that name its own run and are already in the state branch.
 * - A daily cap (UTC day) and a cap over the last 30 days (rolling, so a month boundary never resets it) refuse any call
 *   whose worst case would pass them. The spend log keeps the last 30 days.
 * - The charge is replaced by the actual cost only when the provider reports usage; a failed call keeps the worst case.
 * - The clock is GitHub's (the run's own start time), never earlier than the last recorded charge; without it, or with a
 *   runner clock more than 15 minutes off, no paid call is made in that run.
 * - A charge left by another run (crash, cancel, re-run attempt) becomes `uncertain`: kept, and never called again.
 *
 * Output is only ever a proposal: plans become `job_plan` inbox items (every prompt shown), reviews and unblock ideas
 * become `chief_proposal` items. Briefs, job evidence and lessons are untrusted data between random markers.
 * A Claude subscription token is never used, and `claude -p` is not a backend.
 */
import { HOSTED_FREE } from '../shared/engines.js';
import { CHIEF_ROLES, MAX_BRIEF_CHARS, PLAN_LIMITS } from '../shared/chief.js';
import { MAX_EVIDENCE, inputTokenBound, parsePlan, parseReview, parseStallProposal, planMessages, reviewMessages, stallMessages, type ChatMessage } from '../shared/chief-rules.js';
import { relevantLessons } from '../shared/memory.js';
import { hasHiddenChars } from '../shared/text-safety.js';
import { checkOrg, raiseApproval, OrgRuleError, type CloudOrg } from './org.js';
import type { CloudJob } from './schema.js';

export const BRAIN_FILE = 'state/brain.json';
export const BRAIN_PROVIDERS = ['openrouter', 'gemini', 'groq', 'anthropic', 'openai'] as const;
export type BrainProvider = (typeof BRAIN_PROVIDERS)[number];
export const FREE_BRAIN_PROVIDERS: readonly BrainProvider[] = ['openrouter', 'gemini', 'groq'];
export type BrainMode = 'off' | 'free' | 'premium';
export const BRAIN_CALLS_PER_TICK = 2;
export const BRAIN_TOKENS = { plan: 3000, review: 700, unblock: 500 } as const;
export const MAX_CLOCK_SKEW_MS = 15 * 60_000;
export const ROLLING_MS = 30 * 24 * 3600_000;
export const BRAIN_LIMITS = { maxDailyCapCents: 10_000, maxMonthlyCapCents: 100_000, maxFreeCalls: 500, maxPrice: 1000, requests: 100, pending: 12, log: 2000, reason: 300, model: 100, title: 120 } as const;

const SECRET: Record<BrainProvider, string> = { openrouter: 'OPENROUTER_API_KEY', gemini: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };
/** The Actions secret (in the state repository) each provider's key lives in. Only the name is ever checked. */
export const brainSecretName = (p: BrainProvider) => SECRET[p];
export const BRAIN_PROVIDER_LABEL: Record<BrainProvider, string> = {
  openrouter: 'OpenRouter (free models)', gemini: 'Google Gemini API (free tier)', groq: 'Groq (free plan)', anthropic: 'Anthropic API key', openai: 'OpenAI API key',
};
export const isBrainProvider = (x: unknown): x is BrainProvider => typeof x === 'string' && (BRAIN_PROVIDERS as readonly string[]).includes(x);

export interface BrainSettings {
  mode: BrainMode;
  provider: BrainProvider;
  model: string;
  /** Premium: USD per million tokens [input, output]; required and never zero. */
  price?: [number, number];
  dailyCapCents: number;
  /** Applied to the rolling last 30 days. */
  monthlyCapCents: number;
  /** Free tier: calls per UTC day (rate limits; US$0). */
  freeCallsPerDay: number;
  /** Free tier: the provider whose data-use terms the CEO acknowledged, and when. */
  termsAccepted?: { provider: BrainProvider; at: number };
}
export const DEFAULT_BRAIN_SETTINGS: BrainSettings = { mode: 'off', provider: 'openrouter', model: '', dailyCapCents: 200, monthlyCapCents: 2000, freeCallsPerDay: 50 };

export interface BrainCharge { id: string; runId: string; at: number; micros: number; basis: 'worst_case' | 'reported' | 'free'; provider: BrainProvider; model: string }
export type BrainRequestKind = 'plan' | 'review' | 'unblock';
export type BrainRequestStatus = 'queued' | 'charged' | 'done' | 'needs_attention' | 'uncertain';
export interface BrainRequest {
  id: string;
  kind: BrainRequestKind;
  createdAt: number;
  status: BrainRequestStatus;
  title?: string;
  client?: string;
  brief?: string;
  jobId?: string;
  charge?: { runId: string; at: number; worstMicros: number };
  reason?: string;
  approvalId?: string;
  model?: string;
}
export interface CloudBrain { schemaVersion: 1; settings: BrainSettings; clockAt: number; log: BrainCharge[]; requests: BrainRequest[] }

export const emptyBrain = (): CloudBrain => ({ schemaVersion: 1, settings: { ...DEFAULT_BRAIN_SETTINGS }, clockAt: 0, log: [], requests: [] });
export const isEmptyBrain = (b: CloudBrain) => JSON.stringify(b) === JSON.stringify(emptyBrain());

export class BrainRuleError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'BrainRuleError'; }
}
const refuse = (code: string, message: string): never => { throw new BrainRuleError(code, message); };
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const usd = (micros: number) => `$${(micros / 1e6).toFixed(micros > 0 && micros < 10_000 ? 4 : 2)}`;
const centsUsd = (c: number) => `$${(c / 100).toFixed(2)}`;
export const utcDayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

// ---------------------------------------------------------------- settings (intents)

const int = (v: unknown, min: number, max: number, what: string) => { if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) refuse('invalid_settings', `${what} must be a whole number from ${min} to ${max}.`); return v as number; };
const modelId = (v: unknown) => { if (typeof v !== 'string' || !v.trim() || v.length > BRAIN_LIMITS.model || !/^[\w.:/@-]+$/.test(v.trim())) refuse('invalid_settings', 'The model must be the provider’s model id (letters, digits and . : / @ - _).'); return (v as string).trim(); };

/**
 * Checks brain settings from an intent. Off needs only the mode. Premium needs the paid confirmation, a provider with an
 * API key (Anthropic or OpenAI) and a price that is not zero. A free tier needs the acknowledgement of that provider's
 * data-use terms. Never a Claude subscription.
 */
export function checkBrainSettings(raw: Record<string, unknown>, opts: { confirmPaid?: unknown }): Omit<BrainSettings, 'termsAccepted'> & { acceptTerms?: BrainProvider } {
  const allowed = ['mode', 'provider', 'model', 'price', 'dailyCapCents', 'monthlyCapCents', 'freeCallsPerDay', 'acceptTerms'];
  const extra = Object.keys(raw).find((k) => !allowed.includes(k));
  if (extra) refuse('invalid_intent', `Unexpected intent field "${extra.slice(0, 40)}".`);
  if (raw.mode === 'off') return { ...DEFAULT_BRAIN_SETTINGS, mode: 'off' };
  if (raw.mode !== 'free' && raw.mode !== 'premium') refuse('invalid_settings', 'The brain mode must be off, free or premium.');
  if (!isBrainProvider(raw.provider)) refuse('invalid_settings', `The provider must be one of ${BRAIN_PROVIDERS.join(', ')} (a Claude subscription is never used for the brain).`);
  const provider = raw.provider as BrainProvider;
  const free = FREE_BRAIN_PROVIDERS.includes(provider);
  const dailyCapCents = int(raw.dailyCapCents, 1, BRAIN_LIMITS.maxDailyCapCents, 'The daily cap (cents)');
  const monthlyCapCents = int(raw.monthlyCapCents, 1, BRAIN_LIMITS.maxMonthlyCapCents, 'The monthly cap (cents)');
  if (monthlyCapCents < dailyCapCents) refuse('invalid_settings', 'The monthly cap (last 30 days) must be at least the daily cap.');
  const model = modelId(raw.model);
  if (raw.mode === 'free') {
    if (!free) refuse('invalid_settings', 'A free tier is OpenRouter, Gemini or Groq with your own key; Anthropic and OpenAI keys are premium.');
    if (raw.acceptTerms !== provider) refuse('terms_not_accepted', `Read and accept ${BRAIN_PROVIDER_LABEL[provider]}’s data-use terms before turning it on.`);
    if (raw.price !== undefined) refuse('invalid_settings', 'A free tier has no price.');
    const freeCallsPerDay = raw.freeCallsPerDay === undefined ? DEFAULT_BRAIN_SETTINGS.freeCallsPerDay : int(raw.freeCallsPerDay, 1, BRAIN_LIMITS.maxFreeCalls, 'Free calls a day');
    return { mode: 'free', provider, model, dailyCapCents, monthlyCapCents, freeCallsPerDay, acceptTerms: provider };
  }
  if (free) refuse('invalid_settings', 'Premium uses your Anthropic or OpenAI API key.');
  if (opts.confirmPaid !== true) refuse('confirm_paid', 'Turning on the premium brain spends money: confirm the caps (confirmPaid).');
  if (raw.acceptTerms !== undefined) refuse('invalid_settings', 'acceptTerms is for a free tier.');
  const p = raw.price;
  if (p === undefined || p === null) refuse('invalid_settings', 'Set the price per million tokens so the caps can be enforced.');
  if (!Array.isArray(p) || p.length !== 2 || p.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > BRAIN_LIMITS.maxPrice)) refuse('invalid_settings', `The price must be [input, output] USD per million tokens, each 0–${BRAIN_LIMITS.maxPrice}.`);
  if ((p as number[])[0] === 0 || (p as number[])[1] === 0) refuse('zero_price', 'A paid API price cannot be zero; the caps could not be enforced.');
  return { mode: 'premium', provider, model, price: [(p as number[])[0], (p as number[])[1]], dailyCapCents, monthlyCapCents, freeCallsPerDay: DEFAULT_BRAIN_SETTINGS.freeCallsPerDay };
}

export function applyBrainSettings(brain: CloudBrain, checked: ReturnType<typeof checkBrainSettings>, now: number): void {
  const { acceptTerms, ...settings } = checked;
  if (settings.mode === 'off') { brain.settings = { ...brain.settings, mode: 'off' }; return; }
  brain.settings = { ...settings, ...(acceptTerms ? { termsAccepted: { provider: acceptTerms, at: now } } : {}) };
}

/** Checks a brain request from an intent (strict fields; untrusted text screened). */
export function checkBrainRequest(raw: Record<string, unknown>, isJobId: (v: unknown) => boolean): Pick<BrainRequest, 'kind' | 'title' | 'client' | 'brief' | 'jobId'> {
  const keys = raw.kind === 'plan' ? ['kind', 'title', 'client', 'brief'] : ['kind', 'jobId'];
  if (raw.kind !== 'plan' && raw.kind !== 'review' && raw.kind !== 'unblock') refuse('invalid_intent', 'A brain request is a plan, review or unblock.');
  const extra = Object.keys(raw).find((k) => !keys.includes(k));
  if (extra) refuse('invalid_intent', `Unexpected intent field "${extra.slice(0, 40)}".`);
  if (raw.kind !== 'plan') { if (!isJobId(raw.jobId)) refuse('invalid_intent', 'jobId must be a UUID.'); return { kind: raw.kind as BrainRequestKind, jobId: String(raw.jobId).toLowerCase() }; }
  const text = (v: unknown, max: number, what: string, required: boolean) => {
    if (v === undefined && !required) return undefined;
    if (typeof v !== 'string' || !v.trim()) refuse('invalid_intent', `Write the ${what} first.`);
    const t = (v as string).trim();
    if (t.length > max) refuse('invalid_intent', `The ${what} is at most ${max} characters.`);
    if (hasHiddenChars(t)) refuse('invalid_intent', `The ${what} contains invisible or control characters.`);
    return t;
  };
  const title = text(raw.title, BRAIN_LIMITS.title, 'title', true)!;
  const client = text(raw.client, 120, 'client', false);
  const brief = text(raw.brief, MAX_BRIEF_CHARS, 'brief', true)!;
  if (/\n/.test(title) || (client && /\n/.test(client))) refuse('invalid_intent', 'The title and client are one line each.');
  return { kind: 'plan', title, ...(client ? { client } : {}), brief };
}

// ---------------------------------------------------------------- clock and spend

/** GitHub's time for this run, checked against the runner, never earlier than the last recorded charge. */
export function trustedClock(github: number | undefined, runner: number, clockAt: number): { at: number } | { reason: string } {
  if (github === undefined || !Number.isFinite(github)) return { reason: 'GitHub’s time for this run could not be read, so no paid call or send was made this run.' };
  if (Math.abs(runner - github) > MAX_CLOCK_SKEW_MS) return { reason: 'The runner’s clock differs from GitHub’s by more than 15 minutes, so no paid call or send was made this run.' };
  return { at: Math.max(github, clockAt) };
}

export function brainSpend(brain: CloudBrain, at: number): { todayMicros: number; rollingMicros: number; callsToday: number } {
  const day = utcDayOf(at);
  let todayMicros = 0; let rollingMicros = 0; let callsToday = 0;
  for (const e of brain.log) {
    if (utcDayOf(e.at) === day) { todayMicros += e.micros; callsToday++; }
    if (e.at > at - ROLLING_MS) rollingMicros += e.micros;
  }
  return { todayMicros, rollingMicros, callsToday };
}

const priceMicros = (price: [number, number], input: number, output: number) => Math.ceil(input * price[0] + output * price[1]);

// ---------------------------------------------------------------- requests (coordinator)

export function queueBrainRequest(brain: CloudBrain, req: Pick<BrainRequest, 'kind' | 'title' | 'client' | 'brief' | 'jobId'>, ctx: { now: number; intentId: string }, jobs: readonly CloudJob[]): BrainRequest {
  if (brain.settings.mode === 'off') refuse('brain_off', 'The chief’s brain is off in cloud mode. Turn it on from the chief’s card first; nothing was charged.');
  if (req.jobId) {
    const job = jobs.find((j) => j.id === req.jobId) ?? refuse('job_not_found', 'No such cloud job in the current job list.');
    if (req.kind === 'review' && !['awaiting_review', 'accepted', 'rejected'].includes(job.status)) refuse('not_reviewable', 'Only a finished turn can be reviewed by the chief.');
    if (req.kind === 'unblock' && !['failed', 'dispatch_uncertain', 'unknown', 'cancelled', 'budget_paused'].includes(job.status)) refuse('not_stalled', 'The chief suggests how to unblock failed, uncertain or paused jobs only.');
  }
  if (brain.requests.filter((r) => r.status === 'queued' || r.status === 'charged').length >= BRAIN_LIMITS.pending) refuse('brain_busy', `${BRAIN_LIMITS.pending} requests are already waiting for the chief. Let them finish first.`);
  if (brain.requests.length >= BRAIN_LIMITS.requests) {
    const old = brain.requests.filter((r) => r.status !== 'queued' && r.status !== 'charged').sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!old) refuse('brain_busy', 'Too many requests are open.');
    brain.requests = brain.requests.filter((r) => r !== old);
  }
  const item: BrainRequest = { id: ctx.intentId, ...req, createdAt: ctx.now, status: 'queued' };
  brain.requests.push(item);
  return item;
}

/** The messages and token budget of one call, built from the committed state. */
export interface PlannedCall { requestId: string; provider: BrainProvider; model: string; messages: ChatMessage[]; maxTokens: number; lessonIds: string[] }

function jobEvidence(job: CloudJob): string {
  return [
    `Job: ${job.title}`,
    `Instructions given to the worker (first 200 characters): ${job.promptPreview}`,
    `Status: ${job.status.replace(/_/g, ' ')} · ${job.message.slice(0, 600)}`,
    `Runs on: ${job.provider === 'github-actions' ? 'GitHub Actions' : 'Anthropic Managed Agents'} · branch ${job.branch}`,
    `Cost: ${job.cost ? `${job.cost.amountCents} cents (${job.cost.basis.replace(/_/g, ' ')})` : 'not reported'}`,
    `Outputs: ${job.outputs} (not verified by the Empire)`,
    `Your review: ${job.review ? job.review.decision : 'not reviewed yet'}`,
    'Worker transcript summary: not available in cloud mode',
  ].join('\n').slice(0, MAX_EVIDENCE);
}

function buildCall(brain: CloudBrain, req: BrainRequest, org: CloudOrg, jobs: readonly CloudJob[]): Omit<PlannedCall, 'requestId' | 'provider' | 'model'> | { error: string } {
  if (req.kind === 'plan') {
    const brief = { client: req.client ?? 'Your company', title: req.title ?? 'Plan', brief: req.brief ?? '' };
    const lessons = relevantLessons(org.lessons, brief).slice(0, 20);
    return { messages: planMessages(brief, lessons), maxTokens: BRAIN_TOKENS.plan, lessonIds: lessons.map((l) => l.id) };
  }
  const job = jobs.find((j) => j.id === req.jobId);
  if (!job) return { error: 'The job is no longer in the job list, so nothing was asked and nothing was charged.' };
  if (req.kind === 'review') return { messages: reviewMessages(job.title, jobEvidence(job), false), maxTokens: BRAIN_TOKENS.review, lessonIds: [] };
  return { messages: stallMessages('repeated_failure', jobEvidence(job), false), maxTokens: BRAIN_TOKENS.unblock, lessonIds: [] };
}

/**
 * Phase 1 of a run: marks stale charges uncertain, then charges up to BRAIN_CALLS_PER_TICK queued requests (oldest first)
 * at their worst case, within the caps. Returns the calls to make once this state is committed.
 */
export function chargeBrain(brain: CloudBrain, org: CloudOrg, jobs: readonly CloudJob[], ctx: { now: number; runId: string }, clock: { at: number } | { reason: string }): PlannedCall[] {
  const note = (r: BrainRequest, reason: string) => { const t = short(reason, BRAIN_LIMITS.reason); if (r.reason !== t) r.reason = t; };
  for (const r of brain.requests) {
    if (r.status === 'charged' && r.charge?.runId !== ctx.runId) {
      r.status = 'uncertain';
      note(r, `Coordinator run ${short(r.charge?.runId ?? 'unknown', 60)} charged this call but did not record an answer (it stopped, was cancelled or re-run). Its worst case stays charged and it is never called again. Ask again if you still need it.`);
    }
  }
  const s = brain.settings;
  const queued = brain.requests.filter((r) => r.status === 'queued').sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  if (s.mode === 'off') { for (const r of queued) { r.status = 'needs_attention'; note(r, 'The brain was turned off before this ran; nothing was charged.'); } return []; }
  if (!queued.length) return [];
  if ('reason' in clock) { for (const r of queued) note(r, `Waiting: ${clock.reason}`); return []; }
  const planned: PlannedCall[] = [];
  for (const r of queued) {
    if (planned.length >= BRAIN_CALLS_PER_TICK) break;
    const built = buildCall(brain, r, org, jobs);
    if ('error' in built) { r.status = 'needs_attention'; note(r, built.error); continue; }
    const spend = brainSpend(brain, clock.at);
    let micros = 0;
    if (s.mode === 'premium') {
      if (!s.price || s.price[0] <= 0 || s.price[1] <= 0) { note(r, 'Waiting: no valid price is set, so the caps cannot be enforced.'); break; }
      micros = priceMicros(s.price, inputTokenBound(built.messages), built.maxTokens);
      if (spend.todayMicros + micros > s.dailyCapCents * 10_000) { note(r, `Waiting: this call could cost up to ${usd(micros)}, which would pass today’s ${centsUsd(s.dailyCapCents)} daily cap (${usd(spend.todayMicros)} used, UTC day). It runs once there is room, or raise the cap.`); break; }
      if (spend.rollingMicros + micros > s.monthlyCapCents * 10_000) { note(r, `Waiting: this call could cost up to ${usd(micros)}, which would pass the ${centsUsd(s.monthlyCapCents)} cap for the last 30 days (${usd(spend.rollingMicros)} used). It runs once older charges roll out of the window, or raise the cap.`); break; }
    } else if (spend.callsToday >= s.freeCallsPerDay) { note(r, `Waiting: ${s.freeCallsPerDay} free-tier calls a day are already used (UTC day). It runs tomorrow, or raise the limit.`); break; }
    brain.log.push({ id: r.id, runId: ctx.runId, at: clock.at, micros, basis: s.mode === 'premium' ? 'worst_case' : 'free', provider: s.provider, model: s.model });
    r.status = 'charged';
    r.charge = { runId: ctx.runId, at: clock.at, worstMicros: micros };
    delete r.reason;
    brain.clockAt = Math.max(brain.clockAt, clock.at);
    planned.push({ requestId: r.id, provider: s.provider, model: s.model, ...built });
  }
  brain.log = brain.log.filter((e) => e.at > brain.clockAt - ROLLING_MS).slice(-BRAIN_LIMITS.log);
  return planned;
}

export type BrainResult = { requestId: string; lessonIds: string[]; ok: { text: string; model?: string; usage: { input: number; output: number } } } | { requestId: string; lessonIds: string[]; error: string };

const cleanModel = (m: string | undefined, fallback: string) => (m && /^[\w.:/@-]{1,100}$/.test(m) ? m : fallback);

/**
 * Phase 2: records each answer for a charge of THIS run. The actual cost replaces the worst case only when usage was
 * reported. Valid answers become inbox proposals; anything else needs attention with the reason (nothing is guessed).
 */
export function recordBrainResults(brain: CloudBrain, org: CloudOrg, jobs: readonly CloudJob[], results: BrainResult[], ctx: { now: number; runId: string }): void {
  const s = brain.settings;
  for (const result of results) {
    const r = brain.requests.find((x) => x.id === result.requestId);
    if (!r || r.status !== 'charged' || r.charge?.runId !== ctx.runId) continue;
    const entry = brain.log.find((e) => e.id === r.id && e.runId === ctx.runId);
    const attention = (reason: string) => { r.status = 'needs_attention'; r.reason = short(reason, BRAIN_LIMITS.reason); };
    if ('error' in result) { attention(`The model call failed (${short(result.error, 160)}). ${entry && entry.micros > 0 ? 'It may still have been billed, so its worst case stays charged.' : 'Nothing was charged.'}`); continue; }
    const usage = result.ok.usage;
    if (entry && entry.basis === 'worst_case' && s.price && usage.input + usage.output > 0) { entry.micros = priceMicros(s.price, usage.input, usage.output); entry.basis = 'reported'; }
    const model = cleanModel(result.ok.model, entry?.model ?? s.model);
    r.model = model;
    const costLabel = !entry || entry.basis === 'free' ? 'US$0 · free tier (rate-limited)' : `≈ ${usd(entry.micros)} (${entry.basis === 'reported' ? 'estimate from reported usage' : 'worst case; no usage reported'})`;
    const before = JSON.stringify(org);
    try {
      let approvalId: string;
      if (r.kind === 'plan') {
        const parsed = parsePlan(result.ok.text, result.lessonIds);
        if ('error' in parsed) { attention(`The answer was not used: ${parsed.error}.`); continue; }
        const lessons = org.lessons.filter((l) => result.lessonIds.includes(l.id)).map((l) => ({ id: l.id, text: l.text }));
        const items = parsed.ok.items.map((i) => ({ title: i.title, prompt: i.prompt, phase: i.phase, role: i.role, parallel: i.parallel, dependsOn: i.dependsOn }));
        approvalId = raiseApproval(org, {
          kind: 'job_plan', jobId: '', createdAt: ctx.now, title: short(`Plan: ${r.title ?? 'untitled'}`, 200),
          detail: short(`Alex · Chief of staff proposes ${items.length} item${items.length === 1 ? '' : 's'} for “${r.client ? `${r.client} · ` : ''}${r.title}”. Approving records your decision; each item becomes paid work only when you submit it and confirm the spend.`, 600),
          proposedBy: `Model-backed · ${model} · proposals only`,
          plan: { requestId: r.id, ...(r.client ? { client: r.client } : {}), title: r.title ?? 'Plan', ...(parsed.ok.summary ? { summary: parsed.ok.summary } : {}), items, ...(lessons.length ? { lessons } : {}), ...(parsed.ok.lessons?.length ? { citedLessons: parsed.ok.lessons } : {}), costLabel },
        }).id;
      } else {
        const job = jobs.find((j) => j.id === r.jobId);
        let text: string;
        if (r.kind === 'review') {
          const parsed = parseReview(result.ok.text);
          if ('error' in parsed) { attention(`The answer was not used: ${parsed.error}.`); continue; }
          text = `Recommends ${parsed.ok.recommendation === 'accept' ? 'accept' : 'needs changes'}: ${parsed.ok.summary}${parsed.ok.concerns.length ? ` Concerns: ${parsed.ok.concerns.join('; ')}` : ''}`;
        } else {
          const parsed = parseStallProposal(result.ok.text);
          if ('error' in parsed) { attention(`The answer was not used: ${parsed.error}.`); continue; }
          text = parsed.ok;
        }
        const title = job?.title ?? 'a cloud job';
        approvalId = raiseApproval(org, {
          kind: 'chief_proposal', jobId: r.jobId ?? '', createdAt: ctx.now,
          title: short(`${r.kind === 'review' ? 'Review' : 'Unblock'}: ${title}`, 200),
          detail: r.kind === 'review' ? 'Alex · Chief of staff (model-backed) reviewed a finished cloud job. Deciding records your decision only; the job’s own review is unchanged.' : 'Alex · Chief of staff (model-backed) suggests how to unblock a cloud job. Deciding records your decision only; nothing is retried or spent.',
          proposal: { situation: short(`${r.kind === 'review' ? 'Review of' : 'Stalled:'} “${title}” (${(job?.status ?? 'unknown').replace(/_/g, ' ')}) · ${costLabel}`, 300), text: short(text, 1200), model },
        }).id;
      }
      checkOrg(org);
      r.status = 'done'; r.approvalId = approvalId; delete r.reason;
    } catch (error) {
      Object.assign(org, JSON.parse(before));
      attention(error instanceof OrgRuleError ? error.message : 'The proposal could not be recorded.');
    }
  }
}

// ---------------------------------------------------------------- validation

export class BrainSchemaError extends Error {
  constructor(message: string) { super(`${BRAIN_FILE}: ${message}`); this.name = 'BrainSchemaError'; }
}
type Rec = Record<string, unknown>;
function obj(value: unknown, keys: readonly string[], what: string): Rec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrainSchemaError(`${what} must be an object`);
  const extra = Object.keys(value).find((k) => !keys.includes(k));
  if (extra) throw new BrainSchemaError(`unexpected ${what} field ${extra.slice(0, 40)}`);
  return value as Rec;
}
const num = (v: unknown, what: string) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new BrainSchemaError(`invalid ${what}`); return v; };
const str = (v: unknown, max: number, what: string) => { if (typeof v !== 'string' || v.length > max) throw new BrainSchemaError(`invalid ${what}`); return v; };

export function validateBrain(value: unknown): CloudBrain {
  const b = obj(value, ['schemaVersion', 'settings', 'clockAt', 'log', 'requests'], 'brain');
  if (b.schemaVersion !== 1) throw new BrainSchemaError('unsupported schemaVersion');
  const s = obj(b.settings, ['mode', 'provider', 'model', 'price', 'dailyCapCents', 'monthlyCapCents', 'freeCallsPerDay', 'termsAccepted'], 'settings');
  if (!['off', 'free', 'premium'].includes(String(s.mode)) || !isBrainProvider(s.provider)) throw new BrainSchemaError('invalid settings');
  str(s.model, BRAIN_LIMITS.model, 'model');
  for (const k of ['dailyCapCents', 'monthlyCapCents', 'freeCallsPerDay']) if (!Number.isSafeInteger(s[k]) || (s[k] as number) < 1) throw new BrainSchemaError(`invalid ${k}`);
  if (s.price !== undefined && (!Array.isArray(s.price) || s.price.length !== 2 || s.price.some((n) => typeof n !== 'number' || !(n > 0) || n > BRAIN_LIMITS.maxPrice))) throw new BrainSchemaError('invalid price');
  if (s.mode === 'premium' && (s.price === undefined || FREE_BRAIN_PROVIDERS.includes(s.provider as BrainProvider))) throw new BrainSchemaError('premium needs an API provider and a price');
  if (s.termsAccepted !== undefined) { const t = obj(s.termsAccepted, ['provider', 'at'], 'terms'); if (!isBrainProvider(t.provider)) throw new BrainSchemaError('invalid terms'); num(t.at, 'terms time'); }
  if (s.mode === 'free' && (s.termsAccepted as Rec | undefined)?.provider !== s.provider) throw new BrainSchemaError('a free tier needs its terms accepted');
  num(b.clockAt, 'clock');
  if (!Array.isArray(b.log) || b.log.length > BRAIN_LIMITS.log) throw new BrainSchemaError('invalid log');
  for (const e of b.log) {
    const x = obj(e, ['id', 'runId', 'at', 'micros', 'basis', 'provider', 'model'], 'charge');
    str(x.id, 80, 'charge id'); str(x.runId, 80, 'charge run'); num(x.at, 'charge time'); num(x.micros, 'charge'); str(x.model, BRAIN_LIMITS.model, 'charge model');
    if (!['worst_case', 'reported', 'free'].includes(String(x.basis)) || !isBrainProvider(x.provider)) throw new BrainSchemaError('invalid charge');
  }
  if (!Array.isArray(b.requests) || b.requests.length > BRAIN_LIMITS.requests) throw new BrainSchemaError('invalid requests');
  const ids = new Set<string>();
  for (const item of b.requests) {
    const r = obj(item, ['id', 'kind', 'createdAt', 'status', 'title', 'client', 'brief', 'jobId', 'charge', 'reason', 'approvalId', 'model'], 'request');
    if (typeof r.id !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(r.id) || ids.has(r.id)) throw new BrainSchemaError('invalid request id');
    ids.add(r.id);
    if (!['plan', 'review', 'unblock'].includes(String(r.kind)) || !['queued', 'charged', 'done', 'needs_attention', 'uncertain'].includes(String(r.status))) throw new BrainSchemaError('invalid request');
    num(r.createdAt, 'request time');
    if (r.title !== undefined) str(r.title, BRAIN_LIMITS.title, 'request title');
    if (r.client !== undefined) str(r.client, 120, 'request client');
    if (r.brief !== undefined) str(r.brief, MAX_BRIEF_CHARS, 'request brief');
    if (r.jobId !== undefined) str(r.jobId, 80, 'request job');
    if (r.reason !== undefined) str(r.reason, BRAIN_LIMITS.reason, 'request reason');
    if (r.approvalId !== undefined) str(r.approvalId, 12, 'request approval');
    if (r.model !== undefined) str(r.model, BRAIN_LIMITS.model, 'request model');
    if (r.charge !== undefined) { const c = obj(r.charge, ['runId', 'at', 'worstMicros'], 'request charge'); str(c.runId, 80, 'charge run'); num(c.at, 'charge time'); num(c.worstMicros, 'charge'); }
    if (r.status === 'charged' && r.charge === undefined) throw new BrainSchemaError('a charged request needs its charge');
  }
  return JSON.parse(JSON.stringify(b)) as CloudBrain;
}

/** The game's view of the brain: mode label, spend against the caps, and what is waiting. */
export function brainStatus(brain: CloudBrain, now: number): { label: string; ready: boolean; note: string; todayUsd: string; rollingUsd: string; callsToday: number } {
  const s = brain.settings;
  const sp = brainSpend(brain, Math.max(now, brain.clockAt));
  const label = s.mode === 'off' ? 'Off · rule-based chief'
    : s.mode === 'free' ? `Free · ${s.model} · ${BRAIN_PROVIDER_LABEL[s.provider]} · ${s.freeCallsPerDay} calls a day`
    : `Premium · ${s.model} · your ${s.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} key · ${centsUsd(s.dailyCapCents)}/day, ${centsUsd(s.monthlyCapCents)}/30 days`;
  const note = s.mode === 'off' ? 'No model calls. Plans, reviews and unblock ideas need the brain on.'
    : s.mode === 'free' ? `US$0 · ${sp.callsToday} of ${s.freeCallsPerDay} free-tier calls today. ${BRAIN_PROVIDER_LABEL[s.provider]} may log or train on prompts: see its terms.`
    : `Charged ${usd(sp.todayMicros)} today and ${usd(sp.rollingMicros)} in the last 30 days (worst case until usage is reported; estimates from your price). Separate from city credits and job spend.`;
  return { label, ready: s.mode !== 'off', note, todayUsd: usd(sp.todayMicros), rollingUsd: usd(sp.rollingMicros), callsToday: sp.callsToday };
}

export const PLAN_ROLE_HINT = `Roles: ${CHIEF_ROLES.join(', ')}. At most ${PLAN_LIMITS.items} items.`;
export const HOSTED_TERMS = HOSTED_FREE;
