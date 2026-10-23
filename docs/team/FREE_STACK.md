# FREE-00: Free tier + optional premium linking

Owner direction (2026-10-23): "make this app totally free, even for developers… make use of free tools to achieve all the goals… find free tools, services on GitHub relevant to the tools you need."

Owner clarification (2026-10-23): the free tools are the **default and fallback for users without premium accounts**. Paid options stay. Users must be able to link premium accounts for cloud agents and frontier models: especially **signing in with their own Claude account (Pro/Max) to use Claude Code**, plus Anthropic and OpenAI API keys as today. Sections 1 to 8 cover the free tier. [Section 9](#9-premium-account-linking) covers premium linking.

This document is research only. Nothing was installed, no model was downloaded, no API key was created and no paid call was made. Every fact was checked on **2026-10-23** against the official page, repository or GitHub API listed next to it, unless it is marked **(secondary)** (third-party report, verify before relying on it) or **(unverified)**. Star counts and release dates come from the GitHub GraphQL API on that date.

## Executive summary

**What can be fully free (zero money, permissive licences):**

- **Local AI workers.** An open-source coding agent CLI (Qwen Code, OpenCode, Codex CLI or Goose, all Apache-2.0 or MIT) driving an open-weight model (Qwen3.8-27B, Qwen3-Coder-30B-A3B, Devstral Small 2 or gpt-oss-20b, all Apache-2.0) through Ollama or llama.cpp (MIT). Qwen Code and Codex CLI both have **Claude-Code-style lifecycle hooks** (`UserPromptSubmit`, `Stop`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `SessionStart`), so the existing hook bridge in `src/server/workers.ts` can be reused almost unchanged. The cost is hardware: a 16 GB machine is the floor, 32 GB is comfortable, and local models are slower and weaker than Claude.
- **Speech.** whisper.cpp (MIT) or sherpa-onnx (Apache-2.0) for STT, and Kokoro-82M (Apache-2.0 weights) through sherpa-onnx for TTS. All offline.
- **Notifications.** Telegram Bot API (already integrated), ntfy (Apache-2.0 / GPL-2.0 dual, free public server or self-host) and Discord webhooks.
- **Art and sound.** Kenney, Quaternius, Poly Haven and ambientCG are CC0. Blender is free (GPL, which only matters if we redistribute Blender itself).
- **Distribution for desktop and Android.** GitHub Releases, ad-hoc-signed macOS builds (users must click "Open Anyway"), unsigned or SignPath-signed Windows builds, winget, Android APK sideloading, Obtainium and IzzyOnDroid/F-Droid.
- **Repo-per-product hosting.** GitHub Free gives unlimited private repositories. The limits that bite are the API's content-creation rate limits, not repository counts.

**What cannot be fully free, and the cheapest honest alternative:**

| Goal | Why it is not free | Cheapest honest alternative |
| --- | --- | --- |
| Claude-quality coding agents | Frontier models are paid. GitHub Models (which gave free inference with a GitHub token) **was retired on 2026-07-30**. | Local open-weight models (free, weaker). Free hosted tiers (Gemini API, Groq, OpenRouter `:free`, Cloudflare Workers AI) are rate-limited, can change at any time and in some cases train on your data. |
| Cloud mode without Anthropic Managed Agents | Managed Agents is paid per session. | Run an OSS agent CLI **inside a GitHub Actions job** (the runner is the sandbox). Free and unlimited for **public** repos; private repos get 2,000 Linux minutes a month on GitHub Free. The model is still the problem: standard runners have no GPU, so either a small CPU model (slow) or a free hosted tier. |
| Signed and notarized macOS app, Mac auto-update in place | Developer ID signing and notarization need the Apple Developer Program (US$99/yr). Squirrel.Mac only updates signed apps. | Ad-hoc signing plus a one-time "Open Anyway". Updates by downloading the new release (the app can prompt for it). |
| iOS distribution to other people | Every distribution path (App Store, TestFlight, EU alternative marketplaces, web distribution) needs a paid membership. | A free Apple ID gives 7-day builds on up to 3 of your own devices. AltStore/SideStore build on that and keep the same limits. **PWA install is the only free option for other iOS users.** |
| Android sideloading from 2027 | Google is rolling out developer verification for certified devices: Brazil, Indonesia, Singapore and Thailand from 2026-09-30, global in 2027. | The free "limited distribution" account allows up to 20 devices without ID or fee. Paid verification follows Google's FAQ (fee not stated on the main page). Users can still use the "advanced flow" to install unverified apps. |
| Bulk or cold email outreach | Free tiers are capped (100 to 300 a day) and the providers' terms forbid unsolicited mail. | Transactional or opted-in mail only, on a free tier. Cold outreach is not offered by any reputable free provider and should stay an owner decision. |
| A protected `release` environment while the repo stays private | On GitHub Free, environments, environment secrets and protection rules work **only in public repositories**. `release.yml` (REL-02) relies on a protected `release` environment. | Make the repo public (it is already `"license": "MIT"` in `package.json`), or pay for GitHub Pro (personal). Making it public also unlocks free Actions minutes, bigger runners and SignPath eligibility. |

**Premium linking (section 9) in one paragraph:** Anthropic offers **no "Sign in with Claude" for third-party apps**, and its Claude Code legal page forbids third parties from offering Claude.ai login or from collecting, storing or intermediating Claude.ai credentials or tokens. The compliant paths are: (1) the user signs in to the **unmodified `claude` CLI on the machine where workers run**, through Anthropic's own `/login`. That is today's design for own-server and "Run on this computer". (2) For cloud mode, the user runs `claude setup-token` (a one-year token, Pro/Max/Team/Enterprise) and stores it **themselves** as the `CLAUDE_CODE_OAUTH_TOKEN` Actions secret in their own repo, or uses `/install-github-app`. Empire never sees the token, not even to seal it. (3) API keys (Anthropic, OpenAI) stay as today and are the documented choice for automation. Codex CLI's "Sign in with ChatGPT" works for local workers. OpenAI says API keys remain the recommended default for automation, and its CI `auth.json` route is limited to trusted private infrastructure and is not for public repos.

**The single most valuable free move is to open-source the repository** (it is currently `PRIVATE` on GitHub). That makes Actions free, gives 4-CPU/16 GB Linux runners instead of 2-CPU/8 GB, enables environments on GitHub Free, and is a hard prerequisite for SignPath Foundation and F-Droid. It is an owner decision (see open questions).

## 1. Free LLM inference

### 1a. Local runtimes (OpenAI-compatible API)

| Name | Licence | What it does for us | Platforms | Maintenance | Risks |
| --- | --- | --- | --- | --- | --- |
| [Ollama](https://github.com/ollama/ollama) | MIT | One-command model pull and serve. OpenAI-compatible `/v1` endpoint. Codex CLI has a built-in `ollama` provider (`--oss`). MLX builds of some models (for example `qwen3.8:27b-mlx`). | macOS (Apple Silicon), Windows, Linux | v0.40.10, 2026-10-23; 184k stars | Also sells cloud models (`*-cloud` tags), so the default catalogue mixes local and hosted. We must pin local tags. The default context window may be smaller than agents need (set `num_ctx`). |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | MIT | `llama-server` is OpenAI-compatible. Lowest-level, most portable, best for bundling a runtime. Metal, CUDA, Vulkan, CPU. | All, including Apple Silicon | v0.7.0, 2026-10-15; 132k stars | We would manage GGUF downloads and chat templates ourselves. Tool-call parsing depends on the model template. |
| [MLX-LM](https://github.com/ml-explore/mlx-lm) | MIT | Apple's MLX runtime. `mlx_lm.server` exposes an OpenAI-style API. Usually the fastest option on Apple Silicon. | macOS Apple Silicon only | v0.32.2, 2026-10-16; 7.5k stars | Mac-only, Python dependency (needs owner approval under the TypeScript-first rule). |
| [LM Studio](https://lmstudio.ai/terms) | **Proprietary EULA** (the `lms` CLI repo is MIT, the app is not) | Polished GUI and OpenAI-compatible server. Codex CLI has a built-in `lmstudio` provider. | macOS, Windows, Linux | App closed source | Licence permits "personal and/or internal business purposes" only, and forbids redistribution or offering it as a service. Fine as an optional user choice. **Do not bundle it or make it the default.** |

**Recommendation: Ollama as the default**, with llama.cpp `llama-server` as the bundled or headless fallback. Install size and RAM are dominated by the model, not the runtime.

### 1b. Open-weight coding models for a 16 to 32 GB machine

Sizes are Ollama's quantized download sizes (checked on the ollama.com library pages). They need roughly the download size in RAM plus context cache, so an 18 GB model needs a 32 GB machine in practice.

| Model | Licence | Download | Context | Fits | Notes |
| --- | --- | --- | --- | --- | --- |
| [Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B) | Apache-2.0 (HF licence tag, released 2026-08-14) | 18 GB (`qwen3.8:27b`, MLX variant available) | 256K | 32 GB | Dense, tools and thinking, vision. Self-reported SWE-bench Pro 61.7 **(secondary, not independently replicated)**. Dense means slower (5 to 7 tok/s reported on a 32 GB M5 for comparable dense 27B models, **(secondary)**). The larger **Qwen3.8-Max uses a different, restrictive licence** **(secondary)**, so do not assume every Qwen model is Apache-2.0. |
| [Qwen3-Coder-30B-A3B-Instruct](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct) | Apache-2.0 | 19 GB (`qwen3-coder:30b`) | 256K | 32 GB | Mixture of experts (about 3B active), so much faster than a dense 27B. Trained for agentic coding. |
| [Devstral Small 2 (24B)](https://ollama.com/library/devstral-small-2) | Apache-2.0 | 15 GB | 384K | 24 to 32 GB | Built for coding agents (codebase exploration, multi-file edits). |
| [gpt-oss-20b](https://ollama.com/library/gpt-oss) | Apache-2.0 | 14 GB | 128K | **16 GB** (MXFP4) | The only strong option that the vendor states runs in 16 GB. General reasoning model with function calling, not a coding specialist. |

Model releases change monthly. Ollama's "tools" catalogue on 2026-10-23 already listed newer agentic models (for example Meta's `muse-glimmer` 30B, stated Apache-2.0), which we have not evaluated. Re-check before choosing.

**Recommendation:** default to **Qwen3-Coder-30B-A3B on 32 GB** (speed) with **Qwen3.8-27B** as the quality option, and **gpt-oss-20b on 16 GB**. Before committing, run a small fixed benchmark of our own tasks through each agent CLI. Small local models are noticeably worse at long tool-calling loops than Claude, so the UI must expect more `needs_input` and failed turns.

### 1c. Free hosted tiers

| Service | Free terms (checked 2026-10-23) | Usable from CI | Data use | Risks |
| --- | --- | --- | --- | --- |
| **GitHub Models** | **Retired 2026-07-30** ([changelog](https://github.blog/changelog/2026-07-30-github-models-is-now-retired/), [docs](https://docs.github.com/en/github-models/use-github-models/prototyping-with-ai-models)). GitHub points to Microsoft (Azure AI) Foundry, which is paid. | No longer available | n/a | Any plan relying on "free models via `GITHUB_TOKEN`" is dead. |
| [Google Gemini API](https://ai.google.dev/gemini-api/docs/rate-limits) | A free tier exists. Per-model RPM/RPD are shown only in AI Studio, not on the docs page. Limits are per project. | Yes (API key as an Actions secret) | [Terms](https://ai.google.dev/gemini-api/terms): unpaid usage may be used to "improve, and develop" Google products and ML, and human reviewers may read it. Do not send confidential code. **Apps offered to users in the EEA, UK or Switzerland must use paid services.** | Training on our users' code. EEA restriction conflicts with a global free app. |
| Gemini CLI login (Code Assist for individuals) | 1,000 requests/user/day with a Google account. 250/day (Flash only) with a free API key ([quota page](https://geminicli.com/docs/resources/quota-and-pricing/)). | Per user, not for a shared bot | Not stated on the quota page | The page says Gemini CLI was **replaced by Antigravity CLI on 2026-06-18**. Treat this as a moving target. |
| [Groq](https://console.groq.com/docs/rate-limits) | The docs table is labelled base **Developer**-plan limits, for example gpt-oss-120b, gpt-oss-20b and qwen3.8-27b at 30 RPM, 1K RPD, 8K TPM, 200K TPD. Free-plan numbers are only shown in the account's limits page. | Yes (API key) | (unverified) | 8K tokens a minute is too low for agentic coding with big contexts. |
| [OpenRouter `:free`](https://openrouter.ai/docs/api-reference/limits) | 20 RPM and **50 requests/day** with under 10 credits ever purchased. 1,000/day after buying at least 10 credits (a one-off purchase, so not strictly free). | Yes (API key) | Varies per provider. [Privacy settings](https://openrouter.ai/docs/features/privacy-and-logging) control routing to providers that may train on prompts. | 50/day is a demo allowance, not a worker. |
| [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/) | 10,000 Neurons/day on Free and Paid plans. On Free, calls fail once exhausted. | Yes (API token) | (unverified) | Small allowance. Model catalogue is mostly small models. |
| [Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers/pricing) | **Free users get no monthly credits.** PRO gets US$2/month. | n/a | n/a | Not free. |

**Recommendation:** none of the hosted tiers is a sound default for a "totally free" product. Offer them as an optional "bring your own free key" setting (Gemini first, OpenRouter second), with a clear warning about training and rate limits. Never make them the silent default.

## 2. Open-source coding agent CLIs (Claude Code replacements in a PTY)

Our integration needs: run in a PTY, accept prompts, report **working / done / needs input**, work in a git worktree, and use a local or OpenAI-compatible model.

| CLI | Licence | Maintenance | Headless | Status signals | Local models | Fit |
| --- | --- | --- | --- | --- | --- | --- |
| [Qwen Code](https://github.com/QwenLM/qwen-code) | Apache-2.0 | 28.7k stars, released 2026-10-22 | `-p`/stdin. `--output-format json` or `stream-json`. Budgets `--max-wall-time`, `--max-tool-calls`, `--max-session-turns` (exit codes 55 and 53) ([headless](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/)) | **[Hooks](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/) in `settings.json` with Claude Code's shape:** `UserPromptSubmit`, `Stop`, `StopFailure`, `Notification`, `PermissionRequest`, `PreToolUse`, `PostToolUse`, `SessionStart`/`SessionEnd`. Accepts Claude tool-name matchers and sets `CLAUDE_PROJECT_DIR`. Differences: timeouts in seconds, no variable substitution in bash hooks. | OpenAI-compatible providers (configuration page not read in detail) | **Closest drop-in for `workers.ts`.** Our hook script reads JSON from stdin and posts it, which should port with a per-CLI event map. |
| [Codex CLI](https://github.com/openai/codex) | Apache-2.0 | 130k stars, released 2026-10-23 | `codex exec` | **Hooks** (`features.hooks`): `UserPromptSubmit`, `Stop`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `SessionStart`/`SessionEnd`, `Interrupt` and more, plus `notify` (a command that receives JSON) ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference)). | `--oss` with built-in `ollama` or `lmstudio`. Custom `model_providers.<id>.base_url`, but **only the Responses wire API** is supported. | Strong second choice. Hooks match ours. Provider settings must go in user-level config, because project `.codex/config.toml` ignores `model_provider` and `notify`. Runtimes without a Responses API do not work. |
| [OpenCode](https://github.com/anomalyco/opencode) (formerly `sst/opencode`) | MIT | 220k stars, v1.19.4, 2026-10-22 | `opencode run --format json` (raw JSON events), `--auto` approves permissions. `opencode serve` HTTP server with basic auth ([CLI](https://opencode.ai/docs/cli/)). | [Plugin events](https://opencode.ai/docs/plugins/): `session.idle`, `session.status`, `session.error`, `permission.asked`, `tool.execute.before`/`after`, `message.*`. | Many providers, including OpenAI-compatible and Ollama (Providers page not read in detail) | Very good, but the integration is a JS plugin or HTTP event stream rather than our hook script. The server mode may be cleaner than scraping a PTY. |
| [Goose](https://github.com/aaif-goose/goose) (moved from `block/goose` to the Agentic AI Foundation) | Apache-2.0 | 55.6k stars, v1.56.0, 2026-10-23 | `goose run -t` / `-i`, `--recipe`, `--no-session`, `--max-turns`, `--provider`, `--model`. `--output-format json` or `stream-json` **(secondary, cheat sheet and man page)** | No Claude-style hooks found. Parse the JSON stream. | Ollama and OpenAI-compatible | Viable, but more glue needed. |
| [OpenHands](https://github.com/OpenHands/OpenHands) | MIT | 91.7k stars, v1.33.0, 2026-10-23 | `openhands --headless -t … --json` (JSONL events). Headless always auto-approves ([docs](https://docs.openhands.dev/openhands/usage/cli/headless)). | JSONL events. Exit codes not documented. | Yes (details not checked). Docker sandbox requirement not confirmed. | Heavier. Better suited to cloud and CI than to a desk PTY. |
| [Aider](https://github.com/Aider-AI/aider) | Apache-2.0 | 49.7k stars, **last release v0.86.0, 2025-08-09** | `--message` runs one instruction and exits. `--yes`, auto-commits on by default ([scripting](https://aider.chat/docs/scripting.html)). | Process exit only. Python API unsupported. | Excellent model coverage | Mature git integration but slowing maintenance. Python. Edit-format model rather than a tool-calling agent, which can work better with weak models. Keep as a fallback. |
| [pi](https://github.com/earendil-works/pi) (coding agent) | MIT | 117k stars, v1.4.0, 2026-10-21 | Print, JSON and RPC modes; extensions | Extensions (no hook list confirmed) | Multi-provider (Ollama not confirmed) | Worth a spike: RPC mode could be cleaner than a PTY. |
| [Crush](https://github.com/charmbracelet/crush) | **FSL-1.1-MIT (not OSI open source)**, converts to MIT after 2 years | 28.8k stars | — | — | — | **Avoid**: it forbids "Competing Use". |
| Cline CLI | Apache-2.0 ([repo](https://github.com/cline/cline)) | 70.8k stars | Not researched in depth | — | — | Not evaluated. |

Tool-calling quality with small local models was not measured. No model was downloaded. Community reports **(secondary)** say MoE models (for example Qwen3.6-35B-A3B) are fast but sometimes loop or fail to run tools, while dense 27 to 31B models write better code at 5 to 7 tok/s.

**Recommendation: Qwen Code as the default free worker**, because its hooks match the events `workers.ts` already consumes (`SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`, `PermissionRequest`, `PreToolUse`, `PostToolUse`). **Codex CLI `--oss` is the second adapter.** Spike OpenCode's server mode for a non-PTY integration later. Usage and spend tracking (`usage.ts` reads Claude transcripts) needs a per-CLI implementation, and local runs have provider spend of zero, which keeps them clearly separate from fictional city credits.

## 3. Free speech (offline)

| Name | Licence | Role | Models and size | Bindings | Maintenance | Risks |
| --- | --- | --- | --- | --- | --- | --- |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | MIT (code). Whisper weights are MIT from OpenAI. | STT | tiny 75 MiB disk / ~273 MB RAM up to large 2.9 GiB / ~3.9 GB (README) | C API, JS/WASM, Swift XCFramework, `whisper-server` with an OpenAI-like HTTP API; Metal and Core ML on Apple Silicon | v1.9.5, 2026-10-06; 54.6k stars | Batch rather than streaming (a `whisper-stream` example exists). Latency on our hardware not measured. |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Apache-2.0 | STT (streaming and offline, including Whisper, Moonshine, SenseVoice, Zipformer), **TTS (Kokoro, Piper VITS, Matcha, Kitten)**, VAD, keyword spotting | Per model | **Node addon, WebAssembly**, Swift, Kotlin; iOS, Android, macOS, Windows, Linux | v2.0.0, 2026-10-23; 15.5k stars | One dependency for both STT and TTS on every platform, including mobile. Each model carries its own licence. |
| [Moonshine](https://github.com/moonshine-ai/moonshine) | Code MIT. Models MIT **except legacy non-streaming non-English models (non-commercial Moonshine Community License)** | STT, streaming, low latency | Down to about 1 MB "micro" models | Python, JS/WASM, C API; iOS, Android, macOS, Windows, Linux | v0.1.5, 2026-08-24; 11.3k stars (GitHub reports NOASSERTION for the licence) | Check each model's licence. Available through sherpa-onnx too. |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | MIT | STT | Whisper sizes | Python only | Last release v1.2.1, 2025-10-31 | Python (needs owner approval). CPU/NVIDIA-oriented, no Metal. |
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) | Apache-2.0 weights; [kokoro](https://github.com/hexgrad/kokoro) Apache-2.0 | TTS, high quality for its size | 82M parameters | Through sherpa-onnx (Node/WASM) or [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) (MIT) | hexgrad repo last pushed 2025-08 | Upstream mostly static. Use the sherpa-onnx packaging. |
| Piper | Old [rhasspy/piper](https://github.com/rhasspy/piper) is MIT but **archived**. Successor [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl) is **GPL-3.0**. | TTS, very fast on CPU | Small VITS voices | Voices usable through sherpa-onnx | piper1-gpl v1.8.0, 2026-09-04 | **Copyleft engine.** Voice licences vary per voice. Use voices through sherpa-onnx (Apache-2.0), not the GPL engine. |

**Recommendation: sherpa-onnx as the single speech runtime** (Node addon on desktop and server, WASM in the browser, native on mobile), with **Moonshine or Whisper-small for STT and Kokoro for TTS**. Use whisper.cpp `whisper-server` as the simpler desktop STT fallback. Latency on Apple Silicon and CPU was not measured, because no models were downloaded. Measure before choosing default sizes.

## 4. Free email and notifications

| Option | Free terms (2026-10-23) | Outreach/marketing allowed? | Notes |
| --- | --- | --- | --- |
| [Telegram Bot API](https://core.telegram.org/bots/faq) | Messages "at no cost". About 1 msg/s per chat, 20/min per group, about 30/s bulk. Paid broadcasts above that. | Only to users who started the bot | Already integrated. Best free channel. |
| [ntfy](https://github.com/binwiederhier/ntfy) | **Dual Apache-2.0 / GPL-2.0.** Public ntfy.sh is free without sign-up (limits not stated in the README). Paid plans from US$5/month. Self-hosting is free. | n/a (push) | v2.33.1, 2026-10-23, 35k stars. Topics on the public server are guessable, so use random topic names or self-host. |
| Discord webhooks | Free. Discord enforces rate limits (429 with `retry_after`). Exact per-webhook numbers not verified. | Your own server only | Trivial to add. |
| [Resend](https://resend.com/pricing) | 3,000/month, **100/day**, 3 domains, 30-day retention. Free marketing plan: 1,000 contacts. | **No.** The [acceptable use policy](https://resend.com/legal/acceptable-use) forbids "unsolicited messages of any kind" and requires explicit opt-in. | Good free transactional option. |
| [Mailjet](https://www.mailjet.com/pricing/) | 6,000/month, **200/day**, 1,000 contacts. Mailjet branding on free. | Opt-in only (terms not read in detail) | |
| Brevo | **300/day** **(secondary, several 2026 reviews; the official pricing page did not render)**, Brevo branding | Opt-in marketing allowed, cold lists not (unverified) | |
| Gmail SMTP with app password | Consumer Gmail about 500/day and about 100 recipients per message over SMTP **(secondary, Google's consumer page not retrieved)**. Workspace: 2,000/day (500 on trial) ([Google](https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace)). | Personal use. Bulk sending risks a suspension. | Works with nodemailer. Needs 2-Step Verification to create an app password. |
| Outlook.com SMTP with app password | **Basic auth/app passwords for SMTP are retired**, OAuth only **(secondary)**. | — | Do not plan on it. |

**Recommendation: Telegram as the primary notification channel, plus ntfy (self-hosted or random topics) for push and Discord webhooks as an option.** For email, use **Resend's free tier for transactional and opted-in mail** (with Gmail SMTP as a personal fallback). **Cold outreach is not available free under any reputable provider's terms.** Any outreach feature needs opt-in lists and an explicit owner decision.

## 5. Free cloud execution

| Option | Free terms (2026-10-23) | Fit |
| --- | --- | --- |
| [GitHub Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions) | **Standard runners free in public repos.** Private: 2,000 min/month (Free), 3,000 (Pro). Windows uses minutes at 2x and macOS at 10x ([multipliers](https://docs.github.com/en/enterprise-cloud@latest/billing/concepts/product-billing/github-actions)). Jobs max **6 h**, runs max 35 days, 20 concurrent jobs (5 macOS), `GITHUB_TOKEN` 1,000 API req/h/repo ([limits](https://docs.github.com/en/actions/reference/limits)). Runners: **public 4 CPU / 16 GB**, private 2 CPU / 8 GB, macOS arm64 3 CPU (M1) / 7 GB, **no GPU** ([specs](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)). | **Best free sandbox.** A job checks out the product repo, runs Qwen Code or Codex headless, pushes a branch and opens a PR. The coordinator already lives in Actions. The model problem remains: CPU-only inference of a 20 to 30B model on 4 vCPU is very slow (not measured). Realistic choices are a small model (for example gpt-oss-20b at low effort) for simple tasks, or a user-supplied free hosted key. |
| [Codespaces](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces) | 120 core-hours (= 60 h on 2-core) and 15 GB-month on Free; 180 on Pro. Blocked when exhausted unless a payment method is on file. | Good for a contributor's dev environment. Not for always-on workers. |
| [Oracle Cloud Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) | Ampere A1: 4 OCPU / 24 GB in total, 200 GB block storage, 10 TB egress/month, 2 AMD micro VMs. **Idle instances are reclaimed** (95th-percentile CPU, network and memory all under 20% for 7 days). Home region only. | The best always-free VM for self-hosting the server, and even a small CPU model on 24 GB Arm. Risks: account approval needs a card, A1 capacity is often unavailable **(secondary)**, and the reclamation rule fits an idle office poorly. |
| Self-hosted Actions runner on the owner's own machine | Self-hosted runner usage is free | Lets cloud-mode jobs use a local Mac's Ollama. Never attach self-hosted runners to a public repo (fork PRs could run code on it). |

**Recommendation:** cloud mode's free path is a **"GitHub Actions worker" provider** behind the existing `ProviderAdapter` seam (`src/cloud/provider.ts`): one job per task running Qwen Code headless with a budget (`--max-wall-time` under the 6 h cap), status from `stream-json` and exit codes, and results as a PR. Model source in order of preference: (1) the owner's self-hosted runner with Ollama (private repos), (2) a user-supplied free hosted key, (3) a small CPU model on a public-repo runner. **A public repository is required for this to be free at scale.**

## 6. Free distribution and signing

| Platform | Free option (2026-10-23) | Honest limits |
| --- | --- | --- |
| All | **GitHub Releases**: no total size or bandwidth limit for release binaries. Each file must be under the plan's Git LFS file-size maximum ([docs](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)). | **Release assets of a private repo need authentication to download**, so the in-app update feed (`…/releases/latest/download/…`) only works for anonymous users from a public repo, or from a separate public "releases" repo. |
| macOS | Ad-hoc signing (`codesign -s -`, required on Apple Silicon anyway). Users open it once via **System Settings → Privacy & Security → Open Anyway** ([Apple](https://support.apple.com/en-us/102445)). | Gatekeeper warns on first launch. No notarization. **Squirrel.Mac in-place updates need a signed app**, which `RELEASING.md` already notes, so unsigned builds update by download and replace. Homebrew Cask is a possible free channel (not researched). |
| Windows | Unsigned builds work, with SmartScreen warnings. [SignPath Foundation](https://signpath.org/terms): free certificates for OSS. | SignPath requires an **OSI licence for all components, no proprietary parts, verifiable CI builds from public source, manual approval of each release, MFA for every team member, and a "Code signing policy" section on the home page**. Our repo must be public first. [winget](https://github.com/microsoft/winget-cli) (MIT) manifests are a free PR to `microsoft/winget-pkgs`. |
| Android | APK sideloading from GitHub Releases. [Obtainium](https://github.com/ImranR98/Obtainium) (GPL-3.0, a separate app, no licence impact) installs and updates straight from GitHub Releases. IzzyOnDroid repo. F-Droid main repo. | **F-Droid** builds from source and rejects Play Services, Firebase and proprietary SDKs ([policy](https://f-droid.org/docs/Inclusion_Policy/)). **[Developer verification](https://developer.android.com/developer-verification)**: required on certified devices in BR/ID/SG/TH from 2026-09-30 and globally in 2027. The free limited-distribution account covers **up to 20 devices**. Beyond that, a verified account (fee per Google's FAQ, not read). The power-user "advanced flow" still installs unverified apps. |
| iOS | Free Apple ID "Personal Team": **7-day** provisioning, **3 devices**, **3 apps per device**, 10 App IDs ([Apple](https://developer.apple.com/support/compare-memberships/)). AltStore (AGPL-3.0) and SideStore (AGPL-3.0) automate re-signing every 7 days on top of this. | No free way to distribute to other people. **EU alternative marketplaces need notarized apps from paid Apple Developer Program members**, and operators must be organisations meeting financial criteria ([Apple](https://developer.apple.com/support/alternative-app-marketplace-in-the-eu/)). TestFlight and the App Store are paid. **Fallback: the PWA (web game) installed to the Home Screen**, which is free and is the only path for ordinary iOS users. |

**Recommendation:** ship **GitHub Releases from a public repo**, with ad-hoc macOS builds and SignPath-signed Windows builds (once eligible), plus winget. For Android, use APK, Obtainium and IzzyOnDroid now and aim for F-Droid. On iOS, offer the **PWA first** and document the 7-day self-build for developers. Keep the paid Apple and Google signing paths in `release.yml` as optional, secret-gated upgrades (they already are).

## 7. Free 3D/art assets and tools

| Source | Licence | Notes |
| --- | --- | --- |
| [Kenney](https://kenney.nl/support) | CC0 | Commercial use allowed. Attribution optional. Do not use Kenney's logo. |
| [Quaternius](https://quaternius.com/faq.html) | CC0 | Includes rigged, retargetable humans (Universal Base Characters, Universal Animation Library 1 and 2, Animated Men/Women packs). Some bundles are Patreon-linked, so check each pack page. |
| [Poly Haven](https://polyhaven.com/license) | CC0 (assets) | HDRIs, textures, models. Site terms restrict scraping, and the API has separate terms. |
| [ambientCG](https://docs.ambientcg.com/license/) | CC0 (licence page redirect not followed; widely documented as CC0, **(unverified today)**) | PBR materials. |
| Mixamo | **Free but not open.** Royalty-free commercial use, no attribution. **Raw character and animation files may not be redistributed**, and Mixamo content may not be used to train ML models **(secondary, Adobe FAQ text reposted on Adobe Community; the helpx page returned 403)**. | **Do not commit Mixamo FBX/GLB files to a public repo.** Baked into a shipped game build is allowed. Prefer the Quaternius Universal Animation Library (CC0). |
| [Blender](https://github.com/blender/blender) | GPL-2.0-or-later (GitHub shows NOASSERTION) | Free tool. Output files are ours. GPL applies only if we redistribute Blender or its Python add-ons. |
| Freesound | Per-sound licences. Filter to CC0. | CC-BY sounds need attribution in `THIRD_PARTY_NOTICES.md`. |
| Sonniss GDC Game Audio Bundles | Royalty-free, no attribution, **no AI training** **(secondary, official licence page 404'd)** | Raw redistribution in a public repo is not clearly allowed. Bundle the sounds in builds, not as a sample library. |

**Recommendation:** default to the **CC0 sources (Kenney, Quaternius, Poly Haven, ambientCG)** and **Quaternius rigged humans with the Universal Animation Library** instead of Mixamo. Record every asset in `THIRD_PARTY_NOTICES.md`.

## 8. Free repo and product hosting at scale (one repo per product)

[GitHub Free](https://docs.github.com/en/get-started/learning-about-github/githubs-plans): **unlimited public and private repositories** and unlimited collaborators. 500 MB Packages, 2,000 Actions minutes a month (private), and 120 Codespaces core-hours. Pages, protected branches, required reviewers and environments are **public-repo only** on Free.

Limits that matter for automated repo creation ([REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)):

- 5,000 requests/hour per user (all tokens combined). `GITHUB_TOKEN`: 1,000/hour per repo. GitHub App installations: from 5,000 up to 12,500/hour.
- **Secondary limits: about 80 content-creating requests/minute and 500/hour**, 100 concurrent requests, 900 REST points/minute (writes cost 5 points). Ignoring them can get the integration banned.
- Files over 100 MiB are blocked, a warning appears at 50 MiB, and repos should stay under 1 GB (5 GB strongly recommended) ([docs](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)).
- Mass-creating repositories may also trigger GitHub's acceptable-use and spam enforcement (terms not read in detail).

**Recommendation:** create product repos through a **GitHub App** (higher, per-installation limits) in an organisation owned by the user, with a queue that stays far below 80 writes/minute. Product repos should default to private for the user's own work. Note that private repos then draw on the user's 2,000 free Actions minutes.

## 9. Premium account linking

Checked 2026-10-23 against the official Claude Code docs ([authentication](https://code.claude.com/docs/en/authentication), [headless](https://code.claude.com/docs/en/headless), [GitHub Actions](https://code.claude.com/docs/en/github-actions), [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)), the [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms) (effective 2025-10-08) and OpenAI's Codex docs ([auth](https://learn.chatgpt.com/docs/auth), [CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth), [pricing](https://learn.chatgpt.com/docs/pricing)). This is a summary for planning, not legal advice. The owner should confirm the ToS reading with Anthropic (the legal page invites questions via sales).

### 9a. Claude Code with a Claude subscription (Pro/Max)

**How login works on a machine**

- `claude` (first run), `/login` or `claude auth login` opens Anthropic's browser OAuth flow. On SSH, containers and WSL the browser shows a code to paste back into the terminal. Credentials are stored in the **macOS Keychain** (falling back to `~/.claude/.credentials.json` mode 0600 when the Keychain is locked, for example over SSH), `~/.claude/.credentials.json` on Linux and `%USERPROFILE%\.claude\.credentials.json` on Windows. `CLAUDE_CONFIG_DIR` selects a separate config and login, including a separate Keychain entry.
- Logins expire. Claude Code warns 3 days ahead ("Your login expires in 3 days · run /login to renew"). After expiry every request fails with "Login expired · Please run /login". The docs warn this matters most for unattended sessions. `/status` shows the login state (v2.1.210+).
- **`claude setup-token`** runs the same browser flow and prints a **one-year OAuth token** without saving it. You set it as **`CLAUDE_CODE_OAUTH_TOKEN`** "for CI pipelines and scripts where browser login isn't available". It needs a Pro, Max, Team or Enterprise plan. It can only make model requests (no Remote Control, no claude.ai connectors; local MCP still works).
- **Precedence:** cloud-provider env > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > `apiKeyHelper` > `CLAUDE_CODE_OAUTH_TOKEN` > Anthropic profile > `/login` subscription. **A stray `ANTHROPIC_API_KEY` silently wins over the subscription**: in `-p` mode it is always used when present, and interactively after a one-time approval. Empire must not leak an API key into a subscription worker's environment.

**Headless use**

`claude -p` (Agent SDK CLI) runs non-interactively with `--output-format json` or `stream-json`. It exits 0 on success and non-zero on failure, and SIGTERM gives 143. It works with the subscription login or `CLAUDE_CODE_OAUTH_TOKEN`. **`--bare` mode reads neither**: it needs `ANTHROPIC_API_KEY` or `apiKeyHelper`. The docs say `--bare` "will become the default for `-p` in a future release", which would silently break subscription-authenticated `-p` runs unless we pass the token explicitly or opt out. Watch for this. `-p` cannot run `/login`. From v2.1.302, `-p` runs start in Manual permission mode, so unattended runs need `--permission-mode` or `--allowedTools` plus `--permission-prompts none`.

**Usage limits per plan**

The [legal page](https://code.claude.com/docs/en/legal-and-compliance) states only that "advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK". Exact limits were not found on an official page today. Third-party summaries **(secondary)** describe a rolling 5-hour window plus a weekly cap, shared with Claude on web, desktop and mobile, with Max at 5x or 20x Pro. Several parallel workers running all day on one subscription can exhaust it quickly. Empire should surface rate-limit errors (the `stream-json` `system/api_retry` event carries `error: "rate_limit"`) and never auto-retry endlessly.

**What the terms allow (precisely)**

- *Consumer Terms §3(7)*: users may not access the Services "through automated or non-human means, whether through a bot, script, or otherwise", **"except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it"**. *§2*: users may not share login information or credentials with anyone else.
- *Explicit permission*: the Claude Code docs document `CLAUDE_CODE_OAUTH_TOKEN` for "CI pipelines and scripts", and `claude-code-action` with `claude_code_oauth_token`. That is Anthropic explicitly permitting a subscriber's **own** scripted and CI use of Claude Code, within "ordinary, individual usage".
- *Legal page, "Authentication and credential use"*: OAuth is "intended exclusively" for subscription purchasers and "designed to support ordinary use of Claude Code and other native Anthropic applications". **"Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens. Sign-in to a Claude account must complete through Anthropic's own flow."** It also states this "does not… prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code". Developers building products, including Agent SDK products, "should use API key authentication".
- *Legal page, "Can customers offer Claude Code in their products?"*: preinstalling or running Claude Code in your products or services requires accepting the **Commercial Terms** and: the **binary must not be modified**; no built-in authentication method may be removed, disabled or restricted; and **no paying for, reselling or intermediating** Claude usage, so each end user authenticates with their own API key, subscription or cloud-provider credential. Name use: "runs Claude Code" in plain text is fine. The Claude Code or Anthropic name or logo may not be part of our product or feature names, or suggest endorsement.
- *Consequences for Empire*: the current own-server design (spawning the user's installed `claude` in a PTY, with the user doing `/login` themselves) fits the "end user signs in to the unmodified binary" carve-out. **Empire must not**: ship an OAuth flow of its own, read or copy `.credentials.json` or the Keychain entry, accept a pasted `setup-token` into Empire's UI or server (even to encrypt it), or let one user's subscription serve other users (for example a shared office server with other people's jobs). Whether distributing Empire counts as "running Claude Code in your products", and so needs Commercial Terms acceptance, is an **open question for the owner to confirm with Anthropic**. The `SCRUB_ENV` cleanup in `workers.ts` does not modify the binary or remove auth methods.

### 9b. Claude Code in GitHub Actions with a subscription

- **Official setup:** inside the target repo, run `claude` and then `/install-github-app` (github.com only; needs `gh auth login` and repo admin). It installs the [Claude GitHub App](https://github.com/apps/claude) and offers either a subscription long-lived token or an API key. It saves the secret itself as `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, then opens a workflow PR. Manual setup: run `claude setup-token` locally, add the repo secret `CLAUDE_CODE_OAUTH_TOKEN`, and pass it to [`anthropics/claude-code-action@v1`](https://github.com/anthropics/claude-code-action) as `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`.
- **Modes:** interactive (`@claude` mentions; the triggering user needs write access, and bots are rejected unless listed in `allowed_bots`) or automation (`prompt` input on any event, including `schedule` and `workflow_dispatch`). Caps: `claude_args: --max-turns N`, workflow `timeout-minutes`, concurrency groups.
- **Limits:** OAuth runs draw on the subscriber's plan, not API billing, and Actions minutes are billed separately (section 5). The docs recommend an API key, not an OAuth token, for secrets shared across an organisation, "since an OAuth token is tied to the subscription of the person who ran `claude setup-token`". **Deleting the secret does not revoke the token.** Fork PRs on public repos receive no secrets. The GitHub App asks for broad permissions (Contents, Issues, PRs, Workflows and Actions read/write, and more). A custom app with Contents, Issues and PRs only is possible for the Action.
- **How Empire wires this into a user's repo without touching the token:** Empire generates and commits the workflow file (or opens a PR) in the user's repo, showing the exact commands for the user to run **in their own terminal**: `claude setup-token`, then `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner>/<repo>` (gh reads the value from stdin or a prompt, and encrypts it locally with the repo's public key). Alternatively, the user runs `/install-github-app` in that repo. Empire then checks **only that the secret name exists** (`GET /repos/{owner}/{repo}/actions/secrets` returns names, not values). The "seal it in our UI" variant that the coordinator suggested has Empire's process receive the raw token, which is exactly the "collect… or intermediate" that the legal page forbids. **Do not build it for Claude subscription tokens.** Sealing in our UI remains fine for the user's own **API keys** (Anthropic, OpenAI), which the legal page expressly allows customers to manage in secrets managers.

### 9c. OpenAI Codex CLI: "Sign in with ChatGPT" vs API key

- **Plans:** Codex is included with ChatGPT **Free, Go, Plus, Pro, Business, Edu and Enterprise** ([pricing](https://learn.chatgpt.com/docs/pricing)). Plus and Standard Business get model-dependent local-message estimates per 5 hours (for example 15 to 160 for GPT-6.1 Sol), plus possible weekly limits. Pro currently has no 5-hour limit. Free and Go limits are not listed.
- **Login:** `codex login` (browser), `codex login --device-auth` (device code, beta, must be enabled in ChatGPT security settings), or copy `~/.codex/auth.json` from a machine with a browser. `cli_auth_credentials_store` can be `file`, `keyring`, `auto` or `ephemeral`. API key: `printenv OPENAI_API_KEY | codex login --with-api-key`, billed at API rates.
- **Automation:** OpenAI says "API keys are still the recommended default for automation". The [CI guide](https://learn.chatgpt.com/docs/auth/ci-cd-auth) allows ChatGPT-managed `auth.json` only "on trusted private infrastructure", **"don't use it for public or open-source repositories"**, and warns against sharing one file across concurrent jobs or machines (refresh rotates tokens; Codex refreshes when `last_refresh` is older than about 8 days and writes the file back). Enterprise admins can issue `CODEX_ACCESS_TOKEN`s for non-interactive use. No OpenAI clause equivalent to Anthropic's ban on third-party credential handling was found in these pages. A wider "Sign in with ChatGPT" partner programme for third-party tools was reported in Sept 2026 **(secondary, TheNewStack)**. Its terms were not found, so do not rely on it.

### 9d. "Sign in with Claude" for third-party apps

**It does not exist, and it is explicitly not permitted** (legal page quote above). Secondary reports describe enforcement since early 2026 that blocks consumer OAuth tokens used outside Claude Code and Claude.ai. Tools that impersonate the Claude Code client are a policy violation, not an integration. So the only subscription paths are: the user signs in on the host where workers run, or the user runs `claude setup-token` and stores it in their own Actions secret themselves. A paste-into-Empire flow is ruled out by the "may not collect, store, or intermediate" sentence.

### 9e. Mapping onto Empire modes

| Empire mode | Claude subscription | Anthropic API key | ChatGPT (Codex) login | OpenAI API key | No premium (free default) |
| --- | --- | --- | --- | --- | --- |
| **Own server / computer** (workers run the CLI in PTYs on the host) | User runs `/login` in a worker terminal on that host (current design: the worker shows "type /login"). Credentials stay in that host's Keychain or file. **The host must be the subscriber's own, serving only their jobs.** | Env var or Empire's sealed key store (allowed: a customer managing their own key) | User runs `codex login` (or `--device-auth`) on the host | Sealed key store, passed as env | Qwen Code / Codex `--oss` + Ollama (sections 1 and 2) |
| **Desktop "Run on this computer"** | Same as above. The desktop shell launches the user's installed `claude`, and login happens in its own terminal through Anthropic's flow. | Same | Same | Same | Same |
| **Cloud mode** (coordinator + jobs in GitHub Actions) | User-created `CLAUDE_CODE_OAUTH_TOKEN` secret in **their** repo (via `claude setup-token` + `gh secret set`, or `/install-github-app`). Job uses `claude-code-action` or `claude -p` (not `--bare`). Empire verifies the secret's name only. | `ANTHROPIC_API_KEY` secret (sealing in Empire's UI is fine), or workload identity federation | Not recommended: `auth.json` refresh write-back on ephemeral runners is fragile, and it is forbidden on public repos | `OPENAI_API_KEY` secret (recommended by OpenAI) | GitHub Actions + Qwen Code (section 5) |
| **Anthropic Managed Agents** (existing `anthropic-adapter.ts`) | Not applicable: Managed Agents is an API product | Required (as today) | — | CLOUD-06 OpenAI adapter | — |

### 9f. Recommended integration approach

1. Add a **"Linked accounts" panel** listing, per mode, which credential each worker kind uses and its health: logged-in state (from `claude auth status` or `/status`, or the hook-detected "isn't signed in" message), expiry warning, and for cloud mode, secret present by name.
2. **Claude subscription on a host:** keep the PTY `/login` flow. Add a guided "Sign in to Claude" button that just opens the worker terminal with `/login` typed for the user. Never read credential files. Isolate per account with `CLAUDE_CONFIG_DIR` if one host supports several of the owner's own accounts.
3. **Claude subscription in cloud mode:** a checklist that Empire cannot short-circuit: install the workflow (Empire commits it), the user runs `claude setup-token` and `gh secret set CLAUDE_CODE_OAUTH_TOKEN` (or `/install-github-app`), and Empire confirms the secret exists. Add a calendar reminder about 11 months later to rotate (one-year expiry; old tokens are not revoked by deleting the secret, so tell the user how to revoke).
4. **API keys:** keep the current sealed-secret flow for Anthropic and OpenAI keys. In subscription workers, scrub `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `apiKeyHelper` so the subscription is actually used, and show which credential `/status` reports.
5. **Codex with ChatGPT:** local hosts only (`codex login`). Use API keys in cloud mode.
6. **Fallback:** when no premium credential is healthy, offer the free worker kind (Qwen Code + Ollama) instead of failing, and label it clearly as a different model.

### 9g. Risks

- **ToS:** a shared Empire server using one person's subscription for other people's jobs breaks "no routing on behalf of users" and §2 (no credential sharing). Heavy 24/7 multi-worker use may exceed "ordinary, individual usage". Distributing Empire may need Commercial Terms acceptance (open question). Anthropic "may enforce… without prior notice".
- **Token expiry and rotation:** `/login` sessions expire and stop unattended workers. `setup-token` lasts one year and keeps working after the secret is deleted (revocation steps not documented on the pages read). Codex `auth.json` rotates on refresh, so concurrent use breaks it.
- **Rate limits:** subscription limits are shared with the user's chat usage and are not published exactly. Parallel workers hit them first. Handle `rate_limit` retries visibly.
- **Silent credential switching:** a present `ANTHROPIC_API_KEY` overrides the subscription and bills the API, and a future default of `--bare` for `-p` would drop OAuth.
- **Secret exposure:** OAuth tokens in public repos are withheld from fork PRs but readable by any workflow a maintainer merges. Pin `claude-code-action` to a SHA (as REL-02 does for its actions).

## Recommendation table

| Category | Recommended free default | Runner-up | Avoid / flag |
| --- | --- | --- | --- |
| Local runtime | Ollama (MIT) | llama.cpp `llama-server` (MIT); MLX-LM on Macs | LM Studio as a bundled default (proprietary) |
| Local model | Qwen3-Coder-30B-A3B (32 GB), gpt-oss-20b (16 GB) | Qwen3.8-27B, Devstral Small 2 | Qwen3.8-Max and other custom-licensed weights |
| Hosted free tier | None as a default. Optional BYO Gemini or OpenRouter key | Groq, Cloudflare | GitHub Models (retired). Gemini free tier for EEA/UK/CH users. |
| Agent CLI | **Qwen Code** (Apache-2.0, Claude-style hooks) | Codex CLI `--oss` (Apache-2.0, hooks); OpenCode server (MIT) | Crush (FSL, not open source) |
| STT | sherpa-onnx + Moonshine/Whisper | whisper.cpp `whisper-server` | Non-English legacy Moonshine models (non-commercial) |
| TTS | sherpa-onnx + Kokoro-82M | Piper voices via sherpa-onnx | Bundling piper1-gpl (GPL-3.0) |
| Notifications | Telegram + ntfy | Discord webhooks | Outlook SMTP (app passwords retired) |
| Email | Resend free (transactional/opt-in) | Mailjet, Brevo, Gmail SMTP | Any cold outreach |
| Cloud execution | GitHub Actions job running the agent CLI (public repo) | Self-hosted runner with Ollama; Oracle Always Free VM | Assuming GPU on free runners |
| Desktop signing | Ad-hoc macOS; SignPath (Windows, after going public); winget | Unsigned Windows | — |
| Android | GitHub APK + Obtainium + IzzyOnDroid, then F-Droid | Free 20-device verification account | Play Services/Firebase (blocks F-Droid) |
| iOS | PWA | 7-day self-build, AltStore/SideStore (developers only) | Promising free App Store/TestFlight/EU distribution |
| Assets | Kenney, Quaternius, Poly Haven, ambientCG (CC0) | Freesound CC0 | Committing Mixamo or Sonniss raw files to a public repo |
| Repo hosting | GitHub Free via a GitHub App, throttled | — | Ignoring secondary rate limits |
| Premium: Claude subscription | User `/login` in the unmodified `claude` on their own host; in cloud mode, a user-created `CLAUDE_CODE_OAUTH_TOKEN` secret | Anthropic API key | Any Empire-side OAuth, pasted-token handling or shared subscriptions |
| Premium: OpenAI | `codex login` on the host; `OPENAI_API_KEY` in cloud | — | ChatGPT `auth.json` in public-repo CI |

## Proposed default free configuration

### (a) Developer laptop

- **Server and game:** as today (Node/TS, three.js), run from source. No paid account needed.
- **Workers:** worker kind `qwen-code` (new adapter) in the PTY, with hooks written to the worktree's Qwen `settings.json` and posting to the existing `/hooks/...` endpoint. Optional kinds `codex-oss` and `opencode`. Claude Code stays available as a paid option for users who have it.
- **Model:** Ollama on `localhost:11434`. Model chosen by RAM: 16 GB uses `gpt-oss:20b`, 32 GB uses `qwen3-coder:30b` (fast) or `qwen3.8:27b` (quality). **No automatic model downloads.** The user confirms each pull, showing its size (protected by the existing invariant).
- **Speech:** sherpa-onnx Node addon with a Moonshine or Whisper-small STT model and Kokoro TTS, downloaded only on explicit opt-in.
- **Notifications:** Telegram bot (existing) and an optional ntfy topic.
- **Spend:** provider spend for local workers is reported as US$0 and never mixed with fictional city credits.
- **Premium (optional):** a Claude Code worker kind using the user's own `/login` on this machine (today's behaviour), or Anthropic or OpenAI API keys. Section 9e lists them by mode.

### (b) Cloud mode

- **Repository:** public (see open questions), so Actions, environments and runners are free.
- **Coordinator:** unchanged (GitHub Actions plus the private state repo).
- **Provider:** a new `github-actions` `ProviderAdapter`. Each job dispatches a `workflow_dispatch` run in the product repo (or a runner repo). The job installs Qwen Code (pinned version and checksum), runs `qwen -p … --output-format stream-json --max-wall-time 5h`, and pushes a branch or PR. The coordinator reads the run status and artifacts. `costCents` is 0. Budgets become wall-time and tool-call caps.
- **Model inside the job, in order:** self-hosted runner with Ollama (owner's machine), then a user-provided free key (Gemini or OpenRouter) stored as a repo secret with an explicit training warning, then a small CPU model on a public runner for trivial tasks.
- **Notifications:** Telegram, already used.
- **Updates:** GitHub Releases on the public repo, so anonymous update checks work.
- **Premium (optional):** a Claude Code job (`claude-code-action` or `claude -p`) using the user's own `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` secret, a Codex job with `OPENAI_API_KEY`, or Managed Agents / CLOUD-06 with API keys.

## Open questions (owner decisions)

1. **Make `Billioncodes001/agent-empire` public?** It unlocks free Actions and larger runners, environments on GitHub Free (needed by `release.yml`'s `release` environment), anonymous update downloads, SignPath and F-Droid. Requires a secrets and history audit first. If it stays private: is the account on GitHub Pro? The API did not report the plan.
2. **Acceptable quality floor.** Are slower, weaker local-model workers acceptable as the default, with Claude Code as an optional paid upgrade?
3. **Hosted free tiers.** May the app offer Gemini or OpenRouter free keys at all, given Google's training-on-free-data terms and the EEA/UK/CH paid-only rule?
4. **Hardware floor.** Officially support 16 GB machines (gpt-oss-20b only), or require 32 GB for local workers?
5. **Python dependencies.** Aider, MLX-LM and faster-whisper are Python. Approve them as optional extras, or stay TypeScript/native only (Qwen Code, OpenCode and Codex are Node or native binaries)?
6. **iOS.** Accept "PWA only" for ordinary iOS users, with no paid Apple membership?
7. **Android 2027.** Pay for Google developer verification later, or rely on F-Droid plus the advanced flow?
8. **Email outreach.** Confirm that outreach is limited to opted-in recipients. No free provider allows cold email.
9. **Anthropic terms for Empire itself.** Does distributing Empire, which launches the user's own installed Claude Code, count as "running Claude Code in your products" that needs Commercial Terms acceptance? Ask Anthropic (the legal page points to sales). Also confirm that cloud-mode jobs running on a subscriber's own `CLAUDE_CODE_OAUTH_TOKEN` in their own repo are "ordinary, individual usage" at the job volumes we expect.
10. **Shared or office servers.** Should Empire block subscription-backed workers when a server serves more than one person, given the ban on routing on behalf of users?
11. **Spikes before commitment:** (a) Qwen Code hook payloads against `workers.ts` state handling; (b) benchmark three local models on a fixed task set (needs an approved model download); (c) Actions-runner CPU inference speed for gpt-oss-20b; (d) sherpa-onnx latency on Apple Silicon.
