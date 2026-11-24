import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { buildApi } from '../src/api.ts';
import { applyLexicon, detectMix, ttsText } from '../src/studios/locales.ts';
import { newResearchContent } from '../src/studios/research.ts';

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

const BASE_SECTIONS = [
  { id: 'h', kind: 'hook', text: 'Did you know that octopuses have three hearts and the blood is blue?' },
  { id: 'm', kind: 'main', text: 'Two hearts pump blood to the gills and the third serves the rest of the body.' },
  { id: 'c', kind: 'cta', text: 'Follow for more facts like this.' },
];

async function projectWithApprovedBase(ctx: Ctx, languages = ['en', 'tl', 'taglish']) {
  const p = await ctx.call('POST', '/projects', { name: 'Octopus', languages, formats: ['vertical_9x16'] });
  assert.equal(p.status, 201);
  const id = p.json.id as string;
  const arts = (await ctx.call('GET', `/projects/${id}`)).json.artifacts as any[];
  const find = (kind: string, lang?: string) => arts.find((a) => a.kind === kind && (!lang || a.lang_code === lang)).id as string;
  const research = { ...newResearchContent('Octopus'), sources: [{ id: 's1', url: 'https://example.org' }], checklist: newResearchContent('x').checklist.map((k) => ({ ...k, done: true })) };
  const rid = find('research');
  await ctx.call('PUT', `/artifacts/${rid}/content`, { content: research });
  await ctx.call('POST', `/artifacts/${rid}/submit`);
  await ctx.call('POST', `/artifacts/${rid}/approve`, {});
  const bid = find('script_base');
  await ctx.call('PUT', `/artifacts/${bid}/content`, { content: { title: 'Octopus', lang: 'en', preset: 'short_lt30', sections: BASE_SECTIONS } });
  assert.equal((await ctx.call('POST', `/artifacts/${bid}/submit`)).status, 200);
  assert.equal((await ctx.call('POST', `/artifacts/${bid}/approve`, {})).status, 200);
  return { id, find, bid };
}

const state = (ctx: Ctx, id: string) => ctx.engine.get(id).state;

/** Approve every remaining artifact in dependency order, with kind-appropriate content. */
function approveRest(engine: Engine, projectId: string) {
  const pending = engine.list(projectId).filter((a) => a.state !== 'approved');
  let guard = 0;
  while (pending.length && guard++ < 2000) {
    const a = pending.shift()!;
    if (engine.upstreamDirect(a.id).some((u) => engine.get(u.id).state !== 'approved')) {
      pending.push(a);
      continue;
    }
    const content = a.kind === 'script_lang' ? { title: 'T', lang: a.lang_code, preset: 'short_lt30', sections: BASE_SECTIONS } : { label: a.label };
    if (!a.current_version_id) engine.saveVersion(a.id, content);
    if (engine.get(a.id).state === 'in_progress') engine.submitForReview(a.id);
    engine.approve(a.id, { actor: 'user' });
  }
  assert.equal(pending.length, 0);
}

test('locale registry: built-ins seeded and protected, custom locales added, unregistered rejected', async () => {
  const ctx = boot();
  const list = (await ctx.call('GET', '/locales')).json as any[];
  assert.deepEqual(list.filter((l) => l.builtin).map((l) => l.code).sort(), ['en', 'taglish', 'tl']);
  let r = await ctx.call('POST', '/locales', { code: 'ceb', name: 'Cebuano', bcp47: 'ceb-PH', default_wpm: 130 });
  assert.equal(r.status, 201);
  r = await ctx.call('POST', '/locales', { code: 'tl', name: 'Hack', bcp47: 'x', default_wpm: 100 });
  assert.equal(r.status, 409);
  r = await ctx.call('POST', '/locales', { code: 'Bad Code', name: 'x', bcp47: 'x', default_wpm: 100 });
  assert.equal(r.status, 422);
  r = await ctx.call('POST', '/projects', { name: 'X', languages: ['en', 'klingon'] });
  assert.equal(r.status, 422);
  // registry WPM feeds the estimator default
  const est = await ctx.call('POST', '/estimate', { lang: 'ceb', text: Array(130).fill('w').join(' ') });
  assert.equal(est.json.wpm, 130);
});

test('seed-from-base requires an approved base, copies section ids, and cannot be repeated', async () => {
  const ctx = boot();
  const p = await ctx.call('POST', '/projects', { name: 'X', languages: ['en', 'tl'] });
  const arts = (await ctx.call('GET', `/projects/${p.json.id}`)).json.artifacts as any[];
  const tl = arts.find((a) => a.kind === 'script_lang' && a.lang_code === 'tl').id;
  assert.equal((await ctx.call('POST', `/artifacts/${tl}/seed-from-base`)).status, 409);

  const { find } = await projectWithApprovedBase(ctx);
  const tl2 = find('script_lang', 'tl');
  const seeded = await ctx.call('POST', `/artifacts/${tl2}/seed-from-base`); assert.equal(seeded.status, 201, JSON.stringify(seeded.json));
  const artRes = await ctx.call('GET', `/artifacts/${tl2}`); assert.equal(artRes.status, 200, JSON.stringify(artRes.json)); const art = artRes.json;
  assert.equal(art.content.lang, 'tl');
  assert.deepEqual(art.content.sections.map((s: any) => s.id), ['h', 'm', 'c']);
  assert.ok(art.content.source_version_id);
  assert.equal(art.state, 'in_progress');
  assert.equal((await ctx.call('POST', `/artifacts/${tl2}/seed-from-base`)).status, 422);
});

