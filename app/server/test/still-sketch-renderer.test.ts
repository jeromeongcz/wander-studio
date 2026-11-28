import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { buildApi } from '../src/api.ts';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { LLMProviderRegistry } from '../src/providers/llm/registry.ts';
import { rasterize } from '../src/research/sketch.ts';

test('missing local SVG renderer stops the still drawing job before any provider call', {
  skip: process.platform === 'darwin' && 'macOS also has a system sips fallback that is not resolved from PATH',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'wander sketch probe '));
  const db = openDb();
  const engine = new Engine(db);
  const llm = new LLMProviderRegistry();
  let health = 0, generations = 0;
  llm.register({
    id: 'fixture', name: 'Fixture', kind: 'claude',
    terms: { freeTier: 'test only', requiresKey: false, commercialUse: '', privacy: 'local' },
    async healthCheck() { ++health; return { ok: true, detail: 'Ready' }; },
    async generateText() { ++generations; throw new Error('Provider should not be contacted'); },
  });
  llm.setActive('fixture');
  const app = buildApi(engine, { root, ffprobePath: join(root, 'ffprobe.exe') }, llm);
  const oldPath = process.env.PATH;
  try {
    const created = await app.inject({ method: 'POST', url: '/projects', payload: { name: 'Renderer guard fixture' } });
    assert.equal(created.statusCode, 201, created.body);
    const board = engine.list(created.json().id, { kind: 'storyboard' })[0]!;
    engine.saveVersion(board.id, { scenes: [{ scene_id: 'scene', target_duration: 4, visual_description: 'A window', camera: { movement: 'static' } }] });
    process.env.PATH = root;
    const response = await app.inject({ method: 'POST', url: `/artifacts/${board.id}/sketches`, payload: {} });
    assert.equal(response.statusCode, 202, response.body);
    const { id } = response.json().job;
    let job;
    for (let n = 0; n < 200; n++) {
      job = (await app.inject({ method: 'GET', url: `/jobs/${id}` })).json();
      if (job.state === 'failed' || job.state === 'succeeded') break;
      await delay(25);
    }
    assert.equal(job?.state, 'failed');
    assert.match(job.error.message, /No illustration request was sent.*SVG-to-PNG.*librsvg/);
    assert.equal(health, 0);
    assert.equal(generations, 0);
    assert.deepEqual(await readdir(join(root, 'cache')), []);
    assert.equal((await app.inject({ method: 'GET', url: `/artifacts/${board.id}/sketches` })).json()[0].asset_id, null);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await app.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the bounded SVG capability check still accepts a working rsvg-convert fallback', {
  skip: process.platform === 'win32' && 'uses a local executable shell fixture',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'wander sketch fallback '));
  const oldPath = process.env.PATH;
  const src = join(root, 'probe.svg'), png = join(root, 'probe.png');
  const fixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lmf8AAAAASUVORK5CYII=', 'base64');
  try {
    await writeFile(src, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    await writeFile(join(root, 'fixture.png'), fixture);
    await writeFile(join(root, 'rsvg-convert'), '#!/bin/sh\n[ "$1" = "-o" ] && [ -f "$3" ] && /bin/cp "${0%/*}/fixture.png" "$2"\n', { mode: 0o755 });
    process.env.PATH = root;
    await rasterize(src, png, join(root, 'missing-ffmpeg'), { timeout: 5_000, signal: AbortSignal.timeout(10_000) });
    assert.deepEqual(await readFile(png), fixture);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});
