/**
 * The Ed25519 public key that signs releases (docs/team/RELEASE_PLAN.md, "Update channel contract"): the game
 * manifest, and `channel-<channel>.json` through its `.sig`. Every app checks a channel file against this key before
 * trusting anything in it.
 *
 * Raw 32-byte public key, standard base64. The DEV key below is public on purpose: its seed is derived from a fixed
 * string (tools/update-fixture.ts and the tests sign fixtures with it), so anything signed with it proves nothing.
 * A release build must pin the real key here instead (the release lane replaces RELEASE_PUBLIC_KEY; it must never
 * ship the dev key). While the dev key is pinned, `isDevKey` is true and the shells honour their fixture overrides.
 *
 * NOTE FOR MERGE (REL-02 owns this file): created by the interface lane (REL-03/04) because the release lane's copy
 * did not exist in its tree yet. Keep the shape: RELEASE_PUBLIC_KEY, DEV_RELEASE_PUBLIC_KEY, isDevKey,
 * releasePublicKey().
 */

/** sha256("agent-empire dev release key: public test fixture, never a release key") as the Ed25519 seed. */
export const DEV_RELEASE_KEY_SEED_TEXT = 'agent-empire dev release key: public test fixture, never a release key';
export const DEV_RELEASE_PUBLIC_KEY = '5atmI/qSTeCu7TH1iUGwcRgSuU9sYp/chkURzi9KU2w=';

/** The pinned release key. Replaced by the release pipeline; until then it is the dev key. */
export const RELEASE_PUBLIC_KEY: string = DEV_RELEASE_PUBLIC_KEY;

/** True while the dev key is pinned (development and fixture builds). Release builds must have this false. */
export const isDevKey: boolean = RELEASE_PUBLIC_KEY === DEV_RELEASE_PUBLIC_KEY;

export function releasePublicKey(): { base64: string; isDevKey: boolean } {
  return { base64: RELEASE_PUBLIC_KEY, isDevKey };
}
