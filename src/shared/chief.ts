// FREE-02 / CONSULT-04: the chief of staff's optional planning brain, shared by server and client.
// The brain only writes PROPOSALS: plans go through the existing job_plan approval, reviews are recommendations,
// and regroup ideas are inbox items. It never approves, spends, accepts work or acts outside the Empire.

import type { ItemPhase } from './org.js';

export type BrainMode = 'off' | 'free' | 'premium';
export type PremiumProvider = 'anthropic' | 'openai';

export interface ChiefSettings {
  mode: BrainMode;
  /** The local Ollama model the free brain uses. */
  freeModel: string;
  premiumProvider: PremiumProvider;
  /** The model id at that provider (the user types it; the Empire ships no model list for paid APIs). */
  premiumModel: string;
  /** USD per million tokens [input, output]. Required for premium so the daily cap can be enforced. */
  premiumPrice?: [number, number];
  /** Premium only: the brain pauses itself once its estimated spend today reaches this. */
  dailyCapUsd: number;
}

export const DEFAULT_CHIEF_SETTINGS: ChiefSettings = { mode: 'off', freeModel: 'gpt-oss:20b', premiumProvider: 'anthropic', premiumModel: '', dailyCapUsd: 2 };
export const MAX_CHIEF_CAP_USD = 100;
export const MAX_PRICE_PER_MTOK = 1000;

/** Bounds on what the model may propose. Anything over them is refused, never trimmed into a "fixed" plan. */
export const PLAN_LIMITS = { items: 8, title: 120, prompt: 2000, summary: 400 } as const;
export const REVIEW_LIMITS = { summary: 600, concerns: 5, concern: 200 } as const;
export const MAX_BRIEF_CHARS = 8000;

export const CHIEF_ROLES = ['engineer', 'frontend_engineer', 'backend_engineer', 'designer', 'qa_tester', 'writer', 'researcher', 'devops', 'analyst'] as const;
export type ChiefRole = (typeof CHIEF_ROLES)[number];
export const ROLE_LABEL: Record<ChiefRole, string> = {
  engineer: 'Engineer', frontend_engineer: 'Frontend engineer', backend_engineer: 'Backend engineer', designer: 'Designer',
  qa_tester: 'QA tester', writer: 'Writer', researcher: 'Researcher', devops: 'DevOps', analyst: 'Analyst',
};
export const isChiefRole = (x: unknown): x is ChiefRole => typeof x === 'string' && (CHIEF_ROLES as readonly string[]).includes(x);

export type PlanSource = 'founder_desk' | 'telegram' | 'api';
export type PlanStatus = 'queued' | 'planning' | 'proposed' | 'needs_attention';

export interface ChiefPlanItem {
  title: string;
  phase: ItemPhase;
  role: ChiefRole;
  parallel: boolean;
  /** 1-based numbers of earlier items this one waits for (as the queue will enforce them). */
  dependsOn: number[];
  /** Review fix 2: the full prompt exactly as queued (with its Role line), so every approval view can show it. */
  prompt: string;
}

export interface ChiefPlan {
  id: string;
  requestId: string;
  client: string;
  title: string;
  source: PlanSource;
  status: PlanStatus;
  /** FREE-06: the product the proposed job would run in; absent = the office's own repository. Still a proposal. */
  productId?: string;
  /** needs_attention: why no plan was proposed. Nothing was created. */
  reason?: string;
  /** proposed: the consultancy job (pending approval) holding the plan. */
  jobId?: string;
  model?: string;
  costLabel?: string;
  summary?: string;
  items?: ChiefPlanItem[];
  /** FREE-10: the approved lessons given to the chief as context for this plan (a snapshot of their text). */
  lessons?: { id: string; text: string; scope: string; scopeValue?: string }[];
  /** FREE-10: the lesson ids the plan says it relies on (always a subset of `lessons`). */
  citedLessons?: string[];
  createdAt: number;
  updatedAt: number;
}

export type ReviewStatus = 'queued' | 'reviewing' | 'reviewed' | 'needs_attention';
export type ReviewRecommendation = 'accept' | 'needs_changes';

export interface ChiefReview {
  /** `${jobId}:${itemId}:${taskId}:${attempt}` */
  key: string;
  jobId: string;
  itemId: string;
  itemTitle: string;
  taskId: string;
  status: ReviewStatus;
  recommendation?: ReviewRecommendation;
  summary?: string;
  concerns?: string[];
  /** What the review was based on, in one line (diff stats, PR, transcript availability). */
  evidence?: string;
  reason?: string;
  model?: string;
  /** FREE-10: a lesson the review proposed (waiting in the inbox), or why one was refused. */
  lessonId?: string;
  lessonNote?: string;
  at: number;
}

export type StallKind = 'held_dependency' | 'repeated_failure' | 'budget_hold';
export const STALL_LABEL: Record<StallKind, string> = { held_dependency: 'Held dependency', repeated_failure: 'Repeated failures', budget_hold: 'Budget hold' };

export interface ChiefStall {
  key: string;
  kind: StallKind;
  jobId: string;
  status: 'queued' | 'thinking' | 'raised' | 'needs_attention';
  approvalId?: string;
  reason?: string;
  /** FREE-10: a lesson proposed from a repeated failure, or why one was refused. */
  lessonId?: string;
  lessonNote?: string;
  at: number;
}

/** FREE-10: "Based on lessons L3, L7" for a plan, or undefined when no lessons were given. */
export function lessonsLine(plan: Pick<ChiefPlan, 'lessons' | 'citedLessons'>): string | undefined {
  if (!plan.lessons?.length) return undefined;
  if (plan.citedLessons?.length) return `Based on lessons ${plan.citedLessons.join(', ')}`;
  return `Lessons given as context: ${plan.lessons.map((l) => l.id).join(', ')} (the plan cites none)`;
}

export interface ChiefBrainStatus {
  mode: BrainMode;
  /** True when proposals can be made right now (configured, key present, not paused). */
  ready: boolean;
  model?: string;
  /** Honest one-line label, e.g. "Free · gpt-oss:20b on this computer · US$0". */
  label: string;
  reason?: string;
}

export interface ChiefBudget {
  kind: 'off' | 'free' | 'premium';
  day: string;
  spentUsd: number;
  capUsd: number;
  paused: boolean;
  note: string;
}

export interface ChiefState {
  schemaVersion: 1;
  settings: ChiefSettings;
  brain: ChiefBrainStatus;
  budget: ChiefBudget;
  /** Model calls waiting for the one running (they run one at a time). */
  pendingCalls: number;
  plans: ChiefPlan[];
  reviews: ChiefReview[];
  stalls: ChiefStall[];
  storageError?: string;
}

export const PROPOSALS_ONLY = 'proposals only';

/** The chief card / inbox tag: "Model-backed · <model> · proposals only" when the brain is on, otherwise rule-based. */
export function chiefTag(brain: Pick<ChiefBrainStatus, 'ready' | 'model'> | undefined): string {
  return brain?.ready && brain.model ? `Model-backed · ${brain.model} · ${PROPOSALS_ONLY}` : 'Rule-based';
}

export const REVIEW_NOTE = 'A recommendation from the chief, not an acceptance. Nothing is accepted and no credits move until you decide.';
export const PLAN_NOTE = 'Proposed by the chief’s model. It is a proposal until you approve it; read every item prompt first.';
