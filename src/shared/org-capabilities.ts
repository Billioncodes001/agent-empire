// FREE-07: what the organization features can do on an office server versus in cloud mode (the Empire in the user's
// GitHub state repository, coordinated by a scheduled Actions workflow). One table, so every "not in cloud mode" message
// in the game comes from here and names the specific reason; tests check that every gap has one.

import type { ApprovalKind } from './approvals.js';

export type CloudSupport = 'works' | 'partial' | 'unavailable';

export interface OrgCapability {
  label: string;
  /** What the office server does. */
  local: string;
  cloud: CloudSupport;
  /** What cloud mode does, in one line. */
  cloudSummary: string;
  /** Why part (or all) of it can't run in cloud mode. Required unless `cloud` is `works`. */
  reason?: string;
  /** What the user can do instead, if anything. */
  instead?: string;
}

export type OrgFeature =
  | 'inbox' | 'job_plan' | 'budget_increase' | 'external_action' | 'tool_proposal' | 'chief_proposal' | 'lesson'
  | 'executives' | 'chief_brain' | 'research' | 'outreach' | 'memory' | 'notifications' | 'founder_desk';

export const ORG_CAPABILITIES: Record<OrgFeature, OrgCapability> = {
  inbox: {
    label: 'Approval inbox',
    local: 'Every kind of item, decided in the game, on the founder desk or in Telegram.',
    cloud: 'partial',
    cloudSummary: 'Tool proposals and lessons are decided in the game; your coordinator applies each decision on its next run.',
    reason: 'Client plans, budget increases, campaign sends and chief proposals are never raised in cloud mode (see each kind).',
  },
  job_plan: {
    label: 'Client plans',
    local: 'A saved client job waits in the inbox with its estimate; approving queues its items.',
    cloud: 'unavailable',
    cloudSummary: 'Not raised.',
    reason: 'Cloud mode has no consultancy journal or estimates. Each cloud job is approved when you submit it: the paid confirmation names its allowance and is checked against your current limits.',
    instead: 'Submit work from Cloud Empire → New job.',
  },
  budget_increase: {
    label: 'Budget increases',
    local: 'A job that reached its approved budget holds its unstarted items until you raise it.',
    cloud: 'unavailable',
    cloudSummary: 'Not raised.',
    reason: 'A cloud job can never spend more than the per-job allowance you confirmed: the provider session or Actions run is capped at it, and the coordinator cannot raise the cap of a running session.',
    instead: 'Raise the allowance under Cloud Empire → Limits and submit a new job.',
  },
  external_action: {
    label: 'Campaign sends',
    local: 'Jordan raises the exact message and every recipient; approving sends it over SMTP.',
    cloud: 'unavailable',
    cloudSummary: 'Not raised: outreach does not run in cloud mode.',
    reason: 'A campaign send is email over your SMTP server, paced and capped per day; the cloud coordinator holds no SMTP password and runs only every 15–60 minutes (see Email outreach).',
  },
  tool_proposal: {
    label: 'Tool proposals',
    local: 'Raised from research reports; approving records your decision only.',
    cloud: 'works',
    cloudSummary: 'Raised from cloud research reports; approving records your decision only.',
  },
  chief_proposal: {
    label: 'Chief proposals',
    local: 'The chief’s model suggests how to unblock stalled work.',
    cloud: 'unavailable',
    cloudSummary: 'Not raised.',
    reason: 'Only the chief’s model writes them, and the chief has no model in cloud mode (see Chief’s planning brain).',
  },
  lesson: {
    label: 'Lessons',
    local: 'Proposed by you or the chief’s model; approving makes a lesson planning context.',
    cloud: 'works',
    cloudSummary: 'Lessons you write are decided in the inbox. The chief proposes none, because it has no model in cloud mode.',
  },
  executives: {
    label: 'Executives',
    local: 'Rule-based cards computed from the live queue, workers, client jobs, usage, outreach and reports.',
    cloud: 'partial',
    cloudSummary: 'Rule-based cards computed from the last snapshot of your cloud jobs, spend ledger, research and inbox, labelled with its age.',
    reason: 'There is no live queue or desk worker in cloud mode, so the cards summarise cloud jobs instead, and marketing has no outreach to coordinate.',
  },
  chief_brain: {
    label: 'Chief’s planning brain',
    local: 'Off, free (Ollama on this computer) or premium (your API key, with a daily cap).',
    cloud: 'unavailable',
    cloudSummary: 'The chief is rule-based in cloud mode.',
    reason: 'The free brain needs Ollama on your computer; GitHub-hosted runners have none. A premium brain would need a model API key as another Actions secret and a daily cap the coordinator enforces; that is not built, and the coordinator calls no model. A Claude subscription is never relayed into the cloud.',
    instead: 'Use the brain on your own server or the desktop app (Run on this computer).',
  },
  research: {
    label: 'Research',
    local: 'A question becomes an internal job needing approval; the report is imported from the worker’s worktree.',
    cloud: 'works',
    cloudSummary: 'A question becomes a paid cloud job you confirm; when its turn finishes, the coordinator imports the report from the task branch and raises its tool proposals.',
  },
  outreach: {
    label: 'Email outreach',
    local: 'Leads, suppression, drafted campaigns and paced sending over your SMTP server.',
    cloud: 'unavailable',
    cloudSummary: 'Not available in cloud mode.',
    reason: 'Sending needs your SMTP password as an Actions secret, and the coordinator runs every 15–60 minutes, so it cannot pace sends or keep a daily cap. Leads and opt-outs are personal data: in the state repository, git history would keep them after deletion. There is no Telegram /optout in cloud mode either.',
    instead: 'Run outreach on your own server.',
  },
  memory: {
    label: 'Organizational memory',
    local: 'Reviewed lessons with provenance; approved lessons are cited when the chief plans.',
    cloud: 'partial',
    cloudSummary: 'Add, edit, approve, decline and retire lessons; export them as Markdown.',
    reason: 'No plan cites a lesson in cloud mode, because the chief has no planning brain there.',
  },
  notifications: {
    label: 'Telegram and email notifications',
    local: 'Each new inbox item is announced; Telegram can decide it.',
    cloud: 'unavailable',
    cloudSummary: 'The game’s inbox badge shows what is waiting.',
    reason: 'They need a bot token or SMTP password and an always-on poller; the coordinator runs on a schedule and holds neither.',
  },
  founder_desk: {
    label: 'Founder desk page',
    local: 'Client jobs, estimates, outreach and memory on /consultancy.html.',
    cloud: 'unavailable',
    cloudSummary: 'Use the in-game inbox, executive cards and Cloud Empire window.',
    reason: 'It is served by the office server’s HTTP API, which cloud mode does not have.',
  },
};

/** The approval kinds a cloud coordinator raises. Every other kind is refused by the cloud schema. */
export const CLOUD_APPROVAL_KINDS: readonly ApprovalKind[] = ['tool_proposal', 'lesson'];

/** The one message the game shows where a feature (or part of one) can't run in cloud mode. */
export function cloudGapMessage(feature: OrgFeature): string {
  const c = ORG_CAPABILITIES[feature];
  if (c.cloud === 'works') return c.cloudSummary;
  return [`${c.label} in cloud mode: ${c.cloudSummary}`, c.reason, c.instead].filter(Boolean).join(' ');
}

/** Inbox kinds that never appear in cloud mode, each with its reason (the inbox lists them). */
export const cloudMissingKinds = (): { kind: ApprovalKind; message: string }[] =>
  (['job_plan', 'budget_increase', 'external_action', 'chief_proposal'] as const).map((kind) => ({ kind, message: cloudGapMessage(kind) }));
