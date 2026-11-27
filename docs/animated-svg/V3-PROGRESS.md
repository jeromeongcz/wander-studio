# Animated SVG v3 progress
Target: `animated-svg` only. Preserve the historical still SVG prompt and static validation unchanged. Never merge to main as part of this work.

## Audited baseline
GitHub target at start: `ca22a5a62c00cc49b1f272130b30d5833bcc98fc`. Matching working tree at `1aabc38`. Inspection covered the static sketch route, validator and FFmpeg/Librsvg path; provider registry and Codex ACP / Claude Code / Ollama paths; script, storyboard, and saved animation direction; database, artifacts, asset storage/versioning and job cancellation; existing animation parser, rig and timeline; composition FFmpeg jobs; Storyboard animated tools and existing tests. v2 already has opt-in bundle generation/import, basic animation and rig validation, revision checks, CPU rendering, and video composition integration. At baseline, original static SVGs were discarded after PNG rasterization.

## Phases
- [x] 1: Pin existing still prompts with exact regression fixtures (portrait and landscape, with scene-specific notes and captions); static function and validator unchanged.
- [x] 2: Derive artwork prompt from still baseline; independent exact prompt controls.
- [x] 3: Preserve vector source, linkage, approval, and derivatives.
- [x] 4: Extend validated motion, targeting, environment and deterministic motion evaluation.
- [x] 5: Extend Storyboard controls, fidelity review, approval and timeline.
- [x] 6: Add isolated Chromium rendering and validate MP4 output; retain CPU fallback.
- [x] 7: Validate mixed composition, freshness, timing, camera ownership and audio.
- [x] 8: Reusable performance and art-preserving rigs.
- [x] 9: Optional refinement and rendered visual review.
- [ ] 10: Advanced animation and lip-sync.
- [ ] 11: Performance, hardening, platform and recovery tests.
- [ ] 12: Real Archival Sepia and Dark Folklore verification and separate artwork acceptance.

Checks are marked only when implemented and tested. Rendering success is not artistic approval.

### Phase 2 checkpoint: exact Storyboard requests

- Storyboard generation now starts from the protected still prompt, including the scene's dimensions, position, style notes, and caption-safe settings. Layered artwork requirements are appended separately. The motion request is still a separate stage.
- After successful generation, Animated SVG → Artwork → Show exact artwork prompt exposes the exact text sent for the base artwork request on that revision. Animation → Show exact motion prompt independently exposes the exact motion request. Both include planning details when applicable. Copying makes no provider request, exposes no reference image bytes, and does not approximate prompts not sent yet.
- Verified through queued Storyboard jobs with a capturing provider for single-pass and multi-pass, including generated art direction, unchanged static prompt output, and stale-revision rejection. Broader independent prompt controls and visual acceptance are still open.
- A live Codex check could not start the ACP app-server in this read-only execution environment. The Codex CLI fallback hit the same startup restriction. No live output was generated, and no art quality result is claimed.

### Integrated implementation checkpoint

The default static preview, validator, prompt and composition path still behave as before. New static sketches also retain their already-validated SVG source for an explicit **Copy approved still SVG** action. Original images made before this update cannot be recovered from their PNG derivatives.

