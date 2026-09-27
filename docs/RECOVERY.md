# Recovering interrupted local work

A server restart interrupts tasks that were running. They appear in the queue's finished section as stopped, with the restart reason; that section also contains unsuccessful tasks. Restarting the server or reconnecting a browser does not automatically resume their workers. Already queued tasks still follow the queue's normal scheduling policy.

The chief's startup state describes observed execution. “Turn ended” does not verify a brief, commit, tests or other deliverable. Delegation remains a preference, and rule-based monitoring does not approve agent prompts.

## Recover a task

1. Review the stopped task, its worker terminal, branch and any existing changes or artifacts. A retry starts a new queued attempt; it does not prove the previous attempt had no side effects.
2. Use the worker's **Send home** action before retrying. For a running queue task, **Stop** also requests this. At a desk, the default send-home key is **X**; follow your configured controls. If a worktree cleanup choice appears, keep work you still need to review.
3. Wait for confirmed removal. The server waits for process exit before releasing the worker. If it reports that exit is unconfirmed, the worker and task history remain; do not launch a replacement to bypass that warning.
4. Use **Requeue** on the stopped queue task. Queue retry keeps the logical task ID, increments the attempt, and retains once-only task reward behavior. A manager-startup retry from Management has the same prior-process guard.
5. If the replacement remains queued, check **Workers at once**, the hiring-budget warning and funded workstations. Zero concurrency pauses seating. An old stopped worker can still occupy the last funded desk if you requeued before sending it home; send that worker home to free the desk.

A finished turn can leave its terminal process running. Retry, task removal and queue clearing therefore check process evidence rather than assuming “finished” means stopped. Clearing history is not a recovery shortcut.

## Resume and failed sessions

Workers owned by the queue must recover through the queue. A direct resume request, including one triggered by opening an offline terminal, is refused for these workers. Sending the old worker home does not delete its queue task.

A worker hired outside the queue can be explicitly resumed only when its prior process is confirmed stopped and its desk and existing hiring-budget gate permit it. If its saved session cannot resume, the server leaves it stopped and reports the failure. It does not silently start a fresh session. Review the previous work before separately requesting a new task. Existing trust, login, permission and question prompts still require human input.

## Unknown process evidence

New saves record process state and PID. After restart, a recorded PID that may still exist remains **unknown**: the server does not signal that PID or assume it owns the process. An absence check can establish that the recorded process is no longer present. PID reuse can conservatively keep recovery blocked.

Legacy saves may have no PID, and a crash during launch can leave an interrupted task without a confirmed worker link. These states remain blocked. The diagnostic appears in worker activity/terminal output or the recovery warning. Resume, send-home, retry, removal and clearing cannot erase that uncertainty to allow a replacement.

This release has no “confirm stopped” command or automatic legacy-repair wizard. Manual diagnosis by the machine's operator is required; diagnosing the old process does not itself update a legacy record with missing evidence. Preserve the save files and worktrees for a reviewed repair. Do not delete records, reset history or mark a possibly live process stopped merely to unblock execution.

## Storage failures

If worker or queue saving fails, the server reports the storage error and blocks further launches or queue scheduling/recovery as applicable. A failure message is not confirmation that existing processes stopped. Preserve `workers.json`, `queue.json`, `empire.json` and associated worktrees, repair the storage problem, then restart and review the recovered state. Malformed or inconsistent worker/queue saves fail closed rather than silently replacing the records with an empty list.

Worker and queue saves use temporary-file replacement so a failed replacement preserves the previous complete file. Launch intent is saved before spawning; an uncertain interrupted launch blocks automatic replacement. These are separate files, without a shared transaction or a power-loss durability guarantee. This is local recovery support, not durable cloud execution or safe automatic desktop synchronization.
