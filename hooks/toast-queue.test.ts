import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { schedule } from './toast-queue.ts'

describe('schedule', () => {
  test('no done toast showing: shows now', () => {
    expect(schedule(1000, 0, false)).toEqual({ delayMs: 0, holdUntil: 0 })
  })

  test('a done toast holds the line for its timeout', () => {
    expect(schedule(1000, 0, true, 10_000)).toEqual({ delayMs: 0, holdUntil: 11_000 })
  })

  test('a toast during the hold waits for it; a second done toast queues behind the first', () => {
    expect(schedule(3000, 11_000, false)).toEqual({ delayMs: 8000, holdUntil: 11_000 })
    expect(schedule(3000, 11_000, true, 10_000)).toEqual({ delayMs: 8000, holdUntil: 21_000 })
  })
})

type Shown = { at: number; text: string }

// Records when each toast actually reaches the screen (beneath the plugin's queue).
const world = (on: On, clock: { now: () => number }): Shown[] => {
  const shown: Shown[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x/codynd' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '{}' }], isError: false } }))
  // The kit leaves a hook's result text unset, so the done toast is the generic "🎉 Patch done!".
  on('tool.call', () => ({ result: '{}' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__codynd__${e.name}` } }))
  for (const ev of ['ui.status', 'ui.log', 'audio.play'] as const) on(ev, () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    shown.push({ at: clock.now(), text: e.text })
    return { value: undefined }
  })
  return shown
}

const completePatch = async ($: Engine): Promise<void> => {
  const callTool = $.tool.call as unknown as (input: { tool: string; patch_id: string }) => Promise<unknown>
  await callTool({ tool: 'mcp__claude_ai_ChaosPatch__cp_complete_patch', patch_id: 'x' })
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

const park = async ($: Engine, text: string): Promise<void> => {
  await $.command.run({ command: 'park', args: text, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
}

describe('toast queue', () => {
  test('a /park right after a done toast waits out its 10 seconds', async ($, on) => {
    const clock = mock.clock(on)
    const shown = world(on, clock)
    await $.session.start({ cwd: '/x/codynd', surface: 'terminal', isInteractive: true })
    const t0 = clock.now()
    await completePatch($)
    await clock.advance(3000)
    await park($, 'hi')
    expect(shown.map(s => s.text)).toEqual(['🎉 Patch done!'])
    await clock.advance(7000)
    expect(shown).toEqual([
      { at: t0, text: '🎉 Patch done!' },
      { at: t0 + 10_000, text: '🅿️ Parked: hi' },
    ])
  })

  test('with no done toast showing, toasts appear at once and in order', async ($, on) => {
    const clock = mock.clock(on)
    const shown = world(on, clock)
    await $.session.start({ cwd: '/x/codynd', surface: 'terminal', isInteractive: true })
    await park($, 'one')
    await park($, 'two')
    expect(shown.map(s => s.text)).toEqual(['🅿️ Parked: one', '🅿️ Parked: two'])
  })
})
