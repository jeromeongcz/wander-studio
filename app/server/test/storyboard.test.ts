import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { buildApi } from '../src/api.ts';
import { newResearchContent } from '../src/studios/research.ts';
import { listCategories, profileFor, draftScenes, ASSET_TYPES, MOVEMENTS, TRANSITIONS } from '../src/studios/storyboard.ts';

function boot() {
  const engine = new Engine(openDb());
  const app = buildApi(engine);
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, payload: payload as any });
    return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : null };
  };
  return { engine, call };
}
type Ctx = ReturnType<typeof boot>;

const SECTIONS = [
  { id: 'h', kind: 'hook', text: 'Did you know that octopuses have three hearts?' },
  { id: 'm', kind: 'main', text: 'Two hearts pump blood to the gills. The third serves the rest of the body. When an octopus swims, the main heart actually stops beating. That is why they prefer to crawl.' },
  { id: 'c', kind: 'cta', text: 'Follow for more facts.' },
];

async function setup(ctx: Ctx, category = 'Science', approveBase = true) {
  const p = await ctx.call('POST', '/projects', { name: 'Octopus', category, languages: ['en', 'tl'], formats: ['vertical_9x16'] });
  const id = p.json.id as string;
  const arts = (await ctx.call('GET', `/projects/${id}`)).json.artifacts as any[];
  const find = (kind: string, lang?: string) => arts.find((a) => a.kind === kind && (!lang || a.lang_code === lang)).id as string;
  if (approveBase) {
    const research = { ...newResearchContent('Octopus'), sources: [{ id: 's1', url: 'https://example.org' }], checklist: newResearchContent('x').checklist.map((k) => ({ ...k, done: true })) };
    const rid = find('research');
    await ctx.call('PUT', `/artifacts/${rid}/content`, { content: research });
    await ctx.call('POST', `/artifacts/${rid}/submit`);
    await ctx.call('POST', `/artifacts/${rid}/approve`, {});
    const bid = find('script_base');
    await ctx.call('PUT', `/artifacts/${bid}/content`, { content: { title: 'Octopus', lang: 'en', preset: 'short_30_45', sections: SECTIONS } });
    assert.equal((await ctx.call('POST', `/artifacts/${bid}/submit`)).status, 200);
    assert.equal((await ctx.call('POST', `/artifacts/${bid}/approve`, {})).status, 200);
  }
  return { id, find, sb: find('storyboard') };
}

const sceneAssets = (ctx: Ctx, id: string) => ctx.engine.list(id, { kind: 'scene_asset' });
const getSb = async (ctx: Ctx, sb: string) => (await ctx.call('GET', `/artifacts/${sb}`)).json;

test('categories: all plan categories present, recommendations differ, unknown falls back to custom', () => {
  const names = listCategories().map((c) => c.name);
  for (const n of ['Documentary', 'History', 'Mysteries', 'Science', 'Technology', 'Education', 'Psychology', 'Motivational Stories', 'Travel', 'Nature', 'Adventure', 'Biographies', 'Fictional Storytelling', 'Interesting Facts']) {
    assert.ok(names.includes(n), n);
  }
  for (const n of ['Horror & Folklore', 'Filipino Folklore', 'Urban Legends', 'Mythology', 'True Crime', 'Space & Astronomy', 'Health & Wellness', 'Finance & Business', 'Sports', 'Food & Cooking', 'Animals & Pets', 'Gaming', 'Movies & TV', 'Music & Arts', 'Philosophy', 'How-To & Life Hacks', 'News & Current Events', 'Comedy & Skits', 'Philippine History']) {
    assert.ok(names.includes(n), n);
    assert.equal(profileFor(n).custom, false, n);
  }
  // every profile is well-formed: valid asset types, camera moves and transition
  for (const c of listCategories()) {
    assert.ok(c.profile.assets.length >= 3 && c.profile.assets.every((a) => ASSET_TYPES.includes(a)), `${c.name} assets`);
    assert.ok(c.profile.cameras.length >= 2 && c.profile.cameras.every((m) => MOVEMENTS.includes(m)), `${c.name} cameras`);
    assert.ok(TRANSITIONS.includes(c.profile.transition), `${c.name} transition`);
    assert.ok(c.profile.styles.length >= 1 && c.profile.hint.length > 5, `${c.name} text`);
  }
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, 'no duplicate names');
  assert.ok(names.length >= 50, `${names.length} categories`);
  // every category sits in a named group (none falls into the catch-all), and group names are stable
  for (const c of listCategories()) assert.notEqual(c.group, 'More', `${c.name} has no group`);
  assert.deepEqual([...new Set(listCategories().map((c) => c.group))].sort(), ['Business & news', 'Entertainment & culture', 'Knowledge & learning', 'Lifestyle', 'Nature & travel', 'Stories & spooky']);
  for (const n of ['Ghost Stories & Paranormal', 'Language Learning', 'Kids & Bedtime Stories', 'Conspiracies & Debunking', 'Anime & Comics']) assert.ok(names.includes(n), n);
  assert.ok(profileFor('history').profile.assets.includes('map'));
  assert.ok(profileFor('Science').profile.assets.includes('infographic'));
  assert.ok(profileFor('Fictional_Storytelling').profile.assets.includes('character'));
  const custom = profileFor('Cooking');
  assert.equal(custom.custom, true);
  assert.equal(custom.name, 'Cooking');
});

