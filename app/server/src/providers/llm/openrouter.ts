import type { TextLLMProvider, LLMProviderTerms, LLMHealthStatus } from './types.ts';
import { LLMProviderError } from './types.ts';

const BASE_URL = 'https://openrouter.ai/api/v1';

const FREE_MODELS: Array<{ id: string; name: string }> = [
  { id: 'baidu/ernie-5.5-flash-preview:free', name: 'ERNIE 5.5 Flash Preview' },
  { id: 'recursive/flint-v1.0:free', name: 'Flint' },
  { id: 'liquid/lfm-3-1.7b:free', name: 'LFM3-1.7B' },
  { id: 'inclusionai/ling-3.2-flash:free', name: 'Ling 3.2 Flash' },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', name: 'Nemotron 3 Nano Omni' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra' },
  { id: 'nvidia/nemotron-3.5-lightning:free', name: 'Nemotron 3.5 Lightning' },
  { id: 'nvidia/nemotron-3.5-super-vl:free', name: 'Nemotron 3.5 Super VL' },
  { id: 'openrouter/free', name: 'OpenRouter Free Models Router' },
  { id: 'particle-ai/particle-1:free', name: 'Particle-1' },
];

interface OpenRouterOptions {
  apiKey?: string;
  model?: string;
  fetchFn?: typeof fetch;
}

function sseStreamText(res: Response, onChunk?: (chunk: string) => void): Promise<string> {
  if (!res.body || !onChunk) {
    return res.text();
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let buf = '';
  return new Promise((resolve, reject) => {
    function pump() {
      reader.read().then(({ done, value }) => {
        if (done) { resolve(out); return; }
        buf += decoder.decode(value, { stream: true });
        let lines: string[];
        [lines, buf] = splitSSE(buf);
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
            const c = j.choices?.[0]?.delta?.content ?? '';
            if (c) { out += c; onChunk?.(c); }
          } catch { /* ignore malformed SSE line */ }
        }
        pump();
      }).catch(reject);
    }
    pump();
  });
}

function splitSSE(buf: string): [string[], string] {
  const parts = buf.split('\n');
  const last = parts.pop() ?? '';
  const lines = parts.filter((l) => l.trim() !== '');
  return [lines, last];
}

export function openRouterProvider(opts: OpenRouterOptions): TextLLMProvider {
  const base = BASE_URL.replace(/\/+$/, '');
  const chatUrl = `${base}/chat/completions`;
  const hasKey = !!opts.apiKey;
  const terms: LLMProviderTerms = {
    freeTier: 'Free models via OpenRouter; no direct charge from this app',
    requiresKey: hasKey,
    commercialUse: 'Per OpenRouter and each model’s license terms',
    privacy: 'Prompt text is sent to OpenRouter; review OpenRouter’s privacy policy',
    termsUrl: 'https://openrouter.ai/terms',
  };

  async function health(): Promise<LLMHealthStatus> {
    const start = Date.now();
    try {
      const f: typeof fetch = opts.fetchFn ?? (fetch as typeof fetch);
      const res = await f(`${base}/models`, {
        method: 'GET',
        headers: { ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
      });
      if (!res.ok) {
        return { ok: false, detail: `OpenRouter returned HTTP ${res.status}`, latencyMs: Date.now() - start, lastError: `HTTP ${res.status}`, checkedAt: new Date().toISOString() };
      }
      return { ok: true, detail: 'OpenRouter reachable', latencyMs: Date.now() - start, checkedAt: new Date().toISOString() };
    } catch (e) {
      return { ok: false, detail: `OpenRouter not reachable: ${(e as Error).message}`, latencyMs: Date.now() - start, lastError: (e as Error).message, checkedAt: new Date().toISOString() };
    }
  }

  return {
    id: 'openrouter',
    kind: 'openrouter',
    name: 'OpenRouter (free models)',
    terms,
    async healthCheck() {
      return health();
    },
    async listModels() {
      // Try to fetch live free models from OpenRouter API.
      if (opts.apiKey) {
        try {
          const f: typeof fetch = opts.fetchFn ?? (fetch as typeof fetch);
          const res = await f(`${base}/models`, {
            method: 'GET',
            headers: { authorization: `Bearer ${opts.apiKey}` },
          });
          if (res.ok) {
            const j = await res.json() as { data?: Array<{ id?: string; name?: string; pricing?: { prompt?: number; completion?: number } }> };
            const free = (j.data ?? [])
              .filter((m) => m.pricing?.prompt === 0 && m.pricing?.completion === 0)
              .map((m) => ({ id: m.id ?? '', name: m.name ?? m.id ?? '' }))
              .filter((m) => m.id);
            if (free.length > 0) return free;
          }
        } catch { /* fall back to static list below */ }
      }
      return FREE_MODELS;
    },
    async generateText({ prompt, model, temperature, signal, onChunk }) {
      const usedModel = model ?? opts.model;
      if (!usedModel) throw new LLMProviderError('VALIDATION', 'No model configured for OpenRouter');
      const start = Date.now();
      try {
        const f: typeof fetch = opts.fetchFn ?? (fetch as typeof fetch);
        const res = await f(chatUrl, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
          body: JSON.stringify({
            model: usedModel,
            messages: [{ role: 'user', content: prompt }],
            stream: !!onChunk,
            ...(temperature !== undefined ? { temperature } : {}),
          }),
        });
        if (!res.ok) {
          let detail = `OpenRouter returned HTTP ${res.status}`;
          try { const j = await res.json() as { error?: { message?: string } }; if (j.error?.message) detail = j.error.message; } catch { /* ignore */ }
          throw new LLMProviderError('PROVIDER_ERROR', detail);
        }
        const text = await sseStreamText(res, onChunk);
        const j = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
        if (j.error?.message) throw new LLMProviderError('PROVIDER_ERROR', `OpenRouter: ${j.error.message}`);
        const content = j.choices?.[0]?.message?.content ?? text;
        if (!content.trim()) throw new LLMProviderError('PROVIDER_ERROR', 'OpenRouter returned an empty answer');
        return content;
      } catch (e) {
        if (e instanceof LLMProviderError) throw e;
        const h = await health();
        throw new LLMProviderError('PROVIDER_ERROR', `${h.detail}. ${(e as Error).message}`);
      }
    },
  };
}
