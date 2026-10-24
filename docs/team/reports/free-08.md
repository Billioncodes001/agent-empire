# FREE-08: Onboarding (ORG-06)

Author slice on `claude/free-08-onboarding`, branched from `origin/codex/empire-world` at `2cc2142`, with `8cde79e` (FREE-06, FREE-09, file-open notice) merged in. Awaiting independent review. A security review is recommended because the slice handles credentials.

## Requirements (recorded before coding)

From [FREE_PLAN.md](../FREE_PLAN.md) (rules 1–6, the FREE-08 row), [FREE_STACK.md](../FREE_STACK.md) §4 and §9, AGENTS.md and the assignment:

1. First-run setup collects:
   - the company profile;
   - worker engines and models (FREE-01);
   - notification channels: Telegram (existing), **ntfy (new)** and email (the existing SMTP client);
   - approval rules: who approves what, the default budget caps and the chief's daily premium cap (FREE-02).
2. Every server setting that is env-only today gets a decision: onboarding/Settings, or stays env. Env vars keep working as overrides, and the precedence is documented.
3. It builds on the existing first-launch and founding flows, not a parallel one:
   - resumable;
   - skippable per step;
   - re-openable from Settings;
   - old installs are never forced through it.
4. Secrets (Telegram bot token, SMTP password, ntfy token):
   - sealed like API keys;
   - never echoed, only shown as "present".
   - "Send test" calls only the configured endpoint, and only on click.
5. Claude compliance:
   - no in-app Claude login;
   - no Claude.ai token field;
   - the engines step links to the existing Linked accounts flow.
6. No automatic model or voice download. Downloads stay in the existing confirmed flows.
7. Free path first: every step names its free option and says when something costs money.
8. Cloud mode says which steps apply. It does not depend on FREE-04.
9. UI requirements:
   - dark dialog style reusing existing classes and tokens;
   - keyboard and focus;
   - reduced motion and Save-Data;
   - 1440x900 and 874x402.
10. Tests:
    - failing-before tests for precedence, sealing, resume/skip, legacy installs, fake-server test sends and cross-origin refusal;
    - `tools/onboarding-ui-check.ts`, which refuses 4610 and saves screenshots to `reports/free-08/`.

## Design

### Where onboarding sits

The existing in-game chain is character → founding → execution offer. Onboarding is inserted after founding (`offerExecutionWhenFree` in `main.ts`). If the host offers onboarding, it opens, and the separate execution offer is marked as seen, because the workers step contains "Where agents run…". Otherwise the execution offer runs exactly as before. The pre-connection launcher (`src/client/setup/`, cloud vs own server) is unchanged. It runs before there is a host to store settings on.

### Steps

| Step | Collects | Free / paid wording |
| --- | --- | --- |
| Company | Name, what you do, website, mission | Free |
| Workers | Engine status, default engine for new hires. Buttons: **Open Linked accounts…**, **Sign in to Claude…**, **Where agents run…** (all three are the existing flows) | Free: Qwen Code + Ollama, US$0. Costs money: Claude Code with your own subscription or key, billed by your provider |
| Notifications | Telegram (token, user ID), ntfy (server, topic, optional token, "Use a random topic"), Email (SMTP host, port, TLS/STARTTLS, user, password, to, from). Each channel has **Save and send test** | Free per channel, with the provider caveats |
| Approvals | Read-only "who approves what" table, worker daily budget plus "stop new hires", the chief's daily premium cap (through the existing `/api/chief/settings`) | Local models US$0; the cap only applies to the premium brain |

### State and resumability

`onboarding.json` holds the step model in `src/shared/onboarding.ts`:
- `status`: `not_started`, `in_progress`, `done` or `dismissed`;
- `current`: the current step;
- `steps`: each step's state, `pending`, `done` or `skipped`;
- `legacy`: whether the install predates onboarding.

