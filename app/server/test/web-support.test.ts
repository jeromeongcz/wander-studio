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

  let r = await patch({ category: 'Mythology and Folklore' });
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).category, 'Mythology and Folklore');
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
  await patch({ category: 'Superstitions' });
  const recs = JSON.parse((await app.inject({ method: 'GET', url: '/categories/Superstitions/recommendations' })).body);
  assert.equal(recs.custom, false);
});

test('deleting a project: needs the exact name, previews what goes, removes everything of that project only, keeps the shared library', async () => {
  const { app, engine, root } = boot();
  const post = async (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as any });
  const mk = async (name: string) => JSON.parse((await post('/projects', { name, languages: ['en'], formats: ['vertical_9x16'] })).body).id as string;
  const doomed = await mk('Doomed project');
  const keeper = await mk('Keeper project');
  const LIC = { type: 'own', commercial_use: 'yes' };

  const src = join(root, 'a.png');
  execFileSync(join(dirname(ffprobeBinary()), 'ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:d=1', '-frames:v', '1', src]);
  const src2 = join(root, 'b.png');
  execFileSync(join(dirname(ffprobeBinary()), 'ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=s=160x90:d=1', '-frames:v', '1', src2]);
  const asset = JSON.parse((await post(`/projects/${doomed}/assets/import`, { path: src, type: 'stock_photo', license: LIC })).body);
  await post(`/assets/${asset.id}/approve`, {});
  const shared = JSON.parse((await post(`/assets/${asset.id}/promote`, {})).body);
  const kept = JSON.parse((await post(`/projects/${keeper}/assets/import`, { path: src2, type: 'stock_photo', license: LIC })).body);
  await app.inject({ method: 'PUT', url: `/projects/${doomed}/lexicon/en`, payload: { term: 'octopus', respelling: 'OK-to-pus' } });
  const scene = engine.createArtifact({ projectId: doomed, kind: 'scene_asset', label: 'Scene', sceneId: 'SCENE-DOOMED' });
  engine.saveVersion(scene, { assets: [{ asset_id: asset.id }], primary_asset_id: asset.id });
  engine.db.prepare("INSERT INTO scene_timing (scene_id, lang_code, audio_seconds, updated_at) VALUES ('SCENE-DOOMED', 'en', 2, 'x')").run();
  engine.saveVersion(engine.list(doomed, { kind: 'research' })[0].id, { topic: 'x' });

  const preview = JSON.parse((await app.inject({ method: 'GET', url: `/projects/${doomed}/deletion-preview` })).body);
  assert.equal(preview.name, 'Doomed project');
  assert.equal(preview.assets, 1);
  assert.ok(preview.artifacts >= 10 && preview.files >= 1 && preview.bytes > 0, JSON.stringify(preview));
  assert.equal(preview.active_jobs, 0);
  assert.ok(preview.keeps.some((k: string) => /shared library/i.test(k)));

  // confirmation is enforced by the server, not just the UI
  for (const body of [{}, { confirm_name: '' }, { confirm_name: 'doomed project' }, { confirm_name: 'Doomed project ' }, { confirm_name: 5 }]) {
    const r = await post(`/projects/${doomed}/delete`, body);
    assert.equal(r.statusCode, 422, JSON.stringify(body));
  }
  assert.equal(engine.getProject(doomed).name, 'Doomed project', 'nothing deleted by a wrong confirmation');
  assert.equal((await post('/projects/NOPE/delete', { confirm_name: 'x' })).statusCode, 404);

  // a queued or running job blocks deletion
  engine.db.prepare("INSERT INTO jobs (id, project_id, kind, state, created_at, updated_at) VALUES ('JBUSY', ?, 'x', 'running', 'x', 'x')").run(doomed);
  const busy = await post(`/projects/${doomed}/delete`, { confirm_name: 'Doomed project' });
  assert.equal(busy.statusCode, 409);
  assert.match(JSON.parse(busy.body).error.message, /running job/);
  engine.db.prepare("UPDATE jobs SET state = 'failed' WHERE id = 'JBUSY'").run();

  // if the database refuses, the files are put back and nothing is lost
  engine.db.exec("CREATE TRIGGER block_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
  const failed = await post(`/projects/${doomed}/delete`, { confirm_name: 'Doomed project' });
  assert.equal(failed.statusCode, 500);
  assert.ok(existsSync(join(root, asset.rel_path)), 'files restored after a failed delete');
  assert.equal(engine.getProject(doomed).name, 'Doomed project');
  assert.deepEqual(readdirSync(join(root, 'cache')).filter((f) => f.startsWith('trash_')), []);
  engine.db.exec('DROP TRIGGER block_delete');

  const keeperRows = engine.list(keeper).length;
  const ok = await post(`/projects/${doomed}/delete`, { confirm_name: 'Doomed project' });
  assert.equal(ok.statusCode, 200);
  const res = JSON.parse(ok.body);
  assert.equal(res.deleted, true);
  assert.equal(res.files_removed, true);
  assert.equal(res.cleanup, 'removed');

  // everything of the project is gone, in every table and on disk
  const n = (sql: string, ...a: string[]) => (engine.db.prepare(sql).get(...a) as { n: number }).n;
  for (const t of ['artifacts', 'assets', 'audio_clips', 'renders', 'pronunciation_entries', 'publishing_kits', 'thumbnails', 'jobs', 'project_languages']) {
    assert.equal(n(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`, doomed), 0, t);
  }
  assert.equal(n("SELECT COUNT(*) AS n FROM versions WHERE artifact_id NOT IN (SELECT id FROM artifacts)"), 0, 'no orphaned versions');
  assert.equal(n('SELECT COUNT(*) AS n FROM artifact_deps WHERE artifact_id NOT IN (SELECT id FROM artifacts)'), 0);
  assert.equal(n('SELECT COUNT(*) AS n FROM approval_events WHERE artifact_id NOT IN (SELECT id FROM artifacts)'), 0);
  assert.equal(n("SELECT COUNT(*) AS n FROM scene_timing WHERE scene_id = 'SCENE-DOOMED'"), 0);
  assert.equal(n('SELECT COUNT(*) AS n FROM projects WHERE id = ?', doomed), 0);
  assert.ok(!existsSync(join(root, 'projects', `proj_${doomed}`)));
  assert.deepEqual(readdirSync(join(root, 'cache')).filter((f) => f.startsWith('trash_')), [], 'no leftovers');
  assert.equal((await app.inject({ method: 'GET', url: `/projects/${doomed}` })).statusCode, 404);
  assert.equal((await post(`/projects/${doomed}/delete`, { confirm_name: 'Doomed project' })).statusCode, 404, 'second delete');

  // other project and the shared library are untouched
  assert.equal(engine.list(keeper).length, keeperRows);
  assert.ok(existsSync(join(root, kept.rel_path)));
  assert.equal(JSON.parse((await app.inject({ method: 'GET', url: `/projects/${keeper}/assets` })).body).length, 1);
  assert.ok(existsSync(join(root, shared.rel_path)), 'shared library file kept');
  assert.equal(JSON.parse((await app.inject({ method: 'GET', url: '/library' })).body).length, 1);
});

test('the categories endpoint serves the six topics with their recommendations', async () => {
  const { app } = boot();
  const cats = JSON.parse((await app.inject({ method: 'GET', url: '/categories' })).body) as { name: string; profile: { assets: string[] } }[];
  assert.deepEqual(cats.map((c) => c.name), ['Philippine History', 'Mythology and Folklore', 'Culture and Traditions', 'Food Origins', 'Geography', 'Superstitions']);
  assert.ok(cats.every((c) => c.profile.assets.length >= 3));
  const known = JSON.parse((await app.inject({ method: 'GET', url: '/categories/Food%20Origins/recommendations' })).body);
  assert.equal(known.custom, false);
  const other = JSON.parse((await app.inject({ method: 'GET', url: '/categories/Anything%20else/recommendations' })).body);
  assert.equal(other.custom, true);
});
