/**
 * Ed25519 signature check of a channel file against the pinned release key, before anything in it is trusted.
 *
 * `.sig` format (agreed with the release lane, tools/release/sign.mjs): the raw 64-byte Ed25519 signature over the exact
 * bytes of the file, standard base64, optional surrounding whitespace. WebCrypto verifies when the engine supports
 * Ed25519 (Safari 17+, Chrome 137+); otherwise tweetnacl's audited implementation does the same check.
 */
import nacl from 'tweetnacl';
import { RELEASE_PUBLIC_KEY } from '../../shared/release-key';
import { parseChannel, ChannelError, type Channel, type ChannelFile } from './channel';

export function decodeBase64(text: string, expectedLength: number): Uint8Array | null {
  const clean = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length % 4 !== 0) return null;
  let bin: string;
  try {
    bin = atob(clean);
  } catch {
    return null;
  }
  if (bin.length !== expectedLength) return null;
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type Subtle = Pick<SubtleCrypto, 'importKey' | 'verify'>;

/** True only for a valid signature by `publicKeyBase64` over `message`. Never throws for bad input. */
export async function verifyEd25519(message: Uint8Array, signatureBase64: string, publicKeyBase64: string, subtle: Subtle | null = globalThis.crypto?.subtle ?? null): Promise<boolean> {
  const sig = decodeBase64(signatureBase64, 64);
  const key = decodeBase64(publicKeyBase64, 32);
  if (!sig || !key) return false;
  if (subtle) {
    try {
      const k = await subtle.importKey('raw', key as BufferSource, { name: 'Ed25519' } as AlgorithmIdentifier, false, ['verify']);
      return await subtle.verify({ name: 'Ed25519' } as AlgorithmIdentifier, k, sig as BufferSource, message as BufferSource);
    } catch {
      // No Ed25519 in this engine's WebCrypto: fall through to tweetnacl.
    }
  }
  try {
    return nacl.sign.detached.verify(message, sig, key);
  } catch {
    return false;
  }
}

/**
 * Verifies, then parses. Throws ChannelError('signature') when the signature does not match the pinned key: nothing
 * from an unverified file is read, not even its version.
 */
export async function verifyChannel(text: string, signature: string, channel: Channel, publicKey: string = RELEASE_PUBLIC_KEY, subtle?: Subtle | null): Promise<ChannelFile> {
  const ok = await verifyEd25519(new TextEncoder().encode(text), signature, publicKey, subtle);
  if (!ok) throw new ChannelError('The update channel’s signature does not match this app’s release key');
  return parseChannel(text, channel);
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