The file is written on the host's first start. If the empire was already founded at that point, `legacy` is set to true for good, and the dialog is never offered automatically. The host offers onboarding (`offer`) only when founded, not legacy, and not done or dismissed. The client additionally offers it at most once per page load.

Dialog controls:
- **Finish later** (or ✕/Esc): keeps the step, and it resumes there.
- **Don't show again**: sets `dismissed`.
- **Settings › Company setup…**: `reopen`, which opens at the first unanswered step.

### Secrets

`SecretStore` (`src/server/secrets.ts`) supports `names()`, `get`, `set` and `delete`. It has no names for any Claude credential.
- **Desktop:** `credential-vault.cjs` gains the three fields plus `notifySecrets()`, so the secrets go into the same Electron safeStorage vault as the API keys. `local-host.cjs` passes it as `runtime.notify.secrets`.
- **Server install:** `FileSecretStore`, an AES-256-GCM `secrets.enc` with a separate owner-only `secrets.key`, both at mode 0600. The UI says plainly that this keeps secrets out of backups, screenshots and git, but not away from someone who can read the account's files.
- Unreadable files fail closed: reads return nothing, writes are refused, and the file is left untouched.
- `GET /api/onboarding` returns `secrets: {name: boolean}` only. Validation errors never repeat the value. Secret inputs are `type=password`, are cleared after saving, and show "● Saved on the host" plus **Remove**.

### Precedence (env stays an override)

| Setting | Order (first wins) |
| --- | --- |
| Telegram | test injection (`runtime.telegram`) > `AGENT_EMPIRE_TELEGRAM_TOKEN` / `_OWNER_ID` > saved |
| Email | test injection (`runtime.email`) > `AGENT_EMPIRE_SMTP_URL` / `AGENT_EMPIRE_NOTIFY_EMAIL` (/ `_FROM`) > saved |
| ntfy (new) | `AGENT_EMPIRE_NTFY_URL` (full topic URL) / `AGENT_EMPIRE_NTFY_TOKEN` > saved |
| Worker daily budget | `--budget` / `--budget-pause` > `AGENT_OFFICE_BUDGET` / `AGENT_OFFICE_BUDGET_PAUSE` > saved |
| Chief premium cap | Saved (FREE-02, unchanged) |

Precedence is per channel and all-or-nothing. If any of a channel's variables is set, that channel comes from the environment, even when the environment is incomplete; the UI then shows the variable's error. When env wins, the dialog says which variables are responsible, and the saved values are kept for later. `Config.budgetSource` records whether the host budget came from the CLI or the environment.

### Env-only settings: the decision for each

| Variable(s) | Decision |
| --- | --- |
| `AGENT_EMPIRE_TELEGRAM_*`, `AGENT_EMPIRE_SMTP_URL`, `AGENT_EMPIRE_NOTIFY_*` | **Onboarding/Settings**, env overrides |
| `AGENT_EMPIRE_NTFY_URL`, `AGENT_EMPIRE_NTFY_TOKEN` (new) | **Onboarding/Settings**, env overrides |
| `AGENT_OFFICE_BUDGET`, `AGENT_OFFICE_BUDGET_PAUSE` | **Onboarding/Settings** (Approvals), env and CLI override |
| Provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, free hosted keys) | Unchanged: desktop vault through Linked accounts; env on servers. The workers step links there; no new key store |
| `CLAUDE_CODE_OAUTH_TOKEN` | **Never in the UI** (FREE_STACK §9) |
| `PORT`, `AGENT_OFFICE_PASSWORD`, `AGENT_OFFICE_CLAIM_TOKEN`, `AGENT_OFFICE_PUBLIC_HOST`, `AGENT_OFFICE_AGENT(_ARGS)`, `AGENT_OFFICE_TEAM_HELPER`, `AGENT_OFFICE_SELF_UPDATE`, `AGENT_EMPIRE_SYNC_PASSWORD` | **Stay env/CLI**: start-up, security or deployment settings needed before any UI exists |
| `AGENT_EMPIRE_GITHUB_TOKEN` | Stays: owned by the existing execution setup |
| `AGENT_EMPIRE_OUTREACH_*` | **Deferred**: outreach sender identity and postal address are legal content (CAN-SPAM style). ORG-04b needs an owner decision. Outreach still reads env |
| `AGENT_EMPIRE_PRODUCTS_DIR`, `AGENT_EMPIRE_REPO_CREATES_PER_HOUR` | Stay env (advanced; FREE-06 owns them) |
| `AGENT_OFFICE_HOOK_*`, `AGENT_OFFICE_WORKER_ID`, `QWEN_CODE_SYSTEM_SETTINGS_PATH`, `PATH`, `SHELL` | Internal plumbing, not configuration |

