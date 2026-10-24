/**
 * FREE-08: sealed notification secrets (Telegram bot token, ntfy access token, SMTP password).
 *
 * The host only ever reports them as present or not; no endpoint returns a value. The desktop app passes a store backed
 * by its operating-system credential vault (Electron safeStorage, as for API keys). On a server install the store is
 * an AES-256-GCM file whose key sits in a separate owner-only file: it keeps secrets out of backups of the save,
 * screenshots and git, but anyone who can read this account's files can read both. That is said in the UI.
 *
 * Never a Claude credential: there is no name for one (FREE_PLAN rule 3).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SECRET_NAMES, type SecretName } from '../shared/onboarding.js';

export interface SecretStore {
  names(): Record<SecretName, boolean>;
  get(name: SecretName): string | undefined;
  set(name: SecretName, value: string): void;
  delete(name: SecretName): void;
  /** Plain words for the UI: where and how the values are kept. */
  readonly describe: string;
}

const TELEGRAM_TOKEN = /^\d{5,20}:[A-Za-z0-9_-]{20,}$/;

/** Why a value cannot be stored, or undefined. Messages never repeat the value. */
export function invalidSecret(name: SecretName, value: unknown): string | undefined {
  if (!SECRET_NAMES.includes(name)) return 'Unknown secret.';
  if (typeof value !== 'string' || !value.trim()) return 'Enter a value, or remove it instead.';
  if (/[\r\n\0]/.test(value)) return 'A secret has no line breaks.';
  if (value.length > 1024) return 'That value is too long.';
  if (name === 'telegramToken' && !TELEGRAM_TOKEN.test(value.trim())) return 'A Telegram bot token looks like 123456789:ABC… (from @BotFather).';
  if (name === 'ntfyToken' && !/^[A-Za-z0-9_-]{8,200}$/.test(value.trim())) return 'An ntfy access token looks like tk_… (letters and digits only).';
  return undefined;
}

const none = (): Record<SecretName, boolean> => ({ telegramToken: false, ntfyToken: false, smtpPassword: false });

export class FileSecretStore implements SecretStore {
  readonly describe = 'Saved on the office host, encrypted at rest with a key in a separate owner-only file. Anyone who can read this computer account’s files could read them; on the desktop app the operating system’s credential store is used instead.';
  private readonly file: string;
  private readonly keyFile: string;

  constructor(private readonly dataDir: string) {
    this.file = path.join(dataDir, 'secrets.enc');
    this.keyFile = path.join(dataDir, 'secrets.key');
  }

  private key(create: boolean): Buffer | undefined {
    if (existsSync(this.keyFile)) {
      const k = Buffer.from(readFileSync(this.keyFile, 'utf8').trim(), 'base64');
      if (k.length !== 32) throw new Error('Saved secrets could not be opened (their key file is damaged). Nothing was changed.');
      return k;
    }
    if (!create) return undefined;
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const k = randomBytes(32);
    writeFileSync(this.keyFile, k.toString('base64'), { mode: 0o600, flag: 'wx' });
    return k;
  }

  /** Throws when the file exists but cannot be opened: callers fail closed. */
  private readAll(): Partial<Record<SecretName, string>> {
    if (!existsSync(this.file)) return {};
    try {
      const key = this.key(false);
      if (!key) throw new Error();
      const blob = JSON.parse(readFileSync(this.file, 'utf8')) as { v?: number; iv?: string; tag?: string; data?: string };
      if (blob.v !== 1 || !blob.iv || !blob.tag || !blob.data) throw new Error();
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
      d.setAuthTag(Buffer.from(blob.tag, 'base64'));
      const parsed = JSON.parse(Buffer.concat([d.update(Buffer.from(blob.data, 'base64')), d.final()]).toString('utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error();
      return Object.fromEntries(SECRET_NAMES.filter((n) => typeof parsed[n] === 'string' && parsed[n]).map((n) => [n, parsed[n]]));
    } catch { throw new Error('Saved secrets could not be opened. Nothing was changed; restore secrets.enc and secrets.key together, or remove both and enter the secrets again.'); }
  }

  private writeAll(values: Partial<Record<SecretName, string>>) {
    const key = this.key(true)!;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(values), 'utf8'), c.final()]);
    const temp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.file);
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }

  names(): Record<SecretName, boolean> {
    try { const all = this.readAll(); return Object.fromEntries(SECRET_NAMES.map((n) => [n, !!all[n]])) as Record<SecretName, boolean>; }
    catch { return none(); }
  }

  get(name: SecretName): string | undefined {
    try { return this.readAll()[name]; } catch { return undefined; }
  }

  set(name: SecretName, value: string) {
    const problem = invalidSecret(name, value);
    if (problem) throw new Error(problem);
    const all = this.readAll();
    all[name] = value.trim();
    this.writeAll(all);
  }

  delete(name: SecretName) {
    if (!SECRET_NAMES.includes(name)) throw new Error('Unknown secret.');
    if (!existsSync(this.file)) return;
    const all = this.readAll();
    if (!(name in all)) return;
    delete all[name];
    this.writeAll(all);
  }
}
