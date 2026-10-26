/**
 * FREE-11: the coordinator's model client for the chief's brain. Coordinator-only (runs in the tick job on Actions).
 *
 * - Keys come only from five Actions secret names (brainKeysFromEnv); a Claude subscription token is never read, and
 *   `claude -p` is not a backend.
 * - One OpenAI-compatible `POST {baseUrl}/chat/completions`, non-streaming, temperature 0, with max_tokens, a timeout and
 *   a bounded response body. No retries: a paid call is never repeated silently (the caller charged its worst case).
 * - Errors never echo the key.
 */
import { HOSTED_FREE } from '../shared/engines.js';
import type { BrainProvider } from './brain.js';
import { brainSecretName, BRAIN_PROVIDERS } from './brain.js';
import type { BrainCaller } from './tick.js';

export type BrainKeys = Partial<Record<string, string>>;
const PAID_BASE: Record<'anthropic' | 'openai', string> = { anthropic: 'https://api.anthropic.com/v1', openai: 'https://api.openai.com/v1' };
export const MAX_BRAIN_RESPONSE_BYTES = 1024 * 1024;
export const BRAIN_TIMEOUT_MS = 90_000;

/** The brain's keys from the tick job's environment: only the five provider key names, trimmed. */
export function brainKeysFromEnv(env: Record<string, string | undefined>): BrainKeys {
  const out: BrainKeys = {};
  for (const p of BRAIN_PROVIDERS) { const name = brainSecretName(p); const v = env[name]?.trim(); if (v) out[name] = v; }
  return out;
}

const baseUrl = (p: BrainProvider) => (p === 'anthropic' || p === 'openai' ? PAID_BASE[p] : HOSTED_FREE.find((h) => h.id === p)!.baseUrl);
const redact = (s: string) => s.replace(/\b(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|gsk_[A-Za-z0-9]{16,})/g, '[redacted]');

async function readCapped(r: Response, limit: number): Promise<string> {
  if (!r.body) return '';
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) { void reader.cancel().catch(() => {}); throw new Error(`the response was larger than ${limit} bytes`); }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes); let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(all);
}

export function openAiCompatibleCaller(keys: BrainKeys, transport: typeof fetch = fetch, timeoutMs = BRAIN_TIMEOUT_MS): BrainCaller {
  return async ({ provider, model, messages, maxTokens }) => {
    const key = keys[brainSecretName(provider)];
    if (!key) throw new Error(`the ${brainSecretName(provider)} secret is not set in the state repository`);
    let r: Response;
    try {
      r = await transport(`${baseUrl(provider)}/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens, temperature: 0 }),
      });
    } catch (error) { throw new Error(`could not reach ${provider}: ${redact((error as Error).message).slice(0, 120)}`); }
    if (!r.ok) {
      const body = redact((await readCapped(r, 4096).catch(() => '')).replace(/\s+/g, ' ').slice(0, 200));
      throw new Error(`${provider} answered HTTP ${r.status}${r.status === 429 ? ' (rate-limited)' : ''}${body ? `: ${body}` : ''}`);
    }
    const raw = await readCapped(r, MAX_BRAIN_RESPONSE_BYTES);
    let j: any;
    try { j = JSON.parse(raw); } catch { throw new Error(`${provider} returned invalid JSON`); }
    return {
      text: String(j?.choices?.[0]?.message?.content ?? ''),
      ...(typeof j?.model === 'string' ? { model: j.model } : {}),
      usage: { input: Number(j?.usage?.prompt_tokens) || 0, output: Number(j?.usage?.completion_tokens) || 0 },
    };
  };
}
