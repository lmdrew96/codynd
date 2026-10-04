import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import type { Celebration } from '../types'
import { truncate } from './patch-status.ts'

// #2 Done chime: a toast (and optional sound) when a ChaosPatch patch is completed.
// #8 Chime variety: the sound and the toast's opener rotate, never the same twice running.
// Built against Claude Code 2.1.289.

const COMPLETE_TOOL = /__cp_complete_patch$/
// Original synthesized clips. done.wav comes first: a session's first win is always the classic.
export const CHIMES = ['sounds/done.wav', 'sounds/arpeggio.wav', 'sounds/marimba.wav', 'sounds/blip-ding.wav'] as const
// patches-pane.tsx shares this through the same atom, so a Done there counts as the last pick too.
const lastCelebration = atom({ plugin: 'codynd', key: 'lastCelebration' } as const, null)
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

// Openers for the done toast; the first is the classic. toast-queue.ts recognizes done toasts by them.
export const DONE_OPENERS = ['🎉 Patch done', '✨ Shipped', '🌱 One less thing', '🏁 Done and dusted', '💥 Knocked out'] as const

export const isDoneToast = (text: string): boolean => DONE_OPENERS.some(opener => text.startsWith(opener))

export const doneMessage = (title: string | undefined, opener: number = 0): string => {
  const head = DONE_OPENERS[opener] ?? DONE_OPENERS[0]
  return title === undefined ? `${head}!` : `${head}: ${truncate(title)}`
}

// Any index but `last`, drawn by `roll` in [0, 1); no last pick means the classic (0).
export const pickOther = (count: number, last: number | undefined, roll: number): number => {
  if (last === undefined || count < 2) return 0
  const n = Math.floor(roll * (count - 1))
  return n >= last ? n + 1 : n
}

export const nextCelebration = (last: Celebration | null, rolls: [number, number]): Celebration => ({
  sound: pickOther(CHIMES.length, last?.sound, rolls[0]),
  opener: pickOther(DONE_OPENERS.length, last?.opener, rolls[1]),
})

const celebrate = async ($: EngineInterface, title: string | undefined, withSound: boolean): Promise<void> => {
  const pick = nextCelebration(await read($, lastCelebration), [Math.random(), Math.random()])
  // Toast before the state write: written after it, the toast skipped toast-queue.ts's hook.
  $.ui.toast(doneMessage(title, pick.opener), { timeoutMs: DONE_TOAST_MS })
  await update($, lastCelebration, () => pick)
  if (!withSound) return
  try {
    await $.audio.play({ asset: CHIMES[pick.sound] ?? CHIMES[0] })
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
