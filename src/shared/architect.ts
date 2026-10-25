/**
 * CITY-10: the city architect's settings and the state the office host reports (shared by server and client).
 * Off by default; own-server installs only. Provider spend is an estimate with its own caps and is never city credits.
 */
import type { AppliedChange, ArchitectEngine, AvoidRule, WorldDocument } from './world.js';
import type { JournalIdea } from './world-journal.js';

export interface ArchitectSettings {
  enabled: boolean;
  paused: boolean;
  engine: ArchitectEngine;
  /** Local hour (0–23) of the daily run. */
  runHour: number;
  maxChangesPerRun: number;
  /** Premium only: estimated USD, checked against the worst case before each call. */
  dailyCapUsd: number;
  monthlyCapUsd: number;
}

export const DEFAULT_ARCHITECT_SETTINGS: ArchitectSettings = { enabled: false, paused: false, engine: 'rules', runHour: 3, maxChangesPerRun: 3, dailyCapUsd: 0.05, monthlyCapUsd: 1 };
export const ARCHITECT_LIMITS = { maxChangesPerRun: 5, maxDailyCapUsd: 1, maxMonthlyCapUsd: 10, minCapUsd: 0.01, undoDays: 30, outputTokens: 900 } as const;
export const CLOUD_ARCHITECT_NOTE = 'The city architect is not available in cloud mode yet. It runs on your own server (an office host or a VPS).';
export const ARCHITECT_TITLE = 'Let the city grow while you’re away';

export type RunStatus = 'running' | 'applied' | 'no_changes' | 'rejected' | 'interrupted';
export interface RunRecord {
  id: string;
  day: string;
  trigger: 'schedule' | 'manual';
  /** The engine that produced the changes (rules when a model engine was not usable). */
  engine: ArchitectEngine;
  engineLabel: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  /** rejected: why nothing changed. */
  reason?: string;
  /** e.g. why rule-based growth ran instead of the chosen engine. */
  note?: string;
  changes: AppliedChange[];
  /** Estimated USD charged for this run (worst case unless the provider reported usage). */
  costUsd: number;
  worstUsd?: number;
  costLabel: string;
  approvalId?: string;
  reverted?: boolean;
}

export interface ArchitectBudget { day: string; month: string; spentTodayUsd: number; spentMonthUsd: number; dailyCapUsd: number; monthlyCapUsd: number; paused: boolean; note: string }

export interface ArchitectState {
  schemaVersion: 1;
  available: boolean;
  unavailableReason?: string;
  settings: ArchitectSettings;
  engine: { label: string; ready: boolean; reason?: string };
  budget: ArchitectBudget;
  /** When the next scheduled run is due (local time), while enabled and not paused. */
  nextRunAt?: number;
  running: boolean;
  /** Runs within the 30-day undo window, newest first. */
  runs: RunRecord[];
  world: WorldDocument;
  journal: { entries: number; ideas: JournalIdea[]; avoid: AvoidRule[] };
  storageError?: string;
}

export const ENGINE_TEXT: Record<ArchitectEngine, { title: string; note: string }> = {
  rules: { title: 'Rule-based growth · US$0', note: 'A deterministic generator follows the style guide. No model is called.' },
  free: { title: 'Free local model · US$0', note: 'The chief’s local Ollama model proposes the changes. Falls back to rule-based growth when Ollama is not ready.' },
  premium: { title: 'Premium · your API key', note: 'The chief’s provider, model and price. Capped per day and per month from estimates; pauses itself at a cap.' },
};
