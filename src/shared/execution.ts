/** Configuration contains references only. Credentials never cross these HTTP contracts. */
export type ExecutionMode = 'local' | 'vps' | 'anthropic_cloud';
export interface ExecutionConfig {
  schemaVersion: 1;
  completed: boolean;
  mode: ExecutionMode;
  repository: { owner: string; name: string; baseBranch: string };
  anthropic: { agentId: string; environmentId: string; vaultId?: string };
  githubAuth: 'host_token';
  limits: { maxConcurrent: number; perTaskBudgetCents: number; dailyBudgetCents: number };
}

export interface ExecutionSetup {
  config: ExecutionConfig;
  configRevision: number;
  credentials: { anthropic: boolean; github: boolean };
  check: { status: 'unchecked' | 'ready' | 'blocked'; checkedAt?: number; message?: string };
  ready: boolean;
  notices: string[];
  storageError?: string;
}

/** Reuse this ID when a submission response is lost; a new ID authorizes another paid task. */
export interface ExecutionSubmit {
  id: string;
  prompt: string;
  configRevision: number;
  confirmPaid: true;
}

export type ExecutionTaskStatus =
  | 'dispatch_uncertain' | 'running' | 'waiting_for_approval' | 'budget_paused'
  | 'idle' | 'unknown' | 'completed' | 'failed' | 'cancelled';

export interface ExecutionTask {
  id: string;
  provider: 'anthropic';
  mode: 'anthropic_cloud';
  status: ExecutionTaskStatus;
  prompt: string;
  createdAt: number;
  updatedAt: number;
  repository: ExecutionConfig['repository'];
  sourceCommit: string;
  branch: string;
  sessionId?: string;
  eventCursor?: string;
  reservedCents: number;
  budgetDay: string;
  cost?: { amountCents: number; currency: 'USD'; observedAt: number };
  providerStatus?: 'running' | 'idle' | 'terminated' | 'archived';
  stopReason?: 'end_turn' | 'requires_action' | 'budget_reached' | 'error' | 'unknown';
  message: string;
  /** A provider idle/terminated state alone never verifies code, a branch, or a pull request. */
  outputs: 'unverified';
}

export interface ExecutionTaskList { tasks: ExecutionTask[] }
