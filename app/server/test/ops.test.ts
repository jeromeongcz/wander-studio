import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { buildApi } from '../src/api.ts';
import { ffprobeBinary, sha256File } from '../src/media.ts';
import { ZipWriter, extractToBuffer, readZipEntries } from '../src/zip.ts';
import { JobRunner } from '../src/jobs.ts';
import { CacheService } from '../src/cache.ts';
import { resolveConfig } from '../src/config.ts';
import { runPreflight, requireHealthy } from '../src/preflight.ts';
import { generateKit, validateKit, buildKitPrompt, formatChapters } from '../src/publish/kit.ts';
import { parseMotionPrompt } from '../src/providers/i2v.ts';
import { DEFAULT_STYLE } from '../src/captions/track.ts';

const FFMPEG = join(dirname(ffprobeBinary()), 'ffmpeg');
let tmp: string;
let png: string;
let png2: string;
let wav: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wander-ops-'));
  const ff = (args: string[]) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...args]);
  png = join(tmp, 'a.png');
  png2 = join(tmp, 'b.png');
  wav = join(tmp, 'n.wav');
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=1600x900:d=1', '-frames:v', '1', png]);
  ff(['-f', 'lavfi', '-i', 'gradients=s=900x1200:d=1', '-frames:v', '1', png2]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=1.5', wav]);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function boot() {
  const root = mkdtempSync(join(tmpdir(), 'wander-ops-root-'));
  const engine = new Engine(openDb());
  const app = buildApi(engine, { root });
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, payload: payload as any });
    let json: any = null;
    try {
      json = r.body ? JSON.parse(r.body) : null;
    } catch {
      /* binary */
    }
    return { status: r.statusCode, json, raw: r.rawPayload };
  };
  return { engine, root, call };
}

// ---------------- zip ----------------
test('zip: round trip of text, binary, empty and unicode-named files; CRC verified on extract', async () => {
  const out = join(tmp, 't.zip');
  const big = Buffer.alloc(300_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 255;
  writeFileSync(join(tmp, 'big.bin'), big);
  writeFileSync(join(tmp, 'empty.txt'), '');
  writeFileSync(join(tmp, 'note.txt'), 'hello '.repeat(1000));
  const z = new ZipWriter(out);
  await z.addBuffer('manifest.json', Buffer.from('{"a":1}'));
  await z.addFile('files/big.bin', join(tmp, 'big.bin'));
  await z.addFile('files/empty.txt', join(tmp, 'empty.txt'));
  await z.addFile('files/ünï-ñame.txt', join(tmp, 'note.txt'));
  await z.addFile('files/a.png', png); // stored, not deflated
  assert.equal(await z.finish(), 5);
  const entries = await readZipEntries(out);
  assert.deepEqual(entries.map((e) => e.name), ['manifest.json', 'files/big.bin', 'files/empty.txt', 'files/ünï-ñame.txt', 'files/a.png']);
  assert.equal(entries[1].method, 8);
  assert.equal(entries[4].method, 0);
  assert.ok(entries[3].csize < entries[3].usize, 'text compressed');
  assert.deepEqual(await extractToBuffer(out, entries[1], 1e9), big);
  assert.equal((await extractToBuffer(out, entries[2], 1e9)).length, 0);
  assert.equal((await extractToBuffer(out, entries[3], 1e9)).toString(), 'hello '.repeat(1000));
  assert.equal((await extractToBuffer(out, entries[4], 1e9)).length, statSync(png).size);
  // the system unzip agrees the archive is valid
  assert.match(execFileSync('unzip', ['-tq', out]).toString(), /No errors detected/);
});

test('zip: corrupt data is detected, garbage is not a zip, oversize is refused', async () => {
  const out = join(tmp, 'c.zip');
  const z = new ZipWriter(out);
  await z.addBuffer('x.txt', Buffer.from('important data here'));
  await z.finish();
  const bytes = readFileSync(out);
  const at = bytes.indexOf('important');
  bytes[at + 2] ^= 0xff;
  writeFileSync(out, bytes);
  const [e] = await readZipEntries(out);
  await assert.rejects(() => extractToBuffer(out, e, 1e6), /integrity/);
  writeFileSync(join(tmp, 'junk.zip'), 'not a zip at all');
  await assert.rejects(() => readZipEntries(join(tmp, 'junk.zip')), /Not a zip/);
  const ok = join(tmp, 'ok.zip');
  const z2 = new ZipWriter(ok);
  await z2.addBuffer('x.txt', Buffer.alloc(5000, 1));
  await z2.finish();
  const [e2] = await readZipEntries(ok);
  await assert.rejects(() => extractToBuffer(ok, e2, 100), /larger than declared/);
});

// ---------------- archive / restore ----------------
async function projectWithFiles(ctx: ReturnType<typeof boot>) {
  const p = await ctx.call('POST', '/projects', { name: 'Archive me', category: 'Science', languages: ['en', 'tl'], formats: ['vertical_9x16'] });
  const id = p.json.id as string;
  const a = await ctx.call('POST', `/projects/${id}/assets/import`, { path: png, type: 'stock_photo', license: { type: 'cc0', commercial_use: 'yes' }, name: 'pic' });
  assert.equal(a.status, 201);
  const c = await ctx.call('POST', `/projects/${id}/audio/import`, { path: wav, kind: 'music', name: 'bed', license: { type: 'cc0', commercial_use: 'yes' } });
  assert.equal(c.status, 201);
  await ctx.call('PUT', `/projects/${id}/lexicon/en`, { term: 'octopus', respelling: 'OK-to-pus' });
  const research = ctx.engine.list(id, { kind: 'research' })[0];
  ctx.engine.saveVersion(research.id, { topic: 'x', note: 'v1' });
  ctx.engine.saveVersion(research.id, { topic: 'x', note: 'v2' });
  return { id, asset: a.json, clip: c.json, research };
}

test('archive: contains manifest + every project file, none from cache or other projects; checksums recorded', async () => {
  const ctx = boot();
  const other = await projectWithFiles(ctx);
  const { id } = await projectWithFiles(ctx);
  mkdirSync(join(ctx.root, 'cache'), { recursive: true });
  writeFileSync(join(ctx.root, 'cache', 'junk.mp4'), 'cache file');
  const r = await ctx.call('POST', `/projects/${id}/archive`, {});
  assert.equal(r.status, 201);
  assert.ok(existsSync(r.json.path));
  const entries = await readZipEntries(r.json.path);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('manifest.json'));
  assert.ok(names.every((n) => n === 'manifest.json' || n.startsWith(`files/projects/proj_${id}/`)), 'only this project');
  assert.ok(!names.some((n) => n.includes(other.id)));
  assert.ok(!names.some((n) => n.includes('cache')));
  assert.equal(names.filter((n) => n.startsWith('files/')).length, 2);
  const manifest = JSON.parse((await extractToBuffer(r.json.path, entries[0], 1e8)).toString());
  assert.equal(manifest.project_id, id);
  assert.equal(manifest.rows.versions.length, 2);
  assert.ok(manifest.files.every((f: any) => /^[0-9a-f]{64}$/.test(f.sha256)));
  assert.equal(manifest.rows.pronunciation_entries.length, 1);
});

