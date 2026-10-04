import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import type { Board, BoardRow } from '../types'
import { CHIME, DONE_TOAST_MS, doneMessage } from './done-chime.ts'
import { DEFAULT_SERVER, parsePatches, patchesForCwd, statusLine, type Patch } from './patch-status.ts'

// #11 /patches: this repo's ChaosPatch board in a pane, driven by buttons, no model turn.
// Built against Claude Code 2.1.289.

const PANE = 'codynd-patches'
const MAX_OPEN = 9
const board = atom({ plugin: 'codynd', key: 'board' } as const, null)
// The same state as patch-status.ts's activePatches (the validator wants atoms declared per file).
const activePatches = atom({ plugin: 'codynd', key: 'activePatches' } as const, [])
const focus = atom({ plugin: 'codynd', key: 'focus' } as const, null)

// "claude.ai ChaosPatch" is listed to the model as mcp__claude_ai_ChaosPatch__<tool>.
export const mcpToolName = (server: string, tool: string): string =>
  `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__${tool}`

export const toRows = (patches: Patch[]): BoardRow[] =>
  patches.flatMap(p => {
    const id = (p as Patch & { id?: unknown }).id
    return typeof id === 'string' ? [{ id, title: p.title }] : []
  })

export const handoffPrompt = (row: BoardRow): string => `Start ChaosPatch patch "${row.title}" (id ${row.id}).`

const listForRepo = async ($: EngineInterface, server: string, args: Record<string, unknown>, cwd: string): Promise<Patch[]> => {
  const result = await $.mcp.call(server, 'cp_list_all_patches', args)
  if (result.isError) throw new Error(result.content.map(b => b.text ?? '').join(' '))
  return patchesForCwd(parsePatches(result.content.map(b => b.text ?? '').join('')), cwd)
}

const loadBoard = async ($: EngineInterface, server: string): Promise<void> => {
  try {
    const cwd = await $.session.cwd()
    const [inProgress, open] = await Promise.all([
      listForRepo($, server, { status: 'in_progress' }, cwd),
      listForRepo($, server, { status: 'open', sort_by: 'priority' }, cwd),
    ])
    await update($, board, () => ({ inProgress: toRows(inProgress), open: toRows(open).slice(0, MAX_OPEN) }))
    // Keep the status line in step: it shares this list (see activePatches in patch-status.ts).
    await update($, activePatches, () => inProgress)
    $.ui.status(statusLine(inProgress, await read($, focus), await $.clock.now()))
  } catch (err) {
    $.ui.log(`patches: load failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    await update($, board, () => ({ inProgress: [], open: [], error: "Couldn't reach ChaosPatch." })).catch((e: unknown) =>
      $.ui.log(`patches: showing the error failed: ${e instanceof Error ? e.message : String(e)}`, { to: 'debug' }),
    )
  }
}

// The done chime, played here: a plugin's own $.tool.call skips its own tool.call hooks,
// so done-chime.ts never sees a Done pressed in this pane.
const celebrate = async ($: EngineInterface, title: string, withSound: boolean): Promise<void> => {
  $.ui.toast(doneMessage(title), { timeoutMs: DONE_TOAST_MS })
  if (!withSound) return
  try {
    await $.audio.play({ asset: CHIME })
  } catch (err) {
    $.ui.log(`patches: sound failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

type LooseResult = { deny?: string; isError?: boolean }

// Through $.tool.call with consent, so the permission path reads the press as Nae's request.
const changePatch = async (
  $: EngineInterface,
  server: string,
  tool: string,
  row: BoardRow,
  label: string,
  withSound: boolean,
): Promise<void> => {
  // Loosely typed: tsc gives up expanding every connected MCP tool's input types here (TS2589).
  const ran = await ($.tool.call as unknown as (input: Record<string, unknown> & { tool: string }) => Promise<LooseResult>)({
    tool: mcpToolName(server, tool),
    patch_id: row.id,
    consent: `Nae pressed "${label}" on "${row.title}" in /patches`,
  })
  if (ran.deny !== undefined || ran.isError === true) $.ui.toast(`Couldn't ${label.toLowerCase()} that patch.`)
  else if (tool === 'cp_complete_patch') void celebrate($, row.title, withSound)
  await loadBoard($, server)
}

const handToCody = async ($: EngineInterface, row: BoardRow): Promise<void> => {
  await $.ui.close({ id: PANE })
  $.ui.toast(`→ Cody: ${row.title}`)
  await $.prompt.submit({ text: handoffPrompt(row) })
}

export const registerPatchesPane = (on: On, options: PluginOptions): void => {
  const server = typeof options.chaospatchServer === 'string' ? options.chaospatchServer : DEFAULT_SERVER
  const withSound = options.doneChimeSound !== false

  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'patches', description: "Open this repo's ChaosPatch board" })
    return result
  })

  on('command.run', { command: 'patches' }, async $ => {
    await update($, board, () => null)
    void loadBoard($, server)
    await $.ui.open({ id: PANE, title: 'Patches', focus: true, closeOnEscape: true })
    return {}
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
            <Button key={`done-${row.id}`} onPress={() => changePatch($, server, 'cp_complete_patch', row, 'Done', withSound)}>
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
            <Button key={`start-${row.id}`} onPress={() => changePatch($, server, 'cp_start_patch', row, 'Start', withSound)}>
              Start
            </Button>
            <Button key={`cody-${row.id}`} hotkey={String(i + 1)} variant="primary" onPress={() => handToCody($, row)}>
              → Cody
            </Button>
          </Box>
        ))}
        <Text dimColor>1–{shown.open.length || 1}: hand to Cody · Esc: close</Text>
      </Box>
    )
  })
}
