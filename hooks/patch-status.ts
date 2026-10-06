import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import type { NextEvent, Patch, WorkStretch } from '../types'
import { BREAK_MS } from './session-clock.ts'

// #1 Patch status line: shows the in-progress ChaosPatch patch for this repo.
// #7 Patch timer: with how long it has been in progress.
// The one place the line is drawn: other modules write state, and a state.set hook here redraws.
// That hook misses this file's own writes and writes made in a /patches button press, so refresh()
// here and loadBoard() in patches-pane.tsx draw for themselves.
// Built against Claude Code 2.1.289.

export type { Patch }

// In $.state, not a module variable: /patches writes it after a press, since a plugin's
// own $.tool.call skips its own tool.call hooks (so the refresh hook below never sees it).
const activePatches = atom({ plugin: 'codynd', key: 'activePatches' } as const, [])
// #12: shown when no patch is in progress (set by focus.ts).
const focus = atom({ plugin: 'codynd', key: 'focus' } as const, null)
// next-event.ts caches it; the line ticks its minutes each redraw.
const nextEvent = atom({ plugin: 'codynd', key: 'nextEvent' } as const, null)
const workStretch = atom({ plugin: 'codynd', key: 'workStretch' } as const, null)
// Changes to these redraw the line.
const LINE_KEYS: readonly string[] = ['activePatches', 'focus', 'nextEvent', 'workStretch']

export const DEFAULT_SERVER = 'claude.ai ChaosPatch'
const REFRESH_MS = 5 * 60_000
// At session start ChaosPatch is often still connecting, so the first load fails. Without a quick
// retry the line, and the patch-or-focus reminder that reads it, sat empty until the 5-minute refresh.
export const STARTUP_RETRY_MS = 20_000
const STARTUP_RETRIES = 6
// Elapsed time redraws from the cached patches; no ChaosPatch call.
const TICK_MS = 60_000
const MAX_TITLE = 60
// Any ChaosPatch call that can change which patch is in progress.
const PATCH_WRITE_TOOL = /__cp_(start_patch|complete_patch|request_review|update_patch|reopen_patch|delete_patch|batch_update)$/

// "chicken-scratch", "Chicken Scratch" and "ChickenScratch" all become "chickenscratch".
export const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export const parsePatches = (text: string): Patch[] => {
  const parsed: unknown = JSON.parse(text)
  return Array.isArray(parsed) ? (parsed as Patch[]) : []
}

// Normalized folder name → normalized project slug or name, for repos whose folder doesn't match.
export type Aliases = Readonly<Record<string, string>>

// The projectAliases setting: "ADHD-AgenticDevHumanDesigns=adhdesigns, other-folder=other-slug".
export const parseAliases = (raw: unknown): Aliases => {
  if (typeof raw !== 'string') return {}
  const pairs = raw.split(',').flatMap(pair => {
    const [folder = '', project = ''] = pair.split('=').map(normalize)
    return folder !== '' && project !== '' ? [[folder, project] as const] : []
  })
  return Object.fromEntries(pairs)
}

// A repo matches a project when its folder name (or that folder's alias) equals the project's slug or name.
export const matchesRepo = (slug: string, name: string, cwd: string, aliases: Aliases = {}): boolean => {
  const folder = normalize(cwd.split('/').filter(Boolean).pop() ?? '')
  if (folder === '') return false
  const key = aliases[folder] ?? folder
  return normalize(slug) === key || normalize(name) === key
}

export const patchesForCwd = (patches: Patch[], cwd: string, aliases: Aliases = {}): Patch[] =>
  patches
    .filter(p => matchesRepo(p.project_slug, p.project_name, cwd, aliases))
    .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))

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

const EVENT_EMOJI: Record<string, string> = { school: '📚', work: '💼', personal: '🏠', errands: '🛒', health: '🩺' }
const EVENT_WINDOW_MS = 3 * 60 * 60_000
// The line is plain text, so "amber" is the emoji: 🟠 from 15 minutes out.
const EVENT_SOON_MS = 15 * 60_000

// "📚 Latin in 40m"; nothing once it has started or while it's more than 3h off.
export const eventSegment = (event: NextEvent | null, now: number): string | undefined => {
  if (event === null) return undefined
  const left = event.startsAt - now
  if (left <= 0 || left > EVENT_WINDOW_MS) return undefined
  const emoji = left <= EVENT_SOON_MS ? '🟠' : (EVENT_EMOJI[event.category ?? ''] ?? '📅')
  return `${emoji} ${truncate(event.title, 30)} in ${formatElapsed(left + 59_999)}`
}