test('restore: same ids into a fresh install reproduces everything, byte for byte; restoring over an existing project is refused', async () => {
  const src = boot();
  const { id, asset, research } = await projectWithFiles(src);
  const arch = (await src.call('POST', `/projects/${id}/archive`, {})).json;

  const dst = boot();
  const r = await dst.call('POST', '/archive/restore', { path: arch.path });
  assert.equal(r.status, 201);
  assert.equal(r.json.projectId, id);
  assert.equal(r.json.remapped, false);
  assert.equal(dst.engine.getProject(id).name, 'Archive me');
  assert.equal(dst.engine.list(id).length, src.engine.list(id).length);
  assert.equal(dst.engine.versions(research.id).length, 2);
  assert.equal(dst.engine.get(research.id).current_version_id, src.engine.get(research.id).current_version_id);
  const a2 = (await dst.call('GET', `/assets/${asset.id}`)).json;
  assert.equal(a2.sha256, asset.sha256);
  assert.equal(await sha256File(join(dst.root, a2.rel_path)), asset.sha256);
  assert.equal((await dst.call('GET', `/projects/${id}/lexicon/en`)).json.length, 1);
  assert.equal((await dst.call('POST', '/archive/restore', { path: arch.path })).status, 409);
  assert.deepEqual(readdirSync(join(dst.root, 'cache')).filter((f) => f.startsWith('restore_')), [], 'staging cleaned up');
});

test('restore as copy: every record gets a new id, internal references follow, original untouched', async () => {
  const ctx = boot();
  const { id, asset, research } = await projectWithFiles(ctx);
  const arts = ctx.engine.list(id).length;
  const arch = (await ctx.call('POST', `/projects/${id}/archive`, {})).json;
  const r = await ctx.call('POST', '/archive/restore', { path: arch.path, as_copy: true });
  assert.equal(r.status, 201);
  assert.notEqual(r.json.projectId, id);
  assert.equal(r.json.remapped, true);
  const nid = r.json.projectId as string;
  const copyArts = ctx.engine.list(nid);
  assert.equal(copyArts.length, arts);
  assert.ok(copyArts.every((a) => !ctx.engine.list(id).some((o) => o.id === a.id)), 'artifact ids are new');
  const [cres] = ctx.engine.list(nid, { kind: 'research' });
  assert.equal(ctx.engine.versions(cres.id).length, 2);
  assert.equal(ctx.engine.get(cres.id).current_version_id, ctx.engine.versions(cres.id)[1].id, 'current version pointer remapped');
  // dependency graph survived the remap
  const base = ctx.engine.list(nid, { kind: 'script_base' })[0];
  assert.deepEqual(ctx.engine.upstreamDirect(base.id).map((u) => u.kind), ['research']);
  const copiedAsset = (await ctx.call('GET', `/projects/${nid}/assets`)).json[0];
  assert.notEqual(copiedAsset.id, asset.id);
  assert.equal(copiedAsset.sha256, asset.sha256);
  assert.match(copiedAsset.rel_path, new RegExp(`proj_${nid}`));
  assert.ok(existsSync(join(ctx.root, copiedAsset.rel_path)));
  // original is intact
  assert.equal(ctx.engine.list(id).length, arts);
  assert.equal(ctx.engine.get(research.id).state, 'in_progress');
  assert.ok(existsSync(join(ctx.root, asset.rel_path)));
  // restoring the same archive as a copy twice is fine
  assert.equal((await ctx.call('POST', '/archive/restore', { path: arch.path, as_copy: true })).status, 201);
});

