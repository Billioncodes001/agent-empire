# The chief of staff's planning brain

Alex, the chief of staff, can optionally use a model to plan, review and coordinate. Without it, Alex is rule-based, as before. Everything the model writes is a **proposal**: plans wait for your approval, reviews never accept work, and unblock ideas arrive in your inbox.

## Turning it on

Settings → **Chief of staff · planning brain**:

| Brain | What it uses | Cost |
| --- | --- | --- |
| Off (default) | Nothing. Alex stays rule-based. | none |
| Free | A model in Ollama on this computer (the default is `gpt-oss:20b`). Download one first under Linked accounts. | US$0. Calls run one at a time, at your computer's speed. |
| Premium | Your own Anthropic or OpenAI API key (Linked accounts), a model id, and that provider's current price per million tokens. | Billed by the provider to you. A daily cap applies (default $2, editable). |

The chief card then reads **"Model-backed · ‹model› · proposals only"**. The other executives stay rule-based.

### Premium budget

- Before each call, the worst case (the estimated input plus the maximum output, at your price) is checked against today's cap. A call that could pass the cap isn't made.
- Once today's estimated spend reaches the cap, the brain pauses itself. Settings and the founder desk show why. It resumes the next day, or when you raise the cap.
- A failed paid call is counted at its worst case, so the cap stays conservative.
- The Empire ships no price list, because prices change. Without a price, premium stays off and says why.
- This spend is separate from worker spend and is **never** city credits.

### Why not your Claude subscription (`claude -p`)?

The brief is untrusted text. `claude -p` is an agent with tools: it can run commands and read files, depending on the user's own settings. Turning tools off reliably needs flags this slice couldn't verify against the real binary. It would also need the FREE-01 launch gate and environment scrub for a background process the user never sees. API keys are used instead, through the shared client (`src/server/llm.ts`), which only sends text. This can be revisited with a verified tool-less invocation.

## Planning

From the founder desk ("Ask the chief to propose the work items"), Telegram (`/plan Client | Job title | Brief`) or `POST /api/chief/plans` (`{requestId, client, title, brief}`):

1. The brief goes to the model as data, between random markers. The model is told that text inside them is not instructions.
2. The answer must be exactly one JSON object: `summary` and 1–8 `items`, each with `title` (≤120), `prompt` (≤2000), `phase`, `role` (from a fixed list), `parallel` and `dependsOn`.
   - `dependsOn` must equal what the queue will enforce: "after the previous item" or "parallel with the previous item" (LIFE-04).
   - Unknown fields (for example `approve` or `budgetUsd`) are refused.
   - Prompts that pipe downloads into a shell, move secrets or money, force-push, deploy, mass-contact people, disable tests or security, or try to approve or change budgets are refused.
3. A valid plan becomes a consultancy job **pending approval**, with the ORG-02 estimate. It goes through the existing `job_plan` approval: inbox, founder desk, or `/approve A…`. Each item's prompt starts with `Role: …`. Nothing is queued before approval.
4. Anything else (prose, broken JSON, oversized, unsafe, a timeout, an unreachable model, the cap) **needs attention** with the reason. Nothing is created, and nothing is guessed or repaired.

Requests are idempotent by `requestId`, so Telegram replays are safe. A call cut off by a restart is marked needs attention and is never re-run silently.

## Review

When a consultancy item's task finishes with outcome `done`, the chief reviews it from bounded evidence:

- the item's instructions;
- the worker, branch and attempt;
- `git diff --shortstat base...branch`;
- the pull request;
- the worker transcript summary (not available on this host yet; the review says so).

The review has a recommendation (accept / needs changes), a summary and up to 5 concerns. It shows on the founder desk job, in the inbox detail and in Telegram (`/job`, and a silent notice). It **never** accepts the item, changes its status or moves credits.

Only work that finishes after the brain was switched on is reviewed, so turning it on never spends on a backlog.

## Coordination

When work stalls, the chief raises a **Chief proposal** (`chief_proposal`) in the inbox. Stalls are:

- a task held on a failed dependency;
- a task that failed again after a retry;
- a job whose budget was reached.

Each stall is raised once (idempotent by source). Approving records your decision. For a held dependency, approving also runs the one listed action: retry the dependency, then the held task, through the queue's normal retry. Before it runs, the situation is re-checked; if it changed, you get 409 and nothing is recorded. Dismissing records only.

## API

- `GET /api/chief`: state (settings without keys, brain status, budget, plans, reviews, stalls).
- `POST /api/chief/settings`: `{mode, freeModel, premiumProvider, premiumModel, premiumPrice: [in, out] | null, dailyCapUsd}`.
- `POST /api/chief/plans`: answers 202 with the plan request.

All POSTs need a same-origin `Origin` header. State is kept in `<dataDir>/chief.json`. WebSocket clients receive `{t: 'chief'}` updates.
