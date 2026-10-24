/**
 * FREE-01 shared model client (used by FREE-02 and FREE-05). Speaks the OpenAI-compatible Chat Completions API
 * (`POST {baseUrl}/chat/completions`) to:
 * - Ollama on this computer (`http://127.0.0.1:11434/v1`) — US$0;
 * - an opt-in free hosted tier with the user's own key (OpenRouter, Gemini, Groq) — US$0, labelled "free tier (rate-limited)";
 * - the user's Anthropic or OpenAI API key — a labelled estimate from the price table below.
 * Nothing runs at import. No retries: callers decide, so a paid call is never repeated silently.
 */
import { HOSTED_FREE, type KeyName } from '../shared/engines.js';
import { DEFAULT_OLLAMA_URL } from './ollama.js';

export type LlmProviderId = 'ollama' | 'openrouter' | 'gemini' | 'groq' | 'anthropic' | 'openai';
export type CostKind = 'local' | 'free-tier' | 'paid-estimate';

export interface LlmProvider {
  id: LlmProviderId;
  baseUrl: string;
  /** Absent for Ollama. */
  apiKey?: string;
  model: string;
  kind: CostKind;
  /** USD per million tokens [input, output], for paid estimates only. */
  price?: [number, number];
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface ChatResult {
  text: string;
  model: string;
  usage: { input: number; output: number };
  cost: { usd: number | null; kind: CostKind; label: string };
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

const PAID: Record<'anthropic' | 'openai', { baseUrl: string; key: KeyName }> = {
  // Anthropic's OpenAI SDK compatibility layer: https://docs.anthropic.com/en/api/openai-sdk
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', key: 'ANTHROPIC_API_KEY' },
  openai: { baseUrl: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY' },
};

/**
 * Paid calls are estimated from a price the caller configures (USD per million tokens, [input, output]), because
 * provider prices change: the Empire does not ship a price list here. Without one the result says so instead of guessing.
 */
export function estimateCost(price: [number, number], input: number, output: number): number {
  return Math.round(((input * price[0] + output * price[1]) / 1e6) * 1e6) / 1e6;
}

function costOf(p: LlmProvider, input: number, output: number): ChatResult['cost'] {
  if (p.kind === 'local') return { usd: 0, kind: 'local', label: 'US$0 · local model' };
  if (p.kind === 'free-tier') return { usd: 0, kind: 'free-tier', label: 'US$0 · free tier (rate-limited)' };
  if (!p.price) return { usd: null, kind: 'paid-estimate', label: 'Paid API call · no price configured, so no estimate' };
  const usd = estimateCost(p.price, input, output);
  return { usd, kind: 'paid-estimate', label: `≈ US$${usd.toFixed(4)} (estimate)` };
}

/** Builds a provider from configuration. Keys come from the caller (env or the sealed vault), never from disk here. */
export function provider(id: LlmProviderId, model: string, keys: Partial<Record<KeyName, string>> = {}, opts: { ollamaUrl?: string; baseUrl?: string; price?: [number, number] } = {}): LlmProvider {
  if (id === 'ollama') return { id, model, kind: 'local', baseUrl: `${opts.ollamaUrl ?? DEFAULT_OLLAMA_URL}/v1` };
  const hosted = HOSTED_FREE.find((h) => h.id === id);
  if (hosted) {
    const apiKey = keys[hosted.key];
    if (!apiKey) throw new LlmError(`${hosted.name} needs your own ${hosted.key} (opt-in).`);
    return { id, model, kind: 'free-tier', baseUrl: opts.baseUrl ?? hosted.baseUrl, apiKey };
  }
  const paid = PAID[id as 'anthropic' | 'openai'];
  const apiKey = keys[paid.key];
  if (!apiKey) throw new LlmError(`No ${paid.key} saved.`);
  return { id, model, kind: 'paid-estimate', baseUrl: opts.baseUrl ?? paid.baseUrl, apiKey, ...(opts.price ? { price: opts.price } : {}) };
}

export interface ChatOptions {
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  /** Stream tokens to this callback (SSE); the result still carries the whole text. */
  onToken?: (text: string) => void;
  signal?: AbortSignal;
}

/** A model answer larger than this is abandoned, never buffered whole (security review). */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Removes key-shaped text (OpenAI/Anthropic `sk-…`, Google `AIza…`, Groq `gsk_…`, OpenRouter `sk-or-…`) from provider messages. */
export function redactKeys(s: string): string {
  return s.replace(/\b(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,}|gsk_[A-Za-z0-9]{16,})/g, '[redacted]');
}

/** Reads a body up to `limit` bytes. Over the limit: cancels the stream and throws (or truncates when `strict` is false). */
async function readCapped(r: Response, limit: number, id: string, strict: boolean): Promise<string> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    if (bytes > limit) {
      await r.body?.cancel().catch(() => {});
      if (strict) throw new LlmError(`${id}'s response was too large (over ${limit} bytes); stopped reading it.`);
      break;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function chat(p: LlmProvider, messages: ChatMessage[], o: ChatOptions = {}): Promise<ChatResult> {
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 120_000);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  const stream = !!o.onToken;
  let r: Response;
  try {
    r = await fetch(`${p.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}) },
      body: JSON.stringify({
        model: p.model, messages, stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
        ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
        ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
      }),
    });
  } catch (error) {
    throw new LlmError(timeout.aborted ? 'The model did not answer in time.' : `Could not reach ${p.id}: ${(error as Error).message}`);
  }
  if (!r.ok) {
    const body = redactKeys((await readCapped(r, 4096, p.id, false).catch(() => '')).slice(0, 300));
    throw new LlmError(`${p.id} answered HTTP ${r.status}${r.status === 429 ? ' (rate-limited)' : ''}${body ? `: ${body.replace(/\s+/g, ' ')}` : ''}`, r.status);
  }
  let text = '';
  let model = p.model;
  let input = 0;
  let output = 0;
  if (!stream) {
    const raw = await readCapped(r, MAX_RESPONSE_BYTES, p.id, true);
    const j: any = (() => { try { return JSON.parse(raw); } catch { throw new LlmError(`${p.id} returned invalid JSON.`); } })();
    text = String(j?.choices?.[0]?.message?.content ?? '');
    model = typeof j?.model === 'string' ? j.model : model;
    input = Number(j?.usage?.prompt_tokens) || 0;
    output = Number(j?.usage?.completion_tokens) || 0;
  } else {
    const decoder = new TextDecoder();
    let buf = '';
    let bytes = 0;
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await r.body?.cancel().catch(() => {}); throw new LlmError(`${p.id}'s response was too large (over ${MAX_RESPONSE_BYTES} bytes); stopped reading it.`); }
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j: any;
        try { j = JSON.parse(data); } catch { continue; }
        const piece = j?.choices?.[0]?.delta?.content;
        if (typeof piece === 'string' && piece) { text += piece; o.onToken!(piece); }
        if (typeof j?.model === 'string') model = j.model;
        if (j?.usage) { input = Number(j.usage.prompt_tokens) || input; output = Number(j.usage.completion_tokens) || output; }
      }
    }
  }
  return { text, model, usage: { input, output }, cost: costOf(p, input, output) };
}
