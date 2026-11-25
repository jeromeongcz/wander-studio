import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alignHeuristic, alignWithAsr, monotonic, normalizeWord, tokenize } from '../src/captions/align.ts';
import { DEFAULT_STYLE, checkAgainstScript, segmentWords, toSrt, toVtt, validateStyle, validateTrackShape } from '../src/captions/track.ts';
import type { CaptionWord } from '../src/captions/track.ts';
import { buildAss } from '../src/captions/ass.ts';
import { parseWhisperJson } from '../src/captions/whisper.ts';
import { parseSilence } from '../src/media.ts';
import { parseFormat, safeZoneFor } from '../src/render/formats.ts';
import { coverCrop, motionPlan, sceneClipArgs, sceneClipKey, zoompanFilter } from '../src/render/motion.ts';
import { computeSceneTimes } from '../src/render/timing.ts';
import { buildMixGraph, validateMixShape } from '../src/audio/mix.ts';
import { TtsRegistry, parseEdgeVoices, resolveBin } from '../src/audio/tts.ts';

const SCRIPT = [
  { id: 'h', text: 'Did you know octopuses have three hearts?' },
  { id: 'm', text: 'Two pump blood to the gills, and one serves the body.' },
];

test('tokenize keeps display text and drops empty tokens; normalize strips punctuation but keeps inner apostrophes/hyphens', () => {
  const w = tokenize([{ id: 'a', text: 'Mag-aral ka, "ha"? — Don’t go...' }]);
  assert.deepEqual(w.map((x) => x.norm), ['mag-aral', 'ka', 'ha', "don't", 'go']);
  assert.equal(w[0].text, 'Mag-aral');
  assert.equal(normalizeWord('"Hello!"'), 'hello');
});

test('parseSilence reads ffmpeg silencedetect logs, including trailing silence', () => {
  const log = `[silencedetect @ 0x1] silence_start: 0\n[silencedetect @ 0x1] silence_end: 0.31 | silence_duration: 0.31\n[silencedetect @ 0x1] silence_start: 1.9\n[silencedetect @ 0x1] silence_end: 2.4 | silence_duration: 0.5\n[silencedetect @ 0x1] silence_start: 4.5`;
  assert.deepEqual(parseSilence(log), [{ start: 0, end: 0.31 }, { start: 1.9, end: 2.4 }, { start: 4.5, end: Infinity }]);
});

test('heuristic alignment pins sentence boundaries to detected pauses and stays monotonic', () => {
  const words = tokenize(SCRIPT);
  const r = alignHeuristic(words, 6, [{ start: 0, end: 0.3 }, { start: 2.5, end: 3.1 }, { start: 5.6, end: Infinity }]);
  assert.equal(r.method, 'silence-anchored');
  assert.equal(r.timings.length, words.length);
  const firstSentenceEnd = r.timings[words.findIndex((w) => w.text.endsWith('?'))].end;
  const secondStart = r.timings[words.findIndex((w) => w.text === 'Two')].start;
  assert.ok(firstSentenceEnd <= 2.5 + 1e-6, `first sentence ends before the pause (${firstSentenceEnd})`);
  assert.ok(secondStart >= 3.1 - 1e-6, `second sentence starts after the pause (${secondStart})`);
  assert.ok(r.timings[0].start >= 0.3 - 1e-6, 'leading silence trimmed');
  assert.ok(r.timings.at(-1)!.end <= 5.6 + 1e-6, 'trailing silence trimmed');
  r.timings.forEach((t, i) => {
    assert.ok(t.end > t.start);
    if (i) assert.ok(t.start >= r.timings[i - 1].end - 1e-9);
  });
});

test('heuristic alignment falls back to proportional timing when pauses do not match', () => {
  const words = tokenize(SCRIPT);
  const r = alignHeuristic(words, 5, []);
  assert.equal(r.method, 'proportional');
  assert.equal(r.confidence, 'low');
  assert.ok(r.timings.at(-1)!.end <= 5 + 1e-9);
  assert.deepEqual(alignHeuristic([], 3, []).timings, []);
});

