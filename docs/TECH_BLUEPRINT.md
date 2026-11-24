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
