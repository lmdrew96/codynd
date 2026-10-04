import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { truncate } from './patch-status.ts'

// #6 /park: send a side-thought to Kindling without leaving the session.
// Built against Claude Code 2.1.289.

export const KINDLING_SERVER = 'claude.ai Kindling'
const TITLE_AFTER = 120

// Kindling lowercases tags; the folder name keeps parked thoughts findable per repo.
export const parkTags = (cwd: string): string[] => {
  const folder = cwd.split('/').filter(Boolean).pop()
  return folder === undefined ? ['parked'] : ['parked', `project:${folder.toLowerCase()}`]
}

// Long thoughts get a short title so they stay scannable in Kindling's list.
export const kindleArgs = (text: string, cwd: string): Record<string, unknown> => ({
  content: text,
  tags: parkTags(cwd),
  ...(text.length > TITLE_AFTER ? { title: truncate(text) } : {}),
})

// Saved: a toast and no transcript line. Not saved: the thought is echoed back so it isn't lost.
const park = async ($: EngineInterface, server: string, text: string): Promise<{ text?: string }> => {
  try {
    const result = await $.mcp.call(server, 'kindle', kindleArgs(text, await $.session.cwd()))
    if (result.isError) throw new Error(result.content.map(b => b.text ?? '').join(' '))
    $.ui.toast(`🅿️ Parked: ${truncate(text, 40)}`)
    return {}
  } catch (err) {
    $.ui.log(`park: kindle failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    $.ui.toast("Couldn't park that one; it's in the transcript.")
    return { text: `Not saved to Kindling. Your thought: ${text}` }
  }
}

export const registerPark = (on: On, options: PluginOptions): void => {
  const server = typeof options.kindlingServer === 'string' ? options.kindlingServer : KINDLING_SERVER

  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const result = await next(e)
    // Immediate: runs the moment it's typed, even mid-turn, so a parked thought never waits on Cody.
    await $.command.register({ name: 'park', description: 'Park a side-thought in Kindling: /park <thought>', immediate: true })
    return result
  })

  on('command.run', { command: 'park' }, async ($, e) => {
    const text = e.args.trim()
    if (text === '') return { text: 'Usage: /park <thought>' }
    return park($, server, text)
  })
}
