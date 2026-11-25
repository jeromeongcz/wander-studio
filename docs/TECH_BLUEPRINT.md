# Wander AI Director — Technical Blueprint (Phase 0)

Status: draft for user review. No application code exists yet.

## Host (audited 2026-11-25)
Apple M1 (arm64), 16 GB RAM, 211 GB free, Node 22.23, npm 10.9, git, Homebrew.
FFmpeg: use Homebrew `ffmpeg-full` (keg-only at /opt/homebrew/opt/ffmpeg-full/bin); the plain `ffmpeg` formula lacks libass/drawtext. Optional, not installed: Piper, whisper.cpp, Ollama. Python 3.9 system build is not relied on.

## Stack
| Concern | Choice | Notes |
|---|---|---|
| Packaging | npm workspaces (`app/web`, `app/server`, `app/shared`) | pnpm optional later |
| Frontend | React + Vite + TypeScript | local web app on localhost |
| Backend | Fastify + TypeScript | REST + SSE for job progress |
| DB | SQLite (better-sqlite3) + Drizzle migrations | ULID primary keys |
| Jobs | SQLite-backed in-process queue, child-process workers | progress, cancel, retry, structured logs |
| Render | FFmpeg first; Remotion optional behind `timeline.json` | engine-agnostic schema |
| TTS | Piper (offline), Edge TTS (online, flagged), manual import | capability detection per adapter |
| Alignment | whisper.cpp / faster-whisper forced to approved script | canonical text never overwritten by ASR |
| LLM | Ollama, user API key, or manual copy-paste | no hardcoded model |

## Provider interface (all adapters)
`id`, `capabilities()`, `license()` (free-tier limits, commercial use, privacy), `healthCheck()`, `run(job)`.
Every capability has a manual fallback. No silent free-to-paid fallback.

## Core data rules
- Immutable ULIDs for project, language, scene, asset, caption track, job, version.
- `depends_on` edges stored in SQLite; invalidation is per-language and per-scene (plan section 11.2).
- Approved versions are archived, never overwritten.
- Output counts as done only after `ffprobe` verification.

## Roadmap and gates
Phases 1–10 as in the v2.2 plan, with one addition: a throwaway vertical slice (TTS clip, alignment, burned 9:16 caption) before Phase 6 to de-risk Tagalog/Taglish alignment. The section 16 acceptance test becomes an automated end-to-end test, rerun from Phase 6 onward.

## Open items
1. Install FFmpeg and pnpm via Homebrew (awaiting approval).
2. Confirm web app vs desktop shell (default: web app).
3. Bundle OFL caption fonts (including Tagalog-safe Latin coverage) in `templates/fonts`.

## Build status (all roadmap phases implemented, backend only)
Phases 0-10 are built and tested (`npm test`, includes a real 10-second, 3-format end-to-end run).

Known gaps, stated plainly:
- The web UI covers every stage (checked by hand in a browser against a seeded demo project, not by automated UI tests). The UI has no accounts: it binds to loopback only and refuses non-localhost Host headers and cross-origin writes.
- Tagalog TTS needs Edge TTS (online), Piper with your own model, or your own recording. The Edge TTS adapter was run for real (English and Filipino voices make audio; pronunciation quality is unjudged); the Piper adapter is tested only against stub programs.
- Whisper alignment is implemented but unrun: no model file is installed. Default alignment is silence-anchored and always reported as approximate.
- AI image-to-video and cloud GPU adapters are not bundled; the provider interface and a built-in still-image-motion fallback exist.
- True parallax layers are approximated (slow zoom plus drift). Stock video clips play as-is.
- Caption font defaults to macOS Arial Black, which cannot be redistributed; add an open-licensed font to `templates/fonts`.
- Archives use plain zip (no zip64): files over 4 GB are refused.

