/**
 * The cloud session handed from the launch screen (boot.ts) to the game (main.ts), and the snapshot this device saved
 * so a relaunch shows the Empire immediately, labelled as saved, before GitHub answers.
 *
 * The GitHub token lives here in memory only. Apps keep it in the Keychain / Keystore / OS credential store (native
 * bridge key `github.token`); a browser keeps it only until the page closes.
 */
import { parseRepo, repoLabel, type RepoRef } from './repo';

export interface CloudSession {
  repo: RepoRef;
  token: string;
  login?: string;
}

let current: CloudSession | null = null;

export function setCloudSession(session: CloudSession | null) {
  current = session;
}
export function cloudSession(): CloudSession | null {
  return current;
}

const CACHE_PREFIX = 'agent-empire.cloud.snapshot.v1:';
export interface SavedSnapshot {
  sha: string;
  files: Record<string, string>;
  pending: string[];
  readAt: number;
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** The snapshot saved for this repository, or null (missing, malformed or storage blocked). */
export function loadSavedSnapshot(repo: RepoRef, store: Storage | null = storage()): SavedSnapshot | null {
  try {
    const raw = JSON.parse(store?.getItem(CACHE_PREFIX + repoLabel(repo).toLowerCase()) ?? 'null');
    if (!raw || typeof raw.sha !== 'string' || typeof raw.readAt !== 'number' || !raw.files || typeof raw.files !== 'object' || !Array.isArray(raw.pending)) return null;
    if (!Object.values(raw.files).every((v) => typeof v === 'string')) return null;
    return { sha: raw.sha, files: raw.files, pending: raw.pending.filter((p: unknown) => typeof p === 'string'), readAt: raw.readAt };
  } catch {
    return null;
  }
}

export function saveSnapshot(repo: RepoRef, snap: SavedSnapshot, store: Storage | null = storage()) {
  try {
    store?.setItem(CACHE_PREFIX + repoLabel(repo).toLowerCase(), JSON.stringify(snap));
  } catch {
    // Quota or blocked storage: the next launch simply waits for GitHub.
  }
}

/** "Forget this device": the saved snapshot goes with the session keys. The repository on GitHub is untouched. */
export function forgetSavedSnapshots(store: Storage | null = storage()) {
  try {
    const s = store as globalThis.Storage | null;
    if (!s || typeof s.length !== 'number') return;
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(CACHE_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => s.removeItem(k));
  } catch {}
}

export { parseRepo, repoLabel };
