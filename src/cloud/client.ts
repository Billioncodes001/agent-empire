/**
 * What a client (CLOUD-04) needs from the state repository: read the last committed snapshot with
 * its age, and write intents. Clients never write `state/`. Browser-safe.
 */
import { intentPath, parseIntent, type CloudIntent } from './intents.js';
import { parseStateFiles, type CloudState } from './schema.js';
import { updateWithRetry, type StateStore, type WorkflowControl } from './store.js';

export interface CloudView {
  state: CloudState;
  /** Commit the view was read from. */
  sha: string;
  /** Milliseconds since the coordinator last committed; undefined before its first run. Never "live". */
  snapshotAgeMs?: number;
  pendingIntents: string[];
}

export async function readCloudView(store: StateStore, now: number): Promise<CloudView> {
  const snapshot = await store.read();
  const stateFiles = Object.fromEntries(Object.entries(snapshot.files).filter(([path]) => !path.startsWith('intents/')));
  const { state } = parseStateFiles(stateFiles, now);
  const last = state.meta.coordinator.lastRunAt;
  return {
    state, sha: snapshot.sha,
    ...(last !== undefined ? { snapshotAgeMs: Math.max(0, now - last) } : {}),
    pendingIntents: Object.keys(snapshot.files).filter(path => path.startsWith('intents/')).sort(),
  };
}

/** Adds `intents/<id>.json`. Re-submitting the identical intent is a no-op; a different body is refused. */
export async function submitIntent(store: StateStore, intent: CloudIntent): Promise<{ sha: string; alreadyPresent: boolean }> {
  const path = intentPath(intent.id);
  const content = JSON.stringify(intent, null, 2) + '\n';
  parseIntent(path, content); // Validate locally with the coordinator's own rules before writing.
  const result = await updateWithRetry(store, snapshot => {
    const existing = snapshot.files[path];
    if (existing !== undefined && existing !== content) throw new Error('A different intent with this id is already pending.');
    return { changes: existing === undefined ? [{ path, content }] : [], message: `Agent Empire intent ${intent.kind} ${intent.id}`, value: existing !== undefined };
  });
  return { sha: result.sha, alreadyPresent: result.value };
}

/** CLOUD-05: record the shutdown intent; the coordinator stops sessions and then disables itself. */
export async function requestShutdown(store: StateStore & Partial<{ dispatchEvent(type: string): Promise<void> }>, id: string, now: number) {
  const result = await submitIntent(store, { schemaVersion: 1, id, createdAt: now, kind: 'shutdown' });
  await store.dispatchEvent?.('agent-empire-shutdown').catch(() => {}); // Optional wake-up; the schedule also picks it up.
  return result;
}

/** CLOUD-05: re-enable the workflow with the user's token, then record the start intent and wake it. */
export async function requestStart(store: StateStore & WorkflowControl & Partial<{ dispatchEvent(type: string): Promise<void> }>, id: string, now: number) {
  await store.setWorkflowEnabled(true);
  const result = await submitIntent(store, { schemaVersion: 1, id, createdAt: now, kind: 'start' });
  await store.dispatchEvent?.('agent-empire-start').catch(() => {});
  return result;
}