test('ASR alignment uses only timestamps: misspelled Taglish ASR output never changes canonical words', () => {
  const script = tokenize([{ id: 'a', text: 'Alam mo ba na may tatlong puso ang pugita?' }]);
  const asr = [
    { word: 'Alam', start: 0.1, end: 0.4 }, { word: 'mo', start: 0.4, end: 0.6 }, { word: 'bah', start: 0.6, end: 0.8 }, { word: 'na', start: 0.8, end: 0.9 },
    { word: 'my', start: 0.9, end: 1.1 }, { word: 'tatlung', start: 1.1, end: 1.6 }, { word: 'poso', start: 1.6, end: 2.0 }, { word: 'ang', start: 2.0, end: 2.2 }, { word: 'pugeeta', start: 2.2, end: 2.9 },
  ];
  const r = alignWithAsr(script, asr, 3);
  assert.equal(r.timings.length, script.length);
  assert.ok(r.matched >= 7, `matched ${r.matched}`);
  assert.equal(r.timings[5].start, 1.1); // "tatlong" took the time of ASR "tatlung"
  assert.ok(r.timings.every((t, i) => i === 0 || t.start >= r.timings[i - 1].end - 1e-9));
  assert.equal(script[5].text, 'tatlong'); // canonical spelling untouched
});

test('ASR alignment interpolates words the recogniser dropped and handles empty ASR', () => {
  const script = tokenize([{ id: 'a', text: 'one two three four five' }]);
  const r = alignWithAsr(script, [{ word: 'one', start: 0, end: 0.5 }, { word: 'five', start: 2.0, end: 2.5 }], 3);
  assert.equal(r.matched, 2);
  assert.ok(r.timings[2].start >= 0.5 && r.timings[3].end <= 2.0 + 1e-6);
  const none = alignWithAsr(script, [], 4);
  assert.equal(none.timings.length, 5);
  assert.equal(none.confidence, 'low');
  assert.ok(monotonic([{ start: 2, end: 1 }, { start: 0, end: 0.1 }], 5).every((t, i, a) => t.end > t.start && (!i || t.start >= a[i - 1].end)));
});

test('whisper JSON parsing keeps word tokens and skips markers', () => {
  const j = JSON.stringify({ transcription: [{ offsets: { from: 100, to: 400 }, text: ' Hello' }, { offsets: { from: 400, to: 900 }, text: ' [BLANK_AUDIO]' }, { offsets: { from: 900, to: 1200 }, text: ' world.' }] });
  assert.deepEqual(parseWhisperJson(j), [{ word: 'Hello', start: 0.1, end: 0.4 }, { word: 'world.', start: 0.9, end: 1.2 }]);
});

const W = (text: string, start: number, end: number, section_id = 'h', override = false): CaptionWord => ({ text, start, end, section_id, ...(override ? { override } : {}) });
const WORDS: CaptionWord[] = [W('Did', 0, 0.3), W('you', 0.3, 0.5), W('know', 0.5, 0.8), W('octopuses', 0.8, 1.4), W('have', 1.4, 1.6), W('three', 1.6, 1.9), W('hearts?', 1.9, 2.5), W('Two', 3.2, 3.5, 'm'), W('pump,', 3.5, 3.9, 'm'), W('and', 3.9, 4.1, 'm'), W('one', 4.1, 4.4, 'm')];

test('segmentation breaks at sentence ends and respects word/char budgets', () => {
  const segs = segmentWords(WORDS, { maxWords: 3, maxChars: 20 });
  assert.ok(segs.every((s) => s.words.length <= 3));
  assert.ok(segs.every((s) => s.text.length <= 20 || s.words.length === 1));
  const horizontal = segmentWords(WORDS, { maxWords: 10, maxChars: 56 });
  assert.equal(horizontal[0].text, 'Did you know octopuses have three hearts?');
  assert.equal(horizontal.length, 2);
  assert.ok(segs.length > horizontal.length);
});

