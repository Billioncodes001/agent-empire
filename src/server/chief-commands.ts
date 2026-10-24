import { createHash } from 'node:crypto';
import { Consultancy, ConsultancyError } from './consultancy.js';
import { ApprovalError, approvalLine, approvalText, type ApprovalInbox } from './approvals.js';
import { APPROVAL_ID_RE } from '../shared/approvals.js';
import { TELEGRAM_HELP, type TelegramCommands } from './telegram.js';
import { ResearchError, type ResearchDesk } from './research.js';
import { ChiefError, type ChiefBrain } from './chief.js';
import { ROLE_LABEL, REVIEW_NOTE } from '../shared/chief.js';
import type { ConsultancyJob } from '../shared/consultancy.js';
import { ACTUAL_SPEND_LABEL, PHASE_LABEL, basisLabel, fmtDurationRange, fmtUsdRange } from '../shared/org.js';

/** The estimate as plain text: labelled, with its basis, and actuals once there are any. */
export function estimateText(job: ConsultancyJob): string {
  const e = job.estimate;
  if (!e) return '';
  const lines = [`\n\nEstimate (not a quote): ${fmtUsdRange(e.costUsd)} · ${fmtDurationRange(e.calendarMs)} calendar time · ${basisLabel(e.basis)}`];
  job.items.forEach((item, i) => { const ie = e.items[i]; if (ie) lines.push(`${i + 1}. ${item.title} [${PHASE_LABEL[ie.phase]}] ${fmtUsdRange(ie.costUsd)}`); });
  if (job.approvedBudgetUsd !== undefined) lines.push(`Approved budget $${job.approvedBudgetUsd.toFixed(2)}`);
  if (job.actualSpendUsd !== undefined) lines.push(`Actual so far $${job.actualSpendUsd.toFixed(2)} (${ACTUAL_SPEND_LABEL})`);
  if (job.budgetHold) lines.push('Budget reached: unstarted items are held until the budget is raised.');
  return lines.join('\n');
}

/** A deterministic command surface shared with the same consultancy service as the CEO console. */
/** Review fix 2: Telegram cannot show a whole model-written plan, so it cannot approve one. */
export const MODEL_PLAN_REFUSAL = 'This plan was proposed by the chief’s model. Review the prompts in the game or on the founder desk and approve it there; Telegram can show only part of them. You can still /reject it here.';