test('restore refuses tampered, unsafe and foreign archives and leaves nothing behind', async () => {
  const src = boot();
  const { id } = await projectWithFiles(src);
  const arch = (await src.call('POST', `/projects/${id}/archive`, {})).json;
  const dst = boot();
  const state = () => ({ projects: dst.engine.listProjects().length, files: existsSync(join(dst.root, 'projects')) ? readdirSync(join(dst.root, 'projects')).length : 0 });

  // 1. flip a byte inside a stored (PNG) file: zip CRC catches it
  const bytes = readFileSync(arch.path);
  const entries = await readZipEntries(arch.path);
  const e = entries.find((x) => x.name.endsWith('.png'))!;
  const tampered = join(tmp, 'tampered.zip');
  const copy = Buffer.from(bytes);
  copy[e.offset + 30 + Buffer.byteLength(e.name) + 40] ^= 0xff;
  writeFileSync(tampered, copy);
  const r1 = await dst.call('POST', '/archive/restore', { path: tampered });
  assert.equal(r1.status, 422);
  assert.match(r1.json.error.message, /integrity|checksum/);
  assert.deepEqual(state(), { projects: 0, files: 0 });

  // 2. manifest edited so a file checksum no longer matches (valid zip, wrong content)
  const manifest = JSON.parse((await extractToBuffer(arch.path, entries[0], 1e8)).toString());
  manifest.files[0].sha256 = '0'.repeat(64);
  const forged = join(tmp, 'forged.zip');
  const z = new ZipWriter(forged);
  await z.addBuffer('manifest.json', Buffer.from(JSON.stringify(manifest)));
  for (const f of entries.slice(1)) await z.addBuffer(f.name, await extractToBuffer(arch.path, f, 1e9));
  await z.finish();
  const r2 = await dst.call('POST', '/archive/restore', { path: forged });
  assert.equal(r2.status, 422);
  assert.match(r2.json.error.message, /checksum/);
  assert.deepEqual(state(), { projects: 0, files: 0 });

  // 3. path traversal (zip slip)
  const slip = JSON.parse(JSON.stringify(manifest));
  slip.files = [{ path: `projects/proj_${id}/../../../evil.txt`, bytes: 1, sha256: 'a'.repeat(64) }];
  const slipZip = join(tmp, 'slip.zip');
  const z2 = new ZipWriter(slipZip);
  await z2.addBuffer('manifest.json', Buffer.from(JSON.stringify(slip)));
  await z2.addBuffer(`files/projects/proj_${id}/../../../evil.txt`, Buffer.from('x'));
  await z2.finish();
  const r3 = await dst.call('POST', '/archive/restore', { path: slipZip });
  assert.equal(r3.status, 422);
  assert.match(r3.json.error.message, /Unsafe path/);
  assert.ok(!existsSync(join(dst.root, 'evil.txt')) && !existsSync(join(dirname(dst.root), 'evil.txt')));

  // 4. not our archive / newer schema / no manifest
  const foreign = join(tmp, 'foreign.zip');
  const z3 = new ZipWriter(foreign);
  await z3.addBuffer('manifest.json', Buffer.from(JSON.stringify({ app: 'other', format: 1 })));
  await z3.finish();
  assert.equal((await dst.call('POST', '/archive/restore', { path: foreign })).status, 422);
  const newer = join(tmp, 'newer.zip');
  const z4 = new ZipWriter(newer);
  await z4.addBuffer('manifest.json', Buffer.from(JSON.stringify({ ...manifest, schema: 999 })));
  await z4.finish();
  assert.match((await dst.call('POST', '/archive/restore', { path: newer })).json.error.message, /newer app version/);
  const empty = join(tmp, 'empty.zip');
  const z5 = new ZipWriter(empty);
  await z5.addBuffer('readme.txt', Buffer.from('hi'));
  await z5.finish();
  assert.match((await dst.call('POST', '/archive/restore', { path: empty })).json.error.message, /no manifest/);
  assert.equal((await dst.call('POST', '/archive/restore', { path: join(tmp, 'nope.zip') })).status >= 400, true);
  assert.deepEqual(state(), { projects: 0, files: 0 });
});

// ---------------- jobs ----------------
function jobsFixture(handlers: Record<string, any>) {
  const engine = new Engine(openDb());
  const projectId = engine.createProject('J', ['en']);
  return { engine, projectId, runner: new JobRunner(engine, handlers) };
}

