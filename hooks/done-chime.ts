import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { truncate } from './patch-status.ts'

// #2 Done chime: a toast (and optional sound) when a ChaosPatch patch is completed.
// Built against Claude Code 2.1.289.

const COMPLETE_TOOL = /__cp_complete_patch$/
const CHIME = 'sounds/done.wav'

// cp_complete_patch answers with the patch as JSON; anything else gets the generic toast.
export const patchTitle = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    const title = (parsed as { title?: unknown } | null)?.title
    return typeof title === 'string' ? title : undefined
  } catch {
    return undefined
  }
}

export const doneMessage = (title: string | undefined): string =>
  title === undefined ? '🎉 Patch done!' : `🎉 Patch done: ${truncate(title)}`

const celebrate = async ($: EngineInterface, title: string | undefined, withSound: boolean): Promise<void> => {
  $.ui.toast(doneMessage(title))
  if (!withSound) return
  try {
    await $.audio.play({ asset: CHIME })
  } catch (err) {
    $.ui.log(`done-chime: sound failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

export const registerDoneChime = (on: On, options: PluginOptions): void => {
  const withSound = options.doneChimeSound !== false

  on('tool.call', { tool: COMPLETE_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) void celebrate($, patchTitle(ran.text), withSound)
    return ran
  })
}
