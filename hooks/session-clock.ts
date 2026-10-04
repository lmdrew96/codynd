import type { EngineInterface, On, PluginOptions } from 'claude-code'

// #3 Session clock: a gentle body-check toast after a long stretch of continuous work.
// Built against Claude Code 2.1.289.

const MINUTE = 60_000
const DEFAULT_INTERVAL_MIN = 90
// No prompt from Nae for this long counts as a break: the streak starts over.
const BREAK_MS = 20 * MINUTE
const CHECK_MS = MINUTE
const DEFAULT_SNOOZE_MIN = 30
const TOAST_MS = 15_000

export type Streak = { start: number; lastActive: number; nextNudgeAt: number }

export const newStreak = (now: number, intervalMs: number): Streak => ({
  start: now,
  lastActive: now,
  nextNudgeAt: now + intervalMs,
})

// A prompt after a break starts a fresh streak; otherwise it just marks Nae as still here.
export const markActive = (streak: Streak, now: number, intervalMs: number): Streak =>
  now - streak.lastActive >= BREAK_MS ? newStreak(now, intervalMs) : { ...streak, lastActive: now }

// Nudge only while Nae is still around, and once per interval (never stacked).
export const isNudgeDue = (streak: Streak, now: number): boolean =>
  now >= streak.nextNudgeAt && now - streak.lastActive < BREAK_MS

export const formatDuration = (ms: number): string => {
  const minutes = Math.floor(ms / MINUTE)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

export const nudgeMessage = (elapsedMs: number): string =>
  `🫖 ${formatDuration(elapsedMs)} in — water? food? stretch?`

export const parseSnooze = (args: string): number | undefined => {
  const trimmed = args.trim()
  if (trimmed === '') return DEFAULT_SNOOZE_MIN
  const minutes = Number(trimmed)
  return Number.isInteger(minutes) && minutes > 0 ? minutes : undefined
}

type Box = { streak: Streak | undefined }

const tick = async ($: EngineInterface, box: Box, intervalMs: number): Promise<void> => {
  const now = await $.clock.now()
  if (box.streak === undefined || !isNudgeDue(box.streak, now)) return
  $.ui.toast(nudgeMessage(now - box.streak.start), { timeoutMs: TOAST_MS })
  box.streak = { ...box.streak, nextNudgeAt: now + intervalMs }
}

export const registerSessionClock = (on: On, options: PluginOptions): void => {
  const minutes = typeof options.bodyCheckMinutes === 'number' && options.bodyCheckMinutes > 0
    ? options.bodyCheckMinutes
    : DEFAULT_INTERVAL_MIN
  const intervalMs = minutes * MINUTE
  const box: Box = { streak: undefined }

  // Interactive only: nobody needs a body check in a headless `claude -p` run.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const result = await next(e)
    box.streak = newStreak(await $.clock.now(), intervalMs)
    // Immediate: snoozing shouldn't wait for a long turn to finish.
    await $.command.register({
      name: 'snooze',
      description: 'Snooze the body-check nudge (minutes, default 30).',
      immediate: true,
    })
    $.clock.every(CHECK_MS, () => void tick($, box, intervalMs))
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer') {
      const now = await $.clock.now()
      box.streak = box.streak === undefined ? newStreak(now, intervalMs) : markActive(box.streak, now, intervalMs)
    }
    return next(e)
  })

  on('command.run', { command: 'snooze' }, async ($, e) => {
    const snoozeMin = parseSnooze(e.args)
    if (snoozeMin === undefined) return { text: 'Usage: /snooze [minutes], e.g. /snooze 45' }
    const now = await $.clock.now()
    const streak = box.streak ?? newStreak(now, intervalMs)
    box.streak = { ...streak, nextNudgeAt: now + snoozeMin * MINUTE }
    return { text: `Body check snoozed for ${formatDuration(snoozeMin * MINUTE)}.` }
  })
}