test('jobs reject cross-project targets and prototype handler names', async () => {
  const { engine, projectId, runner } = jobsFixture({ render_composition: async () => ({}) });
  const other = engine.createProject('Other', ['en']);
  const target = engine.createArtifact({ projectId: other, kind: 'composition', label: 'Other composition' });
  const own = engine.createArtifact({ projectId, kind: 'composition', label: 'Own composition' });
  assert.throws(() => runner.enqueue('render_composition', { projectId, params: { compositionId: target } }), /does not belong/);
  assert.throws(() => runner.enqueue('render_composition', { projectId, artifactId: target, params: { compositionId: own } }), /does not belong/);
  assert.throws(() => runner.enqueue('toString', { projectId }), /Unknown job kind/);
  assert.equal(runner.list(projectId).length, 0);
  const job = runner.enqueue('render_composition', { projectId, artifactId: own, params: { compositionId: own } });
  await runner.idle();
  assert.equal(runner.get(job.id).state, 'succeeded');
});

test('jobs: run in order one at a time, report progress and results, and log', async () => {
  const order: string[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const { runner, projectId } = jobsFixture({
    work: async (ctx: any) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push(ctx.params.n);
      ctx.progress(0.5, 'halfway');
      ctx.log('did a thing');
      await new Promise((r) => setTimeout(r, 15));
      concurrent--;
      return { n: ctx.params.n };
    },
  });
  const jobs = [1, 2, 3].map((n) => runner.enqueue('work', { projectId, params: { n } }));
  await runner.idle();
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(maxConcurrent, 1);
  const done = runner.get(jobs[0].id);
  assert.equal(done.state, 'succeeded');
  assert.equal(done.progress, 1);
  assert.deepEqual(done.result, { n: 1 });
  assert.equal(done.attempts, 1);
  assert.ok(done.log.some((l) => l.msg === 'did a thing'));
  assert.ok(done.started_at && done.finished_at);
  assert.throws(() => runner.enqueue('nope', { projectId }), /Unknown job kind/);
});

test('jobs: failures carry code, message and a recovery hint; only that job fails; retry re-runs with the same params', async () => {
  let calls = 0;
  const { runner, projectId } = jobsFixture({
    flaky: async (ctx: any) => {
      calls++;
      if (calls === 1) {
        const { EngineError } = await import('../src/engine.ts');
        throw new EngineError('RENDER_INPUT', 'asset missing', ['a.png']);
      }
      return { ok: ctx.params.x };
    },
    boom: async () => {
      throw new Error('kaboom');
    },
  });
  const a = runner.enqueue('flaky', { projectId, params: { x: 7 } });
  const b = runner.enqueue('boom', { projectId });
  const c = runner.enqueue('flaky', { projectId, params: { x: 8 } });
  await runner.idle();
  const fa = runner.get(a.id);
  assert.equal(fa.state, 'failed');
  assert.equal(fa.error!.code, 'RENDER_INPUT');
  assert.match(fa.error!.recovery!, /missing/);
  assert.deepEqual(fa.error!.details, ['a.png']);
  assert.ok(fa.log.some((l) => l.level === 'error'));
  assert.equal(runner.get(b.id).error!.code, 'INTERNAL');
  assert.equal(runner.get(c.id).state, 'succeeded', 'a failure does not stop later jobs');
  const retried = runner.retry(a.id);
  assert.equal(retried.retry_of, a.id);
  assert.deepEqual(retried.params, { x: 7 });
  await runner.idle();
  assert.equal(runner.get(retried.id).state, 'succeeded');
  assert.throws(() => runner.retry(c.id), /Only failed or cancelled/);
});

test('jobs: cancel works for queued and running jobs, and cancelled jobs can be retried', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { runner, projectId } = jobsFixture({
    slow: async (ctx: any) => {
      await new Promise<void>((res, rej) => {
        ctx.signal.addEventListener('abort', () => rej(new Error('aborted')));
        gate.then(res);
      });
      return 'finished';
    },
    quick: async () => 'q',
  });
  const running = runner.enqueue('slow', { projectId });
  const queued = runner.enqueue('quick', { projectId });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runner.get(running.id).state, 'running');
  assert.equal(runner.cancel(queued.id).state, 'cancelled');
  runner.cancel(running.id);
  await runner.idle();
  assert.equal(runner.get(running.id).state, 'cancelled');
  assert.equal(runner.get(queued.id).state, 'cancelled');
  assert.throws(() => runner.cancel(running.id), /already cancelled/);
  release();
  const again = runner.retry(queued.id);
  await runner.idle();
  assert.equal(runner.get(again.id).state, 'succeeded');
});

test('jobs: a job left running by a crash is marked interrupted on restart, never reported as done', async () => {
  const engine = new Engine(openDb());
  const projectId = engine.createProject('J', ['en']);
  engine.db.prepare("INSERT INTO jobs (id, project_id, kind, state, created_at, updated_at) VALUES ('J1', ?, 'work', 'running', 'x', 'x')").run(projectId);
  engine.db.prepare("INSERT INTO jobs (id, project_id, kind, state, created_at, updated_at) VALUES ('J2', ?, 'work', 'queued', 'x', 'x')").run(projectId);
  const runner = new JobRunner(engine, { work: async () => 'ok' });
  await runner.idle();
  assert.equal(runner.get('J1').state, 'failed');
  assert.equal(runner.get('J1').error!.code, 'INTERRUPTED');
  assert.equal(runner.get('J2').state, 'succeeded', 'queued work resumes after restart');
});

