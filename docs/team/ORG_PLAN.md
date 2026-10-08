# Executive organization and recreation while waiting

Owner direction, 2026-10-02: "go ahead with the executive org and recreation while waiting". The direction is recorded in
[OFFICE_LIFE_AND_MOBILE_PLAN.md](OFFICE_LIFE_AND_MOBILE_PLAN.md) (ORG-01..03, LIFE-04), and its invariants still
apply. Baseline: `codex/empire-world` at `2e61835`. Server (own-server) mode first; cloud mode is out of scope
for this round and says so in the UI.

## What exists today (facts the slices build on)

- **Chief of staff:** a rule-based monitor (`src/server/supervision.ts`, `SupervisionState` in `src/shared/empire.ts`)
  with an HQ manager worker, "Alex · Chief of staff".
- **Client jobs:** client jobs are approved once and then become queue tasks (`src/server/consultancy.ts`, `jobKey =
  consultancy:<job>:<item>`). The founder desk page (`src/client/consultancy.*`) and Telegram (`src/server/telegram.ts`)
  can create, approve and reject jobs. There is no email.
- **Queue:** `TaskQueue.seat()` (`src/server/queue.ts`) already leaves a task queued when it's blocked
  (`managerSiblingBlocker`). Nothing models task dependencies.
- **Office life:** `routines.ts` already understands `waitingOn` for idle/done workers, but the server never sends it.
- **Spending:** provider spend per worker comes from the usage ledger (`src/server/usage.ts`). City credits are
  separate (`EmpireState.economy`). There are no estimates in server mode.

## Product rules (from AGENTS.md and the office-life plan)

1. **No fake work.** An executive shows only what its function really computed. In this round every executive is
   rule-based, labelled "Rule-based" like the chief today. It makes no model calls and has no hidden worker. A
   model-backed executive is later work, needs CEO approval and has its own budget.
2. **Recreation is driven by the server's `waitingOn`.** It never spends tokens and never delays a runnable task.
   The name card says who the worker is waiting on.
3. **Estimates are estimates.** They are labelled, show their basis (how many past tasks), and are compared with
   actual provider spend afterwards. City credits are never shown as provider money.
4. **CEO sign-off.** Spending beyond an approved budget and anything outward-facing waits in the CEO's approval
   inbox. Email and Telegram only notify. Approving happens in the game, on the founder desk page, or with the
   existing owner-only Telegram commands. Email never accepts approvals.
5. **Protected session and tests.** Never touch localhost:4610, Pixel or `.agent-office`. No paid calls in tests.
   Email and Telegram use fake transports in tests.

## Slices

| ID | Slice | Owner lane | Acceptance |
| --- | --- | --- | --- |
| LIFE-04 | Task dependencies and recreation while waiting | Queue + world | See below |
| ORG-01 | Executive roster and offices | Org + world | See below |
| ORG-02 | Estimates before work, compared with actuals | Org | See below |
| ORG-03 | CEO approval inbox and notifications | Org (after ORG-01/02) | See below |
| ORG-04a | Email outreach (first marketing channel) | ORG-03 | See "Round 2" below |
| ORG-05 | Research executive | ORG-03 | See "Round 2" below |
| ORG-04b, ORG-06 | Other marketing channels; onboarding/voice | — | Later |

### LIFE-04: Dependencies and recreation while waiting

**Server**
- `QueueTask.dependsOn?: string[]` names queue task ids. `queue.add` accepts it (validated: existing ids, no
  cycles, at most 8).
- `seat()` never starts a task while a dependency is unfinished:
  - The task stays `queued` with `blockedBy: string[]`, the unfinished dependency ids.
  - If a dependency finished without `outcome === 'done'`, the task is held with `error: 'dependency <id> did not
    finish'`. It needs the CEO to retry or remove it, and is never auto-run.
- Approved items of one consultancy job run in order: item N depends on item N−1, and a plan may opt out per item
  with `parallel: true`.
  - **Owner confirmed** the `parallel` semantics: a parallel step runs beside the previous one, and the next step
    waits for both.
