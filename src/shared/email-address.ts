// FREE-12: plain email address rules shared by the office server (src/server/email.ts and src/server/outreach.ts
// re-export them unchanged) and the cloud coordinator and game (src/cloud/outreach.ts). Pure and browser-safe.

export const ADDRESS = /^[^\s<>@"',;]{1,64}@[A-Za-z0-9.-]{1,253}$/;

/** Whether a string is one plain email address (no display name, no list, no CR/LF). */
export const isEmailAddress = (s: string) => ADDRESS.test(s) && /\.[A-Za-z]{2,}$/.test(s) && !/[\u0000-\u001f\u007f]/.test(s);

/** One address as stored and compared: trimmed, Unicode NFC, lowercase. C0 controls are refused. Plus-addressing is distinct. */
export function normalizeEmail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const email = raw.trim().normalize('NFC').toLowerCase();
  if (!email || email.length > 254 || /[\u0000-\u001f\u007f]/.test(email) || !isEmailAddress(email)) return undefined;
  return email;
}