// ---------------- cache ----------------
test('cache: stats, prune by age and size, abandoned temp files; never touches anything outside cache/', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wander-cache-'));
  const cfg = resolveConfig({ root });
  const cache = new CacheService(cfg);
  const mk = (sub: string, name: string, bytes: number, ageDays: number) => {
    const d = join(root, 'cache', sub);
    mkdirSync(d, { recursive: true });
    const p = join(d, name);
    writeFileSync(p, Buffer.alloc(bytes, 1));
    const t = new Date(Date.now() - ageDays * 86_400_000);
    utimesSync(p, t, t);
    return p;
  };
  const old = mk('scene_clips', 'old.mp4', 1000, 30);
  const mid = mk('scene_clips', 'mid.mp4', 1000, 5);
  const fresh = mk('mix', 'fresh.wav', 1000, 0);
  const tmpOld = mk('scene_clips', 'x.1.tmp.mp4', 500, 1);
  const tmpNew = mk('scene_clips', 'y.2.tmp.mp4', 500, 0);
  mkdirSync(join(root, 'projects'), { recursive: true });
  const precious = join(root, 'projects', 'asset.png');
  writeFileSync(precious, 'precious');

  assert.equal((await cache.stats()).total_bytes, 4000);
  const r1 = await cache.prune({ olderThanDays: 20 });
  assert.equal(r1.removed_files, 2); // old.mp4 + the day-old abandoned tmp
  assert.ok(!existsSync(old) && !existsSync(tmpOld) && existsSync(mid) && existsSync(tmpNew));
  const r2 = await cache.prune({ maxBytes: 1500 });
  assert.ok(r2.freed_bytes >= 1000);
  assert.ok(!existsSync(mid), 'oldest removed first');
  assert.ok(existsSync(fresh) || existsSync(tmpNew));
  assert.equal(readFileSync(precious, 'utf8'), 'precious');
  assert.deepEqual(await cache.prune({}), { removed_files: 0, freed_bytes: 0 });
  rmSync(root, { recursive: true, force: true });
});

// ---------------- preflight ----------------
test('preflight: real environment passes; an impossible disk requirement is reported with a fix; requireHealthy throws PREFLIGHT', async () => {
  const cfg = resolveConfig({ root: mkdtempSync(join(tmpdir(), 'wander-pf-')) });
  const ok = await runPreflight(cfg);
  assert.equal(ok.ok, true, JSON.stringify(ok.checks.filter((c) => !c.ok)));
  for (const n of ['FFmpeg', 'ffprobe', 'FFmpeg filters', 'Encoders (H.264 + AAC)', 'Disk space', 'Memory']) assert.ok(ok.checks.find((c) => c.name === n)?.ok, n);
  const huge = await runPreflight(cfg, { needBytes: 1e18 });
  assert.equal(huge.ok, false);
  const disk = huge.checks.find((c) => c.name === 'Disk space')!;
  assert.match(disk.fix!, /prune/);
  await assert.rejects(() => requireHealthy(cfg, { needBytes: 1e18 }), (e: any) => e.code === 'PREFLIGHT' && /Disk space/.test(e.message));
  const noFfmpeg = await runPreflight(resolveConfig({ root: cfg.root, ffprobePath: '/nonexistent/ffprobe' }));
  assert.equal(noFfmpeg.ok, false);
  assert.match(noFfmpeg.checks.find((c) => c.name === 'ffprobe')!.detail, /not found/);
  const badFont = await runPreflight(cfg, { fontsOk: () => ({ ok: false, detail: 'missing' }) });
  assert.equal(badFont.ok, false);
});