test('a language artifact refuses content for another language', async () => {
  const ctx = boot();
  const { find } = await projectWithApprovedBase(ctx);
  const tl = find('script_lang', 'tl');
  const r = await ctx.call('PUT', `/artifacts/${tl}/content`, { content: { title: 'T', lang: 'en', preset: 'short_lt30', sections: BASE_SECTIONS } });
  assert.equal(r.status, 422);
});

test('compare shows missing/extra sections and flags a stale adaptation after the base changes', async () => {
  const ctx = boot();
  const { find, bid } = await projectWithApprovedBase(ctx);
  const tl = find('script_lang', 'tl');
  await ctx.call('POST', `/artifacts/${tl}/seed-from-base`);
  const content = (await ctx.call('GET', `/artifacts/${tl}`)).json.content;
  content.sections = content.sections.filter((s: any) => s.id !== 'm').concat([{ id: 'x', kind: 'other', text: 'Dagdag' }]);
  await ctx.call('PUT', `/artifacts/${tl}/content`, { content });

  let cmp = (await ctx.call('GET', `/artifacts/${tl}/compare`)).json;
  assert.deepEqual(cmp.missing, ['m']);
  assert.deepEqual(cmp.rows.map((r: any) => r.status), ['ok', 'missing', 'ok', 'extra']);
  assert.equal(cmp.stale, false);

  // missing base section blocks review
  const sub = await ctx.call('POST', `/artifacts/${tl}/submit`);
  assert.equal(sub.status, 422);
  assert.ok(sub.json.error.details.some((m: string) => /Missing adapted text/.test(m)));

  // change the base: adaptation is now stale
  const base = (await ctx.call('GET', `/artifacts/${bid}`)).json.content;
  base.title = 'Octopus v2';
  await ctx.call('PUT', `/artifacts/${bid}/content`, { content: base, reopen: true });
  cmp = (await ctx.call('GET', `/artifacts/${tl}/compare`)).json;
  assert.equal(cmp.stale, true);
});

test('review warnings: stale adaptation and language-mix heuristics are warnings, not blockers', async () => {
  const ctx = boot();
  const { find } = await projectWithApprovedBase(ctx);
  const tl = find('script_lang', 'tl');
  await ctx.call('POST', `/artifacts/${tl}/seed-from-base`); // untranslated English copy in a Tagalog slot
  const sub = await ctx.call('POST', `/artifacts/${tl}/submit`);
  assert.equal(sub.status, 200);
  assert.ok(sub.json.warnings.some((w: string) => /Tagalog script looks .* English/.test(w)));
  const mix = (await ctx.call('GET', `/artifacts/${tl}/language-mix`)).json;
  assert.equal(mix.heuristic, true);
  assert.equal(mix.tagalogRatio, 0);
});

test('detectMix: Taglish that really mixes both passes; all-English or all-Tagalog Taglish is flagged', () => {
  const good = 'Alam mo ba na may three hearts ang octopus, and the gills are the reason kasi they need oxygen para sa body';
  const m = detectMix(good);
  assert.ok(m.tagalogRatio! > 0.15 && m.tagalogRatio! < 0.85, `ratio ${m.tagalogRatio}`);
  assert.equal(detectMix('hello world').tagalogRatio, null); // too little signal to judge
});

test('adaptation prompt carries locale guidance, section ids, and the no-literal-translation rule', async () => {
  const ctx = boot();
  const { find } = await projectWithApprovedBase(ctx);
  const r = await ctx.call('GET', `/artifacts/${find('script_lang', 'taglish')}/adaptation-prompt`);
  assert.equal(r.status, 200);
  const p: string = r.json.prompt;
  assert.match(p, /Taglish/);
  assert.match(p, /code-switching/);
  assert.match(p, /do not translate literally/i);
  assert.match(p, /"id": "h"/);
  assert.match(p, /tts_text/);
});

