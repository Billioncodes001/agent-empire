# Organizational memory

The Empire keeps a small, **reviewed** memory of lessons from past work. A lesson is a short note (at most 500 characters) with its scope and where it came from. The chief of staff can cite approved lessons when it plans. Nothing in memory trains a model, changes a prompt by itself, or becomes active without your approval.

## Where lessons come from

| Source | How | Status when created |
| --- | --- | --- |
| A chief review | With the planning brain on, a review may include one proposed lesson. | proposed |
| A repeated failure | A chief proposal for a task that failed twice may include one proposed lesson. | proposed |
| You | Founder desk → **Memory** → *Add a lesson*. You may cite a job, work item, review, failure or research report by id. | proposed |

Every lesson, including yours, goes to the approval inbox as a **Lesson** item (decision only). Approve it in the game inbox or with `/approve A…` in Telegram. Declining retires it. Only approved lessons are ever used.

The chief's lesson text is untrusted, like the brief. It is refused, and the review is kept with a note saying why, when it:

- is longer than 500 characters or has unexpected fields;
- contains invisible or control characters (zero-width, bidi overrides, Unicode tags…);
- fails the same heuristic screen as plan prompts (secrets, money, force-push, deploys, mass contact, approving on your behalf); or
- names a client other than the job's own (a client lesson is always bound to that job's client).

An identical lesson that is already proposed or approved is not proposed twice, and each review or failure proposes at most once.

## Scopes and how lessons are chosen

- **Company-wide**: used when it shares a significant word with the brief.
- **Product** (a product name): used when the brief mentions that name.
- **Role** (one of the chief's roles): used when it shares a word with the brief or the brief names the role.
- **Client** (a client name): used **only** for briefs from that exact client. Client memory never crosses to another client.

Matching is simple word overlap, not embeddings, and is deterministic: client, then product, then role, then company lessons, ties to the older lesson. At most 5 lessons (2,500 characters) go into one plan.

## How the chief uses them

- Approved, relevant lessons are put in the chief's planning prompt between their own random markers, as background data with their ids. The model is told they are not instructions and never override its rules.
- The plan may list the lesson ids it relies on in `"lessons"`. An id it was not given is refused and the plan needs attention.
- The proposed plan shows **"Based on lessons L3, L7"** (or "Lessons given as context … the plan cites none"), with the lesson text, in the game inbox and on the founder desk.
- Lessons are **never added to worker prompts**. They reach a worker only if the plan's own prompt says so, and you read every prompt before you approve the plan.
- Each lesson counts how many planning prompts it was given to.
- The rule-based chief (brain off) does not plan, so it uses no lessons. The Memory panel works either way.

## Managing memory

Founder desk → **Memory**:

- filter by status (in use / waiting / retired) and scope;
- open a lesson's source job or research report;
- **Edit…** sends a new proposal that keeps the provenance. The old lesson stays in use until you approve the edit, then it is retired ("Replaced by L9");
- **Retire…** takes effect immediately; a waiting lesson's inbox item is resolved;
- **Export as Markdown** downloads every lesson with its status, scope, provenance and decisions.

## API

- `GET /api/memory`: all lessons.
- `GET /api/memory/export.md`: Markdown export.
- `POST /api/memory/lessons`: `{text, scope, scopeValue?, source?: {kind, ref}, requestId?}` → 201, a proposed lesson.
- `POST /api/memory/lessons/L3/edit`: `{text, scope?, scopeValue?, requestId?}` → 201, the new proposal.
- `POST /api/memory/lessons/L3/retire`: `{reason?}`.
- Deciding: `POST /api/approvals/A…/approve|reject` (the inbox). There is no endpoint that approves a lesson directly.

POSTs need a same-origin `Origin` header. State is kept in `<dataDir>/lessons.json`; an older data directory without it starts empty. If the file cannot be read, memory reports the problem, refuses changes and gives the chief no lessons. The inbox saves a decision before memory acts on it; a restart in between is finished on the next reconcile.