## Web UI process (six steps)
The project page is a six-step stepper: Topic, Script, Storyboard & visuals, Voice & captions, Compose & render, Publish (`app/web/src/pipeline.ts`). A step opens only when the previous one is fully approved; earlier steps stay reachable and locked steps explain what unlocks them. The Topic step is the first gate: the user picks how many topics Claude researches, chooses one, and approves it in an explicit confirmation before Script opens. The UI only mirrors the server's approval rules; it never approves anything itself. Light theme by default with a dark toggle; tokens and rules are in `design-system/wander-ai-director/MASTER.md`. Not yet checked: a real Claude Code research run (needs `claude auth login`), the Script to Publish steps in the browser after the redesign (only Topic and Script were opened), and tablet widths.

### Research Studio
`#/` is the Research Studio: topic research needs no project. Migration v9 makes `topic_batches.project_id` and `topic_ideas.project_id` optional and adds an `approved` idea status. Studio runs live in `ResearchService` (not the project job queue, whose rows require a project), one at a time, cancellable; a restart marks a stuck run failed. Approving an idea is a user-only HTTP action (`POST /topic-ideas/:id/approve`); starting a video from a studio idea requires it to be approved, and the new project's Topic step still needs its own approval. The old per-project research routes remain on the server but the UI no longer uses them.

### App shell
Left sidebar: Dashboard (`#/`), Research Studio (`#/research`), Video Production (`#/projects`, `#/p/<id>/<stage>`), Asset Library (`#/assets`, read-only view over `GET /assets` with licences; managing assets stays in a video's Visuals step), Settings (`#/settings`). The top strip holds only notifications and the theme toggle; content is full width. `GET /notifications` is derived from current state (artifacts awaiting approval or needing revision, failed jobs and finished research in the last 24 hours); "read" is remembered in the browser's localStorage only. On phones the sidebar slides in from a menu button.

### Script writing
The Script step lets the person pick the length (15 to 600 s), the number of storyboard scenes (3 up to one per 2.5 s; default one per 4 s) and the dimensions (adding a format creates its composition and render artifacts; a format with saved work cannot be removed). `ScriptWriter` asks Claude Code, with no tools, to write from the approved research only: narration per section plus a visual brief (`setting`, `characters`, `action`, `shot`, `mood`, `props`) and a character list with fixed looks. It is saved as a draft by actor `ai`; approval stays with the person. Captions use only `text`. Storyboard drafting turns each described section into one scene and repeats the looks of the characters it names. Verified once with a real run (Taglish, 30 s); Taglish naturalness has not been judged by a native speaker.

### Storyboard sketches
The Storyboard step lists every scene with its details and offers "Generate all" or one scene at a time. A `sketch_scenes` job asks Claude Code (no tools) for one SVG per scene; the SVG is checked against an allow-list (no scripts, handlers, external references or declarations), turned into a PNG with macOS `sips` (so this feature is macOS-only), imported as an `ai-generated` illustration asset and set as the scene's visual by actor `ai`. Asset and scene approval stay with the person in Visuals. Approved scenes are only replaced after an explicit reopen. One real drawing was checked.

### Scene styles
A timeline can carry `effects: "folklore"` (chosen on Compose & render, stored in the composition). It applies the grammar of `docs/style/dark-folklore-shorts.md`: a camera move on every shot (replacing storyboard camera and transitions with hard cuts), extra framings about every 3 s from the same picture, a dark grade with vignette, grain and flicker, one-word uppercase italic captions with names and numbers in red, generated impact hits (and a drone bed when no music is set), and a 0.6 s glitch sting. Sounds are synthesized locally and listed in the licence manifest. Not included: the hand-drawn arrow, found-footage insert, in-picture text, image-to-video motion. The browser preview only approximates the style.

### Platforms
`app/server/src/platform.ts` holds the differences: tool lookup (`.exe`, `where`), path containment, ffmpeg filter-path escaping for drive letters, system font folders (names read from the font file outside macOS; a copy when links are refused), and SVG rasterizing (macOS `sips`; elsewhere FFmpeg with librsvg or `rsvg-convert`). macOS is tested. The Windows rules have unit tests run on macOS only; nothing has run on Windows. `say` voices and the shell-script test stubs remain macOS-only.
