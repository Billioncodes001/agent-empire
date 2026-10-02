/**
 * REL-05, cloud mode: the coordinator in the player's state repository is updated only when the player accepts the
 * prompt (docs/team/RELEASE_PLAN.md, "Coordinator update (cloud mode)"); nothing is ever committed automatically.
 *
 * Which version runs: coordinator/coordinator.json ({version, sha256, schema}), written next to the bundle by an
 * update. A repository set up before this existed has only the bundle: its sha256 is compared with the channel's;
 * when it differs the installed version is unknown and treated as older.
 *
 * Accepting commits the new bundle (sha256-checked against the signed channel) and the manifest in one commit through
 * the cloud adapter (CloudRepo.commitFiles), never forced, never touching state/ or intents/.
 */
import { COORDINATOR_BUNDLE_PATH } from '../../cloud/workflow';
import { CLOUD_SCHEMA_VERSION } from '../../cloud/schema';
import type { CloudRepo } from '../cloud/repo';
import type { ChannelFile } from './channel';
import { isNewer, isSemver } from './semver';
import { sha256Hex } from './verify';

export const COORDINATOR_MANIFEST_PATH = 'coordinator/coordinator.json';

export interface InstalledCoordinator {
  version: string | null;
  sha256: string | null;
}

export type CoordinatorStatus =
  | { kind: 'current'; installed: InstalledCoordinator }
  | { kind: 'available'; installed: InstalledCoordinator; version: string; sha256: string; url: string }
  /** The channel's coordinator writes a state schema this app can't read yet: update the game first. */
  | { kind: 'needs-game'; installed: InstalledCoordinator; version: string };

type CoordinatorRepo = Pick<CloudRepo, 'coordinatorInfo' | 'commitFiles'>;

export function parseManifest(text: string | null): InstalledCoordinator | null {
  if (!text) return null;
  try {
    const m = JSON.parse(text);
    if (!m || typeof m !== 'object') return null;
    return { version: isSemver(m.version) ? m.version : null, sha256: typeof m.sha256 === 'string' && /^[0-9a-f]{64}$/.test(m.sha256) ? m.sha256 : null };
  } catch {
    return null;
  }
}

/** Pure: what the channel's coordinator means for a repository running `installed`. */
/**
 * `own` is this app's bundled coordinator ({version: the game version, sha256}). A repository without a manifest whose
 * bundle is that file runs this app's version: a newer app (say beta) that set the repository up must never be offered
 * an older coordinator after a switch to stable.
 */
export function coordinatorDecision(channel: ChannelFile, given: InstalledCoordinator, clientSchema = CLOUD_SCHEMA_VERSION, own?: InstalledCoordinator | null): CoordinatorStatus {
  const installed = !given.version && own?.version && own.sha256 && given.sha256 === own.sha256 ? { version: own.version, sha256: given.sha256 } : given;
  const c = channel.coordinator;
  if (!c) return { kind: 'current', installed };
  if (installed.sha256 === c.sha256) return { kind: 'current', installed: { version: installed.version ?? channel.version, sha256: installed.sha256 } };
  // Known version: forward only. Unknown version (a bundle without a manifest) that differs: offered.
  if (installed.version && !isNewer(channel.version, installed.version)) return { kind: 'current', installed };
  if (c.schema > clientSchema) return { kind: 'needs-game', installed, version: channel.version };
  return { kind: 'available', installed, version: channel.version, sha256: c.sha256, url: c.url };
}

export async function readInstalledCoordinator(repo: CoordinatorRepo): Promise<InstalledCoordinator> {
  const info = await repo.coordinatorInfo({ bundle: COORDINATOR_BUNDLE_PATH, manifest: COORDINATOR_MANIFEST_PATH });
  const manifest = parseManifest(info.manifest);
  if (manifest) return manifest;
  return { version: null, sha256: info.bundle === null ? null : await sha256Hex(info.bundle) };
}

export class CoordinatorUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoordinatorUpdateError';
  }
}

/**
 * Commits the accepted coordinator. `load` returns the bundle text (from the game's own copy when it is the same file,
 * else downloaded through the shell); it is checked against the signed sha256 before anything is written.
 */
export async function commitCoordinatorUpdate(repo: CoordinatorRepo, offer: Extract<CoordinatorStatus, { kind: 'available' }>, schema: number, load: () => Promise<string>): Promise<string> {
  const bundle = await load();
  if (!bundle || bundle.length > 5 * 1024 * 1024 || (await sha256Hex(bundle)) !== offer.sha256) throw new CoordinatorUpdateError('The downloaded coordinator does not match the signed release. Nothing was changed in your GitHub.');
  const manifest = `${JSON.stringify({ version: offer.version, sha256: offer.sha256, schema, updatedBy: 'agent-empire-app' }, null, 2)}\n`;
  return repo.commitFiles(
    [
      { path: COORDINATOR_BUNDLE_PATH, content: bundle },
      { path: COORDINATOR_MANIFEST_PATH, content: manifest },
    ],
    `Agent Empire: update the coordinator to ${offer.version}`,
  );
}
