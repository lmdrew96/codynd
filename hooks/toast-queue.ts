import type { On } from 'claude-code'
import { isDoneToast } from './done-chime.ts'

// Toast queue: a done toast is never replaced by a later CodyND toast. Outside fullscreen a
// toast is one line on the notification bar, so a newer one hides the older.
// Unlike tool.call, the plugin's own ui.toast hook does see its own $.ui.toast calls.
// Built against Claude Code 2.1.289.

const DEFAULT_TOAST_MS = 4000

export type Slot = { delayMs: number; holdUntil: number }

// Every toast waits for any done toast showing; a done toast then holds the line for its own timeout.
export const schedule = (now: number, holdUntil: number, isDone: boolean, timeoutMs = DEFAULT_TOAST_MS): Slot => {
  const at = Math.max(now, holdUntil)
  return { delayMs: at - now, holdUntil: isDone ? at + timeoutMs : holdUntil }
}

export const registerToastQueue = (on: On): void => {
  // Module state: a reload mid-toast just drops the hold, which is harmless.
  let holdUntil = 0

  on('ui.toast', async ($, e, next) => {
    const slot = schedule(await $.clock.now(), holdUntil, isDoneToast(e.text), e.timeoutMs)
    holdUntil = slot.holdUntil
    if (slot.delayMs === 0) return next(e)
    // Re-raised when its turn comes; by then the hold has passed, so it shows (or waits for a newer done toast).
    $.clock.after(slot.delayMs, () => $.ui.toast(e.text, e.timeoutMs === undefined ? undefined : { timeoutMs: e.timeoutMs }))
    return { value: undefined }
  })
}