// ---------------- templates ----------------
test('templates: built-ins exist and are protected; custom ones are validated; outline and style templates apply', async () => {
  const ctx = boot();
  const list = (await ctx.call('GET', '/templates')).json as any[];
  assert.ok(list.filter((t) => t.kind === 'caption_style' && t.builtin).length >= 3);
  assert.ok(list.filter((t) => t.kind === 'script_outline' && t.builtin).length >= 3);
  const builtin = list.find((t) => t.builtin)!;
  assert.equal((await ctx.call('DELETE', `/templates/${builtin.id}`)).status, 409);
  assert.equal((await ctx.call('POST', '/templates', { kind: 'caption_style', name: 'Bad', content: { ...DEFAULT_STYLE, color: 'red' } })).status, 422);
  assert.equal((await ctx.call('POST', '/templates', { kind: 'script_outline', name: 'Bad', content: { sections: [{ kind: 'nonsense' }] } })).status, 422);
  const mine = await ctx.call('POST', '/templates', { kind: 'caption_style', name: 'Mine', content: { ...DEFAULT_STYLE, color: '#00FF00' } });
  assert.equal(mine.status, 201);
  assert.equal((await ctx.call('POST', '/templates', { kind: 'caption_style', name: 'Mine', content: DEFAULT_STYLE })).status, 422, 'duplicate name');
  assert.equal((await ctx.call('DELETE', `/templates/${mine.json.id}`)).status, 200);

  const p = await ctx.call('POST', '/projects', { name: 'T', languages: ['en'], formats: ['vertical_9x16'] });
  const base = ctx.engine.list(p.json.id, { kind: 'script_base' })[0];
  const outline = list.find((t) => t.name === 'Three surprising facts')!;
  const applied = await ctx.call('POST', `/artifacts/${base.id}/apply-script-outline`, { template_id: outline.id, title: 'Facts', lang: 'en', preset: 'short_lt30' });
  assert.equal(applied.status, 200);
  const content = (await ctx.call('GET', `/artifacts/${base.id}`)).json.content;
  assert.deepEqual(content.sections.map((s: any) => s.kind), ['hook', 'main', 'main', 'main', 'cta']);
  assert.ok(content.sections.every((s: any) => s.text === '' && s.delivery_note));
  assert.equal((await ctx.call('POST', `/artifacts/${base.id}/apply-script-outline`, { template_id: outline.id })).status, 422, 'cannot overwrite existing script');

  const cap = ctx.engine.list(p.json.id, { kind: 'caption', lang_code: 'en' })[0];
  const pill = list.find((t) => t.name === 'Clean Pill')!;
  assert.equal((await ctx.call('POST', `/artifacts/${cap.id}/apply-caption-style`, { template_id: pill.id })).status, 409, 'needs a track first');
  const track = { lang: 'en', method: 'manual', confidence: 'high', audio_ref: [], duration: 5, words: [{ text: 'Hi', start: 0, end: 1, section_id: 'h' }], style: DEFAULT_STYLE };
  assert.equal((await ctx.call('PUT', `/artifacts/${cap.id}/content`, { content: track })).status, 200);
  assert.equal((await ctx.call('POST', `/artifacts/${cap.id}/apply-caption-style`, { template_id: pill.id })).status, 200);
  const styled = (await ctx.call('GET', `/artifacts/${cap.id}`)).json.content;
  assert.equal(styled.style.pill.enabled, true);
  assert.equal(styled.words.length, 1, 'words untouched by a style change');
  assert.equal((await ctx.call('POST', `/artifacts/${cap.id}/apply-caption-style`, { template_id: outline.id })).status, 422);
});

// ---------------- image-to-video fallback ----------------
test('motion prompts map to camera moves; still-motion makes a verified, pending video asset that inherits the license', async () => {
  assert.deepEqual(parseMotionPrompt('slow zoom in'), { movement: 'zoom', direction: 'in', intensity: 'subtle' });
  assert.equal(parseMotionPrompt('zooming out dramatically').intensity, 'strong');
  assert.equal(parseMotionPrompt('pan to the left').direction, 'right_to_left');
  assert.equal(parseMotionPrompt('pan right').direction, 'left_to_right');
  assert.equal(parseMotionPrompt('keep it still').movement, 'static');
  assert.equal(parseMotionPrompt('something vague').movement, 'ken_burns');

  const ctx = boot();
  const p = await ctx.call('POST', '/projects', { name: 'M', languages: ['en'], formats: ['vertical_9x16'] });
  const id = p.json.id as string;
  const list = (await ctx.call('GET', '/providers/image-to-video')).json as any[];
  assert.equal(list[0].id, 'still-motion');
  assert.equal(list[0].requirements.gpu, false);
  assert.equal(list[0].requirements.downloadsModel, false);
  const src = (await ctx.call('POST', `/projects/${id}/assets/import`, { path: png, type: 'stock_photo', license: { type: 'cc-by', commercial_use: 'yes', attribution_text: 'by Me' } })).json;
  const r = await ctx.call('POST', `/projects/${id}/assets/motion-clip`, { asset_id: src.id, motion_prompt: 'slow zoom in', seconds: 2, width: 640, height: 360, fps: 24 });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.media_kind, 'video');
  assert.equal(r.json.provider, 'still-motion');
  assert.equal(r.json.approval_status, 'pending');
  assert.equal(r.json.width, 640);
  assert.ok(Math.abs(r.json.duration_seconds - 2) < 0.2);
  assert.equal(r.json.license.type, 'cc-by');
  assert.match(r.json.license.notes, /Derived from asset/);
  assert.equal(r.json.params.source_asset_id, src.id);
  assert.equal((await ctx.call('POST', `/projects/${id}/assets/motion-clip`, { asset_id: r.json.id, motion_prompt: 'zoom', seconds: 2 })).status, 422, 'source must be a still');
  assert.equal((await ctx.call('POST', `/projects/${id}/assets/motion-clip`, { asset_id: src.id, motion_prompt: 'zoom', seconds: 99 })).status, 422);
  assert.equal((await ctx.call('POST', `/projects/${id}/assets/motion-clip`, { asset_id: src.id, motion_prompt: 'zoom', seconds: 2, provider: 'comfyui' })).status, 404);
  assert.deepEqual(readdirSync(join(ctx.root, 'cache')).filter((f) => f.startsWith('motion_')), []);
});

// ---------------- publishing kit ----------------
const SECTIONS = [
  { id: 'h', kind: 'hook', text: 'Did you know octopuses have three hearts? It is true.' },
  { id: 'i', kind: 'intro', text: 'Octopuses are strange animals.' },
  { id: 'm', kind: 'main', text: 'Two hearts pump blood to the gills. The third serves the rest of the body.' },
  { id: 'p', kind: 'payoff', text: 'That is why they tire when swimming.' },
  { id: 'c', kind: 'cta', text: 'Follow for more.' },
];

