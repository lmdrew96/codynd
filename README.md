# CodyND

**Claude Code mods for brains that wander.**

Neurodivergent-friendly mods for Claude Code that keep your work visible and your wins audible. A status line shows the patch you're on, a chime celebrates when it's done, a gentle clock nudges you to check in with your body on long sessions, and a re-entry card tells you where you left off. CodyND helps and celebrates. It never polices.

## The mods

| Mod | What it does |
| --- | --- |
| **Patch status line** | Shows `🩹 <title> · 24m` under the prompt for the [ChaosPatch](https://chaospatch.adhdesigns.dev) patch in progress in *this* repo (`(+N)` if there are more). The time reads `<1m`, `24m`, `1h 10m`, then whole days (`3d`), redrawn once a minute. Patches from other projects stay quiet. With no patch or focus, the line shows your current work stretch instead (`⏱ 45m in`, the same clock as the body check), hidden while you're on a break, so it never counts up while you're away. |
| **Done chime** | When a patch is completed, a 10-second toast (`🎉 Patch done: <title>`) and a short chime. Each session's first win gets the classic two-note chime; after that the sound and the toast's opener rotate (`✨ Shipped`, `🌱 One less thing`, …), never the same twice running, so the reward stays fresh. If the tree is fully committed and the session's latest test run (if any) passed, a second toast follows: `🟢 Clean stopping point. Safe to walk away.` Otherwise it stays silent; it never runs tests itself. Failed calls don't celebrate. Other CodyND toasts that arrive meanwhile wait their turn, so the win is never covered up. |
| **Error decoder** | When a build, typecheck, test or lint run fails, one toast says what broke in plain English: `🧩 TypeScript can't find \`clock\`, probably a missing import or a typo (in wins.ts:81).` Common failures (TypeScript errors, missing modules, failing tests, lint counts, syntax errors) are read straight from the output; anything else gets one quick Haiku sentence. The same error again within 5 minutes stays quiet, it waits behind a done toast, and commands like `grep` that just return non-zero never trigger it. |
| **Instruction hooks** | Quiet reminders for Claude, never for you, so the rules in your instructions don't fade in a long session. Every conversation starts with the rules in `rules.md` (one file, plain text, edit it freely). The first file edit with no patch in progress and no focus set carries a note asking Claude to start the patch or set a focus. It comes back after a topic switch: the focus changes or clears, or a patch is completed. Completing a patch without a completion note gets a nudge to add one. None of it shows on your screen. |
| **Focus slot** | When no patch is in progress, the status line shows `🎯 <focus>`: a short label for the non-patch work at hand. Claude sets it with its `set_focus` / `clear_focus` tools when the topic changes; `/topic <label>` sets it by hand, bare `/topic` asks Claude to name the current work and set it, and `/topic clear` clears it. A patch always wins the line; the focus clears when the session ends. When a focus is replaced by a new one, a small band offers to park the old one in Kindling (Park / Dismiss). It goes away with your next prompt, and each label is offered once a session. |
| **Next-event countdown** | Your next [ControlledChaos](https://controlledchaos.adhdesigns.dev) event rides alongside the patch or focus: `🩹 <patch> │ 📚 Latin in 40m`. Only timed events you've committed to count (not all-day or tentative ones, not planned work blocks), and only within the next 3 hours. At 15 minutes the emoji turns 🟠 and one toast says `🛬 <event> in 15m. Start landing the plane.` Fetched every 5 minutes, ticked each minute; if ControlledChaos can't be reached, the segment just isn't there. |
| **Session clock** | After 90 minutes of continuous prompting: `🫖 1h 30m in — water? food? stretch?`. One toast per stretch, gone after 15 seconds. 20 minutes without a prompt counts as a break and resets the clock. `/snooze [minutes]` pushes it out (default 30). |
| **Re-entry card** | A band above the prompt when a session opens: your `/wrap` note ("Left off"), your last commit ("Last time") and the patch in progress, or the top open one ("Up next"). Disappears on Dismiss or your first prompt. `/recap` brings it back, freshly loaded, when you return to a window you left open. |
| **`/wrap`** | `/wrap <note>` leaves a where-I-left-off note for this repo; the next session's re-entry card shows it (`Left off: <note> · 2h ago`). Bare `/wrap` saves the current patch or focus. Also mentions uncommitted files, as information only. One note per repo, kept on this machine. |
| **`/park`** | `/park <thought>` saves a side-thought to [Kindling](https://kindling.adhdesigns.dev), tagged `parked` and `project:<repo>`, and confirms with a toast. Tangents get caught, not policed. It runs the moment you hit Enter, even while Claude is mid-turn. If it can't save, the thought is echoed back so it isn't lost. |
| **`/patch`** | `/patch <rough idea>` turns an "oh, we should also…" into a real ChaosPatch patch for this repo: a title, a one-line summary and acceptance criteria, drafted from the session so it knows what you're working on. Runs mid-turn without interrupting. Tagged `quick-capture`, plus a guessed `energy:low`/`energy:med`/`energy:high` for `/fried`; your exact words are kept in the patch's spec, and if drafting fails your raw words are filed, tagged `rough`. |
| **`/wins`** | Today's wins in this repo: patches closed and commits made since local midnight. `/wins-all` shows closed patches across every project, and `/wins-week` shows every project's closes since Monday with the total and the busiest day. An empty day gets a gentle line, never a guilt trip. |
| **`/whatchanged`** | What this session changed, without reading diffs: 1–3 plain-language lines on what the code does now, the files touched, and a heads-up for anything worth a second look (dependencies, config, auth, database, deletions). It compares against where the session started, commits and uncommitted work alike. The summary comes from a side call that knows the session, so it doesn't add to the conversation. `/whatchanged patch` keeps it to the patch in progress; other words name a patch. Nothing changed yet? It says so kindly. |
| **`/patches`** | Opens this repo's ChaosPatch board in a pane: in-progress patches with **Done**, open ones by priority with **Start** and **→ Cody**, which hands the patch to Claude as a prompt (number keys press it). Done plays the chime. Esc closes. |
| **`/fried`** | For tired evenings when your brain still wants a goal: a pane of open patches tagged `energy:low`, across every project, by priority. **Start** works on any of them; **→ Cody** shows on this repo's only. Nothing tiny queued? It says so, and suggests rest. |

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
- **A ChaosPatch MCP server** for the status line, the chime, `/patches`, `/fried`, `/patch`, `/wins`, and the card's "Up next" line. Without one those stay quietly empty; the session clock and the card's "Last time" line still work. A project matches a repo when its slug or name equals the repo's folder name, ignoring case and punctuation (`chicken-scratch` = `Chicken Scratch`).
- **A Kindling MCP server** for `/park`.
- **A ControlledChaos MCP server** for the next-event countdown.
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
| `controlledChaosServer` | `claude.ai ControlledChaos` | Your ControlledChaos MCP server's name, for the next-event countdown. |

## Commands

| Command | What it does |
| --- | --- |
| `/patches` | Open this repo's ChaosPatch board. |
| `/fried` | Open only the low-energy patches, across projects. |
| `/topic [label \| clear]` | Set the status-line focus by hand; alone, have Claude name the work; `clear` clears it. |
| `/wrap [note]` | Leave a where-I-left-off note for next session. |
| `/recap` | Bring the re-entry card back up, freshly loaded. |
| `/patch <idea>` | Draft and file a patch for this repo from a rough idea. |
| `/wins` | Today's closed patches and commits in this repo. |
| `/wins-all` | Today's closed patches across every project. |
| `/wins-week` | This week's closed patches across every project, since Monday 00:00 local. |
| `/whatchanged [patch]` | This session's changes in plain language, with files and a heads-up. |
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
hooks/next-event.ts          next-event countdown
hooks/patch-status.ts        status line and patch timer
hooks/focus.tsx              focus slot (set_focus / clear_focus tools, /topic, park offer)
hooks/toast-queue.ts         holds toasts behind a done toast
hooks/done-chime.ts          done chime
hooks/error-decoder.ts       error decoder toast
hooks/session-clock.ts       session clock and /snooze
hooks/reentry-card.tsx       re-entry card, /recap
hooks/park.ts                /park
hooks/patches-pane.tsx       /patches board, /fried
hooks/quick-patch.ts         /patch
hooks/wins.ts                /wins, /wins-all and /wins-week
hooks/wrap.ts                /wrap
hooks/whatchanged.ts         /whatchanged
hooks/instructions.ts        instruction hooks (rules block, patch-or-focus and completion-note reminders)
rules.md                     the rule list every conversation starts with
hooks/*.test.ts              tests (claude plugin test)
types/index.d.ts             $.state contract (card, board, active patches, focus, park offer)
sounds/*.wav                 the chimes (original synthesized clips; done.wav is the classic)
```

## License

[MIT](LICENSE). Part of [ADHDesigns](https://adhdesigns.dev).
