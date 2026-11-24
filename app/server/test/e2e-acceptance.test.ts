import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { statSync as statSync2 } from 'node:fs';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { buildApi } from '../src/api.ts';
import { ffprobeBinary } from '../src/media.ts';
import { newResearchContent } from '../src/studios/research.ts';

// Section 16 acceptance test: a ~10 second captioned video, three formats, real speech, real FFmpeg.
const FFMPEG = join(dirname(ffprobeBinary()), 'ffmpeg');
const FFPROBE = ffprobeBinary();
const OUT = process.env.WANDER_E2E_OUT; // optional: keep frames/videos here for eyeballing

let tmp: string;
let root: string;
let pics: string[];
const ff = (args: string[]) => execFileSync(FFMPEG, ['-v', 'error', '-y', ...args]);
const probe = (file: string) => JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString());

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wander-e2e-'));
  root = join(tmp, 'root');
  mkdirSync(root, { recursive: true });
  pics = [
    ['testsrc2=s=1600x900:d=1', 'p1.png'],
    ['smptebars=s=1280x720:d=1', 'p2.png'],
    ['mandelbrot=s=900x1200:end_pts=1', 'p3.png'],
    ['gradients=s=1000x1000:d=1', 'p4.png'],
  ].map(([src, name]) => {
    const f = join(tmp, name);
    ff(['-f', 'lavfi', '-i', src, '-frames:v', '1', f]);
    return f;
  });
});
after(() => rmSync(tmp, { recursive: true, force: true }));

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
const OWN = { type: 'own', commercial_use: 'yes' };

