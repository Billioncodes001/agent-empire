/**
 * libsodium-compatible sealed boxes (`crypto_box_seal`), which is what GitHub requires for Actions secrets:
 *
 *   ephemeral X25519 key pair (epk, esk)
 *   nonce  = BLAKE2b-192(epk || recipient_pk)                       (24 bytes, unkeyed)
 *   sealed = epk || crypto_box(message, nonce, recipient_pk, esk)   (XSalsa20-Poly1305)
 *
 * Built from tweetnacl (X25519 + XSalsa20-Poly1305) and blakejs (BLAKE2b). The ephemeral secret key is wiped after
 * use. `sealOpen` exists so tests can check round trips; the app itself never holds a recipient secret key.
 */
import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';

export const SEAL_OVERHEAD = nacl.box.publicKeyLength + nacl.box.overheadLength; // 32 + 16

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** The sealed-box nonce: BLAKE2b with a 24-byte output over the ephemeral and recipient public keys. */
export function sealNonce(ephemeralPk: Uint8Array, recipientPk: Uint8Array): Uint8Array {
  return blake2b(concat(ephemeralPk, recipientPk), undefined, nacl.box.nonceLength);
}

/** Seals `message` to `recipientPk`. `ephemeral` is for tests only; normally a fresh key pair is generated. */
export function sealBox(message: Uint8Array, recipientPk: Uint8Array, ephemeral: nacl.BoxKeyPair = nacl.box.keyPair()): Uint8Array {
  if (recipientPk.length !== nacl.box.publicKeyLength) throw new Error('The recipient public key must be 32 bytes.');
  try {
    const boxed = nacl.box(message, sealNonce(ephemeral.publicKey, recipientPk), recipientPk, ephemeral.secretKey);
    return concat(ephemeral.publicKey, boxed);
  } finally {
    ephemeral.secretKey.fill(0);
  }
}

/** Opens a sealed box (crypto_box_seal_open). Null when it was not sealed to this key pair or was altered. */
export function sealOpen(sealed: Uint8Array, recipientPk: Uint8Array, recipientSk: Uint8Array): Uint8Array | null {
  if (sealed.length < SEAL_OVERHEAD) return null;
  const epk = sealed.subarray(0, nacl.box.publicKeyLength);
  return nacl.box.open(sealed.subarray(nacl.box.publicKeyLength), sealNonce(epk, recipientPk), epk, recipientSk);
}

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(text: string): Uint8Array {
  const bin = atob(text.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encrypts a secret value for a repository's Actions public key (base64 in, base64 out), as GitHub documents. */
export function sealForGitHub(publicKeyBase64: string, value: string): string {
  const pk = fromBase64(publicKeyBase64);
  if (pk.length !== nacl.box.publicKeyLength) throw new Error('GitHub returned an unexpected repository public key.');
  const message = new TextEncoder().encode(value);
  try {
    return toBase64(sealBox(message, pk));
  } finally {
    message.fill(0);
  }
}
