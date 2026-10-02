/**
 * LIFE-04 task dependencies, shared by the queue (server) and the queue panel (client). Pure functions only.
 *
 * A queued task with `dependsOn` is never seated until every dependency finished with outcome 'done'. While any
 * dependency is unfinished the task stays queued with `blockedBy`. When a dependency finished any other way (or was
 * removed) the task is HELD: it ends as `failed` with `error: 'dependency <id> did not finish'` and waits for the CEO to
 * retry or remove it. It is never run automatically.
 */
import type { QueueTask } from './protocol.js';

export const MAX_DEPENDENCIES = 8;
const HELD = /^dependency (\S+) did not finish$/;

export function heldDependencyError(dependencyId: string): string {
  return `dependency ${dependencyId} did not finish`;
}

/** The dependency id a held task is waiting for the CEO about, or undefined when the task is not held. */
export function heldDependencyId(task: Pick<QueueTask, 'status' | 'outcome' | 'error'>): string | undefined {
  if (task.status !== 'done' || task.outcome !== 'failed' || !task.error) return undefined;
  return HELD.exec(task.error)?.[1];
}

export type DependencyState =
  | { kind: 'ready' }
  | { kind: 'blocked'; blockedBy: string[] }
  | { kind: 'held'; dependencyId: string };

/** Where a task stands against its dependencies, given every task on the queue. */
export function dependencyState(task: Pick<QueueTask, 'dependsOn'>, tasks: readonly QueueTask[]): DependencyState {
  const blockedBy: string[] = [];
  for (const id of task.dependsOn ?? []) {
    const dep = tasks.find((t) => t.id === id);
    if (!dep) return { kind: 'held', dependencyId: id };
    if (dep.status !== 'done') blockedBy.push(id);
    else if (dep.outcome !== 'done') return { kind: 'held', dependencyId: id };
  }
  return blockedBy.length ? { kind: 'blocked', blockedBy } : { kind: 'ready' };
}

/**
 * Validates a new task's dependency list against the existing tasks. Returns the cleaned list (duplicates dropped,
 * order kept) or an error. `selfId` is the task being added, so a cycle through it is rejected too.
 */
export function validateDependencies(selfId: string, dependsOn: unknown, tasks: readonly Pick<QueueTask, 'id' | 'dependsOn'>[]): { ok: string[] } | { error: string } {
  if (dependsOn === undefined) return { ok: [] };
  if (!Array.isArray(dependsOn)) return { error: 'Dependencies must be a list of task ids' };
  const ids: string[] = [];
  for (const id of dependsOn) {
    if (typeof id !== 'string' || !id) return { error: 'Dependencies must be a list of task ids' };
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_DEPENDENCIES) return { error: `A task may depend on at most ${MAX_DEPENDENCIES} tasks` };
  if (ids.includes(selfId)) return { error: 'A task cannot depend on itself' };
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const id of ids) if (!byId.has(id)) return { error: `Unknown dependency ${id}` };
  const graph = new Map<string, readonly string[]>([...byId].map(([id, t]) => [id, t.dependsOn ?? []]));
  graph.set(selfId, ids);
  if (findCycle(graph)) return { error: 'Dependencies would form a cycle' };
  return { ok: ids };
}

/** One task id on a dependency cycle, or undefined when the graph is acyclic. Ids with no node are leaves. */
export function findCycle(graph: ReadonlyMap<string, readonly string[]>): string | undefined {
  const state = new Map<string, 1 | 2>(); // 1 = on the current path, 2 = finished
  for (const start of graph.keys()) {
    if (state.has(start)) continue;
    // Iterative DFS so a long chain cannot overflow the stack.
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const edges = graph.get(top.id) ?? [];
      if (top.next >= edges.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const to = edges[top.next++];
      const seen = state.get(to);
      if (seen === 1) return to;
      if (seen === 2 || !graph.has(to)) continue;
      state.set(to, 1);
      stack.push({ id: to, next: 0 });
    }
  }
  return undefined;
}

const short = (title: string) => (title.length > 60 ? `${title.slice(0, 59)}…` : title);

/** "Waiting on <dependency title>" for a blocked queued task; '' when nothing blocks it. */
export function blockedLabel(task: Pick<QueueTask, 'blockedBy'>, tasks: readonly QueueTask[]): string {
  const ids = task.blockedBy ?? [];
  if (!ids.length) return '';
  const titles = ids.map((id) => tasks.find((t) => t.id === id)?.title ?? `task ${id}`);
  const first = `Waiting on “${short(titles[0])}”`;
  return titles.length > 1 ? `${first} and ${titles.length - 1} more` : first;
}

/** The held-failure line for the queue panel; '' when the task is not held on a dependency. */
export function heldLabel(task: Pick<QueueTask, 'status' | 'outcome' | 'error'>, tasks: readonly QueueTask[]): string {
  const id = heldDependencyId(task);
  if (!id) return '';
  const dep = tasks.find((t) => t.id === id);
  return `Held — dependency ${dep ? `“${short(dep.title)}”` : `${id} (removed)`} did not finish. Retry or remove it.`;
}