export function chiefCommands(office: Consultancy, resourceReport: () => string, inbox?: ApprovalInbox, afterDecision?: () => void, research?: ResearchDesk, outreach?: { optOutCommand(email: string, actor: string): string }, brain?: ChiefBrain): TelegramCommands {
  const ACTOR = 'CEO via Telegram';
  /** Inbox ids the owner already heard about in a command reply (/new); announced silently. */
  const announced = new Set<string>();
  /** Inbox ids (A3) are distinct from consultancy job ids (consultancy-…); both are accepted. */
  const decideInbox = (cmd: 'approve' | 'reject', id: string, amount: string | undefined, requestId: string) => {
    const before = inbox!.get(id);
    if (!before) return `Unknown approval ${id}. Use /approvals for pending items.`;
    // Review fix 2: a model-proposed plan is approved only where every item prompt was shown in full.
    if (cmd === 'approve' && before.kind === 'job_plan' && before.proposedBy) return MODEL_PLAN_REFUSAL;
    const reopen = cmd === 'approve' && before.status === 'rejected' && before.reopenable === true;
    if (before.status !== 'pending' && !reopen) return `${id} is already ${before.status}.`;
    const item = cmd === 'approve' ? inbox!.approve(id, ACTOR, { requestId, ...(amount === undefined ? {} : { budgetUsd: Number(amount.replace('$', '')) }) }) : inbox!.reject(id, ACTOR, { requestId });
    // Like the HTTP route: a raised budget releases held items, so the queue seats them now.
    try { afterDecision?.(); } catch { /* the decision is saved; seating retries on the queue's own timer */ }
    const budget = item.status === 'approved' && item.budgetUsd !== undefined ? ` · budget $${item.budgetUsd.toFixed(2)}` : '';
    const note = item.kind === 'external_action'
      ? (item.status === 'approved' ? ' Sending starts now, one message per recipient within the rate limit and daily cap. Pause or cancel it on the founder desk.' : ' Nothing was sent.')
      : item.kind === 'budget_increase'
      ? (item.status === 'approved' ? ' Held items are released; existing execution and workstation limits still apply.' : ` The job stays held. To release it later, approve this item in the game inbox (Recent decisions) or send /approve ${item.id} [budget].`)
      : (item.status === 'approved' ? ' The plan is queued under existing execution, budget and workstation limits.' : ' The unstarted plan was declined.');
    return `${item.id} ${item.status}${budget}.${note}`;
  };
  const jobsText = () => {
    const state = office.snapshot();
    if (state.storageError) throw new Error('Consultancy storage unavailable');
    return state.jobs.length ? state.jobs.slice(-12).map(j => `${j.id} · ${j.client} · ${j.title} · ${j.status.replaceAll('_', ' ')}`).join('\n') : 'No client jobs yet. Use /new Client | Job title | Brief';
  };
  return {
    execute(text, requestId) {
      try {
        const match = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
        if (!match) return `Use a command to keep decisions explicit.\n${TELEGRAM_HELP}`;
        const [, cmd, raw = ''] = match;
        if (cmd === 'jobs') return jobsText();
        if (cmd === 'status') return `Chief report · rule-based${brain ? ` · planning brain: ${brain.status().label}` : ''}\n${resourceReport()}\n\n${jobsText()}`;
        if (cmd === 'new') {
          const parts = raw.split('|');
          if (parts.length < 3) return 'Use /new Client | Job title | Brief';
          const [client, title, ...brief] = parts;
          const job = office.create({ requestId, client: client.trim(), title: title.trim(), brief: brief.join('|').trim() }, 'CEO via Telegram');
          inbox?.reconcile();
          const item = inbox?.state().items.find((i) => i.kind === 'job_plan' && i.jobId === job.id);
          if (item) announced.add(item.id);
          return `Job ${job.id} saved for ${job.client}. Nothing starts before approval.\nReview the brief and work items with /job ${job.id}${item ? `\nIt is approval ${item.id} in your inbox: /approve ${item.id} [budget]` : ''}`;
        }
        if (cmd === 'plan') {
          // FREE-02: the chief's model drafts a PROPOSED plan; it arrives as an approval (/approve A…) when ready.
          if (!brain) return 'The chief’s planning brain is not available on this host. Use /new for a one-item plan.';
          const parts = raw.split('|');
          if (parts.length < 3) return 'Use /plan Client | Job title | Brief';
          const [client, title, ...rest] = parts;
          const plan = brain.requestPlan({ requestId, client: client.trim(), title: title.trim(), brief: rest.join('|').trim() }, ACTOR, 'telegram');
          if (plan.status === 'needs_attention') return `The chief could not start: ${plan.reason}`;
          if (plan.status === 'proposed' && plan.jobId) return `Plan ${plan.id} is already proposed as job ${plan.jobId}. /job ${plan.jobId}`;
          return `The chief (${brain.label()}) is drafting a proposed plan for ${plan.client} (${plan.id}). I’ll send it here as an approval when it’s ready. Nothing starts before you approve.`;
        }
        if (cmd === 'research') {
          if (!research) return 'The research executive is not available on this host.';
          const question = raw.trim();
          if (!question) return 'Use /research <your question>';
          // ORG-05: an internal job like any other; nothing starts before approval.
          const { job } = research.ask(question, ACTOR, requestId);
          inbox?.reconcile();
          const item = inbox?.state().items.find((i) => i.kind === 'job_plan' && i.jobId === job.id);
          if (item) announced.add(item.id);
          const estimate = job.estimate ? ` Estimate (not a quote): ${fmtUsdRange(job.estimate.costUsd)}.` : '';
          return `Research job ${job.id} saved for Sam · Research. Nothing starts before approval.${estimate}${item ? `\nIt is approval ${item.id}: /approve ${item.id} [budget] or /reject ${item.id}` : `\nReview it with /job ${job.id}`}`;
        }
        if (cmd === 'job') {
          const job = office.snapshot().jobs.find(j => j.id === raw.trim());
          if (!job) return 'Job not found. Use /jobs for its ID.';
          // Explicit plan review can reveal the requested brief to the configured CEO, never in unsolicited updates.
          const proposed = brain?.planFor(job.id);
          const meta = proposed?.items ? `\n\nProposed by the chief (${proposed.model ?? 'model'} · proposal only):\n${proposed.items.map((it, i) => `${i + 1}. ${it.title} · ${ROLE_LABEL[it.role]}${it.dependsOn.length ? ` · after ${it.dependsOn.join(', ')}` : ''}${it.parallel ? ' · parallel' : ''}\n${it.prompt.length > 360 ? `${it.prompt.slice(0, 360)}… (shortened)` : it.prompt}`).join('\n')}\n\n${MODEL_PLAN_REFUSAL}` : '';
          const reviews = brain?.state().reviews.filter((r) => r.jobId === job.id && r.status === 'reviewed').map((r) => `Review of “${r.itemTitle}”: ${r.recommendation === 'accept' ? 'recommend accept' : 'needs changes'} — ${r.summary}`) ?? [];
          return `${job.id} · ${job.client} · ${job.title}\n${job.status.replaceAll('_', ' ')}\n\n${job.brief}${meta}${estimateText(job)}${reviews.length ? `\n\n${reviews.join('\n')}\n${REVIEW_NOTE}` : ''}${proposed ? '' : `\n\nReview the complete work-item plan in the CEO console before approval. Approval submits it to this host’s local worker queue under existing budget and desk limits. /approve ${job.id} (or /approve ${job.id} 25 to set a $25 budget)`}`;
        }
        if (cmd === 'optout') {
          if (!outreach) return 'Email outreach is not available on this host.';
          const email = raw.trim();
          if (!email || /\s/.test(email)) return 'Use /optout name@example.com';
          return outreach.optOutCommand(email, ACTOR);
        }
        if (cmd === 'approvals') {
          if (!inbox) return 'The approval inbox is not available on this host.';
          const pending = inbox.pending();
          return pending.length ? `Waiting for your approval:\n${pending.map(approvalLine).join('\n')}\n\n/approve ID [budget] or /reject ID` : 'Nothing is waiting for your approval.';
        }
        if (cmd === 'approve' || cmd === 'reject') {
          const [id = '', amount, ...extra] = raw.trim().split(/\s+/);
          if (cmd === 'approve' && extra.length) return 'Use /approve ID or /approve ID 25 (budget in USD).';
          if (cmd === 'approve' && amount !== undefined && !/^\$?\d+(\.\d{1,2})?$/.test(amount)) return 'Use /approve ID or /approve ID 25 (budget in USD).';
          if (inbox && APPROVAL_ID_RE.test(id.toUpperCase())) return decideInbox(cmd, id.toUpperCase(), amount, requestId);
          if (cmd === 'approve' && brain?.planFor(id)) return MODEL_PLAN_REFUSAL;
          const job = cmd === 'approve' ? office.approve(id, 'CEO via Telegram', amount === undefined ? {} : { budgetUsd: Number(amount.replace('$', '')) }) : office.reject(raw.trim(), 'CEO via Telegram');
          const budget = cmd === 'approve' && job.approvedBudgetUsd !== undefined ? ` Approved budget $${job.approvedBudgetUsd.toFixed(2)}; unstarted items are held if provider spend reaches it.` : '';
          return `Job ${job.id}: ${job.status.replaceAll('_', ' ')}. ${cmd === 'approve' ? 'Existing execution, budget and workstation limits still apply.' : 'The unstarted plan was declined.'}${budget}`;
        }
        return TELEGRAM_HELP;
      } catch (error) {
        if ((error instanceof ConsultancyError || error instanceof ApprovalError || error instanceof ResearchError || error instanceof ChiefError) && error.status < 500) return error.message;
        // Storage/transient failure leaves Telegram offset unchanged for safe replay.
        throw error;
      }
    },
    summary() {
      const state = office.snapshot();
      if (state.storageError) throw new Error('Consultancy storage unavailable');
      const statuses = state.jobs.map(j => [j.id, j.status]);
      const resources = resourceReport();
      return {
        fingerprint: createHash('sha256').update(JSON.stringify({statuses,resources})).digest('hex'),
        text: `Chief update · rule-based\n${resources}\n\n${jobsText()}\n\nUse /status for capacity. Turn ended means review needed, not verified delivery.`,
      };
    },
    notifications() {
      // FREE-02: a plan the chief could not propose, and each finished review (a recommendation only).
      const chiefNotes = !brain ? [] : [
        ...brain.state().plans.filter((p) => p.status === 'needs_attention' && p.source === 'telegram').map((p) => ({ key: `chief-plan:${p.id}`, text: `The chief could not propose a plan for ${p.client} · ${p.title} (${p.id}): ${p.reason}\nUse /new ${p.client} | ${p.title} | … for a one-item plan.` })),
        ...brain.state().reviews.filter((r) => r.status === 'reviewed').map((r) => ({ key: `chief-review:${r.key}`, text: `Chief review · ${r.itemTitle}\n${r.recommendation === 'accept' ? 'Recommends accepting' : 'Recommends changes'} (${r.model ?? 'model'} · proposal only): ${r.summary}${r.concerns?.length ? `\nConcerns: ${r.concerns.join('; ')}` : ''}\n${REVIEW_NOTE}`, silent: true })),
      ];
      if (!inbox) return chiefNotes;
      if (inbox.recoveryError) throw new Error('Approval inbox storage unavailable');
      return [...inbox.pending().map((item) => ({ key: item.id, text: `${approvalText(item)}\n/reject ${item.id} to decline.`, ...(announced.has(item.id) ? { silent: true } : {}) })), ...chiefNotes];
    },
  };
}
