import { atom, read } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { Patch } from '../types'
import { truncate } from './patch-status.ts'

// #10 /wrap: leave a "where I left off" note for this repo; the re-entry card shows it next session.
// Built against Claude Code 2.1.289.

export type LeftOff = { note: string; savedAt: number }

const MAX_NOTE = 200
// Read-only here: the same state the status line and focus slot use.
const activePatches = atom({ plugin: 'codynd', key: 'activePatches' } as const, [])
const focus = atom({ plugin: 'codynd', key: 'focus' } as const, null)

// One note per repo, kept across sessions in the mod's own store; the newest wins.
export const wrapKey = (cwd: string): string => `wrap:${cwd}`

// Bare /wrap saves what's current: the in-progress patch, else the focus.
export const autoNote = (patches: Patch[], focusLabel: string | null): string | null => {
  const [newest] = patches
  if (newest !== undefined) return `🩹 ${newest.title}`
  return focusLabel === null ? null : `🎯 ${focusLabel}`
}

// Informational only: a count, never a warning.
export const uncommittedLine = (porcelain: string): string | null => {
  const count = porcelain.split('\n').filter(Boolean).length
  if (count === 0) return null
  return `${count} uncommitted ${count === 1 ? 'file' : 'files'}.`
}

const wrap = async ($: EngineInterface, args: string): Promise<{ text: string }> => {
  const typed = args.replace(/\s+/g, ' ').trim()
  const note = typed !== '' ? truncate(typed, MAX_NOTE) : autoNote(await read($, activePatches), await read($, focus))
  if (note === null) return { text: 'Nothing to save yet. Add a note: /wrap <where you left off>' }
  const cwd = await $.session.cwd()
  try {
    const left: LeftOff = { note, savedAt: await $.clock.now() }
    await $.store.set(wrapKey(cwd), left)
  } catch (err) {
    $.ui.log(`wrap: save failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return { text: `Couldn't save that. Your note: ${note}` }
  }
  const status = await $.process.run(['git', 'status', '--porcelain']).catch(() => undefined)
  const dirty = status !== undefined && status.exitCode === 0 ? uncommittedLine(status.stdout) : null
  return { text: [`Saved for next time: ${note}`, ...(dirty === null ? [] : [dirty])].join('\n') }
}

export const registerWrap = (on: On): void => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const result = await next(e)
    await $.command
      .register({
        name: 'wrap',
        description: 'Leave a where-I-left-off note for next session: /wrap <note>, or /wrap alone to save the current patch/focus',
        argumentHint: '[note]',
        immediate: true,
      })
      .catch((err: unknown) => $.ui.log(`wrap: /wrap not registered: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' }))
    return result
  })

  on('command.run', { command: 'wrap' }, async ($, e) => wrap($, e.args))
}
