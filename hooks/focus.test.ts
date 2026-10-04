import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { cleanFocus } from './focus.ts'
import { statusLine } from './patch-status.ts'

const PATCH = { title: '#12 Focus slot', project_slug: 'codynd', project_name: 'CodyND', started_at: null }

describe('helpers', () => {
  test('labels are one short plain line', () => {
    expect(cleanFocus('  Debugging   Tangle\n identity ')).toBe('Debugging Tangle identity')
    expect(cleanFocus('x'.repeat(60))).toBe(`${'x'.repeat(39)}…`)
    expect(cleanFocus('   ')).toBeNull()
  })

  test('a patch wins, then the focus, then nothing', () => {
    expect(statusLine([PATCH], 'Debugging Tangle')).toBe('🩹 #12 Focus slot')
    expect(statusLine([], 'Debugging Tangle')).toBe('🎯 Debugging Tangle')
    expect(statusLine([], null)).toBeUndefined()
  })
})

// The engine beneath the plugin, with `patches` in progress for this repo.
const world = (on: On, patches: unknown[] = []): (string | undefined)[] => {
  const statuses: (string | undefined)[] = []
  mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's1' }))
  on('session.cwd', () => ({ value: '/x/codynd' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: JSON.stringify(patches) }], isError: false } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__codynd__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  for (const ev of ['ui.log', 'ui.toast'] as const) on(ev, () => ({ value: undefined }))
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  return statuses
}

// Cody calling the tool, as the model would. Loosely typed (TS2589 otherwise).
const callTool = async ($: Engine, tool: string, input: Record<string, unknown> = {}): Promise<{ result?: unknown }> => {
  const call = $.tool.call as unknown as (input: Record<string, unknown>) => Promise<{ result?: unknown }>
  return call({ tool, ...input })
}

const start = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: '/x/codynd', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

const focusCommand = async ($: Engine, args: string): Promise<string | undefined> =>
  (await $.command.run({ command: 'focus', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text

describe('focus slot', () => {
  test('Cody sets and clears the focus; the line follows', async ($, on) => {
    const statuses = world(on)
    await start($)
    expect((await callTool($, 'mcp__codynd__set_focus', { text: 'Debugging Tangle identity' })).result).toBe('Focus set: Debugging Tangle identity')
    expect(statuses.at(-1)).toBe('🎯 Debugging Tangle identity')
    await callTool($, 'mcp__codynd__clear_focus')
    expect(statuses.at(-1)).toBeUndefined()
  })

  test('an in-progress patch keeps the line while a focus is set', async ($, on) => {
    const statuses = world(on, [PATCH])
    await start($)
    await callTool($, 'mcp__codynd__set_focus', { text: 'Side quest' })
    expect(statuses.at(-1)?.startsWith('🩹 #12 Focus slot')).toBe(true)
  })

  test('/focus sets by hand; bare /focus clears', async ($, on) => {
    const statuses = world(on)
    await start($)
    expect(await focusCommand($, 'Reading the mod docs')).toBe('Focus: Reading the mod docs')
    expect(statuses.at(-1)).toBe('🎯 Reading the mod docs')
    expect(await focusCommand($, '')).toBe('Focus cleared.')
    expect(statuses.at(-1)).toBeUndefined()
  })

  test('the focus ends with the session', async ($, on) => {
    const statuses = world(on)
    await start($)
    await focusCommand($, 'Temporary')
    expect(statuses.at(-1)).toBe('🎯 Temporary')
    await $.session.end({ reason: 'clear' } as never)
    expect(statuses.at(-1)).toBeUndefined()
  })
})
