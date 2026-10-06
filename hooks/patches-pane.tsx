import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import type { Board, BoardRow, FriedRow } from '../types'
import { CHIMES, DONE_TOAST_MS, STOP_TOAST, doneMessage, isCleanStop, nextCelebration } from './done-chime.ts'
import { DEFAULT_SERVER, parseAliases, parsePatches, patchesForCwd, statusLine, type Aliases, type Patch } from './patch-status.ts'
import { FADE_SCRIPT, SOUNDTRACK_KEY, START_SCRIPT, playlistUri } from './soundtrack.ts'

// #11 /patches: this repo's ChaosPatch board in a pane, driven by buttons, no model turn.
// /fried: the same pane idea for tired evenings, low-energy open patches across projects.
// Built against Claude Code 2.1.289.

const PANE = 'codynd-patches'
const FRIED_PANE = 'codynd-fried'
export const FRIED_EMPTY = "Nothing tiny queued. Maybe that's your sign to rest 💜"
const MAX_OPEN = 9
// One quick retry: a ChaosPatch deploy or reconnect drops a single call that the next one gets through.
export const LOAD_RETRY_MS = 2_000
const board = atom({ plugin: 'codynd', key: 'board' } as const, null)
const friedBoard = atom({ plugin: 'codynd', key: 'friedBoard' } as const, null)
// The same state as patch-status.ts's activePatches (the validator wants atoms declared per file).
const activePatches = atom({ plugin: 'codynd', key: 'activePatches' } as const, [])
const focus = atom({ plugin: 'codynd', key: 'focus' } as const, null)
const lastCelebration = atom({ plugin: 'codynd', key: 'lastCelebration' } as const, null)
const nextEvent = atom({ plugin: 'codynd', key: 'nextEvent' } as const, null)
const workStretch = atom({ plugin: 'codynd', key: 'workStretch' } as const, null)
const lastTestFailed = atom({ plugin: 'codynd', key: 'lastTestFailed' } as const, null)
const soundtrackStarted = atom({ plugin: 'codynd', key: 'soundtrackStarted' } as const, false)

// The chime, and the soundtrack's playlist and fade (soundtrack.ts), from the settings.
type Sound = { chime: boolean; playlist: string; fadeOnDone: boolean }

// "claude.ai ChaosPatch" is listed to the model as mcp__claude_ai_ChaosPatch__<tool>.
export const mcpToolName = (server: string, tool: string): string =>
  `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__${tool}`

export const toRows = (patches: Patch[]): BoardRow[] =>
  patches.flatMap(p => {
    const id = (p as Patch & { id?: unknown }).id
    return typeof id === 'string' ? [{ id, title: p.title }] : []
  })

// Low-energy rows from every project; only this repo's can be handed to Cody here.
export const toFriedRows = (patches: Patch[], cwd: string, aliases: Aliases = {}): FriedRow[] =>
  patches.flatMap(p =>
    toRows([p]).map(row => ({ ...row, project: p.project_name, isHere: patchesForCwd([p], cwd, aliases).length > 0 })),
  )

export const handoffPrompt = (row: BoardRow): string => `Start ChaosPatch patch "${row.title}" (id ${row.id}).`

const listForRepo = async (
  $: EngineInterface,
  server: string,
  args: Record<string, unknown>,
  cwd: string,
  aliases: Aliases,
): Promise<Patch[]> => {
  const result = await $.mcp.call(server, 'cp_list_all_patches', args)
  if (result.isError) throw new Error(result.content.map(b => b.text ?? '').join(' '))
  return patchesForCwd(parsePatches(result.content.map(b => b.text ?? '').join('')), cwd, aliases)
}

// The pane shows why, so a failure can be traced without a debug log.
export const unreachable = (err: unknown): string =>
  `Couldn't reach ChaosPatch: ${(err instanceof Error ? err.message : String(err)).trim() || 'no reason given'}`

