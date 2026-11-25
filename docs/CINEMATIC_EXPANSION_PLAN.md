# Cinematic expansion: implementation plan

Status: **approved 2026-11-26 with the recommended answers A to D; building one phase at a time**. Baseline on 2026-11-26: `npm test` 144 passed, 1 skipped, 0 failed.

## 1. How it works today

| Area | Today | Where |
|---|---|---|
| Script generation | One Claude call, no tools. Per section: narration plus a text visual brief. Choices: length, scene count, format, notes | `research/scriptwriter.ts`, `web/src/stages/ScriptWriter.tsx` |
| Storyboard | Built from the script **without AI** (`draftScenes`). Camera and transition come from the category profile | `studios/storyboard.ts` |
| Camera | `static`, `pan`, `zoom`, `ken_burns`, `parallax` (approximation); 3 intensities; linear movement; still images only | `render/motion.ts` |
| Transitions | `cut`, `fade`, `dissolve`, `slide`, `wipe`, `zoom` through FFmpeg `xfade`; fixed 0.4 s cap; no direction, duration or easing setting | `render/service.ts`, `render/timeline.ts` |
| Style | One effect, stored as `folklore`, shown as **"Dark folklore"** | `render/effects.ts`, `Compose.tsx` |
| Compose & Render | Style switch (Clean / Dark folklore), caption position per scene, preview, render | `web/src/stages/Compose.tsx` |
| Overrides | Per scene: crop and caption position only. Kept across rebuilds | `services.ts` `setSceneOverride` |
| Storage | Versioned JSON per artifact, `settings_json` per project. FFmpeg 9.1 has the filters needed | `engine.ts`, `db.ts` |

## 2. Where the request differs from the app

1. **The existing "Folklore" is the dark one.** It is stored as `folklore`, labelled "Dark folklore", and does hard cuts, dark grade, glitch ending and impact hits. The request wants existing Folklore preserved, a warmer atmospheric Folklore, and a separate Dark Folklore. See decision A.
2. **Compose & Render has no per-scene camera or transition controls.** Those are in Storyboard > Edit details. Intensity is there too; transition duration and per-scene effects do not exist. Compose gains these as new controls; Storyboard keeps its own.
3. **The existing style overrides everything.** It replaces every scene's camera and transition. That stays for old compositions only; new styles act as preferences and never beat a manual choice.
4. **Editing the storyboard invalidates approved visuals** (scene visuals depend on the storyboard). So changing camera there on a finished video forces re-approval. Compose overrides only invalidate that composition and its render, so they are the right place for late changes.
5. **Cut and Slide/Wipe:** in a test on solid-colour and test-pattern clips, Cut showed no blended frame and Slide and Wipe looked different. Cut will still become a true concatenation so it cannot depend on frame rounding. Output will be compared before and after.
6. **Some data is stored but never rendered:** `transition_out`, `sfx_cues`, `visual_style` (used only when drawing sketches).
7. **Stock video clips get no camera or style** today. New styles will grade them; camera moves stay stills-only.

## 3. Design

### Data (all optional fields, no database migration)

| Where | New data |
|---|---|
| Project `settings_json.cinematic` | `{version: 1, camera, style, transition, custom_text}`. Saving it invalidates nothing |
| Script content | Snapshot of the selections used; per section `cinematic: {camera, visual, transition}` |
| Storyboard scene | Extended `camera`; `look` (style, lighting, color, atmosphere, composition, shot, effects); `transition` (direction, duration, intensity, easing); `origin` per field: `ai`, `draft` or `user` |
| Composition timeline | Resolved values per scene, each with its source; `overrides[scene].camera / look / transition`; `overrides_all` for the whole composition |

Narration (`text`), visual description and the three instruction blocks stay in separate fields. Captions and voice keep reading only `text` / `tts_text`, with a test proving no instruction text reaches them. "Subject tracking" stays an empty optional field: there is no subject detection.

### Precedence

One pure function (`render/resolve.ts`), tested as a table:

1. Compose override for a scene
2. Storyboard value you edited (`origin: user`)
3. Compose setting for the whole composition
4. Generated scene direction (`ai`, then `draft`)
5. Script Generation selection
6. Renderer default

This puts your storyboard hand edits above a composition-wide setting (decision B). Existing storyboard values without `origin`: `draft: true` scenes count as draft, the others as yours.

### Compatibility guarantee

A composition with no new fields must produce **the same FFmpeg arguments and cache keys as today**. A golden test records them first, for clean and `folklore`, before any renderer change. New behaviour lives in new code paths.

## 4. Capabilities and honest limits

Source pictures are flat images, so every 3D-sounding move is a 2D simulation and is labelled so in the app.

