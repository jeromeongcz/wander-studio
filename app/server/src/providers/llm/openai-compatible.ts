import type { TextLLMProvider, LLMProviderTerms, LLMHealthStatus } from './types.ts';
import { LLMProviderError } from './types.ts';

interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
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

export function openAICompatibleProvider(opts: OpenAICompatibleOptions): TextLLMProvider {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const chatUrl = `${base}/chat/completions`;
  const terms: LLMProviderTerms = {
    freeTier: 'Depends on the endpoint you configure; many offer free tiers',
    requiresKey: !!opts.apiKey,
    commercialUse: 'Per your endpoint provider\'s terms',
    privacy: 'Prompt text is sent to the endpoint you configured; review that provider\'s privacy policy',
  };

  async function health(): Promise<LLMHealthStatus> {
    const start = Date.now();
    try {
      const f: typeof fetch = opts.fetchFn ?? (fetch as typeof fetch);
      const res = await f(chatUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
        body: JSON.stringify({
          model: opts.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
      });
      if (!res.ok) {
        return { ok: false, detail: `Endpoint returned HTTP ${res.status}`, latencyMs: Date.now() - start, lastError: `HTTP ${res.status}`, checkedAt: new Date().toISOString() };
      }
      return { ok: true, detail: 'Endpoint reachable', latencyMs: Date.now() - start, checkedAt: new Date().toISOString() };
    } catch (e) {
      return { ok: false, detail: `Endpoint not reachable: ${(e as Error).message}`, latencyMs: Date.now() - start, lastError: (e as Error).message, checkedAt: new Date().toISOString() };
    }
  }

  return {
    id: 'openai-compatible',
    kind: 'openai-compatible',
    name: 'OpenAI-compatible API (Qwen, DeepSeek, Gemini, etc.)',
    terms,
    async healthCheck() {
      return health();
    },
    async generateText({ prompt, model, temperature, signal, onChunk }) {
      const usedModel = model ?? opts.model;
      if (!usedModel) throw new LLMProviderError('VALIDATION', 'No model configured for OpenAI-compatible provider');
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
          let detail = `Endpoint returned HTTP ${res.status}`;
          try { const j = await res.json() as { error?: { message?: string } }; if (j.error?.message) detail = j.error.message; } catch { /* ignore */ }
          throw new LLMProviderError('PROVIDER_ERROR', detail);
        }
        const text = await sseStreamText(res, onChunk);
        const j = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
        if (j.error?.message) throw new LLMProviderError('PROVIDER_ERROR', `Endpoint: ${j.error.message}`);
        const content = j.choices?.[0]?.message?.content ?? text;
        if (!content.trim()) throw new LLMProviderError('PROVIDER_ERROR', 'Endpoint returned an empty answer');
        return content;
      } catch (e) {
        if (e instanceof LLMProviderError) throw e;
        const h = await health();
        throw new LLMProviderError('PROVIDER_ERROR', `${h.detail}. ${(e as Error).message}`);
      }
    },
  };
}
