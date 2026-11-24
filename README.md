# Wander AI Director

Local-first studio for faceless, multilingual (English / Tagalog / Taglish) videos. You approve every stage; nothing is published or uploaded automatically.

## Run it

```bash
npm install
npm run preflight      # checks FFmpeg (needs ffmpeg-full for captions), disk, fonts
npm start              # builds the web UI and starts the server on http://127.0.0.1:4317
```

- Develop the UI with hot reload: `npm run dev:server` in one terminal and `npm run dev:web` in another (http://localhost:5173).
- Try it with sample content: `WANDER_ROOT=/tmp/wander-demo npm run seed:demo -- --full`, then `WANDER_ROOT=/tmp/wander-demo npm run dev:server`.
- Tests: `npm test` (includes a real 10-second, 3-format render; needs FFmpeg and, for narration, macOS `say`). Types: `npm run typecheck`.

Data lives in `data/` (SQLite) and `projects/` (media); both are git-ignored. See `docs/TECH_BLUEPRINT.md` for the architecture and known gaps.
