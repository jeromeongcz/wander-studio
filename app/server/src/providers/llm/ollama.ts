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
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Ollama streams JSON lines - each line is a separate JSON object
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // keep incomplete line in buffer
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as { response?: string; done?: boolean };
        if (j.response) {
          out += j.response;
          onChunk(j.response);
        }
        if (j.done) break;
      } catch {
        // ignore malformed JSON lines
      }
    }
  }
  return out;
}

const MiB = 1024 * 1024;
const visionPayload = (image: Uint8Array) => {
  const bytes = Buffer.from(image.buffer, image.byteOffset, image.byteLength);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return true;
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return true;
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
};

/** Cap the decoded body too, since Content-Length can be absent or describe compressed bytes. */
async function visionJSON(res: Response, limit: number, operation: string): Promise<Record<string, unknown>> {
  const contentLength = res.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > limit) {
    void res.body?.cancel().catch(() => {});
    throw new LLMProviderError('PROVIDER_ERROR', `${operation} exceeded the response budget.`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new LLMProviderError('PROVIDER_ERROR', `${operation} returned no response.`);
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > limit) {
        void reader.cancel().catch(() => {});
        throw new LLMProviderError('PROVIDER_ERROR', `${operation} exceeded the response budget.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, count)));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data as Record<string, unknown>;
  } catch {
    throw new LLMProviderError('PROVIDER_ERROR', `${operation} returned invalid JSON.`);
  }
}

export function ollamaProvider(fetchFn: typeof fetch = fetch, host = DEFAULT_HOST): TextLLMProvider {
  const terms: LLMProviderTerms = {
    freeTier: 'Always free and offline; you supply the models',
    requiresKey: false,
    commercialUse: 'Depends on the model you run; check each model license',
    privacy: 'Uses your configured Ollama host. Keep the host and selected model local to keep inputs on your computer.',
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
      try {
        const res = await request('/api/tags');
        const j = await res.json() as { models?: Array<{ name?: string; model?: string }> };
        return (j.models ?? []).map((m) => ({ id: m.model ?? m.name ?? '', name: m.name ?? m.model ?? '' })).filter((m) => m.id);
      } catch {
        return [];
      }
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

    /** Verify vision support without sending image bytes first. Do not silently change models or pull anything. */
    async generateVision({ prompt, model, images, signal }) {
      const usedModel = model?.trim();
      if (!usedModel || usedModel.length > 256) throw new LLMProviderError('VALIDATION', 'Choose an installed Ollama vision model in Settings.');
      if (/(?:[:_-]cloud)(?::[^/]*)?$/i.test(usedModel)) {
        throw new LLMProviderError('VISION_UNSUPPORTED', 'Choose a local Ollama vision model, not an Ollama Cloud model. No images were sent.');
      }
      if (!prompt.trim() || Buffer.byteLength(prompt, 'utf8') > 64 * 1024) throw new LLMProviderError('VALIDATION', 'Ollama vision needs a prompt of at most 64 KiB.');
      if (!images.length || images.length > 4 || images.some((image) => !(image instanceof Uint8Array) || image.byteLength > 8 * MiB || !visionPayload(image))) {
        throw new LLMProviderError('VALIDATION', 'Ollama vision accepts one to four PNG, JPEG, or WebP images of at most 8 MiB each.');
      }
      const timeout = AbortSignal.timeout(180_000);
      const overall = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const showSignal = AbortSignal.any([overall, AbortSignal.timeout(12_000)]);
      const post = async (path: string, body: Record<string, unknown>, operation: string, abort: AbortSignal) => {
        abort.throwIfAborted();
        const res = await fetchFn(`${baseUrl(host)}${path}`, {
          method: 'POST', redirect: 'error', signal: abort,
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          void res.body?.cancel().catch(() => {});
          if (path === '/api/show' && res.status === 404) throw new LLMProviderError('VISION_UNSUPPORTED', `Ollama vision could not find “${usedModel}” on the configured host. Pick an installed vision model or use text reference notes.`);
          throw new LLMProviderError('PROVIDER_ERROR', `${operation} returned HTTP ${res.status}.`);
        }
        return res;
      };
      let inspected = false;
      try {
        // https://docs.ollama.com/api-reference/show-model-details
        const show = await visionJSON(await post('/api/show', { model: usedModel, verbose: false }, 'Ollama model details', showSignal), 2 * MiB, 'Ollama model details');
        inspected = true;
        if (show.remote_host || show.remote_model) {
          throw new LLMProviderError('VISION_UNSUPPORTED', 'This Ollama model forwards to a remote service. Choose a locally installed vision model. No images were sent.');
        }
        if (!Array.isArray(show.capabilities) || !show.capabilities.includes('vision')) {
          throw new LLMProviderError('VISION_UNSUPPORTED', `Ollama model “${usedModel}” does not declare vision support. Select an installed vision-capable model or use text reference notes. No images were sent.`);
        }
        // The native REST API takes bare base64 bytes, not URLs or data URIs.
        // https://docs.ollama.com/capabilities/vision
        const result = await visionJSON(await post('/api/chat', {
          model: usedModel,
          messages: [{ role: 'user', content: prompt, images: images.map((image) => Buffer.from(image.buffer, image.byteOffset, image.byteLength).toString('base64')) }],
          stream: false,
          options: { num_predict: 1536 },
        }, 'Ollama vision chat', overall), 512 * 1024, 'Ollama vision chat');
        overall.throwIfAborted();
        const message = result.message as { content?: unknown } | undefined;
        if (result.done_reason === 'length') throw new LLMProviderError('PROVIDER_ERROR', 'Ollama vision reached its output budget before completing the answer.');
        if (result.error || typeof message?.content !== 'string' || !message.content.trim()) throw new LLMProviderError('PROVIDER_ERROR', 'Ollama vision did not return a usable answer.');
        return message.content.trim();
      } catch (e) {
        if (signal?.aborted) throw new LLMProviderError('CANCELLED', 'Ollama vision was cancelled.');
        if (timeout.aborted || !inspected && showSignal.aborted) throw new LLMProviderError('PROVIDER_ERROR', inspected ? 'Ollama vision exceeded its time budget.' : 'Ollama did not report the selected model’s capabilities in time.');
        if (e instanceof LLMProviderError) throw e;
        throw new LLMProviderError('PROVIDER_ERROR', 'Ollama vision could not reach or read the configured host. Check the Ollama connection and model in Settings.');
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
