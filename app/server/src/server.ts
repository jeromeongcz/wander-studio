import { fileURLToPath } from 'node:url';
import { createReadStream, existsSync } from 'node:fs';
import { isInside } from './platform.ts';
import { join, dirname, extname, normalize, resolve } from 'node:path';
import { openDb } from './db.ts';
import { Engine } from './engine.ts';
import { buildApi } from './api.ts';
import { LLMProviderRegistry } from './providers/llm/registry.ts';
import { claudeProvider } from './providers/llm/claude.ts';
import { ollamaProvider } from './providers/llm/ollama.ts';
import { openAICompatibleProvider } from './providers/llm/openai-compatible.ts';
import { openRouterProvider } from './providers/llm/openrouter.ts';
import { readLLMSettings, writeLLMSettings } from './llm-settings.ts';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// WANDER_ROOT keeps data (projects, db, cache) somewhere other than the source tree, e.g. for demos.
const root = process.env.WANDER_ROOT ?? appRoot;
const dbPath = process.env.WANDER_DB ?? join(root, 'data', 'wander.db');
const port = Number(process.env.WANDER_PORT ?? 4317);

// ---- Global AI Switcher: build the LLM provider registry and restore the persisted selection ----
const settings = await readLLMSettings();
const llm = new LLMProviderRegistry();

// Claude is always available (uses your own sign-in).
llm.register(claudeProvider(process.env.WANDER_CLAUDE_BIN));
// Ollama is always available (local models, no key required).
llm.register(ollamaProvider(fetch, settings.ollamaHost ?? process.env.WANDER_OLLAMA_HOST));
// OpenAI-compatible endpoint (Qwen, DeepSeek, Gemini, etc.) only when configured.
if (settings.openaiCompatible?.baseUrl) {
  llm.register(openAICompatibleProvider({
    baseUrl: settings.openaiCompatible.baseUrl,
    apiKey: settings.openaiCompatible.apiKey,
    model: settings.openaiCompatible.model,
    fetchFn: fetch,
  }));
}
// OpenRouter free models only when an API key is configured.
if (settings.openrouter?.apiKey) {
  llm.register(openRouterProvider({
    apiKey: settings.openrouter.apiKey,
    model: settings.openrouter.model,
    fetchFn: fetch,
  }));
}

// Restore the globally active provider, fallback, defaultToFreeFirst and selected model.
llm.applySettings({
  activeProvider: settings.activeProvider ?? null,
  fallbackProvider: settings.fallbackProvider ?? null,
  defaultToFreeFirst: settings.defaultToFreeFirst ?? false,
  selectedModel: settings.selectedModel ?? undefined,
});

// Free-first default: when no provider is explicitly chosen and Ollama is reachable, prefer it.
if (!llm.activeIdOrNull() && settings.defaultToFreeFirst) {
  const ollama = llm.list().find((p) => p.id === 'ollama');
  if (ollama) {
    try {
      const h = await ollama.healthCheck();
      if (h.ok) llm.setActive('ollama');
    } catch { /* leave unset; user picks in Settings */ }
  }
}

const config = {
  root,
  activeLLMProvider: llm.activeIdOrNull(),
  fallbackLLMProvider: llm.fallbackIdOrNull(),
  defaultToFreeFirst: settings.defaultToFreeFirst ?? false,
  ollamaHost: settings.ollamaHost ?? process.env.WANDER_OLLAMA_HOST,
  openaiCompatible: settings.openaiCompatible ?? undefined,
  openrouter: settings.openrouter ?? undefined,
  selectedLLMModel: settings.selectedModel ?? null,
};

const app = buildApi(new Engine(openDb(dbPath)), config, llm);

// Serve the built web UI (app/web/dist) when it exists. API routes live at /api/* (and, for tools, at the root).
const dist = join(appRoot, 'app', 'web', 'dist', 'ui');
if (existsSync(join(dist, 'index.html'))) {
  const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };
  app.get('/', async (_req, reply) => reply.type(MIME['.html']).send(createReadStream(join(dist, 'index.html'))));
  app.get('/ui/*', async (req, reply) => {
    const rel = normalize((req.params as { '*': string })['*']);
    const file = resolve(dist, rel);
    if (rel.startsWith('..') || !isInside(dist, file) || !existsSync(file)) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    return reply.type(MIME[extname(file)] ?? 'application/octet-stream').send(createReadStream(file));
  });
}
// Bind to loopback only: this is a local-first app with no authentication.
await app.listen({ host: '127.0.0.1', port });
console.log(`Wander AI Director API on http://127.0.0.1:${port} (db: ${dbPath})`);
console.log(`Active AI provider: ${llm.activeIdOrNull() ?? '(none selected)'}`);
console.log(`Fallback AI provider: ${llm.fallbackIdOrNull() ?? '(none)'}`);
