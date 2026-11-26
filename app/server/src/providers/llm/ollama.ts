import type { TextLLMProvider, LLMProviderTerms, LLMHealthStatus } from './types.ts';
import { LLMProviderError } from './types.ts';

const DEFAULT_HOST = 'http://localhost:11434';

function baseUrl(host?: string): string {
  return (host ?? DEFAULT_HOST).replace(/\/+$/, '');
}

async function readStreamBody(res: Response, onChunk?: (chunk: string) => void): Promise<string> {
  if (!res.body || !onChunk) {
    return res.text();
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    out += chunk;
    onChunk(chunk);
  }
  return out;
}

export function ollamaProvider(fetchFn: typeof fetch = fetch, host = DEFAULT_HOST): TextLLMProvider {
  const terms: LLMProviderTerms = {
    freeTier: 'Always free and offline; you supply the models',
    requiresKey: false,
    commercialUse: 'Depends on the model you run; check each model license',
    privacy: 'Runs fully on this machine; prompts never leave your computer',
  };

  async function request(path: string, opts: { signal?: AbortSignal; body?: unknown; stream?: boolean; onChunk?: (chunk: string) => void } = {}): Promise<Response> {
    const res = await fetchFn(`${baseUrl(host)}${path}`, {
      signal: opts.signal,
      headers: { accept: 'application/json', ...(opts.body ? { 'content-type': 'application/json' } : {}) },
      ...(opts.body ? { method: 'POST', body: JSON.stringify(opts.body) } : {}),
    });
    if (!res.ok) throw new LLMProviderError('PROVIDER_ERROR', `Ollama returned HTTP ${res.status}`);
    return res;
  }

  async function health(): Promise<LLMHealthStatus> {
    const start = Date.now();
    try {
      await request('/api/tags');
      return { ok: true, detail: `Ollama reachable at ${baseUrl(host)}`, latencyMs: Date.now() - start, checkedAt: new Date().toISOString() };
    } catch (e) {
      return { ok: false, detail: `Ollama not reachable at ${baseUrl(host)}: ${(e as Error).message}`, latencyMs: Date.now() - start, lastError: (e as Error).message, checkedAt: new Date().toISOString() };
    }
  }

  return {
    id: 'ollama',
    kind: 'ollama',
    name: 'Ollama (local models)',
    terms,
    async healthCheck() {
      return health();
    },
    async listModels() {
      const res = await request('/api/tags');
      const j = await res.json() as { models?: Array<{ name?: string; model?: string }> };
      return (j.models ?? []).map((m) => ({ id: m.model ?? m.name ?? '', name: m.name ?? m.model ?? '' })).filter((m) => m.id);
    },
    async generateText({ prompt, model, temperature, signal, onChunk }) {
      const usedModel = model;
      if (!usedModel) throw new LLMProviderError('VALIDATION', 'Ollama requires a model; pick one from the model list');
      const start = Date.now();
      try {
        const res = await fetchFn(`${baseUrl(host)}/api/generate`, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: usedModel, prompt, stream: !!onChunk, ...(temperature !== undefined ? { temperature } : {}) }),
        });
        if (!res.ok) throw new LLMProviderError('PROVIDER_ERROR', `Ollama generate returned HTTP ${res.status}`);
        const text = await readStreamBody(res, onChunk);
        const j = JSON.parse(text) as { response?: string; error?: string };
        if (j.error) throw new LLMProviderError('PROVIDER_ERROR', `Ollama: ${j.error}`);
        if (!j.response || !j.response.trim()) throw new LLMProviderError('PROVIDER_ERROR', 'Ollama returned an empty answer');
        return j.response;
      } catch (e) {
        if (e instanceof LLMProviderError) throw e;
        const h = await health();
        throw new LLMProviderError('PROVIDER_ERROR', `${h.detail}. ${(e as Error).message}`);
      } finally {
        // record latency even on success is handled by health(); keep simple here
      }
    },

    /** Pull/download a model from Ollama, streaming progress via onProgress. */
    async pullModel({ model, onProgress }: { model: string; onProgress?: (p: { status: string; completed?: number; total?: number; percent?: number }) => void }): Promise<void> {
      if (!model) throw new LLMProviderError('VALIDATION', 'A model name is required to pull');
      const res = await fetchFn(`${baseUrl(host)}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: true }),
      });
      if (!res.ok) {
        let detail = `Ollama pull returned HTTP ${res.status}`;
        try { const j = await res.json() as { error?: string }; if (j.error) detail = j.error; } catch { /* ignore */ }
        throw new LLMProviderError('PROVIDER_ERROR', detail);
      }
      if (!res.body) throw new LLMProviderError('PROVIDER_ERROR', 'Ollama pull returned no body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let lines: string[];
          [lines, buf] = splitLines(buf);
          for (const line of lines) {
            if (!line.trim()) continue;
            let j: { status?: string; completed?: number; total?: number; digest?: string; error?: string } | null = null;
            try { j = JSON.parse(line); } catch { /* ignore malformed line */ }
            if (!j) continue;
            if (j.error) throw new LLMProviderError('PROVIDER_ERROR', `Ollama pull: ${j.error}`);
            const percent = j.total && j.completed !== undefined ? Math.round((j.completed / j.total) * 100) : undefined;
            onProgress?.({ status: j.status ?? 'pulling', completed: j.completed, total: j.total, percent });
            if (j.status === 'success') return;
          }
        }
      } finally {
        reader.releaseLock();
      }
    },

    /** Delete a model from Ollama's local library. */
    async deleteModel({ model }: { model: string }): Promise<void> {
      if (!model) throw new LLMProviderError('VALIDATION', 'A model name is required to delete');
      const res = await fetchFn(`${baseUrl(host)}/api/delete`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: model }),
      });
      if (!res.ok) {
        let detail = `Ollama delete returned HTTP ${res.status}`;
        try { const j = await res.json() as { error?: string }; if (j.error) detail = j.error; } catch { /* ignore */ }
        throw new LLMProviderError('PROVIDER_ERROR', detail);
      }
    },
  };
}

function splitLines(buf: string): [string[], string] {
  const parts = buf.split('\n');
  const last = parts.pop() ?? '';
  const lines = parts.filter((l) => l.trim() !== '');
  return [lines, last];
}
