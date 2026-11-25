# Wander AI Director: guide for Claude Code and its subagents

Local-first studio for faceless multilingual videos. Backend: `app/server` (Node 22, TypeScript run directly, Fastify, `node:sqlite`). Web UI: `app/web` (React + Vite). Shared ids/states: `app/shared`. Full design and known gaps: `docs/TECH_BLUEPRINT.md`.

## Commands
- `npm run typecheck` (server and web), `npm test` (103 tests, includes a real FFmpeg render; ~1 min)
- `npm run preflight`, `npm start`, `npm run seed:demo -- --full` (use `WANDER_ROOT=/tmp/x` to keep demo data out of the repo)
- One test file: `cd app/server && node --test test/<file>.test.ts`. Set `WANDER_DEBUG=1` to see real 500 messages.
- FFmpeg must be `ffmpeg-full` (libass). It is keg-only; code finds it via `ffprobeBinary()` in `app/server/src/media.ts`.

## Rules that must never break
1. **Only the user approves.** `approve`/`reject` need actor `user`; HTTP routes are user actions, providers and AI use actor `ai`/`system`. Nothing auto-approves.
2. **Approved work is protected.** Saving to an approved artifact needs `reopen`; the UI asks first. Approved versions are never deleted or overwritten.
3. **Invalidation is narrow.** A change marks only its transitive dependents `needs_revision` (per language, per format). Check `pipeline.ts` dependency edges when adding artifacts.
4. **Free-first, no silent fallback.** Providers are chosen explicitly by id. Never call a paid service, never fall back from free to paid, never auto-download models.
5. **Truthful status.** Report a render/asset/export done only after verification (ffprobe, hashes). Failed work leaves no partial files or DB rows.
6. **Caption text comes from the approved script.** Audio/ASR supply timestamps only. Changing caption text needs an explicit `override`.
7. **Immutable ULIDs** identify everything; never key on filenames. Paths are built from ids.
8. **Privacy.** Outbound requests carry only what a provider needs (e.g. a search query). No project names, emails or paths. The API is loopback-only with Host/Origin checks.
9. **Licenses are recorded** for every asset, clip and font that ends up in a video.

## Conventions
- TypeScript with erasable syntax only (no enums/parameter properties). Server imports use `.ts` extensions.
- New tables go in a new migration in `db.ts` (never edit an old one). New errors use `EngineError(code, message, details)`; map codes to HTTP in `api.ts`.
- Add tests with the change. Heavy behavior is covered by `test/e2e-acceptance.test.ts`; keep it green.
- Do not commit `data/`, `projects/`, `cache/`, `exports/`, `node_modules/` (all git-ignored).
- State what was not verified. Edge TTS synthesis was verified live (English and Filipino voices produce real audio) but Tagalog pronunciation quality has not been judged by a native speaker; Whisper and Piper are untested against real engines.