test('SRT and VTT output uses correct timecodes and cue numbering', () => {
  const srt = toSrt(WORDS);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,500\nDid you know octopuses have three hearts\?/);
  assert.match(srt, /\n2\n00:00:03,200 --> /);
  const vtt = toVtt(WORDS);
  assert.ok(vtt.startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:02.500'));
  assert.match(srt, /Two pump, and one/);
  // long cues wrap to at most two lines
  const long = Array.from({ length: 14 }, (_, i) => W(`word${i}`, i * 0.3, i * 0.3 + 0.25));
  const lines = toSrt(long).split('\n\n')[0].split('\n').slice(2);
  assert.ok(lines.length <= 2);
});

test('spelling guardrail: captions must match the script unless a word is explicitly overridden', () => {
  const script = [{ id: 'h', text: 'Alam mo ba na may tatlong puso?' }];
  const ok = ['Alam', 'mo', 'ba', 'na', 'may', 'tatlong', 'puso?'].map((t, i) => W(t, i * 0.3, i * 0.3 + 0.25));
  assert.deepEqual(checkAgainstScript(ok, script), []);
  const asrSpelled = ok.map((w) => ({ ...w }));
  asrSpelled[5].text = 'tatlung';
  const problems = checkAgainstScript(asrSpelled, script);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /tatlung.*tatlong/);
  asrSpelled[5].override = true;
  assert.deepEqual(checkAgainstScript(asrSpelled, script), []);
  assert.match(checkAgainstScript(ok.slice(0, 5), script)[0], /5 words but the script has 7/);
});