const loadBoard = async ($: EngineInterface, server: string, aliases: Aliases, retries = 0): Promise<void> => {
  try {
    const cwd = await $.session.cwd()
    const [inProgress, open] = await Promise.all([
      listForRepo($, server, { status: 'in_progress' }, cwd, aliases),
      listForRepo($, server, { status: 'open', sort_by: 'priority' }, cwd, aliases),
    ])
    await update($, board, () => ({ inProgress: toRows(inProgress), open: toRows(open).slice(0, MAX_OPEN) }))
    // Keep the status line in step: it shares this list. patch-status.ts's redraw hook misses writes
    // made in a button press, so draw here with the list just written.
    await update($, activePatches, () => inProgress)
    $.ui.status(
      statusLine({
        patches: inProgress,
        focus: await read($, focus),
        now: await $.clock.now(),
        event: await read($, nextEvent),
        stretch: await read($, workStretch),
      }),
    )
  } catch (err) {
    $.ui.log(`patches: load failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    if (retries > 0) {
      await $.clock.sleep(LOAD_RETRY_MS)
      return loadBoard($, server, aliases, retries - 1)
    }
    await update($, board, () => ({ inProgress: [], open: [], error: unreachable(err) })).catch((e: unknown) =>
      $.ui.log(`patches: showing the error failed: ${e instanceof Error ? e.message : String(e)}`, { to: 'debug' }),
    )
  }
}

// The server filters by tag and sorts by priority; nothing else to do here.
const loadFried = async ($: EngineInterface, server: string, aliases: Aliases): Promise<void> => {
  try {
    const cwd = await $.session.cwd()
    const result = await $.mcp.call(server, 'cp_list_all_patches', { status: 'open', tags: ['energy:low'], sort_by: 'priority' })
    if (result.isError) throw new Error(result.content.map(b => b.text ?? '').join(' '))
    const patches = parsePatches(result.content.map(b => b.text ?? '').join(''))
    await update($, friedBoard, () => ({ rows: toFriedRows(patches, cwd, aliases).slice(0, MAX_OPEN) }))
  } catch (err) {
    $.ui.log(`patches: /fried load failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    await update($, friedBoard, () => ({ rows: [], error: "Couldn't reach ChaosPatch." })).catch((e: unknown) =>
      $.ui.log(`patches: showing the /fried error failed: ${e instanceof Error ? e.message : String(e)}`, { to: 'debug' }),
    )
  }
}

// The done chime, played here: a plugin's own $.tool.call skips its own tool.call hooks,
// so done-chime.ts never sees a Done pressed in this pane.
const celebrate = async ($: EngineInterface, title: string, withSound: boolean): Promise<void> => {
  let chime: string = CHIMES[0]
  try {
    const pick = nextCelebration(await read($, lastCelebration), [Math.random(), Math.random()])
    chime = CHIMES[pick.sound] ?? CHIMES[0]
    const git = await $.process.run(['git', 'status', '--porcelain']).catch(() => undefined)
    const isClean = git !== undefined && git.exitCode === 0 && isCleanStop(git.stdout, await read($, lastTestFailed))
    $.ui.toast(doneMessage(title, pick.opener), { timeoutMs: DONE_TOAST_MS })
    if (isClean) $.ui.toast(STOP_TOAST)
    await update($, lastCelebration, () => pick)
  } catch (err) {
    $.ui.log(`patches: celebrating failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
  if (withSound) void playChime($, chime)
}

const playChime = async ($: EngineInterface, chime: string): Promise<void> => {
  try {
    await $.audio.play({ asset: chime })
  } catch (err) {
    $.ui.log(`patches: sound failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

// The soundtrack, run here too: the pane's own $.tool.call skips soundtrack.ts's hooks.
// osascript's answer; undefined when it couldn't run at all.
const spotify = async ($: EngineInterface, script: string, args: string[]): Promise<string | undefined> => {
  try {
    const ran = await $.process.run(['osascript', '-e', script, ...args])
    if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `exit ${ran.exitCode}`)
    return ran.stdout.trim()
  } catch (err) {
    $.ui.log(`patches: spotify unreachable: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return undefined
  }
}

const soundtrackMusic = async ($: EngineInterface, tool: string, sound: Sound): Promise<void> => {
  try {
    if ((await $.store.get(SOUNDTRACK_KEY)) !== true) return
    if (tool === 'cp_start_patch') {
      const answer = await spotify($, START_SCRIPT, [sound.playlist])
      await update($, soundtrackStarted, () => answer === 'started')
    } else if (tool === 'cp_complete_patch' && sound.fadeOnDone && (await read($, soundtrackStarted))) {
      await update($, soundtrackStarted, () => false)
      await spotify($, FADE_SCRIPT, [])
    }
  } catch (err) {
    $.ui.log(`patches: soundtrack failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

type LooseResult = { deny?: string; isError?: boolean }

// Through $.tool.call with consent, so the permission path reads the press as Nae's request.
const changePatch = async (
  $: EngineInterface,
  server: string,
  aliases: Aliases,
  tool: string,
  row: BoardRow,
  label: string,
  sound: Sound,
): Promise<void> => {
  // Loosely typed: tsc gives up expanding every connected MCP tool's input types here (TS2589).
  const ran = await ($.tool.call as unknown as (input: Record<string, unknown> & { tool: string }) => Promise<LooseResult>)({
    tool: mcpToolName(server, tool),
    patch_id: row.id,
    consent: `Nae pressed "${label}" on "${row.title}" in /patches`,
  })
  if (ran.deny !== undefined || ran.isError === true) $.ui.toast(`Couldn't ${label.toLowerCase()} that patch.`)
  else {
    // Detached, so the board never waits on Spotify; a fade runs under the chime.
    void soundtrackMusic($, tool, sound)
    // Awaited, sound aside: toasts raised after the press settles skip this plugin's own toast queue.
    if (tool === 'cp_complete_patch') await celebrate($, row.title, sound.chime)
  }
  await loadBoard($, server, aliases)
}

// Start from /fried: the same call as /patches' Start, then this list reloads too.
const startFried = async ($: EngineInterface, server: string, aliases: Aliases, row: BoardRow, sound: Sound): Promise<void> => {
  await changePatch($, server, aliases, 'cp_start_patch', row, 'Start', sound)
  await loadFried($, server, aliases)
}

const handToCody = async ($: EngineInterface, row: BoardRow, pane: string): Promise<void> => {
  await $.ui.close({ id: pane })
  $.ui.toast(`→ Cody: ${row.title}`)
  await $.prompt.submit({ text: handoffPrompt(row) })
}

export const registerPatchesPane = (on: On, options: PluginOptions): void => {
  const server = typeof options.chaospatchServer === 'string' ? options.chaospatchServer : DEFAULT_SERVER
  const aliases = parseAliases(options.projectAliases)
  const sound: Sound = {
    chime: options.doneChimeSound !== false,
    playlist: playlistUri(options.soundtrackPlaylist),
    fadeOnDone: options.soundtrackFadeOnDone !== false,
  }

  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const result = await next(e)
    // Immediate: it only opens a pane and reads ChaosPatch, so it needn't wait for Cody's turn to end.
    await $.command.register({ name: 'patches', description: "Open this repo's ChaosPatch board", immediate: true })
    await $.command
      .register({ name: 'fried', description: 'Low on energy? Open only the easy patches (energy:low), across projects' })
      .catch((err: unknown) => $.ui.log(`patches: /fried not registered: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' }))
    return result
  })

  on('command.run', { command: 'patches' }, async $ => {
    await update($, board, () => null)
    void loadBoard($, server, aliases, 1)
    await $.ui.open({ id: PANE, title: 'Patches', focus: true, closeOnEscape: true })
    return {}
  })

  on('command.run', { command: 'fried' }, async $ => {
    await update($, friedBoard, () => null)
    void loadFried($, server, aliases)
    await $.ui.open({ id: FRIED_PANE, title: 'Low-energy patches', focus: true, closeOnEscape: true })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: FRIED_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = await read($, friedBoard)
    if (shown === null) return <Text dimColor>Finding the easy ones…</Text>
    if (shown.error !== undefined) return <Text dimColor>{shown.error}</Text>
    if (shown.rows.length === 0) return <Text>{FRIED_EMPTY}</Text>
    const here = shown.rows.filter(row => row.isHere)
    return (
      <Box flexDirection="column">
        {shown.rows.map(row => {
          const n = here.indexOf(row) + 1
          return (
            <Box key={`fried-${row.id}`} flexDirection="row" gap={1}>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">
                  {row.title} <Text dimColor>· {row.project}</Text>
                </Text>
              </Box>
              <Button key={`fstart-${row.id}`} onPress={() => startFried($, server, aliases, row, sound)}>
                Start
              </Button>
              {row.isHere && (
                <Button key={`fcody-${row.id}`} hotkey={String(n)} variant="primary" onPress={() => handToCody($, row, FRIED_PANE)}>
                  → Cody
                </Button>
              )}
            </Box>
          )
        })}
        <Text dimColor>{here.length > 0 ? `1–${here.length}: hand to Cody (this repo's) · ` : ''}Esc: close</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = await read($, board)
    if (shown === null) return <Text dimColor>Loading this repo's patches…</Text>
    if (shown.error !== undefined) return <Text dimColor>{shown.error}</Text>
    if (shown.inProgress.length === 0 && shown.open.length === 0) {
      return <Text dimColor>No open patches for this repo.</Text>
    }
    return (
      <Box flexDirection="column">
        {shown.inProgress.length > 0 && <Text bold>In progress</Text>}
        {shown.inProgress.map(row => (
          <Box key={`ip-${row.id}`} flexDirection="row" gap={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">🩹 {row.title}</Text>
            </Box>
            <Button key={`done-${row.id}`} onPress={() => changePatch($, server, aliases, 'cp_complete_patch', row, 'Done', sound)}>
              Done
            </Button>
          </Box>
        ))}
        {shown.open.length > 0 && <Text bold>Open</Text>}
        {shown.open.map((row, i) => (
          <Box key={`open-${row.id}`} flexDirection="row" gap={1}>
            <Text dimColor>{i + 1}</Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">{row.title}</Text>
            </Box>
            <Button key={`start-${row.id}`} onPress={() => changePatch($, server, aliases, 'cp_start_patch', row, 'Start', sound)}>
              Start
            </Button>
            <Button key={`cody-${row.id}`} hotkey={String(i + 1)} variant="primary" onPress={() => handToCody($, row, PANE)}>
              → Cody
            </Button>
          </Box>
        ))}
        <Text dimColor>1–{shown.open.length || 1}: hand to Cody · Esc: close</Text>
      </Box>
    )
  })
}
