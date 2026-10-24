# Free tier with optional premium

Owner direction, 2026-10-23:
- "Make this app totally free, even for developers", using free tools.
- Free is the **default and fallback**, not a replacement. Users can still link premium accounts: their Claude subscription for Claude Code, and Anthropic or OpenAI API keys.

Research and sources: [FREE_STACK.md](FREE_STACK.md). Gap audit: the 2026-10-23 audit summary in the coordinator's report. Baseline: `codex/empire-world` at `68ceca4`.

## Owner decisions (2026-10-23)

| Decision | Choice |
| --- | --- |
| Repository visibility | **Make it public** after a full secrets and history audit, with an MIT licence. The owner changes the visibility setting. |
| Hardware floor for local models | **16 GB**: default `gpt-oss:20b`, and offer `qwen3-coder:30b` / `qwen3.8:27b` when 32 GB or more is detected |
| iOS for free users | **Installable web app (PWA)**. The native app stays for when there's a paid Apple membership |
| Python | **Allowed** for this project where it's the best free option (overrides the TypeScript-only default) |
| Hosted free tiers (Gemini, OpenRouter, Groq) | Coordinator default: **opt-in, the user brings their own key**, with that provider's data-use and training terms shown before saving. Never the default |

## Rules (in addition to AGENTS.md)

1. **No paid account is ever required.** Every feature that spends money has a free path, or says plainly that it doesn't.
2. **Premium stays first-class.** A linked, healthy premium engine is preferred over a free one, and the user can choose per job.
3. **Claude subscription compliance** ([FREE_STACK.md](FREE_STACK.md) §9):
   - The Empire never offers its own Claude sign-in, and never reads, copies, collects, stores or relays Claude.ai credentials or tokens.
   - The user signs in inside the **unmodified** `claude` on their own machine (`/login`).
   - For cloud mode, the user runs `claude setup-token` and stores `CLAUDE_CODE_OAUTH_TOKEN` as their own Actions secret. The Empire only checks that the secret's name exists.
   - One person's subscription never serves other people's jobs.
   - API keys may still be sealed in the Empire's UI, as today.
   - *Open:* whether distributing the Empire needs Anthropic's Commercial Terms. The owner confirms this with Anthropic.
4. **Honest labels.**
   - Each worker shows its engine and model, e.g. "Qwen Code · gpt-oss:20b (local)" or "Claude Code · your Claude account".
   - Local spend shows as US$0. Estimates stay labelled as estimates.
   - A model-backed executive says so, and its output is a *proposal* until the CEO approves it.
5. **No automatic downloads.** Every model or voice download shows its name, size and licence, and needs an explicit click.
6. **Don't leak credentials between engines.** Subscription workers get `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `apiKeyHelper` scrubbed from their environment, so the subscription is really used and the API isn't billed silently.

## Slices (in build order)

| ID | Slice | Depends on | Acceptance |
| --- | --- | --- | --- |
| FREE-01 | Worker engines, model runtime, linked accounts | — | See below |
| FREE-02 | Thinking chief (CONSULT-04) on the shared model client | FREE-01 | See below |
| FREE-03 | Open-source readiness and free distribution | — | See below |
| FREE-04 | Free cloud mode: GitHub Actions runner as the sandbox | FREE-01, FREE-03 | See below |
| FREE-05 | Free voice; phone and chief call (CITY-02/03/04) | FREE-02 | See below |
| FREE-06 | One repository per product (scale) | FREE-01 | Products registry, a repo per product in the user's GitHub (API-throttled), workers bound to the product's repo, products UI |
| FREE-07 | Organization features in cloud mode | FREE-04 | The inbox, executives, research and outreach work in cloud mode through the state repo, or say clearly which parts can't |
| FREE-08 | Onboarding (ORG-06) | FREE-01, FREE-05 | Setup collects the company profile, engines and models, notification channels (Telegram, ntfy, email) and approval rules, replacing environment-variable-only configuration |
| FREE-09 | Bigger city with CC0 assets (CITY-05..08) | — | Districts, garage and owned cars, then the helicopter, built from Kenney/Quaternius/Poly Haven assets |
| FREE-10 | Organizational memory (CONSULT-05) | FREE-02 | Reviewed lessons with provenance; the chief cites them; nothing is self-modifying without approval |

### FREE-01: Worker engines, model runtime, linked accounts

