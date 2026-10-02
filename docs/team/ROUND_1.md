# Round 1: truthful supervision and recoverable local work

This implementation round supersedes the report-only setup assignment. The coordinator owns integration and browser verification. Claude owns client presentation, Codex owns server/shared execution state, and Grok reviews the exact integrated candidate. Do not launch real provider workers, touch the live save or port 4610, provision cloud resources, or bypass prompts. Authors commit on their role branches; only the coordinator merges/pushes.

## Agreed additive wire contract

Backend owns `src/shared/empire.ts` and `src/shared/protocol.ts`. Export `SupervisionState` from shared/empire.ts and add `supervision?: SupervisionState` to `EmpireState`. This projection is runtime evidence, regenerated at startup and each monitoring tick, not trusted from the persisted file.

```ts
interface SupervisionState {
  schemaVersion: 1;
  serverRunId: string;
  observedAt: number;
  delegationRequested: boolean;
  monitor: { mode: 'rule_based'; lastCheckAt: number };
  chief: {
    phase: 'unassigned' | 'pending' | 'queued' | 'starting' | 'idle' |
      'working' | 'needs_input' | 'turn_ended' | 'interrupted' | 'failed' | 'unknown';
    managerId?: string;
    taskId?: string;
    workerId?: string;
    reason?: string;
  };
  workforce: { active: number; attention: number; queued: number };
}
```

Backend may add `QueueTask.attempt?: number`, `QueueTask.interruption?: { reason: 'server_restart'; at: number }`, and `WorkerInfo.processState?: 'running' | 'stopped' | 'unknown'` to distinguish retry attempts, interruptions and process evidence. Existing task status/outcome values remain compatible. Do not invent evidence to fill a field. Missing/conflicting links produce `unknown` rather than `working`; a restored queue interruption outranks a legacy manager flag. Only `kind === 'agent'` workers count in AI workforce; blocked workers are attention, not active work. `turn_ended` means the observed turn ended, not a verified artifact or proof the process stopped.

The client treats missing projection, disconnected transport or >15 seconds since the last received empire message as unknown/stale. Receipt age is client monotonic/local time, not a comparison with the server wall clock. Delegation is a separate preference. No label or avatar may infer an active autonomous supervisor from it. Never say a brief was verified solely from `ready`/`done`.

## Backend scope

- Remove automatic worker wake/resume from constructor and browser connection. Reconcile restored manager/queue state before delivering the initial empire snapshot.
- Persist restored running tasks as visibly interrupted. Explicit retry/resume must not overlap a previous running/unknown attempt, and direct worker resume cannot evade queue recovery ownership, desk capacity or existing budget gates. Do not silently relaunch a failed session as a new task.
- Keep legacy save compatibility and current entry/economy policy. Add atomic worker/queue save replacement and visible failure handling where feasible within this round; do not claim cross-file transactions or cloud durability.
- Implement the projection above and meaningful fake-process/temp-directory regression tests. Do not edit client files. Report any contract issue before diverging.

## Interface scope

- Consume the projection in a clear compact HUD/status display and Management. Show rule-based monitoring separately from chief startup/job phase, attention, fictional credits and provider spend. Disconnect/staleness must remove live claims and continue updating while dialogs are open.
- Improve Management hierarchy with accessible tabs or sections, readable restrained surfaces consistent with the existing dark HUD, responsive controls and readable report history. Preserve all existing economy actions and keyboard/physical traversal behavior. Do not add key mappings this round.
- Improve modal initial focus, trapping and restoration without breaking xterm keyboard input or nested dialogs. Add meaningful names to icon controls, keep workforce access on small screens, and respect reduced-motion preferences in UI animation.
- Idle/finished/blocked managers must not use a working typing pose. Keep durable assignment-based entry eligibility, first/third person, arrow remaps, minimap, graphics presets and audio intact.
- Own client files and client-focused unit tests only. No dependency/shared/server changes. While backend builds the shared type, work on independent layout/accessibility changes; coordinator will bring in the backend contract before final verification. Use a dedicated fixture/dev harness for browser checks, never mutate the live runtime store.

## Acceptance and handoff

Typecheck, tests and build pass after integration. Reconnection makes no spawn/resume call; an interrupted task cannot duplicate execution; retries preserve approvals and once-only rewards. The HUD and Management never show a live chief for offline, blocked, completed, missing or stale evidence. Keyboard dialogs preserve xterm input, small screens expose worker attention, and the minimap/navigation/settings regressions still pass. Grok reviews the exact candidate and identifies material defects before merge.
