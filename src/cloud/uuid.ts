/** Browser-safe UUIDs shared by the coordinator's installer and the client (src/client/cloud/uuid.ts re-exports). */
/**
 * UUIDv7 (RFC 9562): 48-bit Unix milliseconds, version 7, variant 10, 74 random bits. Intent files are named by
 * their id, and the coordinator chooses which intent blobs to fetch by path, so time-ordered ids keep path order
 * close to submission order (docs/team/reports/cloud-coordinator.md, review notes).
 */
export function uuidv7(now: number = Date.now(), random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) throw new Error('UUIDv7 needs a millisecond timestamp.');
  const bytes = random(new Uint8Array(16));
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