test('draft generator covers every section, avoids repeated camera moves, and marks scenes as drafts', () => {
  const base = { title: 'T', lang: 'en', preset: 'short_30_45' as const, sections: SECTIONS as any };
  const d = draftScenes(base, 'Nature', { samples: [], sceneSeconds: 3 });
  assert.ok(d.scenes.length >= 4, 'long main section was split');
  assert.deepEqual([...new Set(d.scenes.map((s) => s.script_segment_id))].sort(), ['c', 'h', 'm']);
  for (let i = 1; i < d.scenes.length; i++) {
    const a = d.scenes[i - 1];
    const b = d.scenes[i];
    if (a.asset_type !== 'text_overlay' && b.asset_type !== 'text_overlay') assert.notEqual(a.camera.movement, b.camera.movement);
  }
  assert.equal(d.scenes.at(-1)!.asset_type, 'text_overlay'); // CTA
  assert.ok(d.scenes.every((s) => s.draft && s.target_duration >= 1.5));
});

test('seeding needs an approved base; creates scenes, ids, scene-asset artifacts; cannot repeat', async () => {
  const ctx = boot();
  const early = await setup(ctx, 'Science', false);
  assert.equal((await ctx.call('POST', `/artifacts/${early.sb}/seed-storyboard`, {})).status, 409);

  const { id, sb } = await setup(ctx, 'History');
  // second project in same db: seed the approved one
  const projects = (await ctx.call('GET', '/projects')).json as any[];
  assert.equal(projects.length, 2);
  const r = await ctx.call('POST', `/artifacts/${sb}/seed-storyboard`, { scene_seconds: 3 });
  assert.equal(r.status, 201);
  const art = await getSb(ctx, sb);
  assert.equal(art.state, 'in_progress');
  assert.ok(art.content.scenes.length >= 4);
  assert.deepEqual(art.content.scenes.map((s: any) => s.order_index), art.content.scenes.map((_: any, i: number) => i));
  assert.ok(art.content.scenes.every((s: any) => /^[0-9A-Z]{26}$/.test(s.scene_id)));
  assert.equal(sceneAssets(ctx, id).length, art.content.scenes.length);
  assert.ok(art.content.scenes.some((s: any) => s.asset_type === 'map' || s.asset_type === 'stock_photo')); // History flavour
  // every composition depends on every scene asset
  const comp = ctx.engine.list(id, { kind: 'composition' })[0];
  assert.equal(ctx.engine.upstreamDirect(comp.id).filter((u) => u.kind === 'scene_asset').length, art.content.scenes.length);
  assert.equal((await ctx.call('POST', `/artifacts/${sb}/seed-storyboard`, {})).status, 422);
});

