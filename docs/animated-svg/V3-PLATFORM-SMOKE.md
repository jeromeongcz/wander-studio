# Animated SVG v3 platform smoke

Run these checks on a native Windows or macOS machine, in a fresh disposable checkout of `animated-svg` whose path contains spaces. Use Node 22.18+ on the 22.x line or Node 24+, and an FFmpeg distribution with ffprobe, libx264, librsvg decoding and libass. Have at least one native font available for captions.

### Select a compatible FFmpeg build

Set `WANDER_FFPROBE` to the **absolute path to ffprobe** from the chosen build. Wander uses the ffmpeg next to it, even when another build is on PATH. The smoke command prints both versions and reports any missing capability.

- **Windows x64:** [MSYS2 UCRT64 FFmpeg](https://packages.msys2.org/packages/mingw-w64-ucrt-x86_64-ffmpeg) is built with these capabilities. Install `mingw-w64-ucrt-x86_64-ffmpeg` from the MSYS2 UCRT64 shell, then run Wander in native PowerShell/Node. Example: `$env:WANDER_FFPROBE = 'C:\msys64\ucrt64\bin\ffprobe.exe'`.
- **macOS:** Homebrew core's [`ffmpeg-full` formula](https://github.com/Homebrew/homebrew-core/blob/HEAD/Formula/f/ffmpeg-full.rb) is usable for general video work but may lack librsvg. The [separate Homebrew FFmpeg tap](https://github.com/homebrew-ffmpeg/homebrew-ffmpeg) supports `--with-librsvg`; [MacPorts FFmpeg 8](https://ports.macports.org/port/ffmpeg8/) with the `+gpl2` variant is another candidate. Use the matching ffprobe path and confirm the smoke check, rather than relying on a package name. Follow the package's instructions if an existing installation conflicts.

### Run the checks

1. At the repository root run `npm ci --include=dev` and `npm run smoke:animated-svg`. The smoke command builds the web UI and tests Storyboard PNG preview, H.264 export, fallback/retry behavior, mixed still/animated composition, and multiple FFmpeg transitions. It uses temporary fixtures and does not need an AI provider.
2. To also check Chromium, install the browser that matches this project's Playwright version: `node node_modules/playwright-core/cli.js install --only-shell chromium`. Require the Chromium tests before running the smoke command again: `$env:WANDER_TEST_CHROMIUM = '1'` in Windows PowerShell, or `export WANDER_TEST_CHROMIUM=1` in a macOS shell. The bundled browser is used by default. To use a different trusted, sandbox-capable Chromium executable, set `WANDER_CHROMIUM` to its full path. The strict check must pass without falling back.
3. In the disposable checkout, launch `npm start`, open `http://127.0.0.1:4317/` (or the port printed in the terminal), and confirm the web UI loads. Open `/health` at the same address and confirm it returns `{"ok":true}`. Stop the process when done.
4. Record the commit (`git rev-parse HEAD`), OS/architecture, Node version, FFmpeg version, whether Chromium was required, and the pass/fail output. Do not count a skipped Chromium test as verified. Native automated and startup checks do not replace [live artwork acceptance](V3-VISUAL-ACCEPTANCE.md).

[Hosted baseline: Windows Server 2025 x64 and macOS 15 ARM64](https://github.com/jeromeongcz/wander-studio/actions/runs/46083738343) passed app startup and CPU rendering with Node 22.23.5 and FFmpeg 9.1. The `animated-svg` workflow also requires Chromium on subsequent pushes. Hosted jobs do not certify an individual laptop and do not run live generation or multilingual phoneme review.
