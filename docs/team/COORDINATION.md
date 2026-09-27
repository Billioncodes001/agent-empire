# One-window development coordination

This extends the existing role workflow for the next city phase. The roadmap was committed as `30061f4` before feature implementation. VS Code 1.139.1 exposes its Agents window on this machine. Its Copilot model picker lists Claude Opus 5.5, Grok 4.7 and GPT-5.3-Codex. Availability in the picker is not execution evidence.

Open **Chat: Open Agents Window**, choose the Agent Empire workspace and Copilot harness, and select **Empire Coordinator** from the agent/mode picker. Project-local definitions live in `.github/agents/`. The coordinator invokes the named specialists through supported native delegation, collects their returned results, and writes the task ledger. Verify the first planning-only run before treating this as an operational workflow. Exact model IDs may differ by harness/account; failures must remain visible.

The desired UI is one session window with coordinator and delegated work visible there. Native subagent conversations may be read-only and are not the same as independently steerable editor sessions. Existing role sessions need not be destroyed. Neither session tabs nor subagents automatically provide filesystem isolation. Use the existing role worktrees for independent editing; read-only planning may share the current checkout. These instructions are coordination rules, not a security sandbox.

| Lane | Requested model | Existing checkout | Allowed ownership |
| --- | --- | --- | --- |
| Interface/world | Claude Opus 5.5 | `../agent-empire-team/interface` | Assigned client UI, world assets, animation |
| Backend | GPT-5.3-Codex through Copilot | `../agent-empire-team/backend` | Assigned server/shared contracts and tests |
| Independent review | Grok 4.7 | `../agent-empire-team/review` | Read-only candidate inspection; scoped report |
| Integration | Coordinator | `../agent-empire-team/integration` | Combine reviewed commits, validate and hand off |

The backend custom agent uses the Codex model listed by the Copilot picker. This does not establish native Codex-extension cross-session control. If a specialist's configured model is not honored, stop that dispatch and record the actual limitation; never label an inherited model as the requested model.

Before implementation, check each worktree's branch, status and prior work, then update from the accepted baseline by normal merge. One writer per lane; explicit ownership of shared files. Each assignment carries an ID, baseline, goal, owned paths, acceptance checks and maximum scope. Completion carries commit, executed checks, unresolved risks and next dependency. Review the exact combined commit before updating the development branch; no blind auto-merge.

Use bounded phases and completion-driven returns to reduce coordination tokens. No timer polling, nested agent chains, repeated full transcripts, or model-status narration. Keep normal tool approval controls. This workflow needs an active VS Code/agent session and available model quota; it is not a persistent cloud scheduler. Only set up a recurring automation if the user separately requests a schedule.

## First coordinator assignment

Planning only: read the roadmap and ledger, ask Interface for phone/call and traversal contracts, ask Backend for speech/dispatch/persistence contracts, then ask Review to check their combined proposal. Specialists return compact reports without edits. Save the consolidated result to `docs/team/reports/city-expansion-coordination.md` and update the planning row in TASKS.md. No product code, commit/push, model downloads, paid product calls or live-world changes. End after reporting whether actual model-specific delegation worked.