- **Continuity:** when a task unblocks, it prefers the desk of the worker that finished its dependency, if that
  desk is free. It has to be the same person continuing the project.
- **`WorkerInfo.waitingOn?: { id: string; name: string; taskId: string }`** is set for an `idle`/`done` worker when
  its last finished task has a dependent task that is blocked by another worker's running task. `id` and `name` are
  the blocking worker's. The field clears the moment the dependent task is seated or the blocker finishes.
- Persisted in `queue.json`. An old queue file without the fields loads unchanged.

**Client**
- `routines.ts`/`worker-life.ts` use the real `waitingOn`. The worker goes to the gym, coffee or cafeteria, and
  the name card reads "Waiting on Bea — at the coffee bar".
- The worker returns to its desk and types only when the server reports it working. All existing gates still
  apply: stale or offline workers never walk, typing only happens through `typingPose`, and reduced motion
  teleports.
- The queue panel shows a blocked task as "Waiting on <task title>", with the dependency failure state.

**Fixture and tests**
- A `tools/ui-fixture.ts` scenario has two workers on one job, one working and one waiting.
- Unit tests cover: seat ordering, cycles rejected, failed dependency held, the continuity desk, `waitingOn`
  projection set and cleared, persistence and an old-file load, and the routine and name card for `waitingOn`.

### ORG-01: Executive roster and offices

**Shared type:** `OrgState` in `src/shared/org.ts`, sent in `welcome` and as an `org` server message when it changes:

```ts
type ExecutiveRole = 'chief_of_staff' | 'operations' | 'finance' | 'marketing_sales' | 'research';
interface Executive {
  role: ExecutiveRole;
  name: string;                 // stable, e.g. "Morgan · Operations"
  monitor: 'rule_based';        // honest label; no model behind it this round
  active: boolean;              // marketing_sales and research are inactive until ORG-04/05 ("Not staffed yet")
  summary: string;              // one line computed from real state, e.g. "2 tasks blocked · 1 waiting worker"
  attention: number;            // items this executive is waiting on the CEO for (approvals it raised)
}
interface OrgState { schemaVersion: 1; observedAt: number; executives: Executive[] }
```

**What each executive does**
- `chief_of_staff`: wraps today's supervision and is unchanged.
- `operations`: computes queue health from the queue and workers: running, queued, blocked, waiting workers and
  held dependency failures.
- `finance`: computes the approved budget versus actual provider spend per job, today's spend versus the budget,
  and the open budget approvals.

**Server and world**
- The server projects `OrgState` purely from existing state (`projectOrg()`, pure and unit-tested), the same way
  `projectSupervision` does.
