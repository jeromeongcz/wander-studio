#!/usr/bin/env node
// Builds a small demo project (needs FFmpeg and, for narration, macOS `say`) so the UI has real content to show.
// Usage: WANDER_ROOT=/some/dir node scripts/seed-demo.mjs    (then WANDER_ROOT=/some/dir npm run dev:server)
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../app/server/src/db.ts';
import { Engine } from '../app/server/src/engine.ts';
import { buildApi } from '../app/server/src/api.ts';
import { ffprobeBinary } from '../app/server/src/media.ts';

const root = process.env.WANDER_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const full = process.argv.includes('--full'); // also render the vertical video
mkdirSync(root, { recursive: true });
const engine = new Engine(openDb(join(root, 'data', 'wander.db')));
const app = buildApi(engine, { root });
const call = async (method, url, payload) => {
  const r = await app.inject({ method, url, payload });
  const json = r.body ? JSON.parse(r.body) : null;
  if (r.statusCode >= 300) throw new Error(`${method} ${url}: ${r.statusCode} ${JSON.stringify(json)}`);
  return json;
};
const approve = async (id) => { await call('POST', `/artifacts/${id}/submit`); await call('POST', `/artifacts/${id}/approve`, {}); };

const ffmpeg = join(dirname(ffprobeBinary()), 'ffmpeg');
const tmp = mkdtempSync(join(tmpdir(), 'wander-demo-'));
const pics = [['gradients=s=1600x900:d=1:seed=3', 'a.png'], ['mandelbrot=s=1200x900:end_pts=1', 'b.png'], ['gradients=s=1500x1500:d=1:seed=9', 'c.png']].map(([src, n]) => {
  const f = join(tmp, n);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-frames:v', '1', f]);
  return f;
});

const p = await call('POST', '/projects', { name: 'Why octopuses have three hearts', category: 'Interesting Facts', languages: ['en', 'taglish'], formats: ['vertical_9x16', 'horizontal_16x9'] });
const pid = p.id;
const arts = () => engine.list(pid);
const one = (kind, lang, format) => arts().find((a) => a.kind === kind && (!lang || a.lang_code === lang) && (!format || a.format === format));

const research = { topic: 'Octopus hearts', sources: [{ id: 's1', url: 'https://example.org/octopus', title: 'Marine biology note' }], claims: [{ id: 'c1', text: 'Octopuses have three hearts.', status: 'verified', sourceIds: ['s1'] }], checklist: p.researchTemplate.checklist.map((k) => ({ ...k, done: true })) };
await call('PUT', `/artifacts/${one('research').id}/content`, { content: research });
await approve(one('research').id);

const SECTIONS = [
  { id: 'h', kind: 'hook', text: 'Did you know octopuses have three hearts?' },
  { id: 'm', kind: 'main', text: 'Two pump blood to the gills, and one serves the body.' },
  { id: 'c', kind: 'cta', text: 'Follow for more.' },
];
const TAGLISH = [
  { id: 'h', kind: 'hook', text: 'Alam mo ba na may three hearts ang octopus?' },
  { id: 'm', kind: 'main', text: 'Two ang nagpa-pump ng blood sa gills, at one sa katawan.' },
  { id: 'c', kind: 'cta', text: 'Follow para sa more.' },
];
const base = { title: 'Octopus hearts', lang: 'en', preset: 'short_lt30', sections: SECTIONS };
await call('PUT', `/artifacts/${one('script_base').id}/content`, { content: base });
await approve(one('script_base').id);
await call('POST', `/artifacts/${one('script_lang', 'en').id}/seed-from-base`);
await approve(one('script_lang', 'en').id);
await call('POST', `/artifacts/${one('script_lang', 'taglish').id}/seed-from-base`);
await call('PUT', `/artifacts/${one('script_lang', 'taglish').id}/content`, { content: { ...base, lang: 'taglish', sections: TAGLISH, source_version_id: engine.get(one('script_base').id).current_version_id } });
await call('POST', `/artifacts/${one('storyboard').id}/seed-storyboard`, { scene_seconds: 5 });
const sb = (await call('GET', `/artifacts/${one('storyboard').id}`)).content;
sb.scenes = sb.scenes.map((s, i) => ({ ...s, draft: false, visual_description: [`Close-up of an octopus drifting over a reef`, `Diagram of the three hearts and the gills`, `Text card: follow for more`][i % 3] }));
await call('PUT', `/artifacts/${one('storyboard').id}/content`, { content: sb });
await approve(one('storyboard').id);

const OWN = { type: 'own', commercial_use: 'yes' };
const sceneArts = engine.list(pid, { kind: 'scene_asset' });
for (const [i, art] of sceneArts.entries()) {
  const a = await call('POST', `/projects/${pid}/assets/import`, { path: pics[i % pics.length], type: 'stock_photo', license: OWN, name: ['Reef (demo)', 'Hearts diagram (demo)', 'Follow card (demo)'][i % 3] });
  await call('POST', `/assets/${a.id}/approve`);
  await call('PUT', `/scenes/${art.scene_id}/assets`, { assets: [{ asset_id: a.id }], primary_asset_id: a.id });
  await approve(art.id);
}

try {
  const voices = await call('GET', '/tts/providers/macos-say/voices');
  const voice = (voices.find((v) => v.id === 'Samantha') ?? voices.find((v) => v.locale === 'en_US')).id;
  await call('POST', `/artifacts/${one('audio', 'en').id}/narration/synthesize`, { voice: { provider: 'macos-say', voice, rate: 185 } });
  await approve(one('audio', 'en').id);
  await call('POST', `/artifacts/${one('caption', 'en').id}/captions/align`, { method: 'heuristic' });
  await approve(one('caption', 'en').id);
  const comp = one('composition', 'en', 'vertical_9x16');
  await call('POST', `/artifacts/${comp.id}/build-timeline`, {});
  await approve(comp.id);
  if (full) {
    const r = await call('POST', `/artifacts/${comp.id}/render`, { variants: ['captioned', 'clean'] });
    console.log(`Rendered ${r.renders.length} videos`);
  }
} catch (e) {
  console.warn('Narration/caption steps skipped:', e.message);
}
console.log(`Demo project "${p.researchTemplate.topic}" created in ${root} (${pid}).`);
process.exit(0);