test('track validation rejects overlaps, words past the audio, and bad styles', () => {
  const base = { lang: 'en', method: 'manual', confidence: 'high', audio_ref: ['c1'], duration: 3, style: DEFAULT_STYLE, words: [W('a', 0, 1), W('b', 1, 2)] };
  assert.doesNotThrow(() => validateTrackShape(base));
  assert.throws(() => validateTrackShape({ ...base, words: [W('a', 0, 1.5), W('b', 1, 2)] }), /overlaps/);
  assert.throws(() => validateTrackShape({ ...base, words: [W('a', 0, 4)] }), /ends after the narration/);
  assert.throws(() => validateTrackShape({ ...base, words: [W('a', 2, 1)] }), /invalid timing/);
  assert.throws(() => validateStyle({ ...DEFAULT_STYLE, color: 'red' }), /#RRGGBB/);
  assert.throws(() => validateStyle({ ...DEFAULT_STYLE, font_family: 'Arial,{evil}' }), /plain font name/);
  assert.throws(() => validateStyle({ ...DEFAULT_STYLE, animation: 'spin' }), /animation/);
});

test('formats: presets, custom ids and validation; each orientation gets its own safe zone', () => {
  assert.deepEqual([parseFormat('vertical_9x16').width, parseFormat('vertical_9x16').height], [1080, 1920]);
  assert.equal(parseFormat('horizontal_16x9').orientation, 'landscape');
  const c = parseFormat('custom_1280x720_24');
  assert.deepEqual([c.width, c.height, c.fps, c.orientation], [1280, 720, 24, 'landscape']);
  assert.equal(parseFormat('custom_1000x1000').orientation, 'square');
  for (const bad of ['custom_1281x720', 'custom_100x100', 'wide', 'custom_9000x9000']) assert.throws(() => parseFormat(bad), /format|Format|dimensions/i);
  const v = safeZoneFor(parseFormat('vertical_9x16'));
  const h = safeZoneFor(parseFormat('horizontal_16x9'));
  assert.ok(v.bottom > h.bottom, 'Shorts keeps captions higher, above the title/description area');
  assert.ok(v.right > h.right, 'Shorts leaves room for the right-hand buttons');
  assert.ok(v.max_words <= 4 && h.max_words >= 7);
});

test('ASS captions: safe-zone margins, per-format sizing, active-word events, fitted font, no overflow tags', () => {
  const style = { ...DEFAULT_STYLE, animation: 'fade' as const };
  for (const id of ['vertical_9x16', 'horizontal_16x9', 'square_1x1']) {
    const f = parseFormat(id);
    const z = safeZoneFor(f);
    const ass = buildAss({ words: WORDS, style, format: f, zone: z });
    assert.match(ass, new RegExp(`PlayResX: ${f.width}\\nPlayResY: ${f.height}`));
    const styleLine = ass.split('\n').find((l) => l.startsWith('Style: Cap'))!.split(',');
    const [size, , , , , , , , , , , , , , , , , , mL, mR, mV] = [styleLine[2], ...styleLine.slice(3)];
    assert.equal(Number(size), Math.round(f.height * z.font_scale), `${id} font size`);
    assert.equal(Number(styleLine[19]), Math.round(f.width * z.left));
    assert.equal(Number(styleLine[20]), Math.round(f.width * z.right));
    assert.equal(Number(styleLine[21]), Math.round(f.height * z.bottom));
    void mL; void mR; void mV;
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    assert.equal(dialogues.length, WORDS.length, 'one event per word with active-word highlight');
    assert.ok(dialogues.some((d) => d.includes('\\c&H0000D4FF')), 'active word colour (BGR of #FFD400)');
  }
  const plain = buildAss({ words: WORDS, style: { ...style, active_word: { ...style.active_word, enabled: false } }, format: parseFormat('vertical_9x16'), zone: safeZoneFor(parseFormat('vertical_9x16')) });
  assert.equal(plain.split('\n').filter((l) => l.startsWith('Dialogue:')).length, segmentWords(WORDS, { maxWords: 4, maxChars: 24 }).length);
});

test('ASS: long words shrink the font to fit, markup characters are stripped, per-scene placement overrides apply', () => {
  const f = parseFormat('vertical_9x16');
  const z = safeZoneFor(f);
  const long = [W('Supercalifragilisticexpialidocious', 0, 1), W('{\\b1}evil', 1, 2)];
  const ass = buildAss({ words: long, style: { ...DEFAULT_STYLE, active_word: { ...DEFAULT_STYLE.active_word, enabled: false } }, format: f, zone: z, placement: [{ from: 1, to: 2, y_pct: 0.4 }] });
  const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.match(lines[0], /\\fs\d+/);
  const fitted = Number(lines[0].match(/\\fs(\d+)/)![1]);
  assert.ok(fitted < Math.round(f.height * z.font_scale));
  assert.ok(fitted * 34 * 0.56 <= f.width * z.max_width_frac + 1, 'fitted text width is inside the safe width');
  assert.ok(!lines[1].includes('{\\b1}'), 'injected override tags removed');
  assert.match(lines[1], /\\pos\(\d+,768\)/);
  const upper = buildAss({ words: [W('hi', 0, 1)], style: { ...DEFAULT_STYLE, uppercase: true, active_word: { ...DEFAULT_STYLE.active_word, enabled: false } }, format: f, zone: z });
  assert.match(upper, /HI/);
});

test('cover crop keeps the focal point in frame across aspect ratios', () => {
  const src = { w: 4000, h: 3000 };
  const focal = { x: 0.8, y: 0.3 };
  for (const id of ['vertical_9x16', 'horizontal_16x9', 'square_1x1']) {
    const f = parseFormat(id);
    const c = coverCrop(src, { w: f.width, h: f.height }, focal);
    assert.ok(Math.abs(c.w / c.h - f.width / f.height) < 0.01, `${id} aspect`);
    assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= src.w && c.y + c.h <= src.h);
    assert.ok(focal.x * src.w >= c.x && focal.x * src.w <= c.x + c.w, `${id} focal x inside crop`);
    assert.ok(focal.y * src.h >= c.y && focal.y * src.h <= c.y + c.h, `${id} focal y inside crop`);
  }
  assert.deepEqual(coverCrop(src, { w: 1080, h: 1080 }, { x: 0.5, y: 0.5 }, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }).w, 2000);
});