test('shape validation rejects bad enums, durations, duplicates', async () => {
  const ctx = boot();
  const { sb } = await setup(ctx);
  const scene = { title: 'S', script_segment_id: 'h', target_duration: 3, visual_description: 'x', asset_type: 'stock_photo', camera: { movement: 'zoom' } };
  const put = (scenes: unknown[]) => ctx.call('PUT', `/artifacts/${sb}/content`, { content: { scenes } });
  assert.equal((await put([{ ...scene, asset_type: 'hologram' }])).status, 422);
  assert.equal((await put([{ ...scene, camera: { movement: 'teleport' } }])).status, 422);
  assert.equal((await put([{ ...scene, target_duration: 0.1 }])).status, 422);
  assert.equal((await put([{ ...scene, transition_in: 'explode' }])).status, 422);
  assert.equal((await put([{ ...scene, scene_id: 'A' }, { ...scene, scene_id: 'A' }])).status, 422);
  assert.equal((await put([scene])).status, 200);
});

test('readiness: uncovered sections, unknown segments, missing visuals and the 60s limit block review; draft skeletons only warn', async () => {
  const ctx = boot();
  const { sb } = await setup(ctx);
  const mk = (over: object) => ({ title: 'S', script_segment_id: 'h', target_duration: 3, visual_description: 'a visual', asset_type: 'stock_photo', camera: { movement: 'zoom' }, ...over });
  const submit = async (scenes: unknown[]) => {
    await ctx.call('PUT', `/artifacts/${sb}/content`, { content: { scenes } });
    return ctx.call('POST', `/artifacts/${sb}/submit`);
  };
  let r = await submit([]);
  assert.equal(r.status, 422);
  r = await submit([mk({})]);
  assert.ok(r.json.error.details.some((m: string) => /No scene covers.*m, c|No scene covers/.test(m)));
  r = await submit([mk({ script_segment_id: 'zzz' }), mk({ script_segment_id: 'm' }), mk({ script_segment_id: 'c' })]);
  assert.ok(r.json.error.details.some((m: string) => /do not exist/.test(m)));
  r = await submit([mk({ visual_description: ' ' }), mk({ script_segment_id: 'm' }), mk({ script_segment_id: 'c' })]);
  assert.ok(r.json.error.details.some((m: string) => /without a visual description/.test(m)));
  r = await submit([mk({ target_duration: 50 }), mk({ script_segment_id: 'm', target_duration: 30 }), mk({ script_segment_id: 'c' })]);
  assert.ok(r.json.error.details.some((m: string) => /60s Shorts limit/.test(m)));

  r = await submit([mk({ draft: true }), mk({ script_segment_id: 'm', target_duration: 12 }), mk({ script_segment_id: 'c' })]);
  assert.equal(r.status, 200);
  assert.ok(r.json.warnings.some((w: string) => /auto-generated skeleton/.test(w)));
  assert.ok(r.json.warnings.some((w: string) => /over 8s/.test(w)));
});

test('editing the scene list syncs scene-asset artifacts; protected when approved asset work exists (and rolls back)', async () => {
  const ctx = boot();
  const { id, sb } = await setup(ctx);
  await ctx.call('POST', `/artifacts/${sb}/seed-storyboard`, { scene_seconds: 3 });
  const content = (await getSb(ctx, sb)).content;
  const n = content.scenes.length;

  // add a scene
  const added = { title: 'Extra', script_segment_id: 'c', target_duration: 2, visual_description: 'extra', asset_type: 'icon', camera: { movement: 'static' } };
  let r = await ctx.call('PUT', `/artifacts/${sb}/content`, { content: { ...content, scenes: [...content.scenes, added] } });
  assert.equal(r.status, 200);
  assert.equal(sceneAssets(ctx, id).length, n + 1);

  // remove it again (never approved): artifact deleted
  const after = (await getSb(ctx, sb)).content;
  r = await ctx.call('PUT', `/artifacts/${sb}/content`, { content: { ...after, scenes: after.scenes.slice(0, n) } });
  assert.equal(r.status, 200);
  assert.equal(sceneAssets(ctx, id).length, n);

  // give the first scene an approved asset, then try to drop that scene
  const first = after.scenes[0];
  const asset = sceneAssets(ctx, id).find((x) => x.scene_id === first.scene_id)!;
  ctx.engine.saveVersion(asset.id, { file: 'a.png' });
  ctx.engine.submitForReview(asset.id);
  await ctx.call('POST', `/artifacts/${sb}/submit`).then(() => ctx.call('POST', `/artifacts/${sb}/approve`, {})); // storyboard must be approved first
  ctx.engine.approve(asset.id, { actor: 'user' });
  const before = await getSb(ctx, sb);
  r = await ctx.call('PUT', `/artifacts/${sb}/content`, { content: { ...before.content, scenes: before.content.scenes.slice(1) }, reopen: true });
  assert.equal(r.status, 409);
  assert.equal(sceneAssets(ctx, id).length, n, 'nothing deleted');
  const unchanged = await getSb(ctx, sb);
  assert.equal(unchanged.current_version_id, before.current_version_id, 'storyboard version not created');
  assert.equal(unchanged.state, 'approved', 'rolled back: still approved');
});

