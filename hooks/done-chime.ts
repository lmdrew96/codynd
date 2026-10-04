import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import type { Celebration } from '../types'
import { truncate } from './patch-status.ts'

// #2 Done chime: a toast (and optional sound) when a ChaosPatch patch is completed.
// #8 Chime variety: the sound and the toast's opener rotate, never the same twice running.
// Clean stopping point: after the win, permission to stop when the tree is committed and the
// last test run passed. Silent otherwise; never a nag.
// Built against Claude Code 2.1.289.

const COMPLETE_TOOL = /__cp_complete_patch$/
const BASH_TOOL = /^Bash$/
// Original synthesized clips. done.wav comes first: a session's first win is always the classic.
export const CHIMES = ['sounds/done.wav', 'sounds/arpeggio.wav', 'sounds/marimba.wav', 'sounds/blip-ding.wav'] as const
// patches-pane.tsx shares this through the same atom, so a Done there counts as the last pick too.
const lastCelebration = atom({ plugin: 'codynd', key: 'lastCelebration' } as const, null)
// null until a test command runs this session; then whether the latest one failed.
const lastTestFailed = atom({ plugin: 'codynd', key: 'lastTestFailed' } as const, null)

export const STOP_TOAST = '🟢 Clean stopping point. Safe to walk away.'

// Test runners Cody runs through Bash, anywhere in the command (cd … && pnpm test | tail). Bare
// runner names count only as a command, so `cat vitest.config.ts` isn't a test run.
const TEST_COMMAND =
  /\b(?:(?:pnpm|npm|yarn|bun)(?:\s+-\S+)*\s+(?:run\s+)?test|npx\s+(?:vitest|jest)|cargo\s+test|go\s+test|claude\s+plugin\s+test)\b|(?:^|[;&|]\s*)(?:vitest|jest|pytest)\b/
// A pipe (| tail) hides the exit code, so the runner's own summary counts too: "3 fail", "1 failed".
const FAIL_SUMMARY = /\b[1-9]\d*\s+(?:fail|failed|failing|failures?)\b/i

export const isTestCommand = (command: string): boolean => TEST_COMMAND.test(command)

export const testRunFailed = (isError: boolean, output: string): boolean => isError || FAIL_SUMMARY.test(output)

// Core's text when it set it; else Bash's own result, a string or { stdout, stderr }.
// error-decoder.ts reads Bash output the same way.
export const outputOf = (ran: { text?: string; result?: unknown }): string => {
  if (ran.text !== undefined) return ran.text
  if (typeof ran.result === 'string') return ran.result
  const r = (ran.result ?? {}) as { stdout?: unknown; stderr?: unknown }
  return [r.stdout, r.stderr].filter((s): s is string => typeof s === 'string').join('\n')
}

// Clean: nothing uncommitted, and no failing test run this session (none run counts as fine).
export const isCleanStop = (porcelain: string, testFailed: boolean | null): boolean =>
  porcelain.trim() === '' && testFailed !== true

const cleanStop = async ($: EngineInterface): Promise<boolean> => {
  try {
    const git = await $.process.run(['git', 'status', '--porcelain'])
    return git.exitCode === 0 && isCleanStop(git.stdout, await read($, lastTestFailed))
  } catch (err) {
    $.ui.log(`done-chime: stopping-point check failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return false
  }
}
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

// Awaited inside the tool.call hook: once that hook returns, this plugin's own ui.toast hook
// (toast-queue.ts) no longer sees its toasts, and a done toast it misses can't hold the line.
// Resolves the chime to play; never throws into the tool call.
const announce = async ($: EngineInterface, title: string | undefined): Promise<string> => {
  try {
    const pick = nextCelebration(await read($, lastCelebration), [Math.random(), Math.random()])
    const isClean = await cleanStop($)
    // The stopping point queues behind the done toast.
    $.ui.toast(doneMessage(title, pick.opener), { timeoutMs: DONE_TOAST_MS })
    if (isClean) $.ui.toast(STOP_TOAST)
    await update($, lastCelebration, () => pick)
    return CHIMES[pick.sound] ?? CHIMES[0]
  } catch (err) {
    $.ui.log(`done-chime: celebrating failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return CHIMES[0]
  }
}

// Detached: the result needn't wait out the sound.
const playChime = async ($: EngineInterface, chime: string): Promise<void> => {
  try {
    await $.audio.play({ asset: chime })
  } catch (err) {
    $.ui.log(`done-chime: sound failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

export const registerDoneChime = (on: On, options: PluginOptions): void => {
  const withSound = options.doneChimeSound !== false

  on('tool.call', { tool: COMPLETE_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const chime = await announce($, patchTitle(ran.text))
    if (withSound) void playChime($, chime)
    return ran
  })

  // Remembers whether the latest test run passed, for the stopping point. Never runs tests itself.
  on('tool.call', { tool: BASH_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    const command = (e as { command?: unknown }).command
    if (ran.deny === undefined && typeof command === 'string' && isTestCommand(command)) {
      const failed = testRunFailed(ran.isError === true, outputOf(ran))
      await update($, lastTestFailed, () => failed).catch((err: unknown) =>
        $.ui.log(`done-chime: recording the test run failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' }),
      )
    }
    return ran
  })
}
