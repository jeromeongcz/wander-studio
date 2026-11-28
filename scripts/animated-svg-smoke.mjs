// Run locally in a checkout of animated-svg. Fixtures use temporary projects and no AI provider.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireSupportedNode } from './runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function run() {
  if (!requireSupportedNode()) return 1;
  const { ffmpegBinary, ffprobeBinary } = await import('../app/server/src/media.ts');
  const ffmpeg = ffmpegBinary();
  const ffprobe = ffprobeBinary();
  const query = (bin, arg) => spawnSync(bin, ['-hide_banner', arg], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  const required = [
    [ffmpeg, '-version', /ffmpeg version/, 'FFmpeg'],
    [ffprobe, '-version', /ffprobe version/, 'ffprobe'],
    [ffmpeg, '-decoders', /\blibrsvg\b/, 'librsvg SVG decoder'],
    [ffmpeg, '-encoders', /\blibx264\b/, 'libx264 H.264 encoder'],
    [ffmpeg, '-filters', /^\s*\S+\s+subtitles\s/m, 'libass subtitles filter'],
  ];
  for (const [bin, arg, pattern, capability] of required) {
    const result = query(bin, arg);
    if (result.status !== 0 || !pattern.test(result.stdout ?? '')) {
      console.error(`Missing ${capability} from ${bin}. Set WANDER_FFPROBE to a compatible build's ffprobe and see docs/animated-svg/V3-PLATFORM-SMOKE.md.`);
      if (result.error) console.error(result.error.message);
      return 1;
    }
    if (arg === '-version') console.log(result.stdout.split(/\r?\n/, 1)[0]);
  }

  const env = { ...process.env, WANDER_ANIMATION_RENDERER: 'librsvg' };
  console.log(`Animated SVG smoke: ${process.platform}/${process.arch}, Node ${process.version}. Chromium ${env.WANDER_TEST_CHROMIUM ? 'required' : 'not requested'}.`);
  for (const command of [
    ['scripts/web-build.mjs'],
    ['--test', '--test-concurrency=1',
      'app/server/test/web-toolchain.test.ts',
      'app/server/test/animated-svg-render.test.ts',
      'app/server/test/animated-svg-mixed-composition.test.ts',
      'app/server/test/animated-svg-recovery.test.ts',
      'app/server/test/animated-svg-walk.test.ts',
      'app/server/test/animated-svg-dialogue.test.ts',
      'app/server/test/transitions.test.ts',
      'app/server/test/render-golden.test.ts',
    ],
  ]) {
    const result = spawnSync(process.execPath, command, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

process.exitCode = await run();
