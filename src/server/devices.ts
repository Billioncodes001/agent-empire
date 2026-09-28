import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './persistence.js';

/**
 * Long-lived, revocable sign-ins for the bundled game apps (iOS, Android, desktop).
 *
 * The app gets a random token once, at sign-in. Only an HMAC of it is stored, keyed on the office
 * secret and the password verifier, so a copy of devices.json can't be replayed, and changing the
 * password or the secret signs every device out (their stored hashes no longer match anything).
 */

export const DEVICE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_DEVICES = 100;
const MAX_NAME = 64;
/** lastUsedAt is kept in memory on every use but only written to disk this often per device. */
const TOUCH_WRITE_MS = 10 * 60_000;

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number;
}

interface StoredDevice extends DeviceInfo {
  /** hex HMAC-SHA256 of the token; never the token itself. */
  hash: string;
}

interface StoreFile {
  version: 1;
  /** Fingerprint of the key the hashes were made with; a mismatch means the secret or password changed. */
  keyId: string;
  devices: StoredDevice[];
}

export function sanitizeDeviceName(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  // Drop control and bidi-override characters; collapse whitespace.
  const clean = raw
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...clean].slice(0, MAX_NAME).join('').trim() || 'Device';
}

export class DeviceStore {
  private readonly file: string;
  private readonly key: Buffer;
  private readonly keyId: string;
  private devices: StoredDevice[] = [];
  private byHash = new Map<string, StoredDevice>();
  private writtenUse = new Map<string, number>();

  constructor(dataDir: string, secret: string, verifier: Buffer) {
    this.file = path.join(dataDir, 'devices.json');
    this.key = createHmac('sha256', secret).update('device-token:').update(verifier).digest();
    this.keyId = createHmac('sha256', this.key).update('key-id').digest('hex').slice(0, 16);
    this.load();
  }

  private load() {
    if (!existsSync(this.file)) return;
    let parsed: Partial<StoreFile> | undefined;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (err) {
      // Failing closed: an unreadable store means no device is signed in. Owners sign in again.
      console.warn(`agent-office: ${this.file} is unreadable (${(err as Error).message}); device sign-ins were reset`);
      this.resetFile();
      return;
    }
    if (!parsed || parsed.keyId !== this.keyId || !Array.isArray(parsed.devices)) {
      // Password or secret rotated since these were issued: every old token is dead, so forget them.
      this.resetFile();
      return;
    }
    for (const d of parsed.devices) {
      if (!d || typeof d.id !== 'string' || typeof d.hash !== 'string' || !/^[0-9a-f]{64}$/.test(d.hash)) continue;
      const device: StoredDevice = {
        id: d.id,
        name: sanitizeDeviceName(d.name),
        hash: d.hash,
        createdAt: Number(d.createdAt) || 0,
        lastUsedAt: Number(d.lastUsedAt) || 0,
      };
      this.devices.push(device);
      this.byHash.set(device.hash, device);
      this.writtenUse.set(device.id, device.lastUsedAt);
    }
  }

  private resetFile() {
    try { this.save(); } catch (err) { console.warn(`agent-office: could not reset ${this.file}: ${(err as Error).message}`); }
  }

  private save() {
    const data: StoreFile = { version: 1, keyId: this.keyId, devices: this.devices };
    writeJsonAtomic(this.file, data);
    for (const d of this.devices) this.writtenUse.set(d.id, d.lastUsedAt);
  }

  private hash(token: string): string {
    return createHmac('sha256', this.key).update(token).digest('hex');
  }

  /** Mints a device token. Returns undefined once the device limit is reached. */
  issue(name: unknown): { token: string; deviceId: string } | undefined {
    if (this.devices.length >= MAX_DEVICES) return undefined;
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const device: StoredDevice = { id: randomBytes(9).toString('base64url'), name: sanitizeDeviceName(name), hash: this.hash(token), createdAt: now, lastUsedAt: now };
    this.devices.push(device);
    this.byHash.set(device.hash, device);
    this.save();
    return { token, deviceId: device.id };
  }

  /** The device a token belongs to, or undefined. Records the use (written to disk at most every 10 minutes). */
  verify(token: string | undefined): DeviceInfo | undefined {
    if (!token || !DEVICE_TOKEN_RE.test(token)) return undefined;
    // The map is keyed on an HMAC the caller can't steer, so the lookup leaks nothing useful by timing.
    const device = this.byHash.get(this.hash(token));
    if (!device) return undefined;
    const now = Date.now();
    device.lastUsedAt = now;
    if (now - (this.writtenUse.get(device.id) ?? 0) >= TOUCH_WRITE_MS) {
      try { this.save(); } catch { /* a failed touch must not fail the request; retried on the next use */ }
    }
    return this.info(device);
  }

  list(): DeviceInfo[] {
    return this.devices.map((d) => this.info(d));
  }

  revoke(id: string): boolean {
    const i = this.devices.findIndex((d) => d.id === id);
    if (i < 0) return false;
    const [gone] = this.devices.splice(i, 1);
    this.byHash.delete(gone.hash);
    this.writtenUse.delete(gone.id);
    this.save();
    return true;
  }

  /** Persists pending lastUsedAt updates (on shutdown). */
  flush() {
    if (this.devices.some((d) => d.lastUsedAt !== this.writtenUse.get(d.id))) {
      try { this.save(); } catch { /* shutting down; the next use records it again */ }
    }
  }

  private info(d: StoredDevice): DeviceInfo {
    return { id: d.id, name: d.name, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt };
  }
}