| Phase | Implemented and verified | Remaining acceptance |
| --- | --- | --- |
| 1–2 | Frozen still prompt; opt-in derived artwork instructions; exact, separately copyable base artwork and motion requests for the saved revision. | Multi-pass text is available once the provider requests are known, not approximated before planning. |
| 3 | Additive SQLite source/revision migration, SVG hashes and lineage, immutable artwork across motion-only changes, older SVG/MP4 downloads, restore as a new draft. | Pre-migration still source cannot be reconstructed automatically. |
| 4 | Bounded and deterministic targeting, ambient loops, IK and ordered track evaluation; selected motion can be revised without touching the drawing. | The optional planted-foot walk covers bounded 2D side-profile shots; turning and running are not driven by this walk. |
| 5 | Storyboard artwork-first approval, motion and MP4 gates, preview playhead with key markers, revision history, optional quality passes and Mixed-mode choice per scene. | The track property editor still uses validated JSON, not a drag-and-drop curve editor. |
| 6 | Actual preview and MP4 jobs use isolated Chromium or CPU librsvg with validated output and backend-aware reuse. Both Linux paths verified with real renders. | Validate each host's browser installation before selecting strict Chromium. |
| 7 | Fresh attached revisions, mixed primary visuals, single camera ownership, silent source clips, and narration-owned timing. Verified with real mixed FFmpeg export. | Live-model artwork is a separate quality gate. |
| 8 | Approved character groups carry their rig and local SVG dependencies through the library. Placement remaps joint and SVG IDs, preserves limits, and leaves other layers untouched. Rendered the same fixture character into two independently animated storyboard MP4s. | The test used fixture artwork and an offline motion provider; judge visual continuity on real artwork in Phase 12. |
| 9 | Optional stage budgets, revision limits, and separately consented visual feedback. Reviews distinguish rendered-vision evidence from source-only feedback and never replace human approval. | A real rendered-vision provider needs testing on an authenticated host. |
| 10 | Bounded two-bone IK, ambient cycles, manual visemes, and optional local audio-based mouth timing. A bounded side-profile walk now coordinates body travel, alternating foot plants, knees, ankles and counter-swinging arms; checked at subframes and exported as an MP4. Both Rhubarb recognition modes returned editable cues through the Storyboard API on Linux. | Scene WAV excerpts are chosen manually; accuracy in Filipino, Taglish, and Cebuano and natural locomotion in live artwork still need review. |
| 11 | Bounded preview concurrency with shared identical requests, fewer render-progress writes, cancellation, SVG validation, and restart recovery. Verified MP4 digests catch same-size damage, and a failed replacement keeps the prior clip. | Windows and macOS runtime/device checks have not been run in this Linux workspace. |
| 12 | [Two-scene live acceptance protocol](V3-VISUAL-ACCEPTANCE.md), with distinct Archival Sepia and Dark Folklore presets. | Codex ACP could not start in this environment; Claude CLI was unavailable. No live art or artistic approval is claimed. |

For release validation, use a disposable project and a copy of the project database. Leave the still pipeline as the default. Use `WANDER_ANIMATION_RENDERER=librsvg` to explicitly select the CPU fallback or `chromium` to fail closed when a trusted sandbox-capable browser cannot launch. The default `auto` falls back only on browser startup failure. Restart an interrupted provider generation from its scene after reconfirming the active provider; image references are held in memory for the original job, not persisted or silently resent.

**Optional local lip sync:** Install [Rhubarb Lip Sync](https://github.com/DanielSWolf/rhubarb-lip-sync#how-to-run-rhubarb-lip-sync) on the Wander host and put it on `PATH` or set `WANDER_RHUBARB_BIN` to its executable. Enable dialogue and, in the Animation tab, choose a WAV excerpt that starts at the beginning of the scene. English and multilingual phonetic modes are available. The file is processed locally and deleted from temporary storage; only reviewed cue timings may be included in a subsequent motion generation request. A long, dense passage can exceed the 38-cue safety bound and should be split or edited manually.

**Reuse a rigged character:** In a source scene, approve the artwork, then open Layers and save a named character group to the vector library. In a second scene, choose that character in Artwork and enter an existing drawable group ID as its placeholder. **Place rigged character without AI** creates a new artwork draft using the placeholder’s placement transform. Review and approve the new artwork, then generate motion or bind a saved role-based motion clip. Joints outside the source character group are not copied, and the destination’s unrelated artwork and joints stay in place. Older vector-library entries without a saved rig remain usable as artwork.

**Planted-foot walk:** For a compatible side-profile rig, use Advanced complexity and Character animation, then request a short walk in the Animation tab. See [the walk specification](V3-WALK.md). This verifies deterministic foot contact on fixture art, not live-provider illustration or multilingual lip-sync quality.

**Recovery:** If a new render is damaged or missing, render that revision again. Retrying an interrupted render is local and does not contact a provider. Restart an interrupted AI generation from Storyboard so you can confirm the provider and references again.
