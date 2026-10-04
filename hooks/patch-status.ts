import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import type { Patch } from '../types'

// #1 Patch status line: shows the in-progress ChaosPatch patch for this repo.
// #7 Patch timer: with how long it has been in progress.
// Built against Claude Code 2.1.289.

export type { Patch }

// In $.state, not a module variable: /patches writes it after a press, since a plugin's
// own $.tool.call skips its own tool.call hooks (so the refresh hook below never sees it).
const activePatches = atom({ plugin: 'codynd', key: 'activePatches' } as const, [])

export const DEFAULT_SERVER = 'claude.ai ChaosPatch'
const REFRESH_MS = 5 * 60_000
// Elapsed time redraws from the cached patches; no ChaosPatch call.
const TICK_MS = 60_000
const MAX_TITLE = 60
// Any ChaosPatch call that can change which patch is in progress.
const PATCH_WRITE_TOOL = /__cp_(start_patch|complete_patch|update_patch|reopen_patch|delete_patch|batch_update)$/

// "chicken-scratch", "Chicken Scratch" and "ChickenScratch" all become "chickenscratch".
export const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export const parsePatches = (text: string): Patch[] => {
  const parsed: unknown = JSON.parse(text)
  return Array.isArray(parsed) ? (parsed as Patch[]) : []
}

// A repo matches a project when its folder name equals the project's slug or name.
export const patchesForCwd = (patches: Patch[], cwd: string): Patch[] => {
  const folder = normalize(cwd.split('/').filter(Boolean).pop() ?? '')
  if (folder === '') return []
  return patches
    .filter(p => normalize(p.project_slug) === folder || normalize(p.project_name) === folder)
    .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))
}

export const truncate = (s: string, max = MAX_TITLE): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

// Informational, never alarming: past a day it's whole days ("3d"), not "74h 12m".
export const formatElapsed = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d`
}

export const formatStatus = (patches: Patch[], now?: number): string | undefined => {
  const [newest, ...rest] = patches
  if (newest === undefined) return undefined
  const startedAt = newest.started_at === null ? NaN : Date.parse(newest.started_at)
  const elapsed = now === undefined || Number.isNaN(startedAt) ? '' : ` · ${formatElapsed(Math.max(0, now - startedAt))}`
  const more = rest.length > 0 ? ` (+${rest.length})` : ''
  return `🩹 ${truncate(newest.title)}${elapsed}${more}`
}

// Runs from timers: it catches its own errors, so a reload mid-draw leaves no unhandled rejection.
const draw = async ($: EngineInterface): Promise<void> => {
  try {
    $.ui.status(formatStatus(await read($, activePatches), await $.clock.now()))
  } catch (err) {
    $.ui.log(`patch-status: draw failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

// Unreachable server or bad response: clear the line, note it in the debug log only.
const refresh = async ($: EngineInterface, server: string): Promise<void> => {
  try {
    const [cwd, result] = await Promise.all([
      $.session.cwd(),
      $.mcp.call(server, 'cp_list_all_patches', { status: 'in_progress' }),
    ])
    if (result.isError) throw new Error(result.content.map(b => b.text ?? '').join(' '))
    const text = result.content.map(b => b.text ?? '').join('')
    const patches = patchesForCwd(parsePatches(text), cwd)
    await update($, activePatches, () => patches)
    await draw($)
  } catch (err) {
    $.ui.status(undefined)
    $.ui.log(`patch-status: refresh failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    await update($, activePatches, () => []).catch((e: unknown) =>
      $.ui.log(`patch-status: clearing failed: ${e instanceof Error ? e.message : String(e)}`, { to: 'debug' }),
    )
  }
}

export const registerPatchStatus = (on: On, options: PluginOptions): void => {
  const server = typeof options.chaospatchServer === 'string' ? options.chaospatchServer : DEFAULT_SERVER

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    void refresh($, server)
    $.clock.every(REFRESH_MS, () => void refresh($, server))
    $.clock.every(TICK_MS, () => void draw($))
    return result
  })

  on('tool.call', { tool: PATCH_WRITE_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    void refresh($, server)
    return ran
  })
}