test('camera plans: zoom/ken-burns/pan stay inside the image; static does not move; intensity scales', () => {
  const fr = { x: 0.5, y: 0.5 };
  assert.deepEqual(motionPlan({ movement: 'static' }, fr), { z0: 1, z1: 1, cx0: 0.5, cy0: 0.5, cx1: 0.5, cy1: 0.5 });
  const zin = motionPlan({ movement: 'zoom', direction: 'in' }, fr);
  const zout = motionPlan({ movement: 'zoom', direction: 'out' }, fr);
  assert.ok(zin.z1 > zin.z0 && zout.z1 < zout.z0);
  assert.ok(motionPlan({ movement: 'zoom', intensity: 'strong' }, fr).z1 > motionPlan({ movement: 'zoom', intensity: 'subtle' }, fr).z1);
  const pan = motionPlan({ movement: 'pan', direction: 'left_to_right' }, fr);
  assert.ok(pan.cx1 > pan.cx0 && pan.z0 > 1);
  const half = 0.5 / pan.z0;
  assert.ok(pan.cx0 - half >= -1e-9 && pan.cx1 + half <= 1 + 1e-9, 'pan window never leaves the image');
  assert.ok(motionPlan({ movement: 'pan', direction: 'right_to_left' }, fr).cx1 < 0.5);
  const kb = motionPlan({ movement: 'ken_burns' }, { x: 0.9, y: 0.2 });
  assert.ok(kb.cx1 > 0.5 && kb.cy1 < 0.5, 'ken burns drifts toward the focal point');
  assert.match(zoompanFilter(zin, 90, { w: 1080, h: 1920 }, 30), /^zoompan=z='1\+\(1\.1\)-?1\*on\/89'|zoompan=z='/);
});

test('scene clip cache key changes with pixels-affecting inputs only', () => {
  const base = { asset: { path: '/x/a.png', kind: 'image' as const, width: 100, height: 50, sha256: 'aa' }, focal: { x: 0.5, y: 0.5 }, camera: { movement: 'zoom' as const }, duration: 3, width: 1080, height: 1920, fps: 30 };
  const k = sceneClipKey(base);
  assert.equal(sceneClipKey({ ...base, asset: { ...base.asset, path: '/elsewhere/a.png' } }), k, 'path is not part of the key');
  assert.notEqual(sceneClipKey({ ...base, asset: { ...base.asset, sha256: 'bb' } }), k);
  assert.notEqual(sceneClipKey({ ...base, focal: { x: 0.2, y: 0.5 } }), k);
  assert.notEqual(sceneClipKey({ ...base, camera: { movement: 'pan' } }), k);
  assert.notEqual(sceneClipKey({ ...base, duration: 3.5 }), k);
  assert.notEqual(sceneClipKey({ ...base, width: 1920, height: 1080 }), k);
  const args = sceneClipArgs(base, '/o.mp4').join(' ');
  assert.match(args, /zoompan/);
  assert.match(sceneClipArgs({ ...base, asset: { ...base.asset, kind: 'video' } }, '/o.mp4').join(' '), /-stream_loop -1/);
});

test('scene timing: scenes split their section by words, start at their first word, first starts at 0 and last runs to the end', () => {
  const scenes = [
    { scene_id: 's1', script_segment_id: 'h', segment_text: 'Did you know', target_duration: 2 },
    { scene_id: 's2', script_segment_id: 'h', segment_text: 'octopuses have three hearts?', target_duration: 2 },
    { scene_id: 's3', script_segment_id: 'm', segment_text: 'Two pump, and one', target_duration: 2 },
  ];
  const t = computeSceneTimes(scenes, WORDS, 5);
  assert.equal(t[0].start, 0);
  assert.equal(t[1].start, 0.8); // first word of "octopuses have three hearts?"
  assert.equal(t[2].start, 3.2);
  assert.equal(t.at(-1)!.start + t.at(-1)!.duration, 5);
  assert.ok(t.every((x) => x.source === 'audio'));
  const sum = t.reduce((n, x) => n + x.duration, 0);
  assert.ok(Math.abs(sum - 5) < 0.01, 'durations tile the narration with no gaps');
  // a section with no narration falls back to its target duration and is flagged as an estimate
  const t2 = computeSceneTimes([...scenes, { scene_id: 's4', script_segment_id: 'zzz', target_duration: 2 }], WORDS, 6);
  assert.equal(t2[3].source, 'estimate');
  // equal weights fallback when segment_text is missing
  const t3 = computeSceneTimes([{ scene_id: 'a', script_segment_id: 'h', target_duration: 1 }, { scene_id: 'b', script_segment_id: 'h', target_duration: 1 }], WORDS.slice(0, 7), 3);
  assert.ok(t3[1].start > 0.5 && t3[1].start < 2.5);
});

test('mix graph: narration delays, music ducking/fades/loop, sfx placement, limiter; validation of the spec', () => {
  const g = buildMixGraph({
    narration: [{ path: '/n1.wav', start: 0 }, { path: '/n2.wav', start: 2.75 }],
    music: [{ path: '/m.mp3', spec: { clip_id: 'm', gain_db: -16, fade_in: 1, fade_out: 2, loop: true } }],
    sfx: [{ path: '/s.wav', spec: { clip_id: 's', at: 1.5, gain_db: -3 } }],
    spec: { ducking: { enabled: true, amount: 10 } },
    duration: 8,
  });
  assert.deepEqual(g.inputs, ['/n1.wav', '/n2.wav', '/m.mp3', '/s.wav']);
  assert.match(g.filter, /adelay=2750\|2750/);
  assert.match(g.filter, /aloop=loop=-1/);
  assert.match(g.filter, /afade=t=in:st=0:d=1/);
  assert.match(g.filter, /afade=t=out:st=6\.000:d=2/);
  assert.match(g.filter, /sidechaincompress=threshold=0\.03:ratio=10/);
  assert.match(g.filter, /adelay=1500\|1500/);
  assert.match(g.filter, /alimiter/);
  assert.equal(g.out, '[aout]');
  const noMusic = buildMixGraph({ narration: [{ path: '/n.wav', start: 0 }], music: [], sfx: [], spec: {}, duration: 3 });
  assert.ok(!noMusic.filter.includes('sidechaincompress'));
  const noDuck = buildMixGraph({ narration: [{ path: '/n.wav', start: 0 }], music: [{ path: '/m.mp3', spec: { clip_id: 'm' } }], sfx: [], spec: { ducking: { enabled: false } }, duration: 3 });
  assert.ok(!noDuck.filter.includes('sidechaincompress'));
  assert.throws(() => buildMixGraph({ narration: [], music: [], sfx: [], spec: {}, duration: 1 }), /No narration/);
  assert.throws(() => validateMixShape({ music: [{ clip_id: 'x', gain_db: 99 }] }), /gain_db/);
  assert.throws(() => validateMixShape({ ducking: { enabled: 'yes' } }), /ducking/);
  assert.deepEqual(validateMixShape(undefined), {});
});

test('TTS providers: availability, voices and synthesis plumbing through stub binaries (no network, no real engines)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wander-stub-'));
  const argsLog = join(dir, 'args.log');
  const stub = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  // fake ffmpeg: copies input to output (last arg), so the provider pipeline completes
  const ffprobe = join(dir, 'ffprobe');
  stub('ffmpeg', 'for a; do last="$a"; done; cp "$IN" "$last" 2>/dev/null || echo wav > "$last"');
  const piperBin = stub('piper', `echo "$@" >> "${argsLog}"; cat > /dev/null; echo data > "$(echo "$@" | sed 's/.*--output_file //')"`);
  const edgeBin = stub('edge-tts', `echo "$@" >> "${argsLog}"; out=""; while [ $# -gt 0 ]; do [ "$1" = "--write-media" ] && out="$2"; shift; done; echo mp3 > "$out"`);
  const model = join(dir, 'voice.onnx');
  writeFileSync(model, 'x');
  const reg = new TtsRegistry({ ffmpeg: ffprobe, piper: { bin: piperBin, models: { tl: model } }, edge: { bin: edgeBin } });

  assert.deepEqual(reg.list().map((p) => p.id), ['macos-say', 'piper', 'edge-tts']);
  assert.equal(reg.get('edge-tts').terms.online, true);
  assert.equal(reg.get('piper').terms.online, false);
  assert.ok(reg.list().every((p) => p.terms.requiresKey === false && p.terms.privacy && p.terms.commercialUse));
  assert.equal((await reg.get('piper').available()).ok, true);
  assert.equal((await reg.get('edge-tts').available()).ok, true);
  assert.equal((await new TtsRegistry({ piper: { bin: piperBin, models: {} } }).get('piper').available()).ok, false);
  assert.equal((await new TtsRegistry({ edge: { bin: join(dir, 'nope') } }).get('edge-tts').available()).ok, false);
  assert.ok((await reg.get('edge-tts').voices()).some((v) => v.id === 'fil-PH-BlessicaNeural'));
  assert.deepEqual((await reg.get('piper').voices()).map((v) => v.id), ['tl']);

  const out = join(dir, 'o.wav');
  await assert.rejects(() => reg.get('edge-tts').synthesize({ text: 'hi', voice: 'not a voice; rm -rf /', outWav: out }), /Edge voice ids/);
  await assert.rejects(() => reg.get('piper').synthesize({ text: 'hi', voice: 'unknown', outWav: out }), /No Piper model/);
  const log = () => (existsSync2(argsLog) ? readFileSync(argsLog, 'utf8') : '');
  void log;
});

