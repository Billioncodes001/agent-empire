/**
 * FREE-01 local model runtime: detects Ollama on this host and downloads models only on an explicit, confirmed request.
 * API: https://github.com/ollama/ollama/blob/main/docs/api.md — GET /api/version, GET /api/tags, POST /api/pull
 * (streams NDJSON `{status, digest?, total?, completed?}` lines, or `{error}`). Nothing here runs at import.
 */
import { MODEL_CATALOGUE, MODEL_TAG, OLLAMA_INSTALL_URL, type OllamaState, type PullState } from '../shared/engines.js';

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

async function getJson(url: string, timeoutMs: number): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export class OllamaRuntime {
  private pullState?: PullState;
  private abort?: AbortController;

  constructor(readonly url = DEFAULT_OLLAMA_URL, private onChange: () => void = () => {}) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(url)) throw new Error('Ollama must be reached on this computer (loopback) only.');
  }

  async detect(): Promise<OllamaState> {
    const base = { url: this.url, installUrl: OLLAMA_INSTALL_URL, pull: this.pullState ? { ...this.pullState } : undefined };
    let version: string | undefined;
    try {
      version = String((await getJson(`${this.url}/api/version`, 1500))?.version ?? '') || undefined;
    } catch {
      return { ...base, running: false, models: [], detail: `Ollama is not running on ${this.url}. Install it from ${OLLAMA_INSTALL_URL} (not bundled), then start it.` };
    }
    let models: OllamaState['models'] = [];
    try {
      const tags = await getJson(`${this.url}/api/tags`, 3000);
      models = (Array.isArray(tags?.models) ? tags.models : [])
        .filter((m: any) => typeof m?.name === 'string')
        .map((m: any) => ({ name: String(m.name), sizeBytes: Number(m.size) || 0 }));
    } catch {
      // running but the model list failed: report what we know
    }
    return { ...base, running: true, version, models, detail: models.length ? `Running${version ? ` (v${version})` : ''} with ${models.length} model${models.length === 1 ? '' : 's'}.` : `Running${version ? ` (v${version})` : ''}. No models downloaded yet.` };
  }

  get pull(): PullState | undefined { return this.pullState ? { ...this.pullState } : undefined; }

  /**
   * Starts a download. Only catalogue models, and only with `confirm === true` (the UI shows name, size and licence
   * first): FREE_PLAN rule 5, no automatic downloads. Resolves once the stream ends; progress is in `pull`.
   */
  startPull(model: unknown, confirm: unknown): { error?: string; started?: Promise<void> } {
    if (confirm !== true) return { error: 'A model download needs explicit confirmation of its name, size and licence.' };
    if (typeof model !== 'string' || !MODEL_TAG.test(model)) return { error: 'Invalid model tag.' };
    if (!MODEL_CATALOGUE.some((m) => m.tag === model)) return { error: 'Only the listed models can be downloaded from here. Use `ollama pull` yourself for others.' };
    if (this.pullState && !this.pullState.done) return { error: `${this.pullState.model} is still downloading.` };
    this.abort = new AbortController();
    this.pullState = { model, status: 'starting', completed: 0, total: 0, done: false };
    this.onChange();
    return { started: this.runPull(model, this.abort.signal) };
  }

  cancelPull(): boolean {
    if (!this.pullState || this.pullState.done || !this.abort) return false;
    this.abort.abort();
    return true;
  }

  private async runPull(model: string, signal: AbortSignal) {
    const state = this.pullState!;
    const set = (patch: Partial<PullState>) => { Object.assign(state, patch); this.onChange(); };
    try {
      const r = await fetch(`${this.url}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal });
      if (!r.ok || !r.body) throw new Error(`Ollama answered HTTP ${r.status}`);
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          if (typeof ev.error === 'string') throw new Error(ev.error.slice(0, 200));
          set({ status: String(ev.status ?? state.status).slice(0, 120), ...(Number.isFinite(ev.total) ? { total: ev.total } : {}), ...(Number.isFinite(ev.completed) ? { completed: ev.completed } : {}) });
          if (ev.status === 'success') { set({ done: true }); return; }
        }
      }
      set({ done: true, ...(state.status === 'success' ? {} : { error: 'The download stream ended before Ollama reported success.' }) });
    } catch (error) {
      if (signal.aborted) set({ done: true, cancelled: true, status: 'cancelled' });
      else set({ done: true, error: (error as Error).message.slice(0, 200), status: 'failed' });
    }
  }
}
