// Run locally in a checkout of animated-svg. Fixtures use temporary projects and no AI provider.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireSupportedNode } from './runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function run() {
  if (!requireSupportedNode()) return 1;
  const { ffmpegBinary, ffprobeBinary } = await import('../app/server/src/media.ts');
  const decoders = spawnSync(ffmpegBinary(), ['-hide_banner', '-decoders'], { encoding: 'utf8', windowsHide: true });
  const probe = spawnSync(ffprobeBinary(), ['-version'], { encoding: 'utf8', windowsHide: true });
  if (decoders.status !== 0 || !/\blibrsvg\b/.test(decoders.stdout) || probe.status !== 0) {
    console.error('Animated SVG smoke requires FFmpeg with librsvg and ffprobe. See docs/animated-svg/V3-PLATFORM-SMOKE.md.');
    return 1;
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
