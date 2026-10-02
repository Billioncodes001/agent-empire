export { uuidv7 } from '../../cloud/uuid';

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
