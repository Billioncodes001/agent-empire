# FREE-01: worker engines, model runtime, linked accounts

Branch `claude/free-01-engines` from `aba620d`. Author: Claude Opus 5.5 (FREE-01 author). Status: **candidate**. It needs an independent review and a security review (credentials) before integration. Nothing is pushed.

## What changed

- **Engines** (`src/shared/engines.ts`, `src/server/engines.ts`, `src/server/workers.ts`):
  - `claude-code` (your account, or your API key), `qwen-code` (local Ollama model) and `codex` (`--oss`, or your own login).
  - The Claude launch path is unchanged: `claude --settings <hooks> [--resume] -- prompt`.
  - Qwen Code gets its hooks through `QWEN_CODE_SYSTEM_SETTINGS_PATH`, which points at `<dataDir>/qwen-system-settings.json`. The hooks post to the new `/hooks/qwen`. Hook format: [hooks docs](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/), [settings docs](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/).
  - Hooks from the wrong engine are refused.
  - Codex is `statusKnown: false`, so the UI says "status unknown". So does Qwen Code when no hook arrives within 12 s.
  - Engines persist. Legacy saves restore as Claude Code on your account.
- **Env scrub (rule 6):** every provider credential is removed, then only the engine's own is added back:
  - Subscription workers lose `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`, and keep the user's own `CLAUDE_CODE_OAUTH_TOKEN`.
  - API-key workers get only their key.
  - Codex-account and local workers get no keys.
  - Custom `--agent` commands and plain shells are unchanged.
- **Ollama** (`src/server/ollama.ts`, loopback only):
  - Detection through `/api/version` and `/api/tags`.
  - `/api/pull` only for catalogue models, and only with `confirm: true`. It streams progress, can be cancelled, and allows one pull at a time.
  - Install link when Ollama is absent.
  - RAM recommendation as decided by the owner. The UI notes that tags must be verified.
- **`src/server/llm.ts`:** an OpenAI-compatible client for Ollama, OpenRouter, Gemini, Groq, Anthropic and OpenAI. It has timeouts and optional SSE streaming, and reports token usage. Cost labels:
  - local: US$0;
  - free tier: US$0, "rate-limited";
  - paid: an estimate only from a caller-configured price, otherwise "no price configured". No price list is shipped, because prices change.
  - Nothing runs at import, and there are no retries.
- **Linked accounts:**
  - `GET /api/engines` reports names and states only.
  - `PUT|POST /api/engines/default`, `…/ollama/pull` and `…/ollama/cancel`.
  - `claude auth status` and `codex login status` run with a key-free environment. Only their output is parsed (JSON or text), and emails, org names and key fragments are dropped.
  - Expiry warning within 7 days.
  - No credential files are read and no Keychain access happens.
- **UI:**
  - The Settings panel covers Claude, Qwen, Ollama (download, confirm, progress, cancel), Codex, key names, opt-in hosted terms and the default engine.
  - The hire dialog's engine choice prefers premium when healthy, otherwise offers free with its label, and refuses to hire when nothing is ready.
  - The engine appears on the HUD card (with `US$0` for local workers), the name plate and the terminal header.
  - "Sign in to Claude" hires a Claude worker on your account and types `/login` without Enter.
- **Desktop:** the vault adds `openaiKey` and the hosted keys. Saving a hosted key needs the terms checkbox, which is enforced in `main.cjs`. Keys reach the server by name through `providerKeys`. The vault's `status()` shape is unchanged.

## Evidence

| Check | Result |
| --- | --- |
| typecheck, `npm run build` | pass |
| `npm test` | 729/729. New `tests/engines.test.ts` (14), using fake CLIs on a PATH-only resolver, a fake Ollama and a fake model API |
| `tools/engines-ui-check.ts` (fixture 4847, `FIXTURE_ENGINES=free`) | 24/24, desktop and 874x402 with reduced motion and Save-Data, no console errors |
| mobile-ui-check | 411/411. It first failed 409/411 because the header tag squeezed the title at 667x375; fixed |
| life04 / inbox / outfit UI checks | 20/20, 47/47, 29/29 |

Screenshots are in `docs/team/reports/free-01/`. Unrelated regenerated screenshots were reverted. No real `claude`, `codex`, `qwen`, Ollama pull or paid call was run. Port 4610, Pixel and `.agent-office` were never touched.

## Review fixes (security review 2026-10-24: accept with fixes)

Each fix has failing-before tests in `tests/engines.test.ts` (7 new; 21 engine tests total) and its own commit.

1. **API-key sign-in is never "your Claude account".** The subscription option is usable only when `claude auth status` reports a subscription method (claude.ai / OAuth). An API key, `apiKeyHelper` or console method makes it unusable and shows why, and "auto" falls back to free. The `--settings` env/`apiKeyHelper` override was **not** added, because its effect on an empty value isn't documented; the method check is used instead.
2. **Qwen prompt injection.** The prompt is now a single `--prompt-interactive=<prompt>` argument (yargs takes everything after `=` as the value). Tested with `--yolo`, `--approval-mode=yolo` and `-y …`.
3. **Sign in without SessionStart.** `/login` is also typed when Claude's own logged-out prompt is on screen. It is never typed into setup menus (login method, trust) and never followed by Enter. Both paths are tested.
4. **Moderate fixes:**
   - The model client caps JSON and streaming responses at 4 MB and stops reading when the cap is hit. Key-shaped text (`sk-…`, `AIza…`, `gsk_…`) is redacted from provider errors.
   - The task namer's `claude -p` gets the same scrubbed env as a subscription worker.
   - `CLAUDE_CODE_USE_FOUNDRY`, `ANTHROPIC_FOUNDRY_API_KEY` and `AZURE_OPENAI_API_KEY` are added to the scrub list.
   - `GET /api/engines?refresh=1` is rate-floored to 10 s.
   - A saved engine this version doesn't recognise keeps the worker with status unknown and the label "Unknown engine", logs a warning and refuses to resume. It is never switched to Claude.

Re-run after the fixes: typecheck pass, `npm test` 736/736, build pass, engines-ui-check 24/24, mobile-ui-check 411/411.

## Deviations and limits

- **Qwen hooks are not written into the worktree.** System-scope settings avoid folder-trust gating and accidental commits. The cost is that this file replaces any `/Library/Application Support/QwenCode/settings.json` for Empire workers.
- **`apiKeyHelper`** is a Claude settings key and the Empire doesn't edit the user's settings. Instead, the panel warns when `claude auth status` reports an API-key or helper method.
- **Not verified against real binaries:** the `claude auth status` JSON shape, the Qwen `-i` flag (inherited from Gemini CLI), and Codex `-c oss_provider` / `-m`.
- **Codex** has no status hooks in this slice.
- **Resume** is Claude-only. Other engines start a new session and say so.
- The queue and other no-engine spawns use the saved default, else Claude Code on your account. In that case API keys are now scrubbed for `claude` (rule 6).
- No usage or cost tracking for Qwen or Codex sessions beyond the US$0 label for local workers.