test('kit: shorts get hashtags/#Shorts and no chapters; titles respect length; only script facts are used', () => {
  const k = generateKit({ lang: 'en', projectName: 'Octopus facts', topic: 'Octopus hearts', category: 'Interesting Facts', sections: SECTIONS, isShort: true, durationSeconds: 21.4, credits: ['"Pic" by Me, CC BY 4.0'] });
  assert.ok(k.title_options.length >= 2);
  assert.ok(k.title_options.every((t) => t.length <= 70));
  assert.equal(k.title_options[0], 'Did you know octopuses have three hearts?');
  assert.ok(k.title_options.some((t) => /in 21 seconds/.test(t)));
  assert.ok(k.hashtags.includes('#Shorts'));
  assert.deepEqual(k.chapters, []);
  assert.match(k.description, /Credits:\n- "Pic" by Me, CC BY 4.0/);
  assert.match(k.description, /Follow for more\./);
  assert.ok(k.tags.includes('octopus hearts') && k.tags.includes('octopus'));
  assert.ok(k.tags.every((t) => t.length <= 30));
  assert.equal(k.generated_by, 'template');
  assert.ok(k.thumbnail_hooks[0].length <= 28 && k.thumbnail_hooks[0] === k.thumbnail_hooks[0].toUpperCase());
  assert.doesNotThrow(() => validateKit(k));
  assert.ok(k.notes.some((n) => /template drafts/.test(n)));
});

test('kit: long-form chapters need 3+ sections at least 10s apart starting at 0:00; Tagalog/Taglish prompts are flagged for native review', () => {
  const starts = [{ id: 'h', start: 0.2 }, { id: 'i', start: 12 }, { id: 'm', start: 30 }, { id: 'p', start: 33 }, { id: 'c', start: 58 }];
  const k = generateKit({ lang: 'taglish', projectName: 'P', topic: 'Octopus', sections: SECTIONS, isShort: false, durationSeconds: 70, sectionStarts: starts });
  assert.deepEqual(k.chapters.map((c) => c.t), [0, 12, 30, 58], 'the 33s section is under 10s after the previous one and is dropped');
  assert.equal(k.chapters[0].label, 'Intro');
  assert.match(formatChapters(k.chapters), /^0:00 Intro\n0:12 /);
  assert.match(k.description, /Chapters:\n0:00 Intro/);
  assert.ok(k.pinned_comment_ideas[0].includes("surprising"));
  assert.ok(k.notes.some((n) => /native speaker/.test(n)));
  assert.ok(!k.hashtags.includes('#Shorts'));
  const few = generateKit({ lang: 'en', projectName: 'P', topic: 'T', sections: SECTIONS, isShort: false, durationSeconds: 70, sectionStarts: starts.slice(0, 2) });
  assert.deepEqual(few.chapters, []);
  assert.ok(few.notes.some((n) => /Not enough separated sections/.test(n)));
});

