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

/**
 * A deterministic UUID (RFC 9562 version 8, from SHA-256 of `key`). The founding startup jobs use it so a plan sent
 * twice (a second device, or a reload before the coordinator ran) names the same jobs, which the coordinator records
 * as duplicates instead of queueing and paying for them again.
 */
export async function stableUuid(key: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))).slice(0, 16);
  bytes[6] = 0x80 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The millisecond timestamp inside a UUIDv7. */
export function uuidv7Time(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}