### Delivery and hot apply

`applyChannels` in `server.ts` rebuilds only the channels a save changed. The Telegram bridge is stopped and restarted. Email and ntfy reuse `EmailNotifier`:
- ntfy has its own `ntfy-notify.json` and label;
- its transport errors carry `signIn` or `permanent` flags.

A saved budget calls `ledger.setBudget`, unless a host budget is set. When the CEO re-binds the Telegram bot to another owner, a checkpoint for a different bot/owner is moved aside as `telegram.previous-<ts>.json`; it is never deleted. Previews and tests (`backgroundServices: false`) never deliver from env or saved settings, and the UI says "saved, not delivering in this preview".

The company name is used in:
- the email sender display name;
- test notification titles;
- the client name of jobs started by phone.

### Endpoints

All of these sit behind sign-in.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/onboarding` | Progress, offer, settings, secret presence, channel states, effective budget |
| `POST /api/onboarding/progress` | `{action: step\|goto\|dismiss\|reopen, step?, result?}` |
| `PUT /api/settings` | Strict partial `{profile?, notifications?, approvals?, secrets?: {name: value\|null}}`. Unknown keys get 400; everything is validated before anything is written |
| `POST /api/settings/test/(telegram\|ntfy\|email)` | Effective configuration only, at most once per 5 s per channel. Errors carry an HTTP status at most |

Non-GET routes require `trusted()`, the existing same-origin or bearer rule.

ntfy URL rules:
- https anywhere;
- http only for loopback;
- no credentials in the URL.

The ntfy transport posts JSON to the server root with `redirect: 'error'`.

### Cloud mode

**Settings › Company setup…** opens a panel that says, per step, what applies (`CLOUD_APPLIES`):

| Step | In cloud mode |
| --- | --- |
| Profile | Does not apply |
| Workers | Partly: no local models or "Sign in to Claude"; cloud uses the keys sealed into the repository at setup |
| Notifications | Does not apply: there is no always-on host |
| Approvals | Partly: the cloud setup has its own limits |

Onboarding is not offered automatically in cloud mode. Nothing depends on FREE-04.

## Test evidence

Run on the head of this branch after the merge.

### Checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm test` | **894/894** |
| `npm run build` | exit 0 |
| `tests/onboarding.test.ts` (new) | 7/7: step model, legacy, validation, sealing on disk and fail-closed, precedence for every channel and the budget, ntfy URL rules, ntfy transport against a fake server |
| `tests/onboarding-server.test.ts` (new) | 6/6: cross-origin 403 with nothing sent; secrets never in responses or files and no Claude field; resume across restarts plus skip; legacy installs not offered; env precedence (the test send uses the env token); saved test sends to fake Telegram, ntfy and SMTP servers only when clicked, plus the saved budget |
| `tests/desktop-vault.test.ts` (+1) | Notification secrets in the vault, presence-only, never provider keys |
| `onboarding-ui-check` (new) | **48/48** |
| `mobile-ui-check` | 411/411 |
| `engines-ui-check` | 24/24 |
| `setup-ui-check` | 127/127 (0 failed) |
| `inbox-ui-check` | 47/47 |

**Failing-before:** each test file was written before its implementation in the same step. I did not record a separate red run. Against baseline `2cc2142` the new test files cannot load: the imported modules and the endpoints do not exist there.

