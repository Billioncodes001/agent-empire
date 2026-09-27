import { randomBytes } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';

/** Same-directory replacement preserves the previous complete file on write/rename failure. */
export function writeJsonAtomic(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed already, or never created */ }
  }
}
