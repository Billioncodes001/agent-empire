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
| ORG-04..06 | Marketing/sales, research, onboarding/voice | — | Later; not in this round |

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

## Coordination

- **Authors:** LIFE-04 and ORG-01/02 run in parallel in separate worktrees. ORG-03 starts after ORG-01/02 merge.
- **Contract owners:** `QueueTask`/`WorkerInfo` changes belong to the LIFE-04 author. `src/shared/org.ts`, the
  approvals types and the estimate types belong to the ORG author. `protocol.ts` additions merge in that order.
- **Each slice:** failing-before tests, an independent review, an integration branch, then typecheck, `npm test`,
  build, `mobile-ui-check`, the slice's own UI check, and screenshots at desktop and 375px/phone landscape. Merge into
  `codex/empire-world` by PR.