import { existsSync as existsSync2 } from 'node:fs';

test('Edge voice list parsing keeps neural voices with gender and locale; unparseable output yields nothing', () => {
  const table = [
    'Name                              Gender    ContentCategories      VoicePersonalities',
    '--------------------------------  --------  ---------------------  --------------------------------------',
    'en-PH-JamesNeural                 Male      General                Friendly, Positive',
    'fil-PH-BlessicaNeural             Female    General                Friendly, Positive',
    'zh-CN-liaoning-XiaobeiNeural      Female    General                Friendly, Positive',
    'not a voice line',
  ].join('\n');
  const v = parseEdgeVoices(table);
  assert.deepEqual(v.map((x) => x.id), ['en-PH-JamesNeural', 'fil-PH-BlessicaNeural']);
  assert.deepEqual(v[1], { id: 'fil-PH-BlessicaNeural', name: 'Blessica (female)', locale: 'fil-PH' });
  assert.deepEqual(parseEdgeVoices('garbage\nmore garbage'), []);
  // an explicit override always wins; otherwise a bare name is returned when nothing is installed
  assert.equal(resolveBin('edge-tts', '/custom/edge-tts'), '/custom/edge-tts');
  assert.match(resolveBin('definitely-not-installed-xyz'), /definitely-not-installed-xyz$/);
});

