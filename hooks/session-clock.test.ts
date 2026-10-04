import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { formatDuration, isNudgeDue, markActive, newStreak, nudgeMessage, parseSnooze } from './session-clock.ts'

const MIN = 60_000
const INTERVAL = 90 * MIN

describe('helpers', () => {
  test('a prompt after a 20-minute gap starts a fresh streak', () => {
    const s = newStreak(0, INTERVAL)
    expect(markActive(s, 19 * MIN, INTERVAL).start).toBe(0)
    expect(markActive(s, 20 * MIN, INTERVAL).start).toBe(20 * MIN)
  })

  test('nudge is due at the interval, only while still active', () => {
    const s = { ...newStreak(0, INTERVAL), lastActive: 85 * MIN }
    expect(isNudgeDue(s, 89 * MIN)).toBe(false)
    expect(isNudgeDue(s, 90 * MIN)).toBe(true)
    expect(isNudgeDue(s, 105 * MIN)).toBe(false)
  })

  test('durations and messages read naturally', () => {
    expect(formatDuration(45 * MIN)).toBe('45m')
    expect(formatDuration(120 * MIN)).toBe('2h')
    expect(formatDuration(150 * MIN)).toBe('2h 30m')
    expect(nudgeMessage(90 * MIN)).toBe('🫖 1h 30m in — water? food? stretch?')
  })

  test('snooze takes whole positive minutes, 30 by default', () => {
    expect(parseSnooze('')).toBe(30)
    expect(parseSnooze(' 45 ')).toBe(45)
    expect(parseSnooze('soon')).toBeUndefined()
    expect(parseSnooze('-5')).toBeUndefined()
  })
})

// Answers what the plugin touches beneath it, and records the toasts.
const world = (on: On): string[] => {
  const toasts: string[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x/elsewhere' }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '[]' }], isError: false } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return toasts
}

const typePrompt = async ($: Engine): Promise<void> => {
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
}

// Nae types a prompt every 10 minutes for `minutes`.
const workFor = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }, minutes: number): Promise<void> => {
  for (let t = 0; t < minutes; t += 10) {
    await typePrompt($)
    await clock.advance(10 * MIN)
  }
}

describe('session clock', () => {
  test('one nudge after 90 minutes of steady work, not stacked', async ($, on) => {
    const clock = mock.clock(on)
    const toasts = world(on)
    await $.session.start({ cwd: '/x/elsewhere', surface: 'terminal', isInteractive: true })
    await workFor($, clock, 100)
    expect(toasts).toEqual(['🫖 1h 30m in — water? food? stretch?'])
  })

  test('no nudge while Nae is away', async ($, on) => {
    const clock = mock.clock(on)
    const toasts = world(on)
    await $.session.start({ cwd: '/x/elsewhere', surface: 'terminal', isInteractive: true })
    await clock.advance(180 * MIN)
    expect(toasts).toEqual([])
  })

  test('/snooze pushes the next nudge out', async ($, on) => {
    const clock = mock.clock(on)
    const toasts = world(on)
    await $.session.start({ cwd: '/x/elsewhere', surface: 'terminal', isInteractive: true })
    await workFor($, clock, 80)
    const snoozed = await $.command.run({
      command: 'snooze',
      args: '45',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 120 },
    })
    expect(snoozed.text).toBe('Body check snoozed for 45m.')
    await workFor($, clock, 40)
    expect(toasts).toEqual([])
    await workFor($, clock, 10)
    expect(toasts.length).toBe(1)
  })

  test('headless sessions never nudge', async ($, on) => {
    const clock = mock.clock(on)
    const toasts = world(on)
    await $.session.start({ cwd: '/x/elsewhere', surface: null, isInteractive: false })
    await workFor($, clock, 200)
    expect(toasts).toEqual([])
  })
})
