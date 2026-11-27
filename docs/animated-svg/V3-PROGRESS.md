# Animated SVG v3 progress
Target: `animated-svg` only. Preserve the historical still SVG prompt and static validation unchanged. Never merge to main as part of this work.

## Audited baseline
GitHub target at start: `ca22a5a62c00cc49b1f272130b30d5833bcc98fc`. Matching working tree at `1aabc38`. Inspection covered the static sketch route, validator and FFmpeg/Librsvg path; provider registry and Codex ACP / Claude Code / Ollama paths; script, storyboard, and saved animation direction; database, artifacts, asset storage/versioning and job cancellation; existing animation parser, rig and timeline; composition FFmpeg jobs; Storyboard animated tools and existing tests. v2 already has opt-in bundle generation/import, basic animation and rig validation, revision checks, CPU rendering, and video composition integration. Original static SVGs were discarded after PNG rasterization.

## Phases
- [x] 1: Pin existing still prompts with exact regression fixtures (portrait and landscape, with scene-specific notes and captions); static function and validator unchanged.
- [ ] 2: Derive artwork prompt from still baseline; independent exact prompt controls.
- [ ] 3: Preserve vector source, linkage, approval, and derivatives.
- [ ] 4: Extend validated motion, targeting, environment and deterministic motion evaluation.
- [ ] 5: Extend Storyboard controls, fidelity review, approval and timeline.
- [ ] 6: Add isolated Chromium rendering and validate MP4 output; retain CPU fallback.
- [ ] 7: Validate mixed composition, freshness, timing, camera ownership and audio.
- [ ] 8: Reusable performance and art-preserving rigs.
- [ ] 9: Optional refinement and rendered visual review.
- [ ] 10: Advanced animation and lip-sync.
- [ ] 11: Performance, hardening, platform and recovery tests.
- [ ] 12: Real Archival Sepia and Dark Folklore verification and separate artwork acceptance.

Checks are marked only when implemented and tested. Rendering success is not artistic approval.