test('10-second multi-format captioned video: research -> script -> storyboard -> visuals -> narration -> captions -> composition -> 3 renders -> single-scene re-render', { timeout: 600_000 }, async () => {
  const engine = new Engine(openDb());
  const app = buildApi(engine, { root });
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, payload: payload as any });
    let json: any = null;
    try {
      json = r.body ? JSON.parse(r.body) : null;
    } catch {
      /* binary */
    }
    return { status: r.statusCode, json, raw: r.rawPayload };
  };
  const ok = async (p: ReturnType<typeof call>, label: string) => {
    const r = await p;
    assert.ok(r.status >= 200 && r.status < 300, `${label}: HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 600)}`);
    return r;
  };
  const approve = async (id: string, label: string) => {
    await ok(call('POST', `/artifacts/${id}/submit`), `${label} submit`);
    await ok(call('POST', `/artifacts/${id}/approve`, {}), `${label} approve`);
  };
  const state = (id: string) => engine.get(id).state;

  // 1. project + research
  const FORMATS = ['vertical_9x16', 'horizontal_16x9', 'square_1x1'];
  const p = await ok(call('POST', '/projects', { name: 'Octopus 10s', category: 'Interesting Facts', languages: ['en', 'taglish'], formats: FORMATS }), 'create project');
  const pid = p.json.id as string;
  const arts = () => engine.list(pid);
  const one = (kind: string, lang?: string, format?: string) => arts().find((a) => a.kind === kind && (!lang || a.lang_code === lang) && (!format || a.format === format))!;
  const research = { ...newResearchContent('Octopus hearts'), sources: [{ id: 's1', url: 'https://example.org/octopus' }], checklist: newResearchContent('x').checklist.map((k) => ({ ...k, done: true })) };
  await ok(call('PUT', `/artifacts/${one('research').id}/content`, { content: research }), 'research save');
  await approve(one('research').id, 'research');

  // 2. 10-second script (22-28 words) + localizations
  const base = { title: 'Octopus hearts', lang: 'en', preset: 'short_lt30', sections: SECTIONS };
  const words = SECTIONS.map((s) => s.text).join(' ').split(/\s+/).length;
  assert.ok(words >= 20 && words <= 28, `script has ${words} words`);
  await ok(call('PUT', `/artifacts/${one('script_base').id}/content`, { content: base }), 'base save');
  await approve(one('script_base').id, 'base script');
  await ok(call('POST', `/artifacts/${one('script_lang', 'en').id}/seed-from-base`), 'seed en');
  await approve(one('script_lang', 'en').id, 'en script');
  await ok(call('POST', `/artifacts/${one('script_lang', 'taglish').id}/seed-from-base`), 'seed taglish');
  await ok(call('PUT', `/artifacts/${one('script_lang', 'taglish').id}/content`, { content: { ...base, lang: 'taglish', sections: TAGLISH, source_version_id: engine.get(one('script_base').id).current_version_id } }), 'taglish save');
  await approve(one('script_lang', 'taglish').id, 'taglish script');

  // 3. storyboard (2-3 scenes)
  await ok(call('POST', `/artifacts/${one('storyboard').id}/seed-storyboard`, { scene_seconds: 5 }), 'seed storyboard');
  const sb = (await call('GET', `/artifacts/${one('storyboard').id}`)).json;
  const scenes = sb.content.scenes as any[];
  assert.ok(scenes.length >= 2 && scenes.length <= 5, `${scenes.length} scenes`);
  sb.content.scenes = scenes.map((s: any, i: number) => ({ ...s, draft: false, camera: { ...s.camera, movement: ['zoom', 'pan', 'ken_burns', 'static'][i % 4], direction: i % 2 ? 'left_to_right' : 'in' }, transition_in: i === 0 ? 'cut' : 'dissolve' }));
  await ok(call('PUT', `/artifacts/${one('storyboard').id}/content`, { content: sb.content }), 'storyboard refine');
  await approve(one('storyboard').id, 'storyboard');
  const sceneArts = engine.list(pid, { kind: 'scene_asset' });
  assert.equal(sceneArts.length, scenes.length);

  // 4. visuals: import, set a focal point on one, link, approve
  const imported: any[] = [];
  for (const [i, art] of sceneArts.entries()) {
    const r = await ok(call('POST', `/projects/${pid}/assets/import`, { path: pics[i % pics.length], type: 'stock_photo', license: OWN, name: `pic${i}` }), `import ${i}`);
    imported.push(r.json);
    await ok(call('POST', `/assets/${r.json.id}/approve`), `asset ${i} approve`);
    await ok(call('PUT', `/scenes/${art.scene_id}/assets`, { assets: [{ asset_id: r.json.id }], primary_asset_id: r.json.id }), `link ${i}`);
  }
  const fp = await ok(call('PATCH', `/assets/${imported[0].id}`, { focal: { x: 0.7, y: 0.4 }, reopen: true }), 'focal');
  assert.deepEqual(fp.json.asset.focal, { x: 0.7, y: 0.4 });
  await ok(call('POST', `/assets/${imported[0].id}/approve`), 'asset 0 re-approve');
  for (const [i, art] of sceneArts.entries()) await approve(art.id, `scene asset ${i}`);

  // 5. narration (macOS voice), audio-anchored durations
  const voices = (await call('GET', '/tts/providers/macos-say/voices')).json as { id: string; locale: string }[];
  const voice = (voices.find((v) => v.id === 'Samantha') ?? voices.find((v) => v.locale === 'en_US'))!.id;
  const ttsStatus = (await call('GET', '/tts/providers')).json.find((x: any) => x.id === 'macos-say');
  assert.equal(ttsStatus.status.ok, true);
  const syn = await ok(call('POST', `/artifacts/${one('audio', 'en').id}/narration/synthesize`, { voice: { provider: 'macos-say', voice, rate: 190 } }), 'synthesize en');
  assert.ok(syn.json.changed);
  const enAudio = (await call('GET', `/artifacts/${one('audio', 'en').id}`)).json;
  assert.equal(enAudio.content.chunks.length, 3);
  const clips = (await call('GET', `/projects/${pid}/audio?kind=narration&lang=en`)).json as any[];
  assert.equal(clips.length, 3);
  for (const c of clips) {
    const pr = probe(join(root, c.rel_path));
    assert.ok(Math.abs(Number(pr.format.duration) - c.duration_seconds) < 0.01, 'stored duration is the measured one');
    assert.equal(c.provider, 'macos-say');
    assert.equal(c.license.commercial_use, 'unknown');
  }
  // Taglish uses a manual voiceover import (a real recording would go here)
  const vo = join(tmp, 'taglish-vo.aiff');
  execFileSync('say', ['-v', voice, '-o', vo, '-r', '185', TAGLISH.map((s) => s.text).join(' ')]);
  const imp = await ok(call('POST', `/artifacts/${one('audio', 'taglish').id}/narration/import`, { path: vo, name: 'taglish voiceover' }), 'import taglish vo');
  assert.deepEqual(imp.json.clip.provider, 'manual-import');
  const peaks = (await call('GET', `/audio/${imp.json.clip.id}/peaks?buckets=50`)).json;
  assert.equal(peaks.peaks.length, 50);
  assert.ok(Math.max(...peaks.peaks) > 0.05, 'waveform has signal');

  // music + ducking on the en mix (generated tone stands in for licensed music)
  const music = join(tmp, 'bed.wav');
  ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', music]);
  const mclip = await ok(call('POST', `/projects/${pid}/audio/import`, { path: music, kind: 'music', name: 'bed', license: { type: 'cc0', commercial_use: 'yes' } }), 'import music');
  await ok(call('PUT', `/artifacts/${one('audio', 'en').id}/mix`, { mix: { music: [{ clip_id: mclip.json.id, gain_db: -18, fade_in: 0.5, fade_out: 1, loop: true }], ducking: { enabled: true, amount: 8 } } }), 'set mix');
  await approve(one('audio', 'en').id, 'en audio');
  await approve(one('audio', 'taglish').id, 'taglish audio');

  // anchoring: measured narration now drives scene timing; speech rate got calibrated
  const total = clips.reduce((n, c) => n + c.duration_seconds, 0) + 0.25 * 2;
  const tl0 = (await call('GET', `/artifacts/${one('storyboard').id}/timeline/en`)).json;
  assert.ok(tl0.scenes.every((s: any) => s.source === 'audio'), 'scene durations are audio-anchored');
  assert.ok(Math.abs(tl0.total_seconds - total) < 0.6, `scene total ${tl0.total_seconds} ~ narration ${total.toFixed(2)}`);
  assert.ok(total > 5 && total < 16, `narration ${total.toFixed(1)}s is roughly the 10s target`);
  const wpm = (await call('GET', '/calibration/en')).json;
  assert.ok(wpm.samples >= 1);

  // 6. captions: aligned to audio, canonical script text, exports
  for (const lang of ['en', 'taglish']) {
    const cap = one('caption', lang);
    const a = await ok(call('POST', `/artifacts/${cap.id}/captions/align`, { method: 'heuristic' }), `align ${lang}`);
    assert.ok(a.json.changed);
    const track = (await call('GET', `/artifacts/${cap.id}`)).json.content;
    const expected = (lang === 'en' ? SECTIONS : TAGLISH).map((s) => s.text).join(' ').split(/\s+/);
    assert.deepEqual(track.words.map((w: any) => w.text), expected, `${lang}: caption text is exactly the approved script`);
    assert.ok(track.words.every((w: any, i: number) => w.end > w.start && (!i || w.start >= track.words[i - 1].end - 1e-6)));
    assert.ok(track.words.at(-1).end <= track.duration + 0.01);
    assert.notEqual(track.confidence, 'high', 'heuristic timing is never reported as high-confidence');
    const exp = await ok(call('POST', `/artifacts/${cap.id}/captions/export`), `export ${lang}`);
    assert.match(exp.json.srt, /00:00:00,\d{3} --> /);
    assert.ok(exp.json.vtt.startsWith('WEBVTT'));
    assert.ok(existsSync(join(root, 'projects', `proj_${pid}`, 'captions', 'exports', `${lang}.srt`)));
    const sub = await ok(call('POST', `/artifacts/${cap.id}/submit`), `caption ${lang} submit`);
    assert.ok(sub.json.warnings.some((w: string) => /confidence/.test(w)));
    await ok(call('POST', `/artifacts/${cap.id}/approve`, {}), `caption ${lang} approve`);
  }
  // a hand-edited caption word that deviates from the script is refused (spelling guardrail)
  const enTrack = (await call('GET', `/artifacts/${one('caption', 'en').id}`)).json.content;
  enTrack.words[3].text = 'octopusses';
  const guard = await call('PUT', `/artifacts/${one('caption', 'en').id}/content`, { content: enTrack, reopen: true });
  assert.equal(guard.status, 422);
  assert.match(JSON.stringify(guard.json.error.details), /octopusses.*octopuses/);

  // 7+8. composition per format, then verified renders (captioned + clean)
  const renders: Record<string, any> = {};
  for (const fmt of FORMATS) {
    const comp = one('composition', 'en', fmt);
    const b = await ok(call('POST', `/artifacts/${comp.id}/build-timeline`, {}), `build ${fmt}`);
    assert.ok(b.json.changed);
    const tl = (await call('GET', `/artifacts/${comp.id}`)).json.content;
    assert.equal(tl.format.id, fmt);
    assert.equal(tl.scenes.length, scenes.length);
    assert.ok(tl.scenes.every((s: any) => s.asset && s.timing_source === 'audio'));
    assert.ok(Math.abs(tl.duration - (total + 0.4)) < 0.6, `timeline ${tl.duration}s`);
    assert.equal(tl.scenes[0].start, 0);
    const sub = await ok(call('POST', `/artifacts/${comp.id}/submit`), `${fmt} comp submit`);
    void sub;
    await ok(call('POST', `/artifacts/${comp.id}/approve`, {}), `${fmt} comp approve`);
    const r = await ok(call('POST', `/artifacts/${comp.id}/render`, { variants: ['captioned', 'clean'] }), `render ${fmt}`);
    renders[fmt] = r.json;
    const [cap, clean] = ['captioned', 'clean'].map((v) => r.json.renders.find((x: any) => x.variant === v));
    for (const rr of [cap, clean]) {
      const file = join(root, rr.rel_path);
      const pr = probe(file);
      const v = pr.streams.find((s: any) => s.codec_type === 'video');
      const a = pr.streams.find((s: any) => s.codec_type === 'audio');
      const expectDims = { vertical_9x16: [1080, 1920], horizontal_16x9: [1920, 1080], square_1x1: [1080, 1080] }[fmt]!;
      assert.deepEqual([v.width, v.height], expectDims, `${fmt} dimensions`);
      assert.equal(v.codec_name, 'h264');
      assert.equal(a.codec_name, 'aac');
      assert.ok(Math.abs(Number(pr.format.duration) - tl.duration) < 0.25, `${fmt} duration ${pr.format.duration} vs ${tl.duration}`);
      assert.ok(rr.bytes > 10_000);
      assert.match(rr.sha256, /^[0-9a-f]{64}$/);
    }
    assert.notEqual(cap.sha256, clean.sha256, 'captioned and clean masters differ');
    assert.ok(cap.rel_path.includes(`renders/${fmt}/`));

    // live caption preview frame (captions on vs off)
    const t = tl.scenes[0].start + 0.9;
    const withCap = await call('GET', `/artifacts/${comp.id}/preview-frame?t=${t}`);
    const noCap = await call('GET', `/artifacts/${comp.id}/preview-frame?t=${t}&captions=false`);
    assert.equal(withCap.status, 200);
    assert.ok(withCap.raw.length > 5000 && noCap.raw.length > 5000);
    assert.notDeepEqual(withCap.raw, noCap.raw, 'captions are visible in the preview');
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, `${fmt}_captioned.png`), withCap.raw);
      writeFileSync(join(OUT, `${fmt}_clean.png`), noCap.raw);
    }
  }
  assert.equal(Object.values(renders).flatMap((r: any) => r.renders).length, 6);
  const listed = (await call('GET', `/projects/${pid}/renders?lang=en`)).json as any[];
  assert.equal(listed.length, 6);
  const served = await call('GET', `/renders/${listed[0].id}/file`);
  assert.equal(served.status, 200);
  assert.ok(served.raw.length === listed[0].bytes);

  // final render approval (an explicit user gate, never automatic)
  for (const fmt of FORMATS) {
    const fr = one('final_render', 'en', fmt);
    assert.equal(state(fr.id), 'in_progress', 'rendering saved a version but did not approve it');
    await approve(fr.id, `${fmt} final`);
  }

  // 10. modify ONE visual asset: script, audio and captions stay approved; only that scene's clip re-renders
  const target = sceneArts[1];
  const newPic = join(tmp, 'replacement.png');
  ff(['-f', 'lavfi', '-i', 'gradients=s=1500x1500:d=1:seed=7', '-frames:v', '1', newPic]);
  const na = await ok(call('POST', `/projects/${pid}/assets/import`, { path: newPic, type: 'stock_photo', license: OWN }), 'replacement import');
  await ok(call('POST', `/assets/${na.json.id}/approve`), 'replacement approve');
  await ok(call('PUT', `/scenes/${target.scene_id}/assets`, { assets: [{ asset_id: na.json.id }], primary_asset_id: na.json.id, reopen: true }), 'swap asset');

  for (const k of ['research', 'script_base', 'storyboard', 'script_lang', 'audio', 'caption']) {
    assert.ok(arts().filter((a) => a.kind === k).every((a) => a.state === 'approved'), `${k} untouched`);
  }
  // exporting subtitles recorded each export as a step awaiting the user's review; a visual swap does not touch it
  assert.ok(arts().filter((a) => a.kind === 'subtitle_export').every((a) => a.state === 'in_progress'), 'subtitle exports recorded, never auto-approved, unaffected by a visual change');
  assert.equal(state(target.id), 'in_progress');
  assert.ok(arts().filter((a) => a.kind === 'composition').every((a) => a.state === 'needs_revision' || a.state === 'not_started' || a.state === 'approved'));
  assert.equal(state(one('composition', 'en', 'vertical_9x16').id), 'needs_revision');
  assert.equal(state(one('final_render', 'en', 'vertical_9x16').id), 'needs_revision');

  await approve(target.id, 'swapped scene asset');
  const vcomp = one('composition', 'en', 'vertical_9x16');
  const stale = await call('POST', `/artifacts/${vcomp.id}/render`, { variants: ['captioned'], reopen: true });
  assert.equal(stale.status, 422, 'a stale timeline cannot be rendered');
  await ok(call('POST', `/artifacts/${vcomp.id}/build-timeline`, { reopen: true }), 'rebuild');
  await approve(vcomp.id, 'vertical comp re-approve');
  const again = await ok(call('POST', `/artifacts/${vcomp.id}/render`, { variants: ['captioned'], reopen: true }), 'incremental render');
  const cached = again.json.scenes.filter((s: any) => s.cached).map((s: any) => s.scene_id);
  const rerendered = again.json.scenes.filter((s: any) => !s.cached).map((s: any) => s.scene_id);
  assert.deepEqual(rerendered, [target.scene_id], 'only the changed scene was re-rendered');
  assert.equal(cached.length, scenes.length - 1);
  const pr = probe(join(root, again.json.renders[0].rel_path));
  assert.ok(Math.abs(Number(pr.format.duration) - (await call('GET', `/artifacts/${vcomp.id}`)).json.content.duration) < 0.25);

  // Taglish stays independent: its own audio/caption approvals untouched by the English work
  assert.equal(state(one('audio', 'taglish').id), 'approved');
  assert.equal(state(one('caption', 'taglish').id), 'approved');

  // ===== Phase 9: publishing package =====
  const vfinal = one('final_render', 'en', 'vertical_9x16');
  assert.equal(state(vfinal.id), 'in_progress');
  await approve(vfinal.id, 'vertical final re-approve');

  const th = await ok(call('POST', `/projects/${pid}/thumbnails`, { lang: 'en', scene_id: scenes[0].scene_id, text: 'Three hearts?!' }), 'thumbnail');
  assert.deepEqual([th.json.width, th.json.height], [1280, 720]);
  assert.equal(probe(join(root, th.json.rel_path)).streams[0].codec_name, 'mjpeg');
  if (OUT) writeFileSync(join(OUT, 'thumbnail.jpg'), readFileSync(join(root, th.json.rel_path)));

  const kitRes = await ok(call('POST', `/projects/${pid}/kit/en/generate`), 'kit');
  assert.ok(kitRes.json.title_options[0].startsWith('Did you know octopuses'));
  assert.ok(kitRes.json.hashtags.includes('#Shorts'));
  assert.equal(kitRes.json.chapters.length, 0);
  const kitEdit = { ...kitRes.json, title_options: ['Octopuses have THREE hearts', ...kitRes.json.title_options], generated_by: 'manual' };
  await ok(call('PUT', `/projects/${pid}/kit/en`, { content: kitEdit }), 'kit edit');
  assert.equal((await call('GET', `/projects/${pid}/kit/en`)).json.content.generated_by, 'manual');
  assert.match((await call('GET', `/projects/${pid}/kit/taglish/prompt`)).json.prompt, /Taglish/);
  assert.equal((await call('PUT', `/projects/${pid}/kit/en`, { content: { ...kitEdit, tags: ['x'.repeat(40)] } })).status, 422);

  const man = (await call('GET', `/projects/${pid}/license-manifest`)).json;
  assert.ok(man.items.some((i: any) => i.kind === 'narration' && i.provider.startsWith('macos-say')));
  assert.ok(man.items.some((i: any) => i.kind === 'font'));
  assert.ok(man.items.filter((i: any) => i.kind === 'visual').length >= scenes.length);
  assert.ok(man.warnings.some((w: string) => /macos-say.*terms|commercial/i.test(w)), JSON.stringify(man.warnings));

  const exp = await ok(call('POST', `/projects/${pid}/export`, { archive: true }), 'export');
  const dir = exp.json.dir as string;
  const names = exp.json.files.map((f: any) => f.path) as string[];
  const mp4s = names.filter((n) => n.endsWith('.mp4')).sort();
  assert.deepEqual(mp4s.map((n) => n.split('/').pop()), ['octopus-10s_en_vertical_9x16_captioned.mp4', 'octopus-10s_en_vertical_9x16_clean.mp4']);
  for (const want of ['subtitles/octopus-10s_en.srt', 'subtitles/octopus-10s_en.vtt', 'thumbnails/octopus-10s_en.jpg', 'publishing/kit_en.json', 'publishing/kit_en.md', 'licenses/license_manifest.json', 'licenses/CREDITS.txt', 'project_archive.wander.zip']) assert.ok(names.includes(want), `export has ${want}`);
  for (const f of exp.json.files) {
    assert.ok(existsSync(join(dir, f.path)), f.path);
    assert.equal(statSync2(join(dir, f.path)).size, f.bytes, `${f.path} size`);
  }
  const rec = (await call('GET', `/projects/${pid}/renders?lang=en&format=vertical_9x16`)).json as any[];
  for (const v of ['captioned', 'clean']) {
    const latest = rec.find((r) => r.variant === v);
    assert.equal(createHash('sha256').update(readFileSync(join(dir, 'videos', `octopus-10s_en_vertical_9x16_${v}.mp4`))).digest('hex'), latest.sha256, `${v}: export is byte-identical to the verified render`);
  }
  const skipped = exp.json.skipped.map((x: any) => x.item);
  assert.ok(skipped.includes('en horizontal_16x9 video'), 'unapproved formats are reported, not silently dropped');
  assert.ok(skipped.includes('taglish vertical_9x16 video'));
  const summary = readFileSync(join(dir, 'EXPORT_SUMMARY.md'), 'utf8');
  assert.match(summary, /upload manually/);
  assert.match(summary, /Not included/);
  assert.match(readFileSync(join(dir, 'subtitles', 'octopus-10s_en.srt'), 'utf8'), /Did you know octopuses/);
  assert.match(readFileSync(join(dir, 'licenses', 'CREDITS.txt'), 'utf8'), /Credits for "Octopus 10s"/);
  const unapproved = await call('POST', `/projects/${(await ok(call('POST', '/projects', { name: 'Empty', languages: ['en'], formats: ['vertical_9x16'] }), 'empty project')).json.id}/export`, {});
  assert.equal(unapproved.status, 422, 'nothing approved, nothing exported');

  // archive round trip with real renders: restore as a copy and compare bytes
  const zipPath = join(dir, 'project_archive.wander.zip');
  const restored = await ok(call('POST', '/archive/restore', { path: zipPath, as_copy: true }), 'restore copy');
  const nid = restored.json.projectId as string;
  assert.notEqual(nid, pid);
  assert.equal(engine.list(nid).length, engine.list(pid).length);
  const origRenders = (await call('GET', `/projects/${pid}/renders`)).json as any[];
  const copyRenders = (await call('GET', `/projects/${nid}/renders`)).json as any[];
  assert.equal(copyRenders.length, origRenders.length);
  for (const r of copyRenders) assert.equal(createHash('sha256').update(readFileSync(join(root, r.rel_path))).digest('hex'), r.sha256, 'restored render is byte-identical');
  assert.equal((await call('POST', '/archive/restore', { path: zipPath })).status, 409, 'cannot restore over the original');
  assert.equal(engine.getProject(nid).name, 'Octopus 10s');

  // ===== Phase 10: jobs, batch, preflight, cache =====
  const pf = (await call('GET', '/preflight')).json;
  assert.equal(pf.ok, true, JSON.stringify(pf.checks.filter((c: any) => !c.ok)));
  const waitJob = async (id: string, until: string[] = ['succeeded', 'failed', 'cancelled'], ms = 180_000) => {
    const t0 = Date.now();
    for (;;) {
      const j = (await call('GET', `/jobs/${id}`)).json;
      if (until.includes(j.state)) return j;
      assert.ok(Date.now() - t0 < ms, `job ${id} stuck in ${j.state}`);
      await new Promise((r) => setTimeout(r, 60));
    }
  };
  const vcomp2 = one('composition', 'en', 'vertical_9x16');
  assert.equal(state(vcomp2.id), 'approved');

  // batch render job: only approved compositions, cached scenes, progress reported
  const batch = await ok(call('POST', '/jobs', { kind: 'batch_render', project_id: pid, params: { formats: ['vertical_9x16'], variants: ['clean'], reopen: true } }), 'enqueue batch');
  assert.equal(batch.status, 202);
  const bdone = await waitJob(batch.json.id);
  assert.equal(bdone.state, 'succeeded', JSON.stringify(bdone.error));
  assert.equal(bdone.progress, 1);
  assert.deepEqual(bdone.result.items.map((i: any) => [i.label, i.ok]), [['Composition (en, vertical_9x16)', true]]);

  // a job that cannot work reports why, with a recovery hint, and does not disturb anything else
  const hcomp = one('composition', 'en', 'horizontal_16x9');
  const bad = await waitJob((await ok(call('POST', '/jobs', { kind: 'render_composition', project_id: pid, artifact_id: hcomp.id, params: { compositionId: hcomp.id, variants: ['clean'] } }), 'enqueue stale')).json.id);
  assert.equal(bad.state, 'failed');
  assert.equal(bad.error.code, 'VALIDATION');
  assert.match(bad.error.message, /out of date/);
  assert.ok(bad.error.recovery);
  const retried = (await call('POST', `/jobs/${bad.id}/retry`)).json;
  assert.equal(retried.retry_of, bad.id);
  await waitJob(retried.id);

  // cancel a RUNNING render: ffmpeg is stopped, no partial master or database row is left
  const rendersBefore = (await call('GET', `/projects/${pid}/renders`)).json.length;
  const mp4Count = () => readdirSync(join(root, 'projects', `proj_${pid}`, 'renders', 'vertical_9x16')).filter((f) => f.endsWith('.mp4')).length;
  const mp4Before = mp4Count();
  const slow = (await ok(call('POST', '/jobs', { kind: 'render_composition', project_id: pid, artifact_id: vcomp2.id, params: { compositionId: vcomp2.id, variants: ['captioned', 'clean'], reopen: true } }), 'enqueue slow')).json;
  const queued = (await ok(call('POST', '/jobs', { kind: 'batch_render', project_id: pid, params: {} }), 'enqueue queued')).json;
  await waitJob(slow.id, ['running']);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await call('POST', `/jobs/${queued.id}/cancel`)).json.state, 'cancelled', 'queued job cancelled before it starts');
  const cancelling = await call('POST', `/jobs/${slow.id}/cancel`);
  assert.equal(cancelling.status, 200);
  const cdone = await waitJob(slow.id);
  assert.equal(cdone.state, 'cancelled');
  assert.equal((await call('GET', `/projects/${pid}/renders`)).json.length, rendersBefore, 'no render recorded');
  assert.equal(mp4Count(), mp4Before, 'no partial master left on disk');

  // cache housekeeping
  const cs = (await call('GET', '/cache')).json;
  assert.ok(cs.total_bytes > 0 && cs.dirs.some((d: any) => d.name === 'scene_clips' && d.files > 0));
  const pruned = (await call('POST', '/cache/prune', { max_bytes: 0 })).json;
  assert.ok(pruned.removed_files > 0 && pruned.freed_bytes > 0);
  assert.equal((await call('GET', '/cache')).json.total_bytes, 0);
  assert.ok(existsSync(join(root, (await call('GET', `/projects/${pid}/renders`)).json[0].rel_path)), 'pruning the cache never touches finished masters');
  // and an emptied cache simply re-renders
  const rebuilt = await waitJob((await ok(call('POST', '/jobs', { kind: 'render_composition', project_id: pid, artifact_id: vcomp2.id, params: { compositionId: vcomp2.id, variants: ['clean'], reopen: true } }), 'rerender after prune')).json.id);
  assert.equal(rebuilt.state, 'succeeded', JSON.stringify(rebuilt.error));
  assert.ok(rebuilt.result.scenes.every((x: any) => x.cached === false), 'cache was really empty');

  // no stray temp files from failed or partial work
  const cacheFiles = readdirSync(join(root, 'cache', 'scene_clips')).filter((f) => f.endsWith('.tmp.mp4'));
  assert.deepEqual(cacheFiles, []);
  if (OUT) writeFileSync(join(OUT, 'vertical_rerender.mp4'), readFileSync(join(root, again.json.renders[0].rel_path)));
});