test("kit validation enforces YouTube's limits", () => {
  const ok = generateKit({ lang: 'en', projectName: 'P', topic: 'T', sections: SECTIONS, isShort: true, durationSeconds: 20 });
  const bad = (patch: object) => () => validateKit({ ...ok, ...patch });
  assert.throws(bad({ title_options: ['x'.repeat(101)] }), /1-100/);
  assert.throws(bad({ description: 'x'.repeat(5001) }), /5000/);
  assert.throws(bad({ tags: ['x'.repeat(31)] }), /30 characters/);
  assert.throws(bad({ tags: Array.from({ length: 60 }, (_, i) => `tag-number-${i}`) }), /500/);
  assert.throws(bad({ hashtags: Array.from({ length: 16 }, (_, i) => `#t${i}`) }), /15 hashtags/);
  assert.throws(bad({ hashtags: ['nohash'] }), /#Word/);
  assert.throws(bad({ chapters: [{ t: 5, label: 'a' }, { t: 20, label: 'b' }, { t: 40, label: 'c' }] }), /3 entries.*0:00/);
  assert.throws(bad({ chapters: [{ t: 0, label: 'a' }, { t: 5, label: 'b' }, { t: 40, label: 'c' }] }), /10 seconds/);
  assert.throws(bad({ generated_by: 'ai' }), /generated_by/);
  assert.doesNotThrow(bad({ chapters: [{ t: 0, label: 'a' }, { t: 15, label: 'b' }, { t: 40, label: 'c' }] }));
  const prompt = buildKitPrompt({ lang: 'tl', languageName: 'Tagalog', projectName: 'P', topic: 'Octopus', category: 'Science', sections: SECTIONS, isShort: true, durationSeconds: 20 });
  assert.match(prompt, /Tagalog/);
  assert.match(prompt, /do not add claims/);
  assert.match(prompt, /Natural conversational Filipino/);
  assert.match(prompt, /"id"|"kind": "hook"/);
});

// ---------------- thumbnails and manifest over the API ----------------
test('thumbnail: crops around the focal point to the requested size, burns in text, verifies output, rejects bad input', async () => {
  const ctx = boot();
  const p = await ctx.call('POST', '/projects', { name: 'Th', languages: ['en'], formats: ['vertical_9x16'] });
  const id = p.json.id as string;
  const a = (await ctx.call('POST', `/projects/${id}/assets/import`, { path: png, type: 'stock_photo', license: { type: 'own', commercial_use: 'yes' } })).json;
  const plain = await ctx.call('POST', `/projects/${id}/thumbnails`, { lang: 'en', asset_id: a.id });
  assert.equal(plain.status, 201);
  assert.deepEqual([plain.json.width, plain.json.height], [1280, 720]);
  const withText = await ctx.call('POST', `/projects/${id}/thumbnails`, { lang: 'en', asset_id: a.id, text: 'Three hearts?!' });
  assert.equal(withText.status, 201);
  assert.notEqual(withText.json.sha256, plain.json.sha256);
  const pr = JSON.parse(execFileSync(ffprobeBinary(), ['-v', 'error', '-print_format', 'json', '-show_streams', join(ctx.root, withText.json.rel_path)]).toString());
  assert.deepEqual([pr.streams[0].width, pr.streams[0].height, pr.streams[0].codec_name], [1280, 720, 'mjpeg']);
  assert.match(withText.json.rel_path, /assets\/thumbnails\/.+\.jpg$/);
  const tall = await ctx.call('POST', `/projects/${id}/thumbnails`, { lang: 'en', asset_id: a.id, size: '1080x1920' });
  assert.deepEqual([tall.json.width, tall.json.height], [1080, 1920]);
  const served = await ctx.call('GET', `/thumbnails/${withText.json.id}/file`);
  assert.equal(served.status, 200);
  assert.equal(served.raw.length, withText.json.bytes);
  assert.equal((await ctx.call('GET', `/projects/${id}/thumbnails?lang=en`)).json.length, 3);
  for (const [label, body] of [['no source', { lang: 'en' }], ['odd size', { lang: 'en', asset_id: a.id, size: '1281x720' }], ['tiny', { lang: 'en', asset_id: a.id, size: '100x100' }], ['long text', { lang: 'en', asset_id: a.id, text: 'x'.repeat(61) }], ['bad lang', { lang: 'xx', asset_id: a.id }]] as const) {
    assert.equal((await ctx.call('POST', `/projects/${id}/thumbnails`, body)).status, 422, label);
  }
  assert.equal((await ctx.call('GET', `/projects/${id}/thumbnails`)).json.length, 3, 'failed attempts left no records');
  assert.equal(readdirSync(join(ctx.root, 'projects', `proj_${id}`, 'assets', 'thumbnails')).length, 3, 'and no files');
});

test('license manifest: lists what the project actually uses, attributions, and warns about unknown/NC/ND/TTS/font issues', async () => {
  const ctx = boot();
  const p = await ctx.call('POST', '/projects', { name: 'Lic', languages: ['en'], formats: ['vertical_9x16'] });
  const id = p.json.id as string;
  const cc = (await ctx.call('POST', `/projects/${id}/assets/import`, { path: png, type: 'stock_photo', license: { type: 'cc-by-nd', commercial_use: 'yes', derivatives_allowed: false, attribution_text: '"Pic" by A, CC BY-ND 4.0' } })).json;
  const unused = (await ctx.call('POST', `/projects/${id}/assets/import`, { path: png2, type: 'stock_photo', license: { type: 'unknown', commercial_use: 'unknown' } })).json;
  const scene = ctx.engine.createArtifact({ projectId: id, kind: 'scene_asset', label: 'Scene one', sceneId: 'S1' });
  ctx.engine.saveVersion(scene, { assets: [{ asset_id: cc.id }], primary_asset_id: cc.id });
  const clip = (await ctx.call('POST', `/projects/${id}/audio/import`, { path: wav, kind: 'music', name: 'bed', license: { type: 'cc-by-nc', commercial_use: 'no', attribution_text: 'Music by B' } })).json;
  const audio = ctx.engine.list(id, { kind: 'audio', lang_code: 'en' })[0];
  ctx.engine.saveVersion(audio.id, { chunks: [], mix: { music: [{ clip_id: clip.id }] } });
  const m = (await ctx.call('GET', `/projects/${id}/license-manifest`)).json;
  assert.deepEqual(m.items.map((i: any) => i.kind).sort(), ['music', 'visual']);
  assert.ok(!m.items.some((i: any) => i.id === unused.id), 'unused assets are not listed');
  assert.equal(m.items.find((i: any) => i.kind === 'visual').used_in[0], 'Scene one');
  assert.deepEqual(m.attribution_lines.sort(), ['"Pic" by A, CC BY-ND 4.0', 'Music by B']);
  assert.ok(m.warnings.some((w: string) => /No-derivatives/.test(w)));
  assert.ok(m.warnings.some((w: string) => /Non-commercial/.test(w)));
  assert.match(m.credits_text, /- Music by B/);
  assert.match(m.credits_text, /! .*Non-commercial/);
  assert.equal(m.items.some((i: any) => i.kind === 'font'), false);
});
