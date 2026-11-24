import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { Engine, EngineError } from '../src/engine.ts';
import { buildApi } from '../src/api.ts';
import { estimate, countWords, resolveWpm } from '../src/studios/estimator.ts';
import { newResearchContent } from '../src/studios/research.ts';

const fresh = () => buildApi(new Engine(openDb()));

async function call(app: ReturnType<typeof fresh>, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const r = await app.inject({ method, url, payload: payload as any });
  return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : null };
}

async function makeProject(app: ReturnType<typeof fresh>) {
  const p = await call(app, 'POST', '/projects', { name: 'Octopus facts', languages: ['en', 'tl', 'taglish'], formats: ['vertical_9x16'], topic: 'Octopus hearts' });
  assert.equal(p.status, 201);
  const proj = await call(app, 'GET', `/projects/${p.json.id}`);
  const find = (kind: string, lang?: string) => proj.json.artifacts.find((a: any) => a.kind === kind && (!lang || a.lang_code === lang)).id as string;
  return { projectId: p.json.id as string, template: p.json.researchTemplate, find };
}

function completeResearch(t: ReturnType<typeof newResearchContent>) {
  return {
    ...t,
    sources: [{ id: 's1', url: 'https://example.org/octopus', title: 'Marine biology note' }],
    claims: [{ id: 'c1', text: 'Octopuses have three hearts.', status: 'verified', sourceIds: ['s1'] }],
    checklist: t.checklist.map((k) => ({ ...k, done: true })),
  };
}

test('countWords handles Tagalog hyphenation, punctuation and apostrophes', () => {
  assert.equal(countWords('Mag-aral ka nang mabuti, ha?'), 5);
  assert.equal(countWords("Don't stop — really..."), 3);
  assert.equal(countWords('   '), 0);
});

test('estimator uses defaults, then calibrated median WPM per language', () => {
  const text = Array(30).fill('word').join(' ') + '.';
  const base = estimate({ sections: [{ text }], lang: 'tl' });
  assert.equal(base.wpmSource, 'default');
  assert.equal(base.wpm, 135);
  const samples = [{ words: 100, seconds: 30 }, { words: 100, seconds: 40 }, { words: 100, seconds: 50 }];
  assert.deepEqual(resolveWpm('tl', samples).wpm, 150); // median of 200,150,120
  const cal = estimate({ sections: [{ text }], lang: 'tl', samples });
  assert.equal(cal.wpmSource, 'calibrated');
  assert.ok(cal.seconds < base.seconds);
  // too few or junk samples fall back to defaults
  assert.equal(resolveWpm('en', [{ words: 2, seconds: 1 }]).source, 'default');
});

test('estimator flags preset fit and the 60s Shorts hard limit', () => {
  const long = Array(200).fill('word').join(' ');
  const e = estimate({ sections: [{ text: long }], lang: 'en', preset: 'short_45_60' });
  assert.equal(e.fit, 'over');
  assert.equal(e.overHardLimit, true);
  const ok = estimate({ sections: [{ text: Array(100).fill('word').join(' ') }], lang: 'en', preset: 'short_30_45' });
  assert.equal(ok.fit, 'ok');
});

test('research: bad URLs, unknown sources and AI verification are rejected; checklist gates submission', async () => {
  const app = fresh();
  const { template, find } = await makeProject(app);
  const rid = find('research');

  let r = await call(app, 'PUT', `/artifacts/${rid}/content`, { content: { ...template, sources: [{ id: 's1', url: 'not a url' }] } });
  assert.equal(r.status, 422);
  r = await call(app, 'PUT', `/artifacts/${rid}/content`, { content: { ...template, claims: [{ id: 'c1', text: 'x', status: 'unverified', sourceIds: ['ghost'] }] } });
  assert.equal(r.status, 422);

  // draft with open checklist saves fine but cannot be submitted
  r = await call(app, 'PUT', `/artifacts/${rid}/content`, { content: { ...template, sources: [{ id: 's1', url: 'https://example.org' }] } });
  assert.equal(r.status, 200);
  r = await call(app, 'POST', `/artifacts/${rid}/submit`);
  assert.equal(r.status, 422);
  assert.ok(r.json.error.details.some((m: string) => /checklist/i.test(m)));

  // a verified claim without a source blocks submission
  const noSource = { ...completeResearch(template), claims: [{ id: 'c1', text: 'Unsourced', status: 'verified', sourceIds: [] }] };
  await call(app, 'PUT', `/artifacts/${rid}/content`, { content: noSource });
  r = await call(app, 'POST', `/artifacts/${rid}/submit`);
  assert.equal(r.status, 422);

  await call(app, 'PUT', `/artifacts/${rid}/content`, { content: completeResearch(template) });
  r = await call(app, 'POST', `/artifacts/${rid}/submit`);
  assert.equal(r.status, 200);
  r = await call(app, 'POST', `/artifacts/${rid}/approve`, {});
  assert.equal(r.status, 200);
});

