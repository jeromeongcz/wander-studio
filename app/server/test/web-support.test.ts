import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { buildApi } from '../src/api.ts';
import { ffprobeBinary } from '../src/media.ts';
import { dirname } from 'node:path';

function boot() {
  const root = mkdtempSync(join(tmpdir(), 'wander-web-'));
  const engine = new Engine(openDb());
  const app = buildApi(engine, { root });
  return { root, engine, app };
}
const png = (root: string) => {
  const f = join(root, 'src.png');
  execFileSync(join(dirname(ffprobeBinary()), 'ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=1', '-frames:v', '1', f]);
  return readFileSync(f);
};

test('the API only answers localhost hosts (DNS-rebinding guard)', async () => {
  const { app } = boot();
  for (const host of ['localhost:4317', '127.0.0.1:4317', 'localhost', '[::1]:4317']) {
    assert.equal((await app.inject({ method: 'GET', url: '/health', headers: { host } })).statusCode, 200, host);
  }
  for (const host of ['evil.example.com', 'localhost.evil.com', '127.0.0.1.evil.com:80', '192.168.1.5:4317']) {
    const r = await app.inject({ method: 'GET', url: '/health', headers: { host } });
    assert.equal(r.statusCode, 403, `host "${host}"`);
    assert.equal(JSON.parse(r.body).error.code, 'FORBIDDEN_HOST');
  }
});

test('cross-origin state-changing requests are refused; same-origin and plain GETs are fine', async () => {
  const { app } = boot();
  const post = (origin?: string) => app.inject({ method: 'POST', url: '/projects', headers: { host: 'localhost:4317', ...(origin ? { origin, 'content-type': 'application/json' } : { 'content-type': 'application/json' }) }, payload: { name: 'X', languages: ['en'] } });
  assert.equal((await post('https://evil.example.com')).statusCode, 403);
  assert.equal((await post('http://localhost:9999')).statusCode, 403, 'different port is a different origin');
  assert.equal((await post('null')).statusCode, 403);
  assert.equal((await post('http://localhost:4317')).statusCode, 201);
  assert.equal((await post()).statusCode, 201, 'non-browser clients send no Origin');
  const get = await app.inject({ method: 'GET', url: '/projects', headers: { host: 'localhost:4317', origin: 'https://evil.example.com' } });
  assert.equal(get.statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: '/templates/x', headers: { host: 'localhost:4317', origin: 'https://evil.example.com' } })).statusCode, 403);
});

test('/api prefix reaches every route', async () => {
  const { app } = boot();
  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/locales' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/nope' })).statusCode, 404);
});

test('uploads: stored in cache, sanitized, type-checked, and removed after an import whether it succeeds or fails', async () => {
  const { app, root } = boot();
  const up = (body: Buffer | string, name: string, type = 'application/octet-stream') => app.inject({ method: 'POST', url: '/api/uploads', headers: { 'content-type': type, 'x-filename': encodeURIComponent(name) }, payload: body });
  const dir = join(root, 'cache', 'uploads');

  const evil = await up(png(root), '../../evil.png');
  assert.equal(evil.statusCode, 201);
  const path = JSON.parse(evil.body).path as string;
  assert.ok(path.startsWith(dir + '/'), 'saved under cache/uploads');
  assert.match(path, /_evil\.png$/);
  assert.ok(!existsSync(join(root, '..', 'evil.png')));
  assert.equal((await up('', 'a.png')).statusCode, 422);
  assert.equal((await up('x', 'notes.txt')).statusCode, 422);
  assert.equal((await up('x', 'script.exe')).statusCode, 422);
  assert.equal((await up('{"a":1}', 'a.png', 'application/json')).statusCode, 422, 'not raw bytes');

  const pid = JSON.parse((await app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'U', languages: ['en'] } })).body).id as string;
  const imp = await app.inject({ method: 'POST', url: `/api/projects/${pid}/assets/import`, payload: { path, type: 'stock_photo', license: { type: 'own', commercial_use: 'yes' } } });
  assert.equal(imp.statusCode, 201);
  assert.ok(!existsSync(path), 'upload removed after a successful import');

  const bad = JSON.parse((await up('this is not an image', 'fake.png')).body).path as string;
  const failed = await app.inject({ method: 'POST', url: `/api/projects/${pid}/assets/import`, payload: { path: bad, type: 'stock_photo', license: { type: 'own', commercial_use: 'yes' } } });
  assert.equal(failed.statusCode, 422);
  assert.ok(!existsSync(bad), 'upload removed after a failed import too');
  assert.deepEqual(readdirSync(dir), [], 'nothing left behind');

  // a path that is NOT an upload is never deleted by an import
  const own = join(root, 'mine.png');
  execFileSync('cp', [join(root, 'src.png'), own]);
  await app.inject({ method: 'POST', url: `/api/projects/${pid}/assets/import`, payload: { path: own, type: 'illustration', license: { type: 'own', commercial_use: 'yes' } } });
  assert.ok(existsSync(own), 'originals are never touched');
});

test('timeline-status reports whether a composition has a timeline', async () => {
  const { app, engine } = boot();
  const p = JSON.parse((await app.inject({ method: 'POST', url: '/projects', payload: { name: 'T', languages: ['en'], formats: ['vertical_9x16'] } })).body);
  const comp = engine.list(p.id, { kind: 'composition' })[0];
  const r = JSON.parse((await app.inject({ method: 'GET', url: `/artifacts/${comp.id}/timeline-status` })).body);
  assert.deepEqual(r, { has_timeline: false, stale: true, duration: null, scenes: 0, captions: false });
});

test('a project can be renamed and its category changed; this never touches approvals', async () => {
  const { app, engine } = boot();
  const p = JSON.parse((await app.inject({ method: 'POST', url: '/projects', payload: { name: 'Old', category: 'Science', languages: ['en'] } })).body);
  const research = engine.list(p.id, { kind: 'research' })[0];
  engine.saveVersion(research.id, { topic: 'x' });
  const before = engine.list(p.id).map((a) => `${a.id}:${a.state}:${a.current_version_id}`);
  const patch = (payload: unknown) => app.inject({ method: 'PATCH', url: `/projects/${p.id}`, payload: payload as any });

  let r = await patch({ category: 'Horror & Folklore' });
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).category, 'Horror & Folklore');
  assert.equal(JSON.parse(r.body).name, 'Old', 'name untouched when not sent');
  r = await patch({ name: '  New name  ', category: 'My own category' });
  assert.equal(JSON.parse(r.body).name, 'New name');
  assert.equal(JSON.parse(r.body).category, 'My own category', 'custom categories are allowed');
  r = await patch({ category: '' });
  assert.equal(JSON.parse(r.body).category, null, 'empty clears it');
  assert.equal((await patch({ name: '   ' })).statusCode, 422);
  assert.equal((await patch({ name: 'x'.repeat(121) })).statusCode, 422);
  assert.equal((await patch({ category: 'x'.repeat(61) })).statusCode, 422);
  assert.equal((await app.inject({ method: 'PATCH', url: '/projects/NOPE', payload: { category: 'Sports' } })).statusCode, 404);
  assert.deepEqual(engine.list(p.id).map((a) => `${a.id}:${a.state}:${a.current_version_id}`), before, 'no artifact changed');
  // recommendations follow the new category
  await patch({ category: 'Sports' });
  const recs = JSON.parse((await app.inject({ method: 'GET', url: '/categories/Sports/recommendations' })).body);
  assert.equal(recs.custom, false);
});
