import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApi } from '../src/api.ts';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { LLMProviderRegistry } from '../src/providers/llm/registry.ts';
import { claudeProvider } from '../src/providers/llm/claude.ts';
import { ollamaProvider } from '../src/providers/llm/ollama.ts';
import { openAICompatibleProvider } from '../src/providers/llm/openai-compatible.ts';

// ---- a stand-in for the `claude` command ----
function claudeStub() {
  const dir = mkdtempSync(join(tmpdir(), 'wander-llm-claude-stub-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/bin/sh
D="$STUB_LLM_DIR"
if [ "$1" = "auth" ]; then
  if [ "$(cat "$D/auth" 2>/dev/null)" = "in" ]; then echo '{"loggedIn":true}'; else echo '{"loggedIn":false}'; fi
  exit 0
fi
n=$(( $(cat "$D/count" 2>/dev/null || echo 0) + 1 )); echo $n > "$D/count"
echo "$@" > "$D/args_$n"
cat > "$D/prompt_$n"
cat "$D/answer_$n"
`,
  );
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, 'auth'), 'in');
  return {
    dir,
    bin,
    answer: (n: number, text: string) => writeFileSync(join(dir, `answer_${n}`), JSON.stringify({ is_error: false, result: text })),
    rawAnswer: (n: number, raw: string) => writeFileSync(join(dir, `answer_${n}`), raw),
    signedIn: (v: boolean) => writeFileSync(join(dir, 'auth'), v ? 'in' : 'out'),
    calls: () => Number(existsSync(join(dir, 'count')) ? readFileSync(join(dir, 'count'), 'utf8') : 0),
    readPrompt: (n: number) => readFileSync(join(dir, `prompt_${n}`), 'utf8'),
    env: () => process.env.STUB_LLM_DIR,
  };
}

// ---- a fake fetch for Ollama / OpenAI-compatible ----
function fakeFetch(handlers: Record<string, (req: { body?: unknown; headers?: Record<string, string> | undefined }) => Response>): typeof fetch {
  return ((input: any, init?: any) => {
    const url = String(input);
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) return handler(init ?? {});
    }
    return new Response(JSON.stringify({ error: { message: 'unhandled url: ' + url } }), { status: 404, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

// ---- registry ----

test('registry: lists, gets, and errors on unknown providers', () => {
  const r = new LLMProviderRegistry();
  r.register({ id: 'a', kind: 'claude', name: 'A', terms: { freeTier: 'f', requiresKey: false, commercialUse: 'c', privacy: 'p' }, async healthCheck() { return { ok: true, detail: 'ok' }; } });
  r.register({ id: 'b', kind: 'ollama', name: 'B', terms: { freeTier: 'f', requiresKey: false, commercialUse: 'c', privacy: 'p' }, async healthCheck() { return { ok: true, detail: 'ok' }; } });
  assert.deepEqual(r.list().map((p) => p.id), ['a', 'b']);
  assert.equal(r.get('a').name, 'A');
  assert.throws(() => r.get('nope'), /Unknown LLM provider/);
});

test('registry: setActive, active, activeIdOrNull, and text()', () => {
  const r = new LLMProviderRegistry();
  r.register({ id: 'a', kind: 'claude', name: 'A', terms: { freeTier: 'f', requiresKey: false, commercialUse: 'c', privacy: 'p' }, async generateText() { return 'x'; }, async healthCheck() { return { ok: true, detail: 'ok' } } });
  r.register({ id: 'b', kind: 'claude', name: 'B', terms: { freeTier: 'f', requiresKey: false, commercialUse: 'c', privacy: 'p' }, async generateText() { return 'y'; }, async healthCheck() { return { ok: true, detail: 'ok' } } });
  assert.equal(r.activeIdOrNull(), null);
  assert.equal(r.active(), null);
  r.setActive('a');
  assert.equal(r.activeIdOrNull(), 'a');
  assert.equal(r.active()!.id, 'a');
  assert.equal(r.text('a').id, 'a');
  assert.throws(() => r.setActive('nope'), /Unknown/);
  assert.throws(() => r.text('nope'), /Unknown/);
});

test('registry: text() rejects providers without generateText', () => {
  const r = new LLMProviderRegistry();
  r.register({ id: 'a', kind: 'claude', name: 'A', terms: { freeTier: 'f', requiresKey: false, commercialUse: 'c', privacy: 'p' }, async healthCheck() { return { ok: true, detail: 'ok' } } });
  assert.throws(() => r.text('a'), /does not support text generation/);
});

// ---- claude provider ----

test('claude: health check reports signed in / signed out / not installed', async () => {
  const s = claudeStub();
  process.env.STUB_LLM_DIR = s.dir;
  const p = claudeProvider(s.bin);
  let h = await p.healthCheck();
  assert.equal(h.ok, true);
  assert.match(h.detail, /signed in/);

  s.signedIn(false);
  h = await p.healthCheck();
  assert.equal(h.ok, false);
  assert.match(h.detail, /not signed in/);

  const missing = claudeProvider('/nonexistent/claude');
  h = await missing.healthCheck();
  assert.equal(h.ok, false);
  assert.match(h.detail, /not found/);
});

test('claude: generateText returns the answer and sends the prompt, no project data', async () => {
  const s = claudeStub();
  process.env.STUB_LLM_DIR = s.dir;
  s.answer(1, 'The script answer text');
  const p = claudeProvider(s.bin);
  const text = await p.generateText({ prompt: 'Write a script about X', model: 'claude-sonnet-4-0', temperature: 0.7 });
  assert.equal(text, 'The script answer text');
  assert.equal(s.calls(), 1);
  assert.match(s.readPrompt(1), /Write a script about X/);
  const args = readFileSync(join(s.dir, 'args_1'), 'utf8');
  assert.match(args, /--model claude-sonnet-4-0/);
  assert.match(args, /--temperature 0.7/);
  assert.ok(!args.includes('WebSearch') && !args.includes('WebFetch'), 'writing gets no tools');
});

test('claude: generateText fails clearly when not signed in, on error, empty answer', async () => {
  const s = claudeStub();
  process.env.STUB_LLM_DIR = s.dir;
  const p = claudeProvider(s.bin);

  s.signedIn(false);
  await assert.rejects(() => p.generateText({ prompt: 'hi' }), /not signed in/);
  s.signedIn(true);

  s.rawAnswer(1, JSON.stringify({ is_error: true, result: 'Rate limit reached' }));
  await assert.rejects(() => p.generateText({ prompt: 'hi' }), /reported an error: Rate limit reached/);

  s.answer(2, '   ');
  await assert.rejects(() => p.generateText({ prompt: 'hi' }), /empty answer/);
});

// ---- ollama provider ----

test('ollama: health check reachable and unreachable', async () => {
  const reachable = ollamaProvider(fakeFetch({
    '/api/tags': () => new Response(JSON.stringify({ models: [] })),
  }), 'http://localhost:11434');
  assert.equal((await reachable.healthCheck()).ok, true);

  const down = ollamaProvider(fakeFetch({
    '/api/tags': () => new Response(null, { status: 502 }),
  }), 'http://localhost:11434');
  const h = await down.healthCheck();
  assert.equal(h.ok, false);
  assert.match(h.detail, /HTTP 502/);
});

test('ollama: listModels and generateText', async () => {
  const calls: unknown[] = [];
  const fetch = fakeFetch({
    '/api/tags': () => new Response(JSON.stringify({ models: [{ name: 'qwen2.5:32b', model: 'qwen2.5:32b' }] })),
    '/api/generate': (req) => { calls.push(req.body); return new Response(JSON.stringify({ response: 'The generated answer' })); },
  });
  const p = ollamaProvider(fetch, 'http://localhost:11434');

  const models = await p.listModels!();
  assert.deepEqual(models, [{ id: 'qwen2.5:32b', name: 'qwen2.5:32b' }]);

  const text = await p.generateText({ prompt: 'Draw a scene', model: 'qwen2.5:32b', temperature: 0.5 });
  assert.equal(text, 'The generated answer');
  assert.equal(calls.length, 1);
  const body = JSON.parse(String(calls[0]));
  assert.equal(body.model, 'qwen2.5:32b');
  assert.equal(body.prompt, 'Draw a scene');
  assert.equal(body.stream, false);
  assert.equal(body.temperature, 0.5);
});

test('ollama: generateText requires a model', async () => {
  const p = ollamaProvider(fakeFetch({}));
  await assert.rejects(() => p.generateText({ prompt: 'hi' }), /requires a model/);
});

test('ollama: generateText surfaces HTTP errors and empty answers', async () => {
  const p = ollamaProvider(fakeFetch({
    '/api/generate': () => new Response(JSON.stringify({ error: 'model not found' }), { status: 404 }),
  }));
  await assert.rejects(() => p.generateText({ prompt: 'hi', model: 'x' }), /HTTP 404/);

  const empty = ollamaProvider(fakeFetch({
    '/api/generate': () => new Response(JSON.stringify({ response: '' })),
  }));
  await assert.rejects(() => empty.generateText({ prompt: 'hi', model: 'x' }), /empty answer/);
});

// ---- openai-compatible provider ----

test('openai-compatible: health check and generateText', async () => {
  const calls: unknown[] = [];
  const fetch = fakeFetch({
    '/chat/completions': (req) => { calls.push(req); return new Response(JSON.stringify({ choices: [{ message: { content: 'The answer' } }] })); },
  });
  const p = openAICompatibleProvider({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'qwen-max', fetchFn: fetch });

  assert.equal((await p.healthCheck()).ok, true);
  const text = await p.generateText({ prompt: 'Hello' });
  assert.equal(text, 'The answer');
  assert.equal(calls.length, 2); // health check + generate
  const body = JSON.parse(String((calls[1] as { body?: unknown }).body));
  assert.equal(body.model, 'qwen-max');
  assert.equal(body.messages[0].content, 'Hello');
  assert.equal((calls[0] as { headers?: Record<string, string> }).headers?.authorization, 'Bearer sk-test');
});

test('openai-compatible: generateText overrides model and reports errors', async () => {
  const fetch = fakeFetch({
    '/chat/completions': () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401, headers: { 'content-type': 'application/json' } }),
  });
  const p = openAICompatibleProvider({ baseUrl: 'https://api.example.com/v1', model: 'default', fetchFn: fetch });
  await assert.rejects(() => p.generateText({ prompt: 'hi', model: 'qwen' }), /bad key/);
});

// ---- API routes ----

function bootApi(opts: { providers?: Array<{ id: string; kind?: string; name: string; active?: boolean }> } = {}) {
  const registry = new LLMProviderRegistry();
  const make = (id: string) => ({
    id,
    kind: 'claude' as const,
    name: id,
    terms: { freeTier: 'f', requiresKey: false, commercialUse: 'c', privacy: 'p' },
    async generateText() { return 'answer'; },
    async healthCheck() { return { ok: true, detail: 'ok' } },
  });
  for (const p of (opts.providers ?? [{ id: 'claude', name: 'claude' }])) {
    registry.register(make(p.id));
    if (p.active) registry.setActive(p.id);
  }
  const engine = new Engine(openDb());
  const app = buildApi(engine, { root: mkdtempSync(join(tmpdir(), 'wander-llm-api-')) }, registry);
  const call = async (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, payload: payload as any });
    return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : null };
  };
  return { registry, call };
}

test('API: GET /llm/providers lists providers with active flag', async () => {
  const { call } = bootApi({ providers: [{ id: 'claude', name: 'claude', active: true }, { id: 'ollama', name: 'ollama' }] });
  const r = await call('GET', '/llm/providers');
  assert.equal(r.status, 200);
  const ids = (r.json as any[]).map((p) => p.id);
  assert.deepEqual(ids, ['claude', 'ollama']);
  const claude = (r.json as any[]).find((p) => p.id === 'claude');
  assert.equal(claude.active, true);
  assert.equal(claude.terms.freeTier, 'f');
});

test('API: GET /llm/active returns the active provider', async () => {
  const { call } = bootApi({ providers: [{ id: 'claude', name: 'claude', active: true }] });
  const r = await call('GET', '/llm/active');
  assert.equal(r.status, 200);
  assert.equal(r.json.active, 'claude');
});

test('API: PUT /llm/active switches provider and persists', async () => {
  const { registry, call } = bootApi({ providers: [{ id: 'claude', name: 'claude' }, { id: 'ollama', name: 'ollama' }] });
  const r = await call('PUT', '/llm/active', { providerId: 'ollama' });
  assert.equal(r.status, 200);
  assert.equal(r.json.active, 'ollama');
  assert.equal(registry.activeIdOrNull(), 'ollama');
});

test('API: PUT /llm/active with unknown provider is rejected', async () => {
  const { call } = bootApi({ providers: [{ id: 'claude', name: 'claude' }] });
  const r = await call('PUT', '/llm/active', { providerId: 'nope' });
  assert.equal(r.status, 404);
});

test('API: GET /llm/providers/:id/health returns provider health', async () => {
  const { call } = bootApi({ providers: [{ id: 'claude', name: 'claude' }] });
  const r = await call('POST', '/llm/providers/claude/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('API: GET /llm/providers/:id/health 404s on unknown provider', async () => {
  const { call } = bootApi({ providers: [{ id: 'claude', name: 'claude' }] });
  const r = await call('GET', '/llm/providers/nope/health');
  assert.equal(r.status, 404);
});