test('AI actor cannot mark claims verified, but may carry forward user-verified ones', () => {
  const engine = new Engine(openDb());
  const app = buildApi(engine);
  return (async () => {
    const { template, find } = await makeProject(app);
    const rid = find('research');
    const { Studio } = await import('../src/services.ts');
    const studio = new Studio(engine);
    const aiDraft = { ...template, sources: [{ id: 's1', url: 'https://example.org' }], claims: [{ id: 'c1', text: 'Fact', status: 'verified', sourceIds: ['s1'] }] };
    assert.throws(() => studio.save(rid, aiDraft, { actor: 'ai' }), (e: EngineError) => e.code === 'AI_CANNOT_VERIFY');
    studio.save(rid, aiDraft, { actor: 'user' });
    // AI adds notes while leaving the verified claim identical: allowed
    studio.save(rid, { ...aiDraft, notes: 'AI suggestion' }, { actor: 'ai' });
    // AI changes the verified claim's text: refused
    assert.throws(
      () => studio.save(rid, { ...aiDraft, claims: [{ id: 'c1', text: 'Changed fact', status: 'verified', sourceIds: ['s1'] }] }, { actor: 'ai' }),
      (e: EngineError) => e.code === 'AI_CANNOT_VERIFY',
    );
  })();
});

test('script: shape validation, Shorts hook rule, hard limit, and approval over HTTP', async () => {
  const app = fresh();
  const { template, find } = await makeProject(app);
  const rid = find('research');
  await call(app, 'PUT', `/artifacts/${rid}/content`, { content: completeResearch(template) });
  await call(app, 'POST', `/artifacts/${rid}/submit`);
  await call(app, 'POST', `/artifacts/${rid}/approve`, {});

  const sid = find('script_base');
  let r = await call(app, 'PUT', `/artifacts/${sid}/content`, { content: { title: 'T', lang: 'en', preset: 'nope', sections: [] } });
  assert.equal(r.status, 422);

  const sections = [
    { id: 'a', kind: 'intro', text: 'Octopuses are strange.' },
    { id: 'b', kind: 'main', text: 'They have three hearts.' },
  ];
  await call(app, 'PUT', `/artifacts/${sid}/content`, { content: { title: 'T', lang: 'en', preset: 'short_lt30', sections } });
  r = await call(app, 'POST', `/artifacts/${sid}/submit`);
  assert.equal(r.status, 422);
  assert.ok(r.json.error.details.some((m: string) => /hook/i.test(m)));

  const tooLong = [{ id: 'h', kind: 'hook', text: Array(220).fill('word').join(' ') + '.' }];
  await call(app, 'PUT', `/artifacts/${sid}/content`, { content: { title: 'T', lang: 'en', preset: 'short_45_60', sections: tooLong } });
  r = await call(app, 'POST', `/artifacts/${sid}/submit`);
  assert.equal(r.status, 422);
  assert.ok(r.json.error.details.some((m: string) => /60s/.test(m)));

  const good = [
    { id: 'h', kind: 'hook', text: 'Did you know octopuses have three hearts?' },
    { id: 'm', kind: 'main', text: 'Two pump blood to the gills and one serves the body.' },
    { id: 'c', kind: 'cta', text: 'Follow for more.' },
  ];
  await call(app, 'PUT', `/artifacts/${sid}/content`, { content: { title: 'T', lang: 'en', preset: 'short_lt30', sections: good } });
  r = await call(app, 'POST', `/artifacts/${sid}/submit`);
  assert.equal(r.status, 200);
  r = await call(app, 'POST', `/artifacts/${sid}/approve`, {});
  assert.equal(r.status, 200);

  // editing approved script without reopen is refused (409); with reopen it invalidates downstream only
  r = await call(app, 'PUT', `/artifacts/${sid}/content`, { content: { title: 'T2', lang: 'en', preset: 'short_lt30', sections: good } });
  assert.equal(r.status, 409);
  r = await call(app, 'PUT', `/artifacts/${sid}/content`, { content: { title: 'T2', lang: 'en', preset: 'short_lt30', sections: good }, reopen: true });
  assert.equal(r.status, 200);
  const research = await call(app, 'GET', `/artifacts/${rid}`);
  assert.equal(research.json.state, 'approved');
  const hist = await call(app, 'GET', `/artifacts/${sid}/history`);
  assert.equal(hist.json.versions.length, 4); // four distinct saves; the rejected-preset save created none
});

test('estimate and calibration endpoints', async () => {
  const app = fresh();
  let r = await call(app, 'POST', '/estimate', { lang: 'taglish', text: Array(29).fill('salita').join(' '), preset: 'short_lt30' });
  assert.equal(r.status, 200);
  assert.equal(r.json.wpmSource, 'default');
  for (const [w, s] of [[60, 20], [60, 22], [60, 24]]) r = await call(app, 'POST', '/calibration/taglish', { words: w, seconds: s });
  assert.equal(r.json.source, 'calibrated');
  r = await call(app, 'POST', '/calibration/taglish', { words: 1, seconds: 1 });
  assert.equal(r.status, 422);
  r = await call(app, 'POST', '/estimate', { text: 'x' });
  assert.equal(r.status, 422);
});

test('unknown artifact returns 404 and approve cannot skip review', async () => {
  const app = fresh();
  assert.equal((await call(app, 'GET', '/artifacts/NOPE')).status, 404);
  const { find } = await makeProject(app);
  const r = await call(app, 'POST', `/artifacts/${find('research')}/approve`, {});
  assert.equal(r.status, 409);
});
