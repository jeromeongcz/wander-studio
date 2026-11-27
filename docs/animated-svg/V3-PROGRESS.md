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

### Phase 2 checkpoint: exact Storyboard requests

- Storyboard generation now starts from the protected still prompt, including the scene's dimensions, position, style notes, and caption-safe settings. Layered artwork requirements are appended separately. The motion request is still a separate stage.
- After successful generation, Animated SVG → Artwork → Show exact artwork prompt exposes the exact text sent for the base artwork request on that revision. Animation → Show exact motion prompt independently exposes the exact motion request. Both include planning details when applicable. Copying makes no provider request, exposes no reference image bytes, and does not approximate prompts not sent yet.
- Verified through queued Storyboard jobs with a capturing provider for single-pass and multi-pass, including generated art direction, unchanged static prompt output, and stale-revision rejection. Broader independent prompt controls and visual acceptance are still open.
- A live Codex check could not start the ACP app-server in this read-only execution environment. The Codex CLI fallback hit the same startup restriction. No live output was generated, and no art quality result is claimed.
