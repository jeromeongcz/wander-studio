import assert from 'node:assert/strict';
import test from 'node:test';
import { ollamaProvider } from '../src/providers/llm/ollama.ts';

const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2);
const jpgWithPrefix = Uint8Array.of(7, 8, 255, 216, 255, 99, 9);
const jpg = jpgWithPrefix.subarray(2, 6);
const imageArgs = { model: 'local-vision:8b', prompt: 'Assess warm bounce light and staging.', images: [png, jpg] };
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
function setup(router: (path: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ path: string; host: string; body: Record<string, unknown>; init: RequestInit }> = [];
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body));
    calls.push({ path: url.pathname, host: url.host, body, init: init! });
    return router(url.pathname, init!);
  };
  return { provider: ollamaProvider(fake, 'http://127.0.0.1:12345/'), calls };
}

test('uses the configured host, verifies the fixed model first, and sends exact base64 images to /api/chat', async () => {
  const { provider, calls } = setup((path) => path === '/api/show' ? json({ capabilities: ['completion', 'vision'] }) : json({ done: true, message: { role: 'assistant', content: '  Depth reads clearly.  ' } }));
  assert.equal(await provider.generateVision!(imageArgs), 'Depth reads clearly.');
  assert.deepEqual(calls.map((c) => [c.host, c.path]), [['127.0.0.1:12345', '/api/show'], ['127.0.0.1:12345', '/api/chat']]);
  assert.deepEqual(calls[0].body, { model: 'local-vision:8b', verbose: false });
  assert.deepEqual(calls[1].body, { model: 'local-vision:8b', messages: [{ role: 'user', content: imageArgs.prompt, images: [Buffer.from(png).toString('base64'), Buffer.from(jpg).toString('base64')] }], stream: false, options: { num_predict: 1536 } });
});

test('does not transmit image bytes when model is missing, cannot see images, or might forward to the cloud', async () => {
  for (const [response, expected] of [
    [{ capabilities: ['completion'] }, /does not declare vision/],
    [{}, /does not declare vision/],
    [{ capabilities: ['vision'], remote_host: 'https://ollama.com' }, /forwards to a remote service/],
    [{ capabilities: ['vision'], remote_model: 'other' }, /forwards to a remote service/],
  ] as const) {
    const { provider, calls } = setup(() => json(response));
    await assert.rejects(provider.generateVision!(imageArgs), { code: 'VISION_UNSUPPORTED', message: expected });
    assert.deepEqual(calls.map((x) => x.path), ['/api/show']);
    assert.ok(!JSON.stringify(calls[0].body).includes(Buffer.from(png).toString('base64')));
  }
  const notInstalled = setup(() => json({}, 404));
  await assert.rejects(notInstalled.provider.generateVision!(imageArgs), { code: 'VISION_UNSUPPORTED', message: /could not find/ });
  assert.equal(notInstalled.calls.length, 1);
  const cloud = setup(() => { throw new Error('unexpected network'); });
  await assert.rejects(cloud.provider.generateVision!({ ...imageArgs, model: 'gemma4:cloud' }), { code: 'VISION_UNSUPPORTED' });
  assert.equal(cloud.calls.length, 0);
});

test('invalid input and cancelled requests never need to inspect models', async () => {
  const { provider, calls } = setup(() => { throw new Error('unexpected network'); });
  await assert.rejects(provider.generateVision!({ ...imageArgs, model: undefined }), { code: 'VALIDATION' });
  await assert.rejects(provider.generateVision!({ ...imageArgs, images: [] }), { code: 'VALIDATION' });
  await assert.rejects(provider.generateVision!({ ...imageArgs, images: [Uint8Array.of(1)] }), { code: 'VALIDATION' });
  const big = new Uint8Array(8 * 1024 * 1024 + 1);
  big.set(png);
  await assert.rejects(provider.generateVision!({ ...imageArgs, images: [big] }), { code: 'VALIDATION' });
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(provider.generateVision!({ ...imageArgs, signal: ctrl.signal }), { code: 'CANCELLED' });
  assert.equal(calls.length, 0);
});

test('streamed response limits and invalid chat output are handled without model fallback', async () => {
  const responses = [
    [() => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(512 * 1024 + 1)); c.close(); } })), /exceeded the response budget/],
    [() => new Response('not JSON'), /invalid JSON/],
    [() => json({ message: { content: '' } }), /usable answer/],
    [() => json({ done_reason: 'length', message: { content: 'partial' } }), /output budget/],
  ] as const;
  for (const [response, message] of responses) {
    const { provider, calls } = setup((path) => path === '/api/show' ? json({ capabilities: ['vision'] }) : response());
    await assert.rejects(provider.generateVision!(imageArgs), { code: 'PROVIDER_ERROR', message });
    assert.deepEqual(calls.map((x) => x.path), ['/api/show', '/api/chat']);
  }
});

test('passes live user cancellation to the chat request', async () => {
  const ctrl = new AbortController();
  const { provider, calls } = setup((path, init) => {
    if (path === '/api/show') return json({ capabilities: ['vision'] });
    return new Promise((resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      ctrl.abort();
    });
  });
  await assert.rejects(provider.generateVision!({ ...imageArgs, signal: ctrl.signal }), { code: 'CANCELLED' });
  assert.deepEqual(calls.map((x) => x.path), ['/api/show', '/api/chat']);
});