| Camera | Method | Limit |
|---|---|---|
| Dolly in/out, dramatic push-in, pullback, slow reveal | Eased zoom and reframing around the focal point | Differs from zoom mainly by easing and framing |
| Truck, tracking, tilt, crane | Eased translation with zoom; slight perspective on tilt | Truck is close to the existing pan |
| Orbit | Animated perspective plus drift | No true rotation around a subject |
| Handheld, impact shake | Layered offsets and small rotation | Simulated |
| Whip pan | Fast move with directional blur | Simulated |

Easing (linear, in, out, in-out, cinematic, dramatic, custom curve) goes into the motion expressions. Movement is limited to what keeps the focal point inside the frame at each aspect ratio.

| Transition | Method |
|---|---|
| Radial wipe, iris in/out, blur dissolve, flash | Built-in `xfade` modes, plus timed filters |
| Push | Eased two-picture slide. The existing Slide already pushes, so the difference is easing and motion blur |
| Whip pan, motion blur, zoom through, zoom reveal | Slide or zoom with timed directional blur and scale |
| Glitch, film burn, light leak | Cut or dissolve with generated overlays and timed colour effects |
| Mask reveal | Generated shape masks |
| Match cut | Focal-point-aligned framing and a very short dissolve. **No shape matching** |

| Visual effect | Confidence |
|---|---|
| Grade, temperature, tint, highlights, shadows, vignette, grain, flicker, blur, glow | Reliable |
| Fog, dust, smoke, light leaks, moonlight rays, moving shadows | Generated procedurally; quality unknown. Each is prototyped and shown to you; any that looks fake is left out and reported |

Styles are data (`render/styles.ts`): one preset per style holding grade, effects, caption presentation, camera, transition, pacing and audio preferences. Custom edits a copy.

Cultural guidance for Folklore goes into the prompts (Filipino context, no generic Western horror, no invented details, tradition kept separate from fact). A prompt cannot guarantee this; review by you or a cultural reviewer is still needed.

Pacing preferences guide the script writer only. Scene length continues to follow the measured narration.

## 5. Phases

Order differs from the request: the renderer comes before the script options, so no option exists that cannot be rendered. Each phase ends with typecheck, tests, an actual render and a review by you.

| # | Phase | Work | Done when |
|---|---|---|---|
| 0 | Safety net | Commit current UI work; golden tests; render a reference video of existing behaviour | Baseline recorded |
| 1 | Foundation | New types and validation, `resolve.ts`, override API | Old projects load; precedence table passes |
| 2 | Camera | 16 new movements, easing, configuration; `motion.ts` split into a camera module | Test renders in 9:16, 16:9, 1:1 inspected frame by frame |
| 3 | Transitions | 15 new types, directions, duration; true cut; compose step moved to its own module | Video length and audio sync unchanged; each type inspected |
| 4 | Styles | Preset system, 9 styles plus Custom, legacy path kept, licence manifest entries for generated sounds and overlays | Folklore and Dark Folklore differ in output; legacy matches baseline |
| 5 | Compose & Render | Per-scene camera, transition and effects, "applies to all", source shown per value, reset to generated, advanced sections collapsed, player approximation | Existing controls untouched; overrides survive rebuild |
| 6 | Script Generation | "Cinematic Direction" section, save and restore, extended single prompt and parser (also for paste-a-prompt), storyboard copies the instructions, explicit "apply directions to storyboard" that skips your edits, sketch prompt uses the look | A real Claude run returns varied per-scene instructions |
| 7 | Full test | The requested test compositions, an existing project copy, browser check of desktop and phone | Report of what passed, what was not verified, what was left out |

Notes for Phase 6:

- Invalid or unknown instructions from the model are dropped and listed to you, never guessed.
- The confirmation before calling Claude must list the custom direction text among what is sent.
- AI output is saved as a draft by actor `ai`; approval stays with you. No extra AI calls.

## 6. Risks

| Risk | Handling |
|---|---|
| Legacy videos change after renderer edits | Golden tests and reference render |
| Heavier filters slow 1080x1920 renders (current limit 15 minutes per final pass) | Measure each phase; apply effects per scene clip where possible so caching helps |
| Longer transitions eat into short scenes | Keep the cap relative to scene length and show the value actually used |
| Too many controls | Collapsed "Advanced" sections |
| Preview player cannot show the new effects | Add a short rendered transition preview; label the player as approximate |
| Each language and format has its own composition | Add "copy settings to other languages and formats" |

## 7. Decisions (accepted)

| | Question | Decision |
|---|---|---|
| A | What happens to today's `folklore` look? | Keep it rendering identically for existing videos, listed as "Dark Folklore (classic)". Add new ids for **Folklore** (warm, atmospheric) and **Dark Folklore** (new, configurable). Nothing migrates |
| B | Storyboard hand edit versus composition-wide setting | The hand edit wins |
| C | Ambient audio (forest, wind, insects, animals) | Store the preference; synthesize only wind, drones and impacts; you import licensed clips for the rest |
| D | Delivery | Build and review one phase at a time |
