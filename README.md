# Wander AI Director

A local-first studio for faceless, multilingual (English, Tagalog, Taglish) videos. It takes a video from a researched topic to a rendered MP4. You approve every step, and nothing is published or uploaded for you.

## What you need

| Tool | Needed for | Required? |
|---|---|---|
| macOS | Storyboard pictures (`sips`) and the built-in voices (`say`) | Yes, for those features |
| Node.js 22 or newer | Running the app | Yes |
| FFmpeg with libass (`ffmpeg-full`) | Captions and rendering | Yes |
| [Claude Code](https://claude.com/claude-code), signed in | Topic research, script writing, storyboard pictures | For those features |
| `edge-tts` | Filipino and English (Philippines) narration voices | Recommended for Tagalog and Taglish |
| 8 GB RAM and 20 GB free disk | What `npm run preflight` checks for | Yes |

Windows and Linux are not supported or tested.

## Install

These steps assume [Homebrew](https://brew.sh) is installed.

**1. Install the tools**

```bash
brew install node ffmpeg-full pipx
```

```bash
pipx install edge-tts
```

`ffmpeg-full` is not linked onto your PATH. The app finds it by itself.

**2. Get the code** (the repository is private, so Git will ask you to sign in)

```bash
git clone https://github.com/jeromeongcz/wander-studio.git
```

```bash
cd wander-studio
```

```bash
npm install
```

**3. Sign in to Claude Code** (install it first, from the link above)

```bash
claude auth login
```

**4. Check the computer**

```bash
npm run preflight
```

Fix anything it marks as required.

## Run

```bash
npm start
```

This builds the web page and starts the server. Open <http://127.0.0.1:4317>. Leave the terminal open while you work, and press `Ctrl+C` to stop.

To use another port:

```bash
WANDER_PORT=4320 npm start
```

The app only accepts connections from your own computer.

## Update

```bash
git pull
```

```bash
npm install
```

Then stop the server, run `npm start` again, and refresh the page. A running server does not pick up new code by itself.

## Make a video

The sidebar has **Dashboard**, **Research Studio**, **Video Production**, **Asset Library** and **Settings**. A video moves through six steps, and each one opens after the step before it is approved.

1. **Research Studio.** Choose a category, say what to look into, and pick how many topics (1 to 20). Claude researches them with source links. Read the sources, approve a topic, then press **Start a video from this**. In the new video, complete the fact checklist, save, submit for review and approve.
2. **Script.** Choose the length, the number of storyboard scenes and the shape (9:16, 16:9 or 1:1), then **Generate script**. You get narration plus the setting, characters, action, shot, mood and props for every scene. Submit and approve it, then open **Languages**, create the language draft and approve that too.
3. **Storyboard & visuals.** **Generate all** pictures, or one scene at a time. Use **Regenerate** for a picture you do not like, then **Approve** or **Approve all**. You can also upload your own images under **Visuals**.
4. **Voice & captions.** Pick a voice and generate the narration (or import your own recording). Approve it. Under **Captions**, align the captions to the narration and approve them. Caption text always comes from your approved script.
5. **Compose & render.** Pick a **Scene style**, then **Build timeline**. Play the preview, submit and approve the composition, render, watch the result, and approve the final render.
6. **Publish.** Export captions and the publishing package. You upload it yourself.

Finished videos are also under **Asset Library → Generated videos**, where you can play and download them.

### Scene styles

- **Clean:** your storyboard's camera moves and transitions, with normal captions.
- **Dark folklore:** hard cuts, a new framing about every 3 seconds, a dark grainy look, one large caption word at a time, impact sounds and a glitch ending. See `docs/style/dark-folklore-shorts.md`.

## What goes online

Everything else stays on your computer.

| Feature | Sent to | What is sent |
|---|---|---|
| Topic research | Claude (your plan), which searches the web | Category, your search text, notes, number of topics, and titles already researched |
| Script writing | Claude | The approved topic and facts, category, length, shape, language and notes |
| Storyboard pictures | Claude | The scene description |
| Edge TTS | Microsoft | The text being spoken (unofficial free endpoint; check terms before commercial use) |
| Stock search | Openverse | Your search words |

The app asks before first using Claude or an online voice. Check facts, licences and platform rules yourself before publishing. AI research can be wrong, and storyboard pictures are AI-generated sketches.

## Your files

| Folder | Contents |
|---|---|
| `data/` | The database (topics, scripts, approvals) |
| `projects/` | Pictures, narration and rendered videos |
| `shared_assets/` | Assets shared between videos |
| `exports/` | Publishing packages and archives |
| `cache/` | Temporary render files; safe to delete while the server is stopped |

Your work in these folders is **not** stored in Git.

**Back up or move to another computer:** stop the server, then copy `data/`, `projects/`, `shared_assets/` and `exports/` into the other copy of the app. Copying over an existing copy replaces that computer's work; the two are not merged.

## Troubleshooting

| Problem | What to do |
|---|---|
| `EADDRINUSE: address already in use` | An old server is still running. Press `Ctrl+C` in its terminal, or run the command below with your port |
| "The server is out of date" | Restart the server, then refresh the page |
| Research or script buttons are disabled | Run `claude auth login`, then press **Check again** |
| No Filipino voice | Install `edge-tts`, restart, and choose Edge TTS (standard macOS voices have none) |
| Captions or rendering fail | Run `npm run preflight`; install `ffmpeg-full` |
| A server error with no detail | Start with `WANDER_DEBUG=1 npm start` to see the full message |

Stop whatever is using port 4317, then start again:

```bash
lsof -ti tcp:4317 -sTCP:LISTEN | xargs kill && sleep 1 && npm start
```

## Development

```bash
npm run typecheck
```

```bash
npm test
```

The tests include a real FFmpeg render and take about a minute.

- **UI with hot reload:** run `npm run dev:server` and `npm run dev:web` in two terminals, then open <http://localhost:5173>.
- **Sample content, kept out of your data:**

```bash
WANDER_ROOT=/tmp/wander-demo npm run seed:demo -- --full
```

```bash
WANDER_ROOT=/tmp/wander-demo npm run dev:server
```

| Variable | Effect |
|---|---|
| `WANDER_PORT` | Server port (default 4317) |
| `WANDER_ROOT` | Folder for data, projects and cache |
| `WANDER_DB` | Database file path |
| `WANDER_CLAUDE_BIN` | Path to the `claude` command |
| `WANDER_FFPROBE` | Path to `ffprobe` |
| `WANDER_DEBUG` | `1` shows real server error messages |

Architecture and known gaps are in `docs/TECH_BLUEPRINT.md`. Project rules for contributors and AI assistants are in `CLAUDE.md`.

## Not yet verified

- A setup on a fresh computer.
- How natural the Tagalog and Taglish voices and scripts sound to a native speaker.
- Whisper alignment and the Piper voice against real engines.
