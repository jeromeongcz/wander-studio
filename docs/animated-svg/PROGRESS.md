# Wander Studio animated SVG implementation checklist

Feature branch: `animated-svg`. A technical render is not visual acceptance. The
desktop workflow stays local-first and its static SVG behavior is still the default.

| Phase | What can be checked off | What is still open |
|---|---|---|
| 0. Baseline | [x] Recovered both plans and the exact high-detail Balete Watcher reference. [x] Isolated the branch. [x] Compared the full suite to unchanged main at `cff1127`. | Periodic checks on Windows and Mac when those hosts are available. |
| 1. Professional illustration | [x] Added art direction for anatomy, organic contours, focal hierarchy, atmosphere, color and motivated light. [x] Refined and inspected the editable Balete reference. | **Visual acceptance open:** creator rejected the reference render's look. Improve character and staging; approve a still before animating it. Do not infer art quality from path count. |
| 2. Script and scene planning | [x] Added static/animated/mixed, art styles, detail, quality, complexity, frame rate and capability selections. [x] Validated timed actions and kept per-scene continuity through ScriptWriter → Storyboard. | Visually verify a newly generated mixed project with a live provider. |
| 3. Multi-pass generation and review | [x] Layered planning, artwork, preview, source/vision critique, authorized refinement, choreography, validation. [x] Pinned existing provider on consent. [x] Tested local Ollama vision transport and review distinction with fixtures. | Live Codex ACP failed to start here; live Claude and compatible Ollama vision host not verified. Text review is not image QA. |
| 4. Continuity and movement | [x] Nested rigs, pivots, constraints, eased transforms and opacity, stepped cues and same-topology path deformation. [x] Exact approved scene and group reuse, including reusable vector library across projects. [x] In-scene character/environment performance and a two-shot continuity acceptance run. | Full expressive walking/running/action benchmark, reusable illustrated multi-view character sheets, and automatic audio-to-viseme alignment are not verified/complete. Use timed mouth layers and deformation manually where supported. |
| 5. Storyboard | [x] Import, preview/scrub, separate human approval, background generation/render jobs, targeted refinement, archive links, and revision-bound attach. [x] Real API tests plus compiled Chromium UI smoke with isolated fixtures. | Live-provider UI run; verify narrower screen/device workflows separately. |
| 6. SVG to MP4 | [x] Local deterministic frame capture using inert SVG and FFmpeg/librsvg; tested real H.264 movement, duration, no GPU, resource bounds, cancel and cleanup. [x] Scene presets and verified-render reuse. | 4K/60 stress testing across desktop platforms. FFmpeg must include librsvg and H.264 (refer to diagnostics). |
| 7. Production | [x] End-to-end two approved clips, exact reuse, final captioned 1080×1920 30 fps 300-frame H.264/AAC MP4; speech and ambience produced locally. [x] No auto publishing. [x] Existing full-suite failures compared with baseline. | Artistic acceptance, more mixed static/animated style fixtures, and live-provider acceptance remain open. |
| 8. Delivery | [x] Regular commits on `animated-svg`. [x] Evidence produced for technical validation. | Do not merge into `main` without separate approval. |

## Verification and quality gate

The technical Balete test produced two 4.8-second, 72-frame draft clips. The
same approved SVG and rig were used in both and the scene cut matched without
a jump. The composed 10.000-second output had 1080×1920 H.264 at 30 fps and
AAC containing offline narration plus generated forest ambience. This proves
the production path, **not** professional illustration or natural locomotion.
Existing failures on base main: macOS voice enumeration, thumbnail fixture,
and two FFmpeg constant-frame-rate transition fixtures.

Before marking illustration quality accepted, inspect a real still at phone
size and full size. The face, hand grip, costume and posture must read before
background detail. Check contact shadows, warm lantern light versus cool
ambient planes, and nonrepetitive organic silhouettes. Ask the creator to
approve that image first. Then inspect key poses and actual video for foot
contact, weight shifts, follow-through, restrained secondary motion, camera
direction and subtitle clarity.

## Local commands

- `npm ci && npm run typecheck && npm run build:web`
- `node --test app/server/test/animated-svg-*.test.ts app/server/test/ollama-vision.test.ts`
- `WANDER_ANIMATED_SVG_REAL_SPEECH=1 node --test app/server/test/animated-svg-e2e.test.ts` (optional FFmpeg flite support; default uses generated test audio)
- `WANDER_TEST_CHROMIUM=/path/to/chromium node app/web/test/animated-svg-browser.mjs` (compiled React app, fixture API)
- `npm start` then configure the existing provider, open Script and set Animated SVG, and use the per-scene Animated SVG controls in Storyboard.

Source requirements: prior *Animated SVG Scene Generation Plan*, *High-Quality
Animated SVG Generation Plan*, and the original high-detail Balete Watcher artwork.
The art fixture is versioned separately from the raw prior reference.

### Prompt-first art direction

Generate the drawing directly from the scene brief. Reference images, when
supplied with consent, guide style and anatomy; they are not traced or embedded.
Review the rendered frame at phone width before evaluating articulation. A
previous color trace lost too much fabric detail and forest depth and is not
an animation source. A new direct-vector still was rendered for review; artistic
approval and a live in-app generation test are still open.
