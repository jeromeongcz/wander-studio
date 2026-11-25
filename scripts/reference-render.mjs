// Renders a fixed test composition (clean and folklore) from generated pictures and tones, and records a checksum of
// every video frame and of the decoded sound. Run it before and after renderer work to prove old output is unchanged:
//   node scripts/reference-render.mjs before
//   node scripts/reference-render.mjs after --compare before
// The folklore ending glitch is random in every run, so differences inside that last stretch are reported, not failed.
// Output goes to exports/reference/<label>/ (git-ignored). Nothing in your projects is read or written.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ffmpegBinary } from '../app/server/src/media.ts';
import { RenderService } from '../app/server/src/render/service.ts';
import { buildTimeline } from '../app/server/src/render/timeline.ts';
import { GLITCH_SECONDS, applyEffects } from '../app/server/src/render/effects.ts';
import { parseFormat } from '../app/server/src/render/formats.ts';
import { DEFAULT_STYLE } from '../app/server/src/captions/track.ts';

const [label, flag, other] = process.argv.slice(2);
if (!label || !/^[\w-]+$/.test(label) || (flag && (flag !== '--compare' || !/^[\w-]+$/.test(other ?? '')))) {
  console.error('Usage: node scripts/reference-render.mjs <label> [--compare <label>]');
  process.exit(2);
}
const base = join(dirname(fileURLToPath(import.meta.url)), '..', 'exports', 'reference');
const root = join(base, label);
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'in'), { recursive: true });
const ffmpeg = ffmpegBinary();
const ff = (...args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });

const moves = [
  { movement: 'static' },
  { movement: 'zoom', direction: 'in', intensity: 'medium' },
  { movement: 'zoom', direction: 'out' },
  { movement: 'pan', direction: 'left_to_right', intensity: 'strong' },
  { movement: 'pan', direction: 'up' },
  { movement: 'ken_burns', direction: 'in' },
  { movement: 'parallax', intensity: 'medium' },
];
const transitions = ['cut', 'cut', 'fade', 'dissolve', 'slide', 'wipe', 'zoom'];
const sources = ['testsrc2', 'smptebars', 'rgbtestsrc', 'testsrc'];
const assets = new Map(
  moves.map((_, i) => {
    const rel = join('in', `a${i}.png`);
    ff('-f', 'lavfi', '-i', `${sources[i % sources.length]}=size=720x1280`, '-vf', `hue=h=${i * 40}`, '-frames:v', '1', join(root, rel));
    return [`scene${i}`, { id: `a${i}`, sha256: `ref-${i}`, rel_path: rel, kind: 'image', width: 720, height: 1280, focal: { x: 0.5, y: 0.4 } }];
  }),
);
const length = moves.length * 2;
ff('-f', 'lavfi', '-i', `sine=frequency=330:duration=${length}`, '-ar', '44100', '-ac', '2', join(root, 'in', 'voice.wav'));
const words = moves.flatMap((_, i) => ['Eksena', `${i + 1}.`].map((text, k) => ({ text, section_id: `s${i}`, start: i * 2 + k * 0.8, end: i * 2 + k * 0.8 + 0.7 })));

const clean = buildTimeline({
  lang: 'en',
  format: parseFormat('vertical_9x16'),
  scenes: moves.map((camera, i) => ({ scene_id: `scene${i}`, script_segment_id: `s${i}`, target_duration: 2, title: `Scene ${i}`, camera, transition_in: transitions[i] })),
  assets,
  timelineWords: words,
  narration: { chunks: [{ clip_id: 'voice', rel_path: join('in', 'voice.wav'), start: 0, duration: length }], narration_total: length, mix: {}, music: [], sfx: [] },
  captionWords: words,
  style: DEFAULT_STYLE,
  overrides: {},
  source: {},
});

const svc = new RenderService(null, null, null, { root, maxImportBytes: 0, maxRemoteBytes: 0 });
const sums = {};
for (const [name, tl] of [['clean', clean], ['folklore', applyEffects(clean, 'folklore')]]) {
  const clips = [];
  for (const s of tl.scenes) clips.push((await svc.ensureSceneClip(tl, s)).path);
  const out = join(root, `${name}.mp4`);
  await svc.compose(tl, clips, await svc.ensureMix(tl), 'captioned', out);
  const verified = await svc.verify(out, tl);
  const hashes = (map) => ff('-i', out, '-map', map, '-f', 'framemd5', '-').toString().split('\n').filter((l) => l && !l.startsWith('#'));
  sums[name] = { video: hashes('0:v'), audio: hashes('0:a') };
  console.log(`${name}: ${out} (${verified.duration.toFixed(2)}s, ${sums[name].video.length} frames)`);
}
writeFileSync(join(root, 'frames.json'), JSON.stringify(sums));

if (other) {
  const was = JSON.parse(readFileSync(join(base, other, 'frames.json'), 'utf8'));
  let changed = 0;
  for (const name of Object.keys(was)) {
    for (const kind of ['video', 'audio']) {
      const a = was[name][kind];
      const b = sums[name]?.[kind] ?? [];
      const diff = Array.from({ length: Math.max(a.length, b.length) }, (_, i) => i).filter((i) => a[i] !== b[i]);
      const glitchFrom = name === 'folklore' && kind === 'video' ? Math.floor((clean.duration - GLITCH_SECONDS) * clean.format.fps) : Infinity;
      const real = diff.filter((i) => i < glitchFrom || i >= a.length);
      const note = diff.length - real.length ? ` (${diff.length - real.length} differ inside the random ending glitch, as expected)` : '';
      console.log(`${name} ${kind}: ${real.length ? `${real.length} of ${a.length} frames differ, first at ${real[0]}` : `identical to "${other}"`}${note}`);
      changed += real.length;
    }
  }
  process.exit(changed ? 1 : 0);
}
