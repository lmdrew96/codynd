import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { truncate } from './patch-status.ts'

// #2 Done chime: a toast (and optional sound) when a ChaosPatch patch is completed.
// Built against Claude Code 2.1.289.

const COMPLETE_TOOL = /__cp_complete_patch$/
export const CHIME = 'sounds/done.wav'
// Toasts can't be sticky (only a timeout), so the win stays up long enough to actually see.
export const DONE_TOAST_MS = 10_000

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

// toast-queue.ts recognizes done toasts by this prefix.
export const DONE_PREFIX = '🎉 Patch done'

export const doneMessage = (title: string | undefined): string =>
  title === undefined ? `${DONE_PREFIX}!` : `${DONE_PREFIX}: ${truncate(title)}`

const celebrate = async ($: EngineInterface, title: string | undefined, withSound: boolean): Promise<void> => {
  $.ui.toast(doneMessage(title), { timeoutMs: DONE_TOAST_MS })
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
