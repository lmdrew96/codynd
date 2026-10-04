import type { EngineInterface, On, PluginOptions } from 'claude-code'

// #1 Patch status line: shows the in-progress ChaosPatch patch for this repo.
// Built against Claude Code 2.1.289.

export type Patch = {
  title: string
  project_slug: string
  project_name: string
  started_at: string | null
}

export const DEFAULT_SERVER = 'claude.ai ChaosPatch'
const REFRESH_MS = 5 * 60_000
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

export const formatStatus = (patches: Patch[]): string | undefined => {
  const [newest, ...rest] = patches
  if (newest === undefined) return undefined
  const title = truncate(newest.title)
  return rest.length > 0 ? `🩹 ${title} (+${rest.length})` : `🩹 ${title}`
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
    $.ui.status(formatStatus(patchesForCwd(parsePatches(text), cwd)))
  } catch (err) {
    $.ui.status(undefined)
    $.ui.log(`patch-status: refresh failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

export const registerPatchStatus = (on: On, options: PluginOptions): void => {
  const server = typeof options.chaospatchServer === 'string' ? options.chaospatchServer : DEFAULT_SERVER

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    void refresh($, server)
    $.clock.every(REFRESH_MS, () => void refresh($, server))
    return result
  })

  on('tool.call', { tool: PATCH_WRITE_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    void refresh($, server)
    return ran
  })
}
