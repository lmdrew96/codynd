# CodyND

**Claude Code mods for brains that wander.**

Neurodivergent-friendly mods for Claude Code that keep your work visible and your wins audible. A status line shows the patch you're on, a chime celebrates when it's done, a gentle clock nudges you to check in with your body on long sessions, and a re-entry card tells you where you left off. CodyND helps and celebrates. It never polices.

## The mods

| Mod | What it does |
| --- | --- |
| **Patch status line** | Shows `🩹 <title> · 24m` under the prompt for the [ChaosPatch](https://chaospatch.adhdesigns.dev) patch in progress in *this* repo (`(+N)` if there are more). The time reads `<1m`, `24m`, `1h 10m`, then whole days (`3d`), redrawn once a minute. Patches from other projects stay quiet. |
| **Done chime** | When a patch is completed, a 10-second toast (`🎉 Patch done: <title>`) and a short two-note chime. Failed calls don't celebrate. |
| **Session clock** | After 90 minutes of continuous prompting: `🫖 1h 30m in — water? food? stretch?`. One toast per stretch, gone after 15 seconds. 20 minutes without a prompt counts as a break and resets the clock. `/snooze [minutes]` pushes it out (default 30). |
| **Re-entry card** | A band above the prompt when a session opens: your last commit ("Last time") and the patch in progress, or the top open one ("Up next"). Disappears on Dismiss or your first prompt. |
| **`/park`** | `/park <thought>` saves a side-thought to [Kindling](https://kindling.adhdesigns.dev), tagged `parked` and `project:<repo>`, and confirms with a toast. Tangents get caught, not policed. It runs the moment you hit Enter, even while Claude is mid-turn. If it can't save, the thought is echoed back so it isn't lost. |
| **`/patch`** | `/patch <rough idea>` turns an "oh, we should also…" into a real ChaosPatch patch for this repo: a title, a one-line summary and acceptance criteria, drafted from the session so it knows what you're working on. Runs mid-turn without interrupting. Tagged `quick-capture`; your exact words are kept in the patch's spec, and if drafting fails your raw words are filed, tagged `rough`. |
| **`/wins`** | Today's wins in this repo: patches closed and commits made since local midnight. `/wins-all` shows closed patches across every project. An empty day gets a gentle line, never a guilt trip. |
| **`/patches`** | Opens this repo's ChaosPatch board in a pane: in-progress patches with **Done**, open ones by priority with **Start** and **→ Cody**, which hands the patch to Claude as a prompt (number keys press it). Done plays the chime. Esc closes. |

## Install

CodyND is a Claude Code plugin of function hooks (a "mod"). Clone it, then load it one of three ways.

```sh
git clone https://github.com/lmdrew96/codynd
```

**Every session (settings).** Add the folder to the `env` block of `~/.claude/settings.json`:

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/codynd" }
```

**One session.** Start Claude Code with the folder:

```sh
claude --plugin-dir /path/to/codynd
```

**Skills folder.** Claude Code also loads a plugin it finds in `~/.claude/skills/<name>`:

```sh
git clone https://github.com/lmdrew96/codynd ~/.claude/skills/codynd
```

Pick one. Loading it two ways at once loads it twice.

> I've used the first two. The skills-folder route comes from Claude Code's plugin docs; I haven't run it myself yet.

## Requirements

- **Claude Code with mod support.** The mod API is early access and can change between releases. CodyND was built against **Claude Code 2.1.289**.
- **A ChaosPatch MCP server** for the status line, the chime, `/patches`, `/patch`, `/wins`, and the card's "Up next" line. Without one those stay quietly empty; the session clock and the card's "Last time" line still work. A project matches a repo when its slug or name equals the repo's folder name, ignoring case and punctuation (`chicken-scratch` = `Chicken Scratch`).
- **A Kindling MCP server** for `/park`.
- **`/patch` makes one model call** per use: a fork of your session, on the session's model, mostly served from the prompt cache. Every other mod runs without model calls.
- **macOS for the sound.** The chime plays through `afplay`; elsewhere you get the toast only.

## Settings

Change these in `/config` (they're stored under `pluginConfigs.codynd` in your settings).

| Setting | Default | What it does |
| --- | --- | --- |
| `chaospatchServer` | `claude.ai ChaosPatch` | Your ChaosPatch MCP server's name, as `/mcp` lists it. |
| `doneChimeSound` | `true` | Play the chime when a patch is completed. |
| `bodyCheckMinutes` | `90` | Minutes of continuous work before the body-check nudge. |
| `kindlingServer` | `claude.ai Kindling` | Your Kindling MCP server's name, for `/park`. |

## Commands

| Command | What it does |
| --- | --- |
| `/patches` | Open this repo's ChaosPatch board. |
| `/patch <idea>` | Draft and file a patch for this repo from a rough idea. |
| `/wins` | Today's closed patches and commits in this repo. |
| `/wins-all` | Today's closed patches across every project. |
| `/park <thought>` | Park a side-thought in Kindling. |
| `/snooze [minutes]` | Push the next body-check nudge out (default 30 minutes). |

## Development

Edits hot-reload in a session that loaded the folder with `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`.

```sh
pnpm install        # TypeScript, for type-checking
pnpm typecheck      # tsc -p .
pnpm test           # claude plugin test .
pnpm validate       # claude plugin validate .
```

Claude Code writes the API's type declarations into `.claude-plugin/types/` when it loads the mod. That folder is gitignored and is the authority on the API for your build.

```
.claude-plugin/plugin.json   manifest and settings (userConfig)
hooks/register.ts            wires the mods together
hooks/patch-status.ts        status line and patch timer
hooks/done-chime.ts          done chime
hooks/session-clock.ts       session clock and /snooze
hooks/reentry-card.tsx       re-entry card
hooks/park.ts                /park
hooks/patches-pane.tsx       /patches board
hooks/quick-patch.ts         /patch
hooks/wins.ts                /wins and /wins-all
hooks/*.test.ts              tests (claude plugin test)
types/index.d.ts             $.state contract (card, board, active patches)
sounds/done.wav              the chime (an original synthesized clip)
```

## License

[MIT](LICENSE). Part of [ADHDesigns](https://adhdesigns.dev).
