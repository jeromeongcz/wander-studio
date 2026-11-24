import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { buildApi } from '../src/api.ts';
import { ffprobeBinary } from '../src/media.ts';
import { newResearchContent } from '../src/studios/research.ts';
import { mapOpenverseLicense } from '../src/providers/openverse.ts';

const FFMPEG = join(dirname(ffprobeBinary()), 'ffmpeg');
let tmp: string;
let files: { png: string; png2: string; jpg: string; mp4: string; fake: string; txt: string };

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wander-assets-'));
  const f = (name: string) => join(tmp, name);
  const run = (args: string[]) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...args]);
  run(['-f', 'lavfi', '-i', 'color=c=red:s=64x36', '-frames:v', '1', f('a.png')]);
  run(['-f', 'lavfi', '-i', 'color=c=blue:s=64x36', '-frames:v', '1', f('b.png')]);
  run(['-f', 'lavfi', '-i', 'color=c=green:s=36x64', '-frames:v', '1', f('c.jpg')]);
  run(['-f', 'lavfi', '-i', 'testsrc=s=64x36:d=1:r=10', '-pix_fmt', 'yuv420p', f('v.mp4')]);
  writeFileSync(f('fake.png'), 'this is not an image');
  writeFileSync(f('notes.txt'), 'hello');
  files = { png: f('a.png'), png2: f('b.png'), jpg: f('c.jpg'), mp4: f('v.mp4'), fake: f('fake.png'), txt: f('notes.txt') };
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const OWN = { type: 'own', commercial_use: 'yes' };

function boot(fetchFn?: typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), 'wander-root-'));
  const engine = new Engine(openDb());
  const app = buildApi(engine, { root, fetchFn, maxRemoteBytes: 1024 * 1024 });
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, payload: payload as any });
    let json: any = null;
    try {
      json = r.body ? JSON.parse(r.body) : null;
    } catch {
      /* binary body */
    }
    return { status: r.statusCode, json, raw: r.rawPayload, headers: r.headers };
  };
  return { engine, root, call };
}
type Ctx = ReturnType<typeof boot>;

const SECTIONS = [
  { id: 'h', kind: 'hook', text: 'Did you know octopuses have three hearts?' },
  { id: 'c', kind: 'cta', text: 'Follow for more.' },
];

async function project(ctx: Ctx, withStoryboard = false) {
  const p = await ctx.call('POST', '/projects', { name: 'Octopus', category: 'Science', languages: ['en'], formats: ['vertical_9x16'] });
  const id = p.json.id as string;
  const arts = (await ctx.call('GET', `/projects/${id}`)).json.artifacts as any[];
  const find = (kind: string) => arts.find((a) => a.kind === kind).id as string;
  if (withStoryboard) {
    const research = { ...newResearchContent('x'), sources: [{ id: 's1', url: 'https://example.org' }], checklist: newResearchContent('x').checklist.map((k) => ({ ...k, done: true })) };
    await ctx.call('PUT', `/artifacts/${find('research')}/content`, { content: research });
    await ctx.call('POST', `/artifacts/${find('research')}/submit`);
    await ctx.call('POST', `/artifacts/${find('research')}/approve`, {});
    await ctx.call('PUT', `/artifacts/${find('script_base')}/content`, { content: { title: 'T', lang: 'en', preset: 'short_lt30', sections: SECTIONS } });
    await ctx.call('POST', `/artifacts/${find('script_base')}/submit`);
    await ctx.call('POST', `/artifacts/${find('script_base')}/approve`, {});
    await ctx.call('POST', `/artifacts/${find('storyboard')}/seed-storyboard`, { scene_seconds: 3 });
  }
  return { id, find };
}

const importPng = (ctx: Ctx, pid: string, path = files.png, extra: object = {}) =>
  ctx.call('POST', `/projects/${pid}/assets/import`, { path, type: 'stock_photo', license: OWN, ...extra });

test('providers: registry lists documented terms; nothing requires a key; manual providers are healthy', async () => {
  const ctx = boot();
  const list = (await ctx.call('GET', '/providers')).json as any[];
  assert.deepEqual(list.map((p) => p.id).sort(), ['manual-import', 'manual-prompt', 'openverse']);
  assert.ok(list.every((p) => p.terms.requiresKey === false && p.terms.privacy && p.terms.commercialUse && p.terms.freeTier));
  assert.equal((await ctx.call('POST', '/providers/manual-import/health')).json.ok, true);
  assert.equal((await ctx.call('POST', '/providers/nope/health')).status, 404);
});

