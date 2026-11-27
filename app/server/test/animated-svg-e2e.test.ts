import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApi } from '../src/api.ts';
import { openDb } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { ffmpegBinary, ffprobeBinary } from '../src/media.ts';
import { newResearchContent } from '../src/studios/research.ts';

const reference = new URL('../../../docs/animated-svg/reference/', import.meta.url);
const readReference = (name: string) => readFileSync(new URL(name, reference), 'utf8');
const expectPng = (bytes: Buffer, w: number, h: number) => {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [w, h]);
};
const probe = (file: string) => JSON.parse(execFileSync(ffprobeBinary(), [
  '-v', 'error', '-show_format', '-show_streams', '-of', 'json', file,
], { encoding: 'utf8' }));

type Keyframe = { time: number; value: number | number[]; ease?: string };
type FixtureMotion = { duration: number; tracks: ({ keys: Keyframe[] } & Record<string, unknown>)[] };
function fixtureSample(keys: Keyframe[], time: number): Keyframe['value'] {
  const i = keys.findIndex(k => k.time >= time);
  if (i < 0) return keys.at(-1)!.value;
  if (i === 0 || keys[i].time === time) return keys[i].value;
  const a = keys[i - 1], b = keys[i];
  let f = (time - a.time) / (b.time - a.time);
  if (b.ease === 'smooth') f = f * f * (3 - 2 * f);
  if (b.ease === 'easeIn') f *= f;
  if (b.ease === 'easeOut') f = 1 - (1 - f) ** 2;
  if (b.ease === 'step') f = 0;
  if (typeof a.value === 'number' && typeof b.value === 'number') return a.value + (b.value - a.value) * f;
  return (a.value as number[]).map((v, j) => v + ((b.value as number[])[j] - v) * f);
}
const sliceMotion = (motion: FixtureMotion, from: number, to: number, duration: number): FixtureMotion => ({
  duration,
  tracks: motion.tracks.map(track => ({
    ...track,
    keys: [
      { time: 0, value: fixtureSample(track.keys, from) },
      ...track.keys.filter(k => k.time > from && k.time < to).map(k => ({ ...k, time: (k.time - from) * duration / (to - from) })),
      { time: duration, value: fixtureSample(track.keys, to), ease: 'smooth' },
    ],
  })),
});
const environment = process.env;
async function runBalete(twoScenes: boolean) {
  const sceneSeconds = twoScenes ? 4.8 : 10;
  const narrationSeconds = twoScenes ? 9.6 : 10;
  const expectedFinalSeconds = narrationSeconds + 0.4;
  const expectedFrames = Math.round(sceneSeconds * 15);
  const root = mkdtempSync(join(tmpdir(), 'wander-animated-svg-e2e-'));
  const db = openDb();
  const engine = new Engine(db);
  const app = buildApi(engine, { root });
  type Method = 'GET' | 'POST' | 'PUT';
  const call = (method: Method, url: string, payload?: object, headers?: Record<string, string>) =>
    app.inject({ method, url, payload, headers });
  const ok = async (method: Method, url: string, payload?: object) => {
    const res = await call(method, url, payload);
    assert.ok(res.statusCode >= 200 && res.statusCode < 300, `${method} ${url}: ${res.statusCode} ${res.body.slice(0, 900)}`);
    return res;
  };
  const json = async (method: Method, url: string, payload?: object) => (await ok(method, url, payload)).json();
  const approve = async (artifactId: string) => {
    await ok('POST', `/artifacts/${artifactId}/submit`);
    await ok('POST', `/artifacts/${artifactId}/approve`, {});
  };
  let pendingJob: string | undefined;
  try {
    const project = await json('POST', '/projects', { name: 'Balete Watcher acceptance', category: 'Folklore', languages: ['en'], formats: ['vertical_9x16'] });
    const projectId: string = project.id;
    const one = (kind: string) => {
      const artifact = engine.list(projectId).find(a => a.kind === kind);
      assert.ok(artifact, `Expected a ${kind} artifact`);
      return artifact;
    };
    const seedResearch = newResearchContent('The Balete Watcher is a fictional scene');
    await ok('PUT', `/artifacts/${one('research').id}/content`, { content: { ...seedResearch, sources: [{ id: "reference-fixture", url: "https://example.org/fictional-acceptance-fixture" }], checklist: seedResearch.checklist.map(item => ({ ...item, done: true })) } });
    await approve(one('research').id);
    const sections = twoScenes ? [
      { id: 'h', kind: 'hook', text: 'The traveler pauses beneath the balete tree and slowly raises his lantern.' },
      { id: 'm', kind: 'main', text: 'Beyond the roots, a watcher emerges and steps silently back into darkness.' },
    ] : [
      { id: 'h', kind: 'hook', text: 'At the old balete tree, a traveler lifts his lantern. For three breaths the forest looks empty. Then something looks back.' },
    ];
    const script = { title: 'The Balete Watcher', lang: 'en', preset: 'short_lt30', sections };
    await ok('PUT', `/artifacts/${one('script_base').id}/content`, { content: script });
    await approve(one('script_base').id);
    await ok('POST', `/artifacts/${one('script_lang').id}/seed-from-base`);
    await approve(one('script_lang').id);
    const storyboard = one('storyboard');
    await ok('POST', `/artifacts/${storyboard.id}/seed-storyboard`, { scene_seconds: 10 });
    const current = await json('GET', `/artifacts/${storyboard.id}`);
    const scenes = sections.map((section, i) => {
      const seed = current.content.scenes.find((sc: { script_segment_id: string }) => sc.script_segment_id === section.id);
      assert.ok(seed, 'seeding provides a scene for each narration section');
      return { ...seed, title: i === 0 ? 'Lantern raised' : 'Watcher revealed', draft: false, target_duration: sceneSeconds,
        visual_description: i === 0 ? 'A traveler pauses under the same balete, raising a swinging lantern.' : 'The Watcher emerges beyond the same traveler, roots and fog; keep the grade and focal point.',
        camera: { movement: 'static', intensity: 'subtle' }, transition_in: 'cut' };
    });
    await ok('PUT', `/artifacts/${storyboard.id}/content`, { content: { ...current.content, scenes } });
    await approve(storyboard.id);
    await ok('PUT', `/projects/${projectId}/animated-svg-settings`, { mode: 'animated', style: 'dark-folklore', fps: 24 });
    const animations = `/artifacts/${storyboard.id}/animated-svg`;
    assert.deepEqual(await json('GET', animations), scenes.map(() => null));
    const svg = readReference('balete-watcher.svg');
    const fullMotion: FixtureMotion = JSON.parse(readReference('animation.json'));
    const rig = JSON.parse(readReference('rig.json'));
    const renderedScenes: { assetId: string; clip: Buffer; start: Buffer; reveal: Buffer; measured: unknown }[] = [];
    let source: { revision: string; svg: string; rig: unknown } | undefined;
    let firstShotEnd: Buffer | undefined;
    for (let i = 0; i < scenes.length; i++) {
      const sceneUrl = `${animations}/${i}`;
      const animation = !twoScenes ? fullMotion : i === 0
        ? sliceMotion(fullMotion, 0, sceneSeconds, sceneSeconds)
        : sliceMotion(fullMotion, sceneSeconds, fullMotion.duration, sceneSeconds);
      let imported;
      if (i === 0) {
        imported = await json('POST', sceneUrl + '/import', { svg, animation, rig, scene: { title: 'The Balete Watcher', genre: 'dark folklore' } });
      } else {
        assert.ok(source);
        const reused = await json('POST', sceneUrl + '/reuse', { fromIndex: 0 });
        assert.equal(reused.state, 'draft');
        assert.equal(reused.scene.reusedFrom, source.revision);
        assert.equal(reused.svg, source.svg, 'reused traveler and environment are identical approved artwork');
        assert.deepEqual(reused.rig, source.rig, 'reused shot retains the exact character rig');
        imported = await json('POST', sceneUrl + '/import', { svg: reused.svg, animation, rig: reused.rig,
          scene: { ...reused.scene, title: 'A second shot within the same setting' }, revision: reused.revision });
      }
      assert.equal(imported.state, 'draft');
      assert.equal(imported.animation.duration, sceneSeconds);
      assert.ok(imported.layers.includes('watcher'));
      assert.notEqual((await call('POST', sceneUrl + '/render', { revision: imported.revision, preset: 'draft' })).statusCode, 202, 'a draft cannot be rendered');
      const start = (await ok('GET', sceneUrl + '/preview?time=0')).rawPayload;
      if (twoScenes && i === 0) firstShotEnd = (await ok('GET', sceneUrl + `/preview?time=${sceneSeconds}`)).rawPayload;
      if (twoScenes && i === 1) assert.deepEqual(start, firstShotEnd, 'the same approved environment and pose continue across the cut');
      const reveal = (await ok('GET', sceneUrl + `/preview?time=${twoScenes ? 3.8 : 5.6}`)).rawPayload;
      expectPng(start, 360, 640);
      expectPng(reveal, 360, 640);
      assert.notDeepEqual(start, reveal, 'different preview times produce different frame bytes');
      const approved = await json('POST', sceneUrl + '/approve', { revision: imported.revision });
      assert.equal(approved.state, 'approved');
      if (i === 0) source = approved;
      const accepted = await call('POST', sceneUrl + '/render', { revision: approved.revision, preset: 'draft' });
      assert.equal(accepted.statusCode, 202, accepted.body);
      const jobId: string = accepted.json().job.id;
      pendingJob = jobId;
      const deadline = Date.now() + 4 * 60_000;
      let job = await json('GET', `/jobs/${jobId}`);
      while ((job.state === 'queued' || job.state === 'running') && Date.now() < deadline) {
        await delay(300);
        job = await json('GET', `/jobs/${jobId}`);
      }
      assert.equal(job.state, 'succeeded', JSON.stringify(job).slice(-1800));
      pendingJob = undefined;
      const readback = (await json('GET', animations))[i];
      assert.equal(readback.state, 'rendered');
      assert.equal(readback.video.frames, expectedFrames);
      const stream = await ok('GET', sceneUrl + '/video');
      assert.equal(stream.headers['content-type'], 'video/mp4');
      const clip = join(root, `probe-scene-${i + 1}.mp4`);
      writeFileSync(clip, stream.rawPayload);
      const clipInfo = probe(clip);
      const video = clipInfo.streams.find((s: any) => s.codec_type === 'video');
      assert.deepEqual([video.codec_name, video.width, video.height, video.avg_frame_rate], ['h264', 360, 640, '15/1']);
      assert.equal(Number(video.nb_frames), expectedFrames);
      assert.ok(Math.abs(Number(clipInfo.format.duration) - sceneSeconds) < 0.05);
      assert.equal(clipInfo.streams.some((s: any) => s.codec_type === 'audio'), false, 'scene clips leave sound to composition');
      const range = await call('GET', sceneUrl + '/video', undefined, { range: 'bytes=0-31' });
      assert.equal(range.statusCode, 206);
      assert.deepEqual(range.rawPayload, stream.rawPayload.subarray(0, 32));
      const attached = await json('POST', sceneUrl + '/attach', { revision: imported.revision });
      assert.equal(attached.state, 'attached');
      assert.ok(attached.assetId);
      const asset = await json('GET', `/assets/${attached.assetId}`);
      assert.equal(asset.type, 'motion_graphic');
      assert.equal(asset.media_kind, 'video');
      assert.equal(asset.approval_status, 'pending');
      await ok('POST', `/assets/${attached.assetId}/approve`);
      const sceneAsset = engine.list(projectId, { kind: 'scene_asset' }).find(a => a.scene_id === asset.params.scene_id);
      assert.ok(sceneAsset);
      await approve(sceneAsset.id);
      assert.equal(engine.get(sceneAsset.id).state, 'approved');
      renderedScenes.push({ assetId: attached.assetId, clip: stream.rawPayload, start, reveal,
        measured: { width: video.width, height: video.height, fps: video.avg_frame_rate, frames: Number(video.nb_frames), duration: Number(clipInfo.format.duration) } });
    }
    const wav = join(root, 'acceptance-audio.wav');
    const spoken = twoScenes && environment.WANDER_ANIMATED_SVG_REAL_SPEECH === '1';
    const ff = (args: string[]) => execFileSync(ffmpegBinary(), ['-v', 'error', '-y', ...args], { cwd: root });
    if (spoken) {
      // Opt-in proof of real, local speech when this FFmpeg build provides libflite.
      // Automated tests use a tone to stay portable, including on macOS/Windows.
      const rawSpeech = join(root, 'spoken.wav');
      writeFileSync(join(root, 'spoken.txt'), sections.map(s => s.text).join(' '));
      ff(['-f', 'lavfi', '-i', 'flite=textfile=spoken.txt:voice=slt', rawSpeech]);
      const ratio = Math.min(2, Math.max(.5, Number(probe(rawSpeech).format.duration) / (narrationSeconds - .25)));
      ff(['-i', rawSpeech, '-af', `atempo=${ratio},apad,atrim=duration=${narrationSeconds}`, '-ar', '44100', wav]);
    } else {
      ff(['-f', 'lavfi', '-i', `sine=frequency=440:duration=${narrationSeconds}`, '-ar', '44100', wav]);
    }
    const audioId = one('audio').id;
    await ok('POST', `/artifacts/${audioId}/narration/import`, { path: wav, name: spoken ? 'Local spoken narration' : 'Acceptance narration tone' });
    let ambientId: string | undefined;
    if (twoScenes) {
      const ambientFile = join(root, 'ambience.wav');
      // Deterministic layered forest wind, present throughout but quieter than speech.
      ff(['-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.18:duration=${narrationSeconds}:seed=5912`,
        '-af', 'lowpass=f=410,highpass=f=38,afade=t=in:st=0:d=0.2', '-ar', '44100', ambientFile]);
      const ambient = await json('POST', `/projects/${projectId}/audio/import`, { path: ambientFile, kind: 'music', name: 'Forest wind (generated)', license: { type: 'own', commercial_use: 'yes' } });
      ambientId = ambient.id;
      await ok('PUT', `/artifacts/${audioId}/mix`, { mix: { music: [{ clip_id: ambient.id, gain_db: -13, fade_in: .2, fade_out: .5 }], ducking: { enabled: false } } });
    }
    await approve(audioId);
    await ok('POST', `/artifacts/${one('caption').id}/captions/align`, { method: 'heuristic' });
    const cap = await json('GET', `/artifacts/${one('caption').id}`);
    const fonts = await json('GET', '/fonts') as { family: string }[];
    const captionFont = fonts.find(f => ['DejaVu Sans', 'Arial Black', 'Arial', 'Liberation Sans'].includes(f.family)) ?? fonts[0];
    assert.ok(captionFont, 'at least one installed caption font is required');
    await ok('PUT', `/artifacts/${one('caption').id}/content`, { content: { ...cap.content, style: { ...cap.content.style, font_family: captionFont.family } } });
    await approve(one('caption').id);
    const composition = one('composition');
    await ok('POST', `/artifacts/${composition.id}/build-timeline`, {});
    const timeline = (await json('GET', `/artifacts/${composition.id}`)).content;
    assert.equal(timeline.scenes.length, scenes.length);
    assert.deepEqual(timeline.scenes.map((s: any) => s.asset.id), renderedScenes.map(s => s.assetId));
    assert.ok(timeline.scenes.every((s: any) => s.asset.kind === 'video'));
    if (ambientId) assert.ok(timeline.audio.music.some((a: any) => a.clip_id === ambientId));
    assert.equal(timeline.captions.enabled, true);
    await approve(composition.id);
    const rendered = await json('POST', `/artifacts/${composition.id}/render`, { variants: ['captioned'] });
    const finalPath = join(root, rendered.renders[0].rel_path);
    const finalInfo = probe(finalPath);
    assert.ok(finalInfo.streams.some((s: any) => s.codec_type === 'audio' && s.codec_name === 'aac'));
    assert.ok(finalInfo.streams.some((s: any) => s.codec_type === 'video' && s.codec_name === 'h264' && s.width === 1080 && s.height === 1920 && s.avg_frame_rate === '30/1'));
    assert.ok(Math.abs(Number(finalInfo.format.duration) - expectedFinalSeconds) <= 0.05);

    if (environment.WANDER_ANIMATED_SVG_E2E_OUT) {
      const out = twoScenes ? join(environment.WANDER_ANIMATED_SVG_E2E_OUT, 'two-scene') : environment.WANDER_ANIMATED_SVG_E2E_OUT;
      mkdirSync(out, { recursive: true });
      renderedScenes.forEach((scene, i) => {
        writeFileSync(join(out, `scene-${i + 1}-start.png`), scene.start);
        writeFileSync(join(out, `scene-${i + 1}-reveal.png`), scene.reveal);
        writeFileSync(join(out, twoScenes ? `balete-scene-${i + 1}.mp4` : 'balete-scene.mp4'), scene.clip);
      });
      writeFileSync(join(out, 'balete-composed-captioned.mp4'), readFileSync(finalPath));
      writeFileSync(join(out, 'measurements.json'), JSON.stringify({ twoScenes, spoken, ambient: !!ambientId,
        clips: renderedScenes.map(s => s.measured), finalDuration: Number(finalInfo.format.duration) }, null, 2));
    }
  } finally {
    if (pendingJob) {
      await call('POST', `/jobs/${pendingJob}/cancel`);
      // A running media child must notice the abort before its DB is closed.
      for (let tries = 0; tries < 30; tries++) {
        const job = await json('GET', `/jobs/${pendingJob}`);
        if (job.state !== 'queued' && job.state !== 'running') break;
        await delay(100);
      }
    }
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('Balete storyboard animation previews, passes review, renders MP4 in the queue and composes with captions and audio', { timeout: 10 * 60_000 }, async () => runBalete(false));
test('two approved Balete shots preserve reused artwork and compose a 10-second captioned 30fps MP4 with narration and ambience', { timeout: 10 * 60_000 }, async () => runBalete(true));
