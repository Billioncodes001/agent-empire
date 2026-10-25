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
  | 'inbox' | 'job_plan' | 'budget_increase' | 'external_action' | 'tool_proposal' | 'chief_proposal' | 'lesson' | 'architect_summary'
  | 'executives' | 'chief_brain' | 'research' | 'outreach' | 'memory' | 'notifications' | 'founder_desk';

export const ORG_CAPABILITIES: Record<OrgFeature, OrgCapability> = {
  inbox: {
    label: 'Approval inbox',
    local: 'Every kind of item, decided in the game, on the founder desk or in Telegram.',
    cloud: 'partial',
    cloudSummary: 'Tool proposals, lessons, the chief’s plans and proposals, and campaign sends are decided in the game; your coordinator applies each decision on its next run.',
    reason: 'Budget increases and city architect summaries are never raised in cloud mode (see each kind).',
  },
  job_plan: {
    label: 'Client plans',
    local: 'A saved client job waits in the inbox with its estimate; approving queues its items.',
    cloud: 'partial',
    cloudSummary: 'With the chief’s brain on, a brief you write becomes a proposed plan in the inbox, every prompt shown. Approving records your decision; each item becomes paid work only when you submit it and confirm the spend.',
    reason: 'Cloud mode has no consultancy journal or estimates, so approving a plan queues nothing by itself: the paid confirmation of each submitted job names its allowance and is checked against your current limits.',
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
    cloud: 'partial',
    cloudSummary: 'Your coordinator raises the exact message and every recipient; approving sends it in batches from a separate send job that holds your SMTP secret.',
    reason: 'The coordinator runs every 15–60 minutes, so sends go out at most a set number per run and per day, not one every few seconds; a send that is not confirmed is never re-sent.',
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
    cloud: 'partial',
    cloudSummary: 'With the chief’s brain on, you can ask for a review of a finished cloud job or an idea to unblock a failed one. Deciding records your decision only.',
    reason: 'In cloud mode the chief answers only when you ask (each answer is a charged model call), and it has no one-click retry: submit a new job instead.',
  },
  architect_summary: {
    label: 'City architect summaries',
    local: 'One per city architect run on a server install; keep the changes or revert that day.',
    cloud: 'unavailable',
    cloudSummary: 'Not raised: the city architect runs only on a server install.',
    reason: 'The architect edits the city on your office host while you are away; cloud mode has no host to run it (see Settings › Let the city grow while you are away on a server install).',
  },
  lesson: {
    label: 'Lessons',
    local: 'Proposed by you or the chief’s model; approving makes a lesson planning context.',
    cloud: 'works',
    cloudSummary: 'Lessons you write are decided in the inbox; approved lessons are given to the chief’s brain when it plans.',
  },
  executives: {
    label: 'Executives',
    local: 'Rule-based cards computed from the live queue, workers, client jobs, usage, outreach and reports.',
    cloud: 'partial',
    cloudSummary: 'Rule-based cards computed from the last snapshot of your cloud jobs, spend ledger, research, outreach and inbox, labelled with its age.',
    reason: 'There is no live queue or desk worker in cloud mode, so the cards summarise cloud jobs instead.',
  },
  chief_brain: {
    label: 'Chief’s planning brain',
    local: 'Off, free (Ollama on this computer) or premium (your API key, with a daily cap).',
    cloud: 'partial',
    cloudSummary: 'Off, a free tier with your own key (OpenRouter, Gemini or Groq, after you accept its data-use terms) or premium (your Anthropic or OpenAI key with a daily cap and a 30-day cap). Your coordinator charges each call’s worst case before making it; the output is proposals only.',
    reason: 'There is no Ollama free brain in cloud mode: GitHub-hosted runners have none. The key is your own Actions secret (only its name is checked), a Claude subscription is never used for the brain, and the chief answers only on the coordinator’s runs (every 15–60 minutes, or when the game wakes it).',
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
    cloud: 'partial',
    cloudSummary: 'Leads, hashed opt-outs and campaigns you write live in your private state repository; each send needs your approval of the exact message and recipients, and a separate send job holding your SMTP secret sends it.',
    reason: 'The coordinator runs every 15–60 minutes, so sends are capped per run and per day, and delivery can take hours. Leads are personal data: “Delete lead data” removes them from the current files, but git history keeps old versions unless you rewrite it. Workers don’t draft campaigns in cloud mode, and there is no Telegram /optout: record opt-outs in the game.',
  },
  memory: {
    label: 'Organizational memory',
    local: 'Reviewed lessons with provenance; approved lessons are cited when the chief plans.',
    cloud: 'works',
    cloudSummary: 'Add, edit, approve, decline and retire lessons, and export them as Markdown; with the chief’s brain on, its plans cite the approved lessons they rely on.',
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
export const CLOUD_APPROVAL_KINDS: readonly ApprovalKind[] = ['tool_proposal', 'lesson', 'job_plan', 'chief_proposal', 'external_action'];

/** The one message the game shows where a feature (or part of one) can't run in cloud mode. */
export function cloudGapMessage(feature: OrgFeature): string {
  const c = ORG_CAPABILITIES[feature];
  if (c.cloud === 'works') return c.cloudSummary;
  return [`${c.label} in cloud mode: ${c.cloudSummary}`, c.reason, c.instead].filter(Boolean).join(' ');
}

/** Inbox kinds that never appear in cloud mode, each with its reason (the inbox lists them). */
export const cloudMissingKinds = (): { kind: ApprovalKind; message: string }[] =>
  (['budget_increase', 'architect_summary'] as const).map((kind) => ({ kind, message: cloudGapMessage(kind) }));
