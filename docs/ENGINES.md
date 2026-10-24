# Worker engines: free, premium and API keys

Every worker runs a coding-agent CLI in its terminal. Agent Empire supports three engines, and you choose one each time you hire (Settings → Linked accounts sets the default).

| Engine | Cost | How it signs in | Status reporting |
| --- | --- | --- | --- |
| **Qwen Code** + a local Ollama model | Free. US$0 provider spend | Nothing to sign in to: the model runs on your computer | Full, through Qwen Code's hooks |
| **Claude Code** (premium) | Your Claude plan, or your Anthropic API key at API rates | You sign in **inside Claude Code** yourself (`/login`), or save an API key | Full, through Claude Code's hooks |
| **Codex CLI** (optional) | Free with `--oss` and Ollama, or your own ChatGPT login | You run `codex login` yourself | Shown as **status unknown**: Codex can't report its turns to the Empire yet |

Each worker's card, name plate and terminal header say which engine and model it runs, for example "Qwen Code · gpt-oss:20b (local)" or "Claude Code · your Claude account". Local workers show US$0. City credits are a separate, fictional currency and are never mixed with provider spend.

## Free setup (Ollama + Qwen Code)

1. Install Ollama from [ollama.com/download](https://ollama.com/download). The Empire doesn't bundle it. Start it.
2. Install Qwen Code (Apache-2.0): `npm install -g @qwen-code/qwen-code`.
3. Open **Settings → Linked accounts & worker engines**. The Ollama card shows your computer's memory and a recommended model:
   - **16 GB:** `gpt-oss:20b` (14 GB download, Apache-2.0).
   - **32 GB or more:** `qwen3-coder:30b` (fast, 19 GB) or `qwen3.8:27b` (quality, 18 GB).
   - Below 16 GB, local coding models don't fit well. Use a free hosted key (below) or a premium engine.
4. Click **Download**. The Empire shows the model's name, size and licence and asks you to confirm. Nothing downloads without that click. You can cancel during the download. Tags can change upstream, so check that the tag exists in the Ollama library.
5. Hire a worker and choose "Qwen Code · <model> (local)".

Small local models are weaker than Claude at long tool-calling sessions. Expect more "needs input" and failed turns.

How it's wired: the Empire starts `qwen --model <model>` with `OPENAI_BASE_URL=http://127.0.0.1:11434/v1` and a placeholder key, and points `QWEN_CODE_SYSTEM_SETTINGS_PATH` at a file in the Empire's data folder that holds its status hooks. Nothing is written into your repository. If the hooks don't report within 12 seconds, the worker shows "status unknown" rather than a guess.

## Premium: Claude Code

- Install Claude Code, then sign in **inside Claude Code** on this computer with `/login`. In Settings, **Sign in to Claude…** opens a worker terminal with `/login` already typed. You press Enter and finish in Claude Code's own browser flow.
- The Empire never offers its own Claude sign-in. It never reads, copies or stores Claude credentials, credential files or the Keychain. The Linked accounts panel shows only what `claude auth status` prints (signed in or not, method, plan, expiry). It warns you when your sign-in is about to expire.
- Workers on "your Claude account" get `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` removed from their environment. That way your subscription is really used and the API isn't billed without you knowing. An `apiKeyHelper` set in your own Claude settings can't be removed from outside Claude Code. If `claude auth status` reports an API-key or helper method, the panel warns you.
- The Empire runs `claude auth status` in the office repository, so an `apiKeyHelper` or `env.ANTHROPIC_API_KEY` in that project's `.claude/settings.json` counts too. If the reported method is not your subscription, "your Claude account" can't be chosen. This applies to the hire dialog, the default engine and queued tasks alike: the server refuses the launch and says why. Limitation: a different `.claude/settings.json` on another branch, or a worktree's own untracked `.claude/settings.local.json`, is not probed.
- Queued tasks use the default engine ("Automatic" picks a healthy premium engine, otherwise the free one). When no engine is ready, the task stays queued with the reason and starts once one is.
- Use your subscription only for your own jobs, on your own computer.

## API keys

- **Anthropic / OpenAI keys:** in the desktop app, use the menu → **Provider keys for this computer…**. Keys are sealed with the operating system's credential store. On a server, set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in its environment.
- Each key reaches only workers of its own engine. "Claude Code · Anthropic API key" workers get only `ANTHROPIC_API_KEY`. Local workers get no provider keys.
- The Linked accounts panel lists key **names** only, never values.

## Free hosted models (opt-in)

OpenRouter free models, the Gemini API free tier and Groq's free plan can be used with **your own key**. They're never the default. Their data-use terms are shown before you save a key. For example, Google may use free-tier prompts to improve its products. The desktop window won't save a hosted key until you confirm that you've read them. Calls through the shared model client are labelled "US$0 · free tier (rate-limited)". Paid API calls are labelled as estimates, or "no price configured" when no price is set.

## When nothing is ready

The hire dialog lists every engine with the reason it isn't ready ("Install Qwen Code", "Download gpt-oss:20b first", "Not signed in"), and won't hire until one is usable.