test('import: copies into the project folder, verifies with ffprobe, leaves the original alone', async () => {
  const ctx = boot();
  const { id } = await project(ctx);
  const before = readFileSync(files.png);
  const r = await importPng(ctx, id);
  assert.equal(r.status, 201);
  const a = r.json;
  assert.equal(a.width, 64);
  assert.equal(a.height, 36);
  assert.equal(a.media_kind, 'image');
  assert.ok(Math.abs(a.aspect_ratio - 64 / 36) < 1e-9);
  assert.deepEqual(a.focal, { x: 0.5, y: 0.5 });
  assert.equal(a.approval_status, 'pending');
  assert.equal(a.provider, 'manual-import');
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  assert.equal(a.rel_path, join('projects', `proj_${id}`, 'assets', 'images', `${a.id}.png`));
  assert.ok(existsSync(join(ctx.root, a.rel_path)));
  assert.deepEqual(readFileSync(files.png), before, 'source untouched');
  assert.deepEqual(readFileSync(join(ctx.root, a.rel_path)), before);
  const bytes = await ctx.call('GET', `/assets/${a.id}/file`);
  assert.equal(bytes.headers['content-type'], 'image/png');
  assert.deepEqual(bytes.raw, before);

  const jpg = await ctx.call('POST', `/projects/${id}/assets/import`, { path: files.jpg, type: 'background', license: OWN });
  assert.equal(jpg.json.height, 64); // portrait stays portrait
  const mp4 = await ctx.call('POST', `/projects/${id}/assets/import`, { path: files.mp4, type: 'stock_video', license: OWN });
  assert.equal(mp4.status, 201);
  assert.equal(mp4.json.media_kind, 'video');
  assert.ok(mp4.json.duration_seconds > 0.5 && mp4.json.duration_seconds < 2);
  assert.match(mp4.json.rel_path, /assets\/footage\//);
  const gfx = await ctx.call('POST', `/projects/${id}/assets/import`, { path: files.png2, type: 'infographic', license: OWN });
  assert.match(gfx.json.rel_path, /assets\/graphics\//);
});

test('import rejects bad inputs and leaves no stray files or rows', async () => {
  const ctx = boot();
  const { id } = await project(ctx);
  const cases: [string, object, number, RegExp?][] = [
    ['fake image', { path: files.fake }, 422, /not valid media|No decodable/],
    ['unsupported ext', { path: files.txt }, 422, /Unsupported/],
    ['missing file', { path: join(tmp, 'nope.png') }, 422, /not found/],
    ['bad type', { path: files.png, type: 'hologram' }, 422],
    ['video as image type', { path: files.mp4, type: 'ai_image' }, 422, /expects an image/],
    ['image as stock_video', { path: files.png, type: 'stock_video' }, 422],
    ['bad license', { path: files.png, license: { type: 'nonsense' } }, 422],
  ];
  for (const [label, over, status, msg] of cases) {
    const r = await ctx.call('POST', `/projects/${id}/assets/import`, { path: files.png, type: 'stock_photo', license: OWN, ...over });
    assert.equal(r.status, status, label);
    if (msg) assert.match(r.json.error.message, msg, label);
  }
  assert.equal((await ctx.call('GET', `/projects/${id}/assets`)).json.length, 0);
  const dir = join(ctx.root, 'projects', `proj_${id}`, 'assets');
  const leftovers = existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => /\.(png|jpg|mp4)$/.test(String(f))) : [];
  assert.deepEqual(leftovers, []);
});

test('duplicate files are detected per project', async () => {
  const ctx = boot();
  const { id } = await project(ctx);
  const first = await importPng(ctx, id);
  const again = await importPng(ctx, id);
  assert.equal(again.status, 409);
  assert.equal(again.json.error.details.existing_id, first.json.id);
});

test('approval: unknown license and missing attribution block it; warnings surfaced; approved can be rejected', async () => {
  const ctx = boot();
  const { id } = await project(ctx);
  const a = (await importPng(ctx, id, files.png, { license: { type: 'unknown', commercial_use: 'unknown' } })).json;
  let r = await ctx.call('POST', `/assets/${a.id}/approve`);
  assert.equal(r.status, 422);
  assert.match(r.json.error.details.join(' '), /unknown/);

  r = await ctx.call('PATCH', `/assets/${a.id}`, { license: { type: 'cc-by', commercial_use: 'yes' } });
  assert.equal(r.status, 200);
  r = await ctx.call('POST', `/assets/${a.id}/approve`);
  assert.equal(r.status, 422);
  assert.match(r.json.error.details.join(' '), /attribution/i);

  await ctx.call('PATCH', `/assets/${a.id}`, { license: { type: 'cc-by', commercial_use: 'yes', attribution_text: '"Red" by Me, CC BY' } });
  r = await ctx.call('POST', `/assets/${a.id}/approve`);
  assert.equal(r.status, 200);
  assert.equal(r.json.asset.approval_status, 'approved');
  assert.ok(r.json.warnings.some((w: string) => /Attribution/.test(w)));

  const nc = (await importPng(ctx, id, files.png2, { license: { type: 'cc-by-nc', commercial_use: 'no', attribution_text: 'x' } })).json;
  r = await ctx.call('POST', `/assets/${nc.id}/approve`);
  assert.ok(r.json.warnings.some((w: string) => /Non-commercial/.test(w)));

  assert.equal((await ctx.call('POST', `/assets/${a.id}/reject`)).json.approval_status, 'rejected');
});

test('focal point: validated, stored, and changing an approved asset needs reopen then invalidates only scenes using it', async () => {
  const ctx = boot();
  const { id } = await project(ctx, true);
  const sb = (await ctx.call('GET', `/projects/${id}`)).json.artifacts.filter((a: any) => a.kind === 'scene_asset');
  assert.ok(sb.length >= 2);
  const scenes = sb.map((s: any) => s.scene_id as string);

  const a1 = (await importPng(ctx, id, files.png)).json;
  const a2 = (await importPng(ctx, id, files.png2)).json;
  for (const a of [a1, a2]) await ctx.call('POST', `/assets/${a.id}/approve`);
  await ctx.call('PUT', `/scenes/${scenes[0]}/assets`, { assets: [{ asset_id: a1.id }], primary_asset_id: a1.id });
  await ctx.call('PUT', `/scenes/${scenes[1]}/assets`, { assets: [{ asset_id: a2.id }], primary_asset_id: a2.id });
  // approve the storyboard chain so scene assets can be approved
  const sbArt = (await ctx.call('GET', `/projects/${id}`)).json.artifacts.find((a: any) => a.kind === 'storyboard');
  await ctx.call('POST', `/artifacts/${sbArt.id}/submit`);
  await ctx.call('POST', `/artifacts/${sbArt.id}/approve`, {});
  for (const s of sb) {
    assert.equal((await ctx.call('POST', `/artifacts/${s.id}/submit`)).status, 200);
    assert.equal((await ctx.call('POST', `/artifacts/${s.id}/approve`, {})).status, 200);
  }

  let r = await ctx.call('PATCH', `/assets/${a1.id}`, { focal: { x: 1.5, y: 0.2 } });
  assert.equal(r.status, 422);
  r = await ctx.call('PATCH', `/assets/${a1.id}`, { focal: { x: 0.25, y: 0.3 } });
  assert.equal(r.status, 409, 'approved asset is protected');
  r = await ctx.call('PATCH', `/assets/${a1.id}`, { focal: { x: 0.25, y: 0.3 }, reopen: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.asset.focal, { x: 0.25, y: 0.3 });
  assert.equal(r.json.asset.approval_status, 'pending');
  assert.ok(r.json.invalidated.length >= 1);

  const states = Object.fromEntries(sb.map((s: any) => [s.scene_id, ctx.engine.get(s.id).state]));
  assert.equal(states[scenes[0]], 'needs_revision');
  assert.equal(states[scenes[1]], 'approved', 'scene using a different asset untouched');
  assert.equal(ctx.engine.get(sbArt.id).state, 'approved');

  // non-visual edits never reset approval
  r = await ctx.call('PATCH', `/assets/${a2.id}`, { name: 'Renamed', tags: ['x'] });
  assert.equal(r.json.asset.approval_status, 'approved');
});

test('scene linking: unapproved assets block review; foreign/shared assets rejected; planned-type mismatch only warns', async () => {
  const ctx = boot();
  const { id } = await project(ctx, true);
  const other = await project(ctx);
  const scene = (await ctx.call('GET', `/projects/${id}`)).json.artifacts.find((a: any) => a.kind === 'scene_asset');
  const a = (await importPng(ctx, id, files.png, { type: 'icon' })).json; // storyboard (Science, hook) planned infographic
  const foreign = (await importPng(ctx, other.id, files.png2)).json;

  assert.equal((await ctx.call('PUT', `/scenes/${scene.scene_id}/assets`, { assets: [{ asset_id: foreign.id }], primary_asset_id: foreign.id })).status, 422);
  assert.equal((await ctx.call('PUT', `/scenes/${scene.scene_id}/assets`, { assets: [{ asset_id: a.id }], primary_asset_id: 'x' })).status, 422);
  assert.equal((await ctx.call('PUT', `/scenes/${scene.scene_id}/assets`, { assets: [], primary_asset_id: '' })).status, 422);
  assert.equal((await ctx.call('PUT', `/scenes/NOPE/assets`, { assets: [{ asset_id: a.id }], primary_asset_id: a.id })).status, 404);

  assert.equal((await ctx.call('PUT', `/scenes/${scene.scene_id}/assets`, { assets: [{ asset_id: a.id }], primary_asset_id: a.id })).status, 200);
  let r = await ctx.call('POST', `/artifacts/${scene.id}/submit`);
  assert.equal(r.status, 422);
  assert.match(r.json.error.details.join(' '), /approve it first/);

  await ctx.call('POST', `/assets/${a.id}/approve`);
  r = await ctx.call('POST', `/artifacts/${scene.id}/submit`);
  assert.equal(r.status, 200);
  assert.ok(r.json.warnings.some((w: string) => /planned/.test(w)));

  // shared-scope assets cannot be linked directly
  const shared = (await ctx.call('POST', `/assets/${a.id}/promote`)).json;
  assert.equal((await ctx.call('PUT', `/scenes/${scene.scene_id}/assets`, { assets: [{ asset_id: shared.id }], primary_asset_id: shared.id, reopen: true })).status, 422);
});

test('delete is blocked while an asset is used by a scene, and removes the file otherwise', async () => {
  const ctx = boot();
  const { id } = await project(ctx, true);
  const scene = (await ctx.call('GET', `/projects/${id}`)).json.artifacts.find((a: any) => a.kind === 'scene_asset');
  const a = (await importPng(ctx, id)).json;
  const b = (await importPng(ctx, id, files.png2)).json;
  await ctx.call('PUT', `/scenes/${scene.scene_id}/assets`, { assets: [{ asset_id: a.id }], primary_asset_id: a.id });
  assert.equal((await ctx.call('GET', `/assets/${a.id}`)).json.used_by.length, 1);
  assert.equal((await ctx.call('DELETE', `/assets/${a.id}`)).status, 409);
  assert.ok(existsSync(join(ctx.root, a.rel_path)));
  assert.equal((await ctx.call('DELETE', `/assets/${b.id}`)).status, 200);
  assert.ok(!existsSync(join(ctx.root, b.rel_path)));
  assert.equal((await ctx.call('GET', `/assets/${b.id}`)).status, 404);
});

test('shared library: only approved assets are promoted; reuse copies into another project as approved with lineage', async () => {
  const ctx = boot();
  const p1 = await project(ctx);
  const p2 = await project(ctx);
  const a = (await importPng(ctx, p1.id)).json;
  assert.equal((await ctx.call('POST', `/assets/${a.id}/promote`)).status, 422);
  await ctx.call('POST', `/assets/${a.id}/approve`);
  const s = await ctx.call('POST', `/assets/${a.id}/promote`);
  assert.equal(s.status, 201);
  assert.equal(s.json.scope, 'shared');
  assert.equal(s.json.project_id, null);
  assert.equal(s.json.source_asset_id, a.id);
  assert.match(s.json.rel_path, /^shared_assets\/images\//);
  assert.ok(existsSync(join(ctx.root, s.json.rel_path)));
  assert.equal((await ctx.call('POST', `/assets/${a.id}/promote`)).status, 409, 'no duplicate shared copies');
  assert.equal((await ctx.call('GET', '/library')).json.length, 1);

  const r = await ctx.call('POST', `/projects/${p2.id}/assets/reuse`, { asset_id: s.json.id });
  assert.equal(r.status, 201);
  assert.equal(r.json.project_id, p2.id);
  assert.equal(r.json.approval_status, 'approved');
  assert.equal(r.json.source_asset_id, a.id);
  assert.equal(r.json.sha256, a.sha256);
  assert.match(r.json.rel_path, new RegExp(`proj_${p2.id}`));
  assert.ok(existsSync(join(ctx.root, r.json.rel_path)));
  assert.equal((await ctx.call('POST', `/projects/${p2.id}/assets/reuse`, { asset_id: s.json.id })).status, 409);
  assert.equal((await ctx.call('POST', `/projects/${p2.id}/assets/reuse`, { asset_id: a.id })).status, 422, 'not a shared asset');
  // the original project asset is unaffected
  assert.equal((await ctx.call('GET', `/assets/${a.id}`)).json.approval_status, 'approved');
});

test('openverse license mapping covers CC0, PDM, BY, NC and ND codes', () => {
  assert.equal(mapOpenverseLicense({ license: 'cc0' }).type, 'cc0');
  assert.equal(mapOpenverseLicense({ license: 'pdm' }).type, 'public-domain');
  const by = mapOpenverseLicense({ license: 'by', license_version: '4.0', title: 'T', creator: 'Me', foreign_landing_url: 'https://x.test/p' });
  assert.equal(by.type, 'cc-by');
  assert.equal(by.commercial_use, 'yes');
  assert.match(by.attribution_text!, /by Me is licensed under CC BY 4.0/);
  const nc = mapOpenverseLicense({ license: 'by-nc-nd' });
  assert.equal(nc.commercial_use, 'no');
  assert.equal(nc.derivatives_allowed, false);
  const weird = mapOpenverseLicense({ license: 'something-new' });
  assert.equal(weird.type, 'other');
  assert.equal(weird.commercial_use, 'unknown');
});

const RESULT_ID = '5137e260-7d40-4c67-a4d3-e6364777b58f';
function mockFetch(opts: { imageType?: string; imageBytes?: Buffer; downloadUrl?: string; redirectTo?: string; calls?: string[] } = {}): typeof fetch {
  const png = opts.imageBytes ?? readFileSync(files.png);
  return (async (input: any) => {
    const url = String(input);
    opts.calls?.push(url);
    const result = { id: RESULT_ID, title: 'Octopus Tempura', creator: 'mdid', license: 'by', license_version: '2.0', url: opts.downloadUrl ?? 'https://img.example.test/a.jpg', foreign_landing_url: 'https://www.flickr.com/photos/x/1', width: 64, height: 36, thumbnail: 'https://t.example.test/t.jpg', attribution: '"Octopus Tempura" by mdid is licensed under CC BY 2.0.' };
    if (url.startsWith('https://api.openverse.org/v1/images/?')) return new Response(JSON.stringify({ results: [result] }), { status: 200 });
    if (url.startsWith(`https://api.openverse.org/v1/images/${RESULT_ID}/`)) return new Response(JSON.stringify(result), { status: 200 });
    if (opts.redirectTo && url === 'https://img.example.test/a.jpg') return new Response(null, { status: 302, headers: { location: opts.redirectTo } });
    return new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': opts.imageType ?? 'image/png', 'content-length': String(png.length) } });
  }) as typeof fetch;
}

test('openverse search defaults to commercial+modification licenses and sends nothing but the query', async () => {
  const calls: string[] = [];
  const ctx = boot(mockFetch({ calls }));
  const r = await ctx.call('GET', '/providers/openverse/search?q=octopus');
  assert.equal(r.status, 200);
  assert.equal(r.json[0].license.type, 'cc-by');
  assert.equal(r.json[0].id, RESULT_ID);
  const u = new URL(calls[0]);
  assert.equal(u.searchParams.get('q'), 'octopus');
  assert.equal(u.searchParams.get('license_type'), 'commercial,modification');
  assert.equal(u.searchParams.get('mature'), 'false');
  await ctx.call('GET', '/providers/openverse/search?q=octopus&restricted=true');
  assert.equal(new URL(calls[1]).searchParams.has('license_type'), false);
  assert.equal((await ctx.call('GET', '/providers/openverse/search?q=')).status, 422);
  assert.equal((await ctx.call('GET', '/providers/manual-import/search?q=x')).status, 422);
});

test('remote import: downloads, verifies with ffprobe, records license/attribution; cache is cleaned', async () => {
  const ctx = boot(mockFetch());
  const { id } = await project(ctx);
  const r = await ctx.call('POST', `/projects/${id}/assets/import-remote`, { provider: 'openverse', result_id: RESULT_ID, type: 'stock_photo' });
  assert.equal(r.status, 201);
  assert.equal(r.json.provider, 'openverse');
  assert.equal(r.json.license.type, 'cc-by');
  assert.match(r.json.license.attribution_text, /CC BY 2.0/);
  assert.equal(r.json.width, 64);
  assert.equal(r.json.params.result_id, RESULT_ID);
  assert.equal(r.json.approval_status, 'pending');
  assert.equal(existsSync(join(ctx.root, 'cache')) ? readdirSync(join(ctx.root, 'cache')).length : 0, 0, 'temp download removed');
  // the license record satisfies approval (attribution present)
  assert.equal((await ctx.call('POST', `/assets/${r.json.id}/approve`)).status, 200);
});

test('remote import refuses unsafe or wrong downloads and leaves nothing behind', async () => {
  const run = async (opts: Parameters<typeof mockFetch>[0], resultId = RESULT_ID) => {
    const ctx = boot(mockFetch(opts));
    const { id } = await project(ctx);
    const r = await ctx.call('POST', `/projects/${id}/assets/import-remote`, { provider: 'openverse', result_id: resultId, type: 'stock_photo' });
    const assetsLeft = (await ctx.call('GET', `/projects/${id}/assets`)).json.length;
    const cacheLeft = existsSync(join(ctx.root, 'cache')) ? readdirSync(join(ctx.root, 'cache')).length : 0;
    assert.equal(assetsLeft, 0);
    assert.equal(cacheLeft, 0);
    return r;
  };
  assert.equal((await run({ downloadUrl: 'http://img.example.test/a.jpg' })).status, 502); // not https
  assert.equal((await run({ downloadUrl: 'https://127.0.0.1/a.jpg' })).status, 502);
  assert.equal((await run({ downloadUrl: 'https://192.168.1.5/a.jpg' })).status, 502);
  assert.equal((await run({ downloadUrl: 'https://localhost/a.jpg' })).status, 502);
  assert.equal((await run({ redirectTo: 'https://10.0.0.1/secret.png' })).status, 502); // redirect into private network
  assert.equal((await run({ imageType: 'text/html' })).status, 422);
  assert.equal((await run({ imageBytes: Buffer.alloc(2 * 1024 * 1024, 1) })).status, 422); // over the 1MB test cap
  assert.equal((await run({ imageBytes: Buffer.from('definitely not a png') })).status, 422); // header check
  assert.equal((await run({}, 'not-a-uuid')).status, 422);
  assert.equal((await run({}, '../../etc/passwd')).status, 422);
});

test('image prompt for a scene uses its storyboard description, style, and project aspect ratio', async () => {
  const ctx = boot();
  const { id } = await project(ctx, true);
  const scene = (await ctx.call('GET', `/projects/${id}`)).json.artifacts.find((a: any) => a.kind === 'scene_asset');
  const r = await ctx.call('GET', `/scenes/${scene.scene_id}/image-prompt`);
  assert.equal(r.status, 200);
  assert.equal(r.json.aspect, '9:16');
  assert.match(r.json.prompt, /octopuses/i);
  assert.match(r.json.prompt, /vertical portrait/);
  assert.match(r.json.instructions, /ai-generated/);
  assert.equal((await ctx.call('GET', `/scenes/${scene.scene_id}/image-prompt?provider=openverse`)).status, 422);
});