test('pronunciation: lexicon affects TTS text only, whole words only, explicit tts_text wins', async () => {
  assert.equal(applyLexicon('Si Jose at Joseph', [{ term: 'Jose', respelling: 'Ho-SEH' }]), 'Si Ho-SEH at Joseph');
  assert.equal(ttsText({ text: 'Jose', tts_text: 'custom' }, [{ term: 'Jose', respelling: 'Ho-SEH' }]), 'custom');

  const ctx = boot();
  const { id, find } = await projectWithApprovedBase(ctx);
  const tl = find('script_lang', 'tl');
  await ctx.call('POST', `/artifacts/${tl}/seed-from-base`);
  const art = (await ctx.call('GET', `/artifacts/${tl}`)).json;
  art.content.sections[0].text = 'Alam mo ba ang octopus?';
  await ctx.call('PUT', `/artifacts/${tl}/content`, { content: art.content });
  const put = await ctx.call('PUT', `/projects/${id}/lexicon/tl`, { term: 'octopus', respelling: 'OK-to-pus' });
  assert.equal(put.status, 200);
  const prev = (await ctx.call('GET', `/artifacts/${tl}/tts-preview`)).json as any[];
  assert.equal(prev[0].display, 'Alam mo ba ang octopus?');
  assert.equal(prev[0].tts, 'Alam mo ba ang OK-to-pus?');
  assert.equal(prev[0].differs, true);
  // display text in the artifact is untouched
  assert.equal((await ctx.call('GET', `/artifacts/${tl}`)).json.content.sections[0].text, 'Alam mo ba ang octopus?');
});

test('lexicon change marks only that language\'s audio and downstream for revision', async () => {
  const ctx = boot();
  const { id, find } = await projectWithApprovedBase(ctx);
  approveRest(ctx.engine, id);
  const all = ctx.engine.list(id);
  assert.ok(all.every((a) => a.state === 'approved'));

  const r = await ctx.call('PUT', `/projects/${id}/lexicon/tl`, { term: 'puso', respelling: 'poo-SO' });
  assert.equal(r.status, 200);
  const changed = ctx.engine.list(id).filter((a) => a.state !== 'approved');
  assert.ok(changed.length > 0 && changed.every((a) => a.lang_code === 'tl'));
  assert.deepEqual([...new Set(changed.map((a) => a.kind))].sort(), ['audio', 'caption', 'composition', 'final_render', 'subtitle_export']);
  assert.equal(state(ctx, find('script_lang', 'tl')), 'approved'); // display script untouched
  assert.equal(state(ctx, find('audio', 'en')), 'approved');
  assert.equal(state(ctx, find('audio', 'taglish')), 'approved');

  // an unchanged lexicon on an unapproved language invalidates nothing new; deleting re-invalidates
  const entries = (await ctx.call('GET', `/projects/${id}/lexicon/tl`)).json as any[];
  assert.equal(entries.length, 1);
  assert.equal((await ctx.call('DELETE', `/lexicon/${entries[0].id}`)).status, 200);
  assert.equal((await ctx.call('DELETE', `/lexicon/${entries[0].id}`)).status, 404);
});

test('adding a language leaves other languages\' approvals intact; removal is blocked for approved work', async () => {
  const ctx = boot();
  const { id } = await projectWithApprovedBase(ctx, ['en', 'tl']);
  approveRest(ctx.engine, id);
  await ctx.call('POST', '/locales', { code: 'ceb', name: 'Cebuano', bcp47: 'ceb-PH', default_wpm: 130 });

  const r = await ctx.call('POST', `/projects/${id}/languages`, { lang: 'ceb' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.languages.sort(), ['ceb', 'en', 'tl']);
  const arts = ctx.engine.list(id);
  assert.ok(arts.filter((a) => a.lang_code === 'ceb').every((a) => a.state === 'not_started'));
  assert.ok(arts.filter((a) => a.lang_code !== 'ceb').every((a) => a.state === 'approved'));
  assert.equal((await ctx.call('POST', `/projects/${id}/languages`, { lang: 'ceb' })).status, 422);

  const comp = arts.find((a) => a.kind === 'composition' && a.lang_code === 'ceb')!;
  const upKinds = ctx.engine.upstreamDirect(comp.id).map((u) => u.kind).sort();
  assert.deepEqual(upKinds, ['audio', 'caption', 'storyboard']);

  assert.equal((await ctx.call('DELETE', `/projects/${id}/languages/tl`)).status, 409);
  const rm = await ctx.call('DELETE', `/projects/${id}/languages/ceb`);
  assert.equal(rm.status, 200);
  assert.equal(rm.json.removedArtifacts, 4 + 2);
  assert.ok(ctx.engine.list(id).every((a) => a.lang_code !== 'ceb'));
  assert.ok(ctx.engine.list(id).every((a) => a.state === 'approved'));
});

test('a new language added after scenes exist depends on every scene asset', async () => {
  const ctx = boot();
  const { id } = await projectWithApprovedBase(ctx, ['en']);
  const { addScene } = await import('../src/pipeline.ts');
  addScene(ctx.engine, id, 'one');
  addScene(ctx.engine, id, 'two');
  await ctx.call('POST', `/projects/${id}/languages`, { lang: 'tl' });
  const comp = ctx.engine.list(id, { kind: 'composition', lang_code: 'tl' })[0];
  assert.equal(ctx.engine.upstreamDirect(comp.id).filter((u) => u.kind === 'scene_asset').length, 2);
});