// "⏱ 45m in": the body-check clock's stretch. Hidden on a break, so it never counts up while Nae's away.
export const stretchSegment = (stretch: WorkStretch | null, now: number): string | undefined =>
  stretch === null || now - stretch.lastActive >= BREAK_MS ? undefined : `⏱ ${formatElapsed(Math.max(0, now - stretch.start))} in`

export type LineParts = {
  patches: Patch[]
  focus: string | null
  now?: number
  event?: NextEvent | null
  stretch?: WorkStretch | null
}

// The whole line: an in-progress patch wins, then the focus, then the work stretch; the next event
// rides alongside whichever shows. The event leads: the status line is one line ("\n" is flattened),
// and a narrow terminal cuts the end, so a long patch title gets trimmed rather than the event.
export const statusLine = ({ patches, focus: label, now, event = null, stretch = null }: LineParts): string | undefined => {
  const work =
    formatStatus(patches, now) ?? (label !== null ? `🎯 ${label}` : now === undefined ? undefined : stretchSegment(stretch, now))
  const segments = [now === undefined ? undefined : eventSegment(event, now), work].filter(s => s !== undefined)
  return segments.length === 0 ? undefined : segments.join(' │ ')
}

// A write being drawn: its own value wins over a read, since every read in one dispatch sees the
// moment that dispatch began (a refresh started at session start would read the old value back).
type Written = { key: string; value: unknown }

const valueOr = <T,>(written: Written | undefined, key: string, readValue: () => Promise<T>): Promise<T> =>
  written?.key === key ? Promise.resolve(written.value as T) : readValue()

// Runs from timers: it catches its own errors, so a reload mid-draw leaves no unhandled rejection.
const draw = async ($: EngineInterface, written?: Written): Promise<void> => {
  try {
    $.ui.status(
      statusLine({
        patches: await valueOr(written, 'activePatches', () => read($, activePatches)),
        focus: await valueOr(written, 'focus', () => read($, focus)),
        now: await $.clock.now(),
        event: await valueOr(written, 'nextEvent', () => read($, nextEvent)),
        stretch: await valueOr(written, 'workStretch', () => read($, workStretch)),
      }),
    )
  } catch (err) {
    $.ui.log(`patch-status: draw failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

// Unreachable server or bad response: clear the line, note it in the debug log only, and try
// again soon while `retries` remain (only the session-start load has any).
const refresh = async ($: EngineInterface, server: string, aliases: Aliases, retries = 0): Promise<void> => {
  try {
    const [cwd, result] = await Promise.all([
      $.session.cwd(),
      $.mcp.call(server, 'cp_list_all_patches', { status: 'in_progress' }),
    ])
    if (result.isError) throw new Error(result.content.map(b => b.text ?? '').join(' '))
    const text = result.content.map(b => b.text ?? '').join('')
    const patches = patchesForCwd(parsePatches(text), cwd, aliases)
    await update($, activePatches, () => patches)
    await draw($, { key: 'activePatches', value: patches })
  } catch (err) {
    $.ui.log(`patch-status: refresh failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    await update($, activePatches, () => []).catch((e: unknown) =>
      $.ui.log(`patch-status: clearing failed: ${e instanceof Error ? e.message : String(e)}`, { to: 'debug' }),
    )
    await draw($, { key: 'activePatches', value: [] })
    if (retries > 0) $.clock.after(STARTUP_RETRY_MS, () => void refresh($, server, aliases, retries - 1))
  }
}

export const registerPatchStatus = (on: On, options: PluginOptions): void => {
  const server = typeof options.chaospatchServer === 'string' ? options.chaospatchServer : DEFAULT_SERVER
  const aliases = parseAliases(options.projectAliases)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    void refresh($, server, aliases, STARTUP_RETRIES)
    $.clock.every(REFRESH_MS, () => void refresh($, server, aliases))
    $.clock.every(TICK_MS, () => void draw($))
    return result
  })

  on('state.set', async ($, e, next) => {
    const result = await next(e)
    if (e.plugin === 'codynd' && LINE_KEYS.includes(e.key)) await draw($, { key: e.key, value: e.value })
    return result
  })

  // Awaited, so the patch list is current before Cody sees the result: a background refresh lost
  // the race to Cody's next edit, and the patch-or-focus reminder read the old, empty list.
  on('tool.call', { tool: PATCH_WRITE_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    await refresh($, server, aliases)
    return ran
  })
}