- **Engine abstraction in `src/server/workers.ts`:**
  - `claude-code` (premium; the user's own `/login` on the host, or an API key);
  - `qwen-code` (free, Apache-2.0; Claude-style hooks wired to the existing hook endpoint);
  - `codex` (optional, `--oss` or the user's own `codex login` or API key).
  - Status detection uses each engine's hooks. If an engine can't report a state, the UI says "status unknown", never a guess.
  - The existing Claude path is unchanged.
- **Model runtime:**
  - Detect Ollama on `localhost:11434` (installed, running, models present).
  - Detect RAM and recommend a model by RAM.
  - Explicit download of a model, with its size, through Ollama's pull API.
  - If Ollama isn't installed, a clear install link (we don't bundle it).
  - A shared model client, `src/server/llm.ts`, that speaks the OpenAI-compatible API. It reaches Ollama locally, an opt-in user key for a free hosted tier, or an Anthropic or OpenAI API key. It's used by FREE-02 and FREE-05.
- **"Linked accounts" panel (Settings):**
  - Claude Code: installed or not, and its login state from `claude auth status` (read its *output* only, never credential files), with an expiry warning.
  - Codex: login state.
  - API keys: present or not.
  - Ollama: status and models.
  - Free hosted keys: optional, with their data-use terms.
  - A "Sign in to Claude" button that only opens a worker terminal with `/login` for the user to complete.
- **Engine choice:** per hire, plus a default. Premium is used when healthy; otherwise the free engine is offered with a clear label. Recreation, the typing gate and stale/offline rules are unchanged.
- **Tests:** a fake `qwen` CLI and a fake Ollama HTTP server. No real model calls in tests. Covers: engine status mapping from hooks, the environment scrub, model recommendations by RAM, the download confirmation flow, and fallback selection.

### FREE-02: Thinking chief

- The chief of staff gains an optional **planning brain** on the FREE-01 model client: free (local) or premium (an API key, or `claude -p` on the user's own host with their own login).
- **Planning:** a client brief becomes a *proposed* plan: items with phase, role, `parallel` and dependencies. It goes through the existing `job_plan` approval with an estimate (ORG-02).
- **Review:** after an item finishes, the chief writes a review summary and a recommendation (accept / needs changes). It never auto-accepts and never moves credits.
- **Coordination:** proposes regrouping or blocking when work stalls, as inbox items.
- **Budgets:** free is $0 (rate-limited by local speed). Premium has a daily cap in USD (default $2, CEO-editable), and the chief pauses itself at the cap.
- **Labels:** the card shows "Model-backed · <model> · proposals only". The rule-based mode stays as the fallback when no brain is configured.
- **Tests:** a fake model client returning fixed and malformed plans. Malformed output becomes needs-attention, never a guessed plan.

### FREE-03: Open-source readiness and free distribution

- **Audit:**
  - A secrets and history scan (gitleaks over all history); review the findings.
  - Check that no credentials, personal data or private paths sit in tracked files or screenshots.
  - Pinned action SHAs re-verified.
- **Repository files:** `LICENSE` (MIT), `SECURITY.md`, `CONTRIBUTING.md`, and a code of conduct.
- **Releases:** `release.yml` works on a public repo with the `release` environment. Distribution routes:
  - **macOS:** ad-hoc signed builds with "Open Anyway" instructions.
  - **Windows:** unsigned, plus a written SignPath Foundation application step for the owner.
  - **Android:** an APK on GitHub Releases, plus an Obtainium/IzzyOnDroid config.
  - **iOS and web:** a PWA manifest, a service worker that never caches authenticated API responses, and install instructions.
- **Owner action at the end:** the exact `gh repo edit --visibility public` command and a checklist. The Empire never flips visibility itself.

### FREE-04: Free cloud mode

- A `github-actions` provider adapter behind the existing `ProviderAdapter`. Each job runs in a GitHub Actions job in the product repo:
  - **Free:** Qwen Code with a model from, in order: the owner's self-hosted runner with Ollama, a user-opted free hosted key, then a small CPU model for trivial tasks.
  - **Premium:** `claude-code-action` with the user's own `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` secret.
- Money-safety rules still apply. The budget becomes wall time and turn caps, and `costCents = 0` for free runs.
- **Setup checklist for a Claude subscription:** the user runs `claude setup-token` and `gh secret set` in their own terminal; the Empire confirms only the secret's name. A rotation reminder at 11 months.

### FREE-05: Free voice and chief call

- **Speech:** speech-to-text with sherpa-onnx (Moonshine or Whisper) and text-to-speech with Kokoro, offline, downloaded only on explicit opt-in.
- **Phone (CITY-02):** contacts are the executives and workers. Calling the chief gives a spoken briefing from real reports, using the FREE-02 brain when present, otherwise rule-based.
- **Push-to-talk (CITY-04):** a transcript is sent once, with subtitles, cancel and a text fallback. The game apps keep the microphone off unless the user enables it.

## Coordination

- **First authors:** FREE-01 and FREE-03 run in parallel.
  - The FREE-01 author owns `src/server/llm.ts` and the engine types.
  - The FREE-03 author owns repository and distribution files. It coordinates README edits with the consistency sweep (merged first).
- **Next:** FREE-02 starts after FREE-01 merges, then FREE-04 and FREE-05.
- **Every slice:** failing-before tests, an independent review (a security review for credentials, distribution and cloud), an integration branch, every UI check, and a PR into `codex/empire-world`.