### Fixtures

Every fixture used my own ports (4981–4985) and was stopped by its task ID afterwards. Screenshots regenerated by the other checks were reverted.

The UI fixture gained `FIXTURE_ONBOARDING=new|legacy` (`tools/onboarding-fixture.ts`). It uses the real `OnboardingService` and `FileSecretStore` over a throwaway directory, with fake Telegram, ntfy and SMTP servers on loopback. `/__fixture/onboarding` reports what those fakes received, never secret values.

Commands:
```
npm run build:client
FIXTURE_PORT=4981 FIXTURE_ONBOARDING=new FIXTURE_ENGINES=free FIXTURE_CHIEF=1 npx tsx tools/ui-fixture.ts
FIXTURE_PORT=4982 FIXTURE_ONBOARDING=legacy npx tsx tools/ui-fixture.ts
FIXTURE_URL=http://localhost:4981/ LEGACY_URL=http://localhost:4982/ npx tsx tools/onboarding-ui-check.ts
```

The UI check covers:
- the offer after founding;
- dialog semantics;
- the focus start and a 25-press Tab trap;
- validation;
- the free/paid labels;
- no Claude field;
- Linked accounts opening above the dialog and closing back to it;
- skip;
- a random topic;
- nothing sent while typing;
- one test per channel reaching only its fake server;
- secrets not in the DOM, shown as present;
- the approvals table and the prefilled chief cap;
- the summary;
- no stacked execution offer;
- progress saved as done;
- no second offer;
- re-opening from Settings;
- reduced motion (animation `none`);
- no overflow at 874x402 and 667x375;
- touch-sized controls;
- no media under Save-Data;
- cross-origin 403;
- the legacy install not offered but able to open it;
- zero console errors in every context.

Phone portrait (375x812) shows the game's deliberate "Rotate your device" screen, as `mobile-ui-check` asserts, so the 375 px check uses 667x375 landscape, as that check does.

## Screenshots (`reports/free-08/`)

| File | Shows |
| --- | --- |
| `01-company-1440x900.jpg` | Step 1, rail, free label |
| `02-workers-1440x900.jpg` | Engines summary, default engine, links to the existing flows, no Claude field |
| `03-notifications-empty-1440x900.jpg` | Three channels, unsaved |
| `04-notifications-saved-and-tested-1440x900.jpg`, `04b-…email…` | After three test sends: toasts, "Saved on the host", "saved, not delivering in this preview" |
| `05-approvals-1440x900.jpg` | Who approves what, budget, chief cap |
| `06-finished-1440x900.jpg` | Summary |
| `07-reopened-874x402.jpg` | Re-opened from Settings on a phone (reduced motion, Save-Data) |
| `08-notifications-667x375.jpg` | Smallest landscape phone |
| `09-legacy-settings-entry-1440x900.jpg` | Old install: no dialog, Settings entry at "0 of 4" |

## Not done / deferred / unverified

- **Real channels:** no real Telegram, ntfy or SMTP delivery was tried, by design. The Telegram transport is the existing one with a test-only base URL. Delivery from saved settings on a live host (backgroundServices on) is covered by code paths shared with the env path, but no running host was observed doing it.
- **Desktop:**
  - the vault adapter is unit-tested;
  - the packaged desktop app was not run.
- **Outreach settings:** stay env-only, pending the ORG-04b owner decision.
- **Discord webhooks** (FREE_STACK §4 option): not added.
- **Cloud mode:**
  - the summary panel only; no cloud-side settings.
  - FREE-07 can extend `CLOUD_APPLIES`;
  - the panel was not screenshotted: there is no cloud fixture for it in `onboarding-ui-check`.
- **Profile use:** the company profile is not yet fed to the chief's planner prompt. That belongs to FREE-02's owner if wanted.
- **Server secret file:** the key sits next to the data, so the protection is honest but limited. The UI says so.
- **Real devices:** none of this was run on a physical phone. Phone evidence is browser emulation only.
