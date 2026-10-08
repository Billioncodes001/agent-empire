import { createHash } from 'node:crypto';
import { Consultancy, ConsultancyError } from './consultancy.js';
import { TELEGRAM_HELP, type TelegramCommands } from './telegram.js';
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
export function chiefCommands(office: Consultancy, resourceReport: () => string): TelegramCommands {
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
        if (cmd === 'status') return `Chief report · rule-based\n${resourceReport()}\n\n${jobsText()}`;
        if (cmd === 'new') {
          const parts = raw.split('|');
          if (parts.length < 3) return 'Use /new Client | Job title | Brief';
          const [client, title, ...brief] = parts;
          const job = office.create({ requestId, client: client.trim(), title: title.trim(), brief: brief.join('|').trim() }, 'CEO via Telegram');
          return `Job ${job.id} saved for ${job.client}. Nothing starts before approval.\nReview the brief and work items with /job ${job.id}`;
        }
        if (cmd === 'job') {
          const job = office.snapshot().jobs.find(j => j.id === raw.trim());
          if (!job) return 'Job not found. Use /jobs for its ID.';
          // Explicit plan review can reveal the requested brief to the configured CEO, never in unsolicited updates.
          return `${job.id} · ${job.client} · ${job.title}\n${job.status.replaceAll('_', ' ')}\n\n${job.brief}${estimateText(job)}\n\nReview the complete work-item plan in the CEO console before approval. Approval submits it to this host’s local worker queue under existing budget and desk limits. /approve ${job.id} (or /approve ${job.id} 25 to set a $25 budget)`;
        }
        if (cmd === 'approve' || cmd === 'reject') {
          const [id = '', amount] = raw.trim().split(/\s+/);
          if (cmd === 'approve' && amount !== undefined && !/^\$?\d+(\.\d{1,2})?$/.test(amount)) return 'Use /approve ID or /approve ID 25 (budget in USD).';
          const job = cmd === 'approve' ? office.approve(id, 'CEO via Telegram', amount === undefined ? {} : { budgetUsd: Number(amount.replace('$', '')) }) : office.reject(raw.trim(), 'CEO via Telegram');
          const budget = cmd === 'approve' && job.approvedBudgetUsd !== undefined ? ` Approved budget $${job.approvedBudgetUsd.toFixed(2)}; unstarted items are held if provider spend reaches it.` : '';
          return `Job ${job.id}: ${job.status.replaceAll('_', ' ')}. ${cmd === 'approve' ? 'Existing execution, budget and workstation limits still apply.' : 'The unstarted plan was declined.'}${budget}`;
        }
        return TELEGRAM_HELP;
      } catch (error) {
        if (error instanceof ConsultancyError && error.status < 500) return error.message;
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
  };
}