- The world gives executives offices in the upper `LOFT`, which is otherwise unused. Each gets a desk with a name
  plate and a body in a suit (`outfit.ts`; a stable, distinct avatar per role, never the CEO's suit). Executives
  sit at their desks. They are not AI workers and never take a workstation from funded capacity.
- Pressing E at an executive desk opens that executive's card: role, Rule-based label, summary, and its attention
  items linking to the inbox.
- The Management panel gets an "Executives" section with the same data. Inactive roles read "Not staffed yet".

### ORG-02: Estimates before work

- **`estimateJob()`** (pure, `src/server/estimate.ts`) estimates each consultancy item:
  - cost in USD as a range (p25 to p75), plus wall-clock duration, from completed queue tasks with usage in
    `usage.json` and the queue history;
  - `basis: { samples: number; source: 'history' | 'default' }`. With fewer than 3 samples it uses a stated default
    and the UI says "Rough default — no history yet".
- **Phases:** each item is labelled `build`, `iteration`, `testing` or `field_testing` from the plan (default
  `build`). The job estimate sums the items, and calendar time accounts for dependencies and concurrency (`maxWorkers`).
- **Approval:** the founder desk review step, the Telegram `/job`, and the in-game inbox show the estimate before
  approval. Approving a job records `approvedBudgetUsd` as the top of the cost range, rounded up, and the CEO may
  edit it.
- **Actuals:** actual spend per job is the sum of usage of the workers that ran its items. It's shown next to the
  estimate, labelled as provider-reported list cost.
- **Over budget:** when actual spend reaches the approved budget, unstarted items of that job are held (not
  started) and finance raises a `budget_increase` approval. Running work is not killed.
- Tests use synthetic history; there are no paid calls.

### ORG-03: CEO approval inbox and notifications

**Server**
- `src/server/approvals.ts` holds a durable inbox in `approvals.json` (atomic writes):
  - Kinds: `job_plan`, which wraps today's consultancy approval, and `budget_increase`. Later slices add
    `external_action`.
  - Fields: id, kind, raisedBy (an executive role), title, detail, estimate?, createdAt, status
    (`pending|approved|rejected`), decidedAt, decidedBy.
  - Decisions are idempotent. Approving a `budget_increase` raises the job's budget and releases held items.
- Routes: `GET /api/approvals` and `POST /api/approvals/:id/(approve|reject)` (authenticated like the rest), plus
  an `approvals` server message.

**Game UI**
- The CEO desk in HQ (the founder's desk) has a physical inbox tray showing the pending count. Pressing E opens the
  inbox. The HUD shows a badge when anything is pending. The phone layout and keyboard are supported.

**Notifications**
- **Telegram** (existing owner-only bot): a pending approval sends one message. `/approvals` lists them, and
  `/approve ID` / `/reject ID` work for every kind.
- **Email** (new, optional): set `AGENT_EMPIRE_SMTP_URL` (`smtps://user:pass@host:465`) and
  `AGENT_EMPIRE_NOTIFY_EMAIL`. Each new pending approval sends one email, notification only, carrying no secret and
  no approval link that acts without sign-in. It's off when unset, and the settings and status show "Email: not
  configured".
  - Implementation: a small SMTP client or the `nodemailer` library (MIT), behind a transport interface. Tests use
    a fake transport.
- **Cloud mode:** the inbox is not available in cloud mode yet, and the UI says so.

## Round 2 (owner direction, 2026-10-08): email outreach and research

The owner chose email outreach as marketing's first channel, with the research executive alongside. The OpenAI cloud
option (CLOUD-06) follows. LinkedIn, X and other channels are later, and each needs its own owner decision.

### Shared: internal jobs with a worker artifact

Drafting a campaign and researching a question are **internal jobs**. They use the existing consultancy job path,
with client `Internal`, an estimate and CEO approval before any paid work. Each item's prompt tells the worker to
write one markdown file with strict frontmatter at a fixed path:
- campaigns: `docs/empire/campaigns/<jobId>.md`;
- research: `docs/empire/research/<jobId>.md`.

The worker writes the file in its worktree. When the task finishes with `outcome === 'done'`, the server reads it
from the task's branch or worktree.
- **Path confinement:** no symlinks, no `..`. **Size cap:** 256 KB.
- **Parsing:** strict. A missing or invalid artifact makes the item need attention, with the reason; nothing is
  guessed.
- **Honest labels:** the imported content is labelled "Drafted by <worker> — not verified".

### ORG-04a: Email outreach (marketing & sales executive, first channel)

- **Executive:** marketing_sales becomes active as "Rule-based": it coordinates, it doesn't write. Its card shows
  campaigns, leads and what's waiting on the CEO.
- **Leads:**
  - **Import:** the CEO imports CSV files (name, email, company, source, basis) on the founder desk or by API. A
    worker can propose leads inside a campaign draft, but proposed leads are unconfirmed until the CEO accepts them.
  - **Validation:** every lead needs a valid address and a recorded `source` and `basis` (e.g. "existing customer",
    "inbound inquiry", "conference contact"). The UI states the CEO is responsible for having a lawful basis to email
    each contact.
  - **No scraping:** the Empire never scrapes or buys addresses.
  - **Storage:** leads are kept in `leads.json`, deduplicated by lowercase address.
- **Suppression list:** opted-out, bounced and CEO-blocked addresses are never emailed again. The CEO adds opt-outs
  (from replies such as "STOP") in the UI or with Telegram `/optout <email>`, because without IMAP the Empire doesn't
  read replies, and the UI says so.
- **Campaign drafts:** a worker drafts a campaign as an internal job. The artifact's frontmatter holds `subject`,
  `audience` (lead tags or ids) and an optional `proposedLeads` list. The body is plain text with only
  `{{name}}`/`{{company}}` merge fields.
- **Owner-config footer:** every email appends a fixed footer, which the worker can't edit:
  - the sender's identity and physical postal address, from `AGENT_EMPIRE_OUTREACH_ADDRESS` (required; sending is
    disabled without it);
  - "Reply STOP to stop receiving these emails".
- **Approval:** sending is an `external_action` inbox item, raised by marketing_sales. It shows:
  - the exact subject and body, rendered for 2 sample recipients;
  - the full recipient count and list, with suppressed or invalid addresses excluded and counted;
  - the sender address and the daily cap.
  - Approving sends exactly that frozen snapshot. Any edit makes a new item. Rejecting records the decision.
    Telegram can approve with `/approve A7`.
- **Sending:**
  - It reuses the ORG-03 SMTP client and transport over the owner's `AGENT_EMPIRE_SMTP_URL`. The From address is
    `AGENT_EMPIRE_OUTREACH_FROM` and must be set.
  - One message per recipient, never CC or BCC lists. Rate-limited, default 1 message every 10 s and 200 a day
    (`AGENT_EMPIRE_OUTREACH_DAILY_CAP`).
  - Results per recipient (sent, refused, failed) are durable in `outreach.json`. A 5xx refusal adds the address to
    suppression as a bounce. A restart resumes without re-sending anyone already marked sent.
  - The CEO can pause or cancel a running campaign.
- **Honesty:** the campaign card reports only real counts. City credits are never involved.
- **Tests:** fake SMTP only, never a real recipient. They cover:
  - suppression always wins;
  - cap and rate limiting;
  - a frozen snapshot;
  - no double send across a restart;
  - footer always present;
  - merge-field escaping, with no header injection from names or companies;
  - CSV validation;
  - artifact path confinement.

### ORG-05: Research executive

- **Executive:** research becomes active as "Rule-based". Its card lists research reports and open tool proposals.
- **Asking:** the CEO asks a question or describes an unfamiliar job (founder desk, the research card, or Telegram
  `/research <question>`). This creates an internal job with an estimate, which needs approval like any job.
- **Report contract:** `docs/empire/research/<jobId>.md` with frontmatter `question`, `feasibility`
  (`feasible` | `partial` | `not_yet` | `unknown`) and `confidence` (low/medium/high). Required sections: Findings,
  where every claim cites a source URL; What we can do now; What we can't do yet and why; Proposed tools.
  - Reports without at least one source URL in Findings are rejected as needing attention.
- **Tool proposals:** each proposed tool (name, URL, licence, what it enables, risk) becomes a `tool_proposal`
  inbox item. Approving only records the decision and shows it on the research card. Installing or adopting a tool
  is never automatic; it's later work through the normal reviewed flow.
- **Memory:** reports stay in the repo and are listed with question, feasibility, date and cost. Nothing is
  presented as verified.

## Coordination

- **Round 2 authors:** ORG-04a and ORG-05 run in parallel. The ORG-04a author owns the shared artifact importer
  (`src/server/artifacts.ts`). The ORG-05 author builds against the same contract and merges after ORG-04a; if it
  finishes first, the coordinator reconciles them.
- **Authors:** LIFE-04 and ORG-01/02 run in parallel in separate worktrees. ORG-03 starts after ORG-01/02 merge.
- **Contract owners:** `QueueTask`/`WorkerInfo` changes belong to the LIFE-04 author. `src/shared/org.ts`, the
  approvals types and the estimate types belong to the ORG author. `protocol.ts` additions merge in that order.
- **Each slice:** failing-before tests, an independent review, an integration branch, then typecheck, `npm test`,
  build, `mobile-ui-check`, the slice's own UI check, and screenshots at desktop and 375px/phone landscape. Merge into
  `codex/empire-world` by PR.