test('Edge TTS lists voices from the CLI, caches them, and falls back to known voices when the CLI fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wander-edge-'));
  const counter = join(dir, 'calls');
  const list = join(dir, 'edge-ok');
  writeFileSync(list, `#!/bin/sh\necho x >> "${counter}"\nprintf 'Name  Gender  X  Y\\nfil-PH-AngeloNeural   Male   General   Friendly\\n'\n`);
  chmodSync(list, 0o755);
  const ok = new TtsRegistry({ edge: { bin: list } }).get('edge-tts');
  assert.deepEqual((await ok.voices()).map((v) => v.id), ['fil-PH-AngeloNeural']);
  await ok.voices();
  assert.equal(readFileSync(counter, 'utf8').trim().split('\n').length, 1, 'second call served from the 10-minute cache');
  const broken = join(dir, 'edge-bad');
  writeFileSync(broken, '#!/bin/sh\nexit 1\n');
  chmodSync(broken, 0o755);
  const fallback = await new TtsRegistry({ edge: { bin: broken } }).get('edge-tts').voices();
  assert.ok(fallback.some((v) => v.id === 'fil-PH-BlessicaNeural'), 'falls back to the known Filipino voices');
  // a failing synthesis is reported as a provider problem, not a crash
  await assert.rejects(() => new TtsRegistry({ edge: { bin: broken } }).get('edge-tts').synthesize({ text: 'hi', voice: 'fil-PH-AngeloNeural', outWav: join(dir, 'o.wav') }), (e: any) => e.code === 'PROVIDER_ERROR' && /internet/.test(e.message));
});