test('editing an approved storyboard needs reopen and invalidates only its downstream', async () => {
  const ctx = boot();
  const { id, sb, find } = await setup(ctx);
  await ctx.call('POST', `/artifacts/${sb}/seed-storyboard`, { scene_seconds: 3 });
  await ctx.call('POST', `/artifacts/${sb}/submit`);
  assert.equal((await ctx.call('POST', `/artifacts/${sb}/approve`, {})).status, 200);
  const content = (await getSb(ctx, sb)).content;
  content.scenes[0].visual_description = 'new idea';
  content.scenes[0].draft = false;

  assert.equal((await ctx.call('PUT', `/artifacts/${sb}/content`, { content })).status, 409);
  assert.equal((await ctx.call('PUT', `/artifacts/${sb}/content`, { content, reopen: true })).status, 200);
  assert.equal(ctx.engine.get(find('script_base')).state, 'approved');
  assert.equal(ctx.engine.get(find('research')).state, 'approved');
  assert.equal(ctx.engine.get(sb).state, 'in_progress');
  void id;
});

test('timeline: audio-anchored durations override estimates per language without invalidating the storyboard', async () => {
  const ctx = boot();
  const { sb } = await setup(ctx);
  await ctx.call('POST', `/artifacts/${sb}/seed-storyboard`, { scene_seconds: 3 });
  await ctx.call('POST', `/artifacts/${sb}/submit`);
  await ctx.call('POST', `/artifacts/${sb}/approve`, {});
  const scenes = (await getSb(ctx, sb)).content.scenes;

  let tl = (await ctx.call('GET', `/artifacts/${sb}/timeline/tl`)).json;
  assert.equal(tl.fully_anchored, false);
  assert.ok(tl.scenes.every((s: any) => s.source === 'estimate'));

  assert.equal((await ctx.call('PUT', `/scenes/${scenes[0].scene_id}/timing/tl`, { audio_seconds: 4.2 })).status, 200);
  tl = (await ctx.call('GET', `/artifacts/${sb}/timeline/tl`)).json;
  assert.equal(tl.scenes[0].seconds, 4.2);
  assert.equal(tl.scenes[0].source, 'audio');
  const en = (await ctx.call('GET', `/artifacts/${sb}/timeline/en`)).json;
  assert.equal(en.scenes[0].source, 'estimate', 'other languages unaffected');

  assert.equal(ctx.engine.get(sb).state, 'approved', 'storyboard stays approved');
  assert.equal((await ctx.call('PUT', `/scenes/${scenes[0].scene_id}/timing/tl`, { audio_seconds: -1 })).status, 422);
  assert.equal((await ctx.call('PUT', `/scenes/NOPE/timing/tl`, { audio_seconds: 2 })).status, 404);
});

test('storyboard prompt includes enums, category guidance and the script', async () => {
  const ctx = boot();
  const { sb } = await setup(ctx, 'Fictional Storytelling');
  const p = (await ctx.call('GET', `/artifacts/${sb}/storyboard-prompt`)).json.prompt as string;
  assert.match(p, /ken_burns/);
  assert.match(p, /motion_graphic/);
  assert.match(p, /character sheet/i);
  assert.match(p, /"id": "m"/);
  assert.match(p, /9:16/);
  const recs = await ctx.call('GET', '/categories/Mysteries/recommendations');
  assert.equal(recs.json.custom, false);
});
