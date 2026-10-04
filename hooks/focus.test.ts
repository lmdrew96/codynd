import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import { cleanFocus, offerFor } from './focus.tsx'
import { statusLine } from './patch-status.ts'

const PATCH = { title: '#12 Focus slot', project_slug: 'codynd', project_name: 'CodyND', started_at: null }

describe('helpers', () => {
  test('labels are one short plain line', () => {
    expect(cleanFocus('  Debugging   Tangle\n identity ')).toBe('Debugging Tangle identity')
    expect(cleanFocus('x'.repeat(60))).toBe(`${'x'.repeat(39)}…`)
    expect(cleanFocus('   ')).toBeNull()
  })

  test('a patch wins, then the focus, then nothing', () => {
    expect(statusLine({ patches: [PATCH], focus: 'Debugging Tangle' })).toBe('🩹 #12 Focus slot')
    expect(statusLine({ patches: [], focus: 'Debugging Tangle' })).toBe('🎯 Debugging Tangle')
    expect(statusLine({ patches: [], focus: null })).toBeUndefined()
  })

  test('only a replaced focus is offered, once', () => {
    expect(offerFor('Old', 'New', new Set())).toBe('Old')
    expect(offerFor(null, 'New', new Set())).toBeNull()
    expect(offerFor('Old', null, new Set())).toBeNull()
    expect(offerFor('Same', 'Same', new Set())).toBeNull()
    expect(offerFor('Old', 'New', new Set(['Old']))).toBeNull()
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
  (await $.command.run({ command: 'topic', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text

describe('focus slot', () => {
  test('Cody sets and clears the focus; the line follows', async ($, on) => {
    const statuses = world(on)
    await start($)
    expect((await callTool($, 'mcp__codynd__set_focus', { text: 'Debugging Tangle identity' })).result).toBe('Focus set: Debugging Tangle identity')
    expect(statuses.at(-1)).toBe('🎯 Debugging Tangle identity')
    await callTool($, 'mcp__codynd__clear_focus')
    expect(statuses.at(-1)).toBe('⏱ <1m in')
  })

  test('an in-progress patch keeps the line while a focus is set', async ($, on) => {
    const statuses = world(on, [PATCH])
    await start($)
    await callTool($, 'mcp__codynd__set_focus', { text: 'Side quest' })
    expect(statuses.at(-1)?.startsWith('🩹 #12 Focus slot')).toBe(true)
  })

  test('/topic sets by hand; bare /topic clears', async ($, on) => {
    const statuses = world(on)
    await start($)
    expect(await focusCommand($, 'Reading the mod docs')).toBe('Focus: Reading the mod docs')
    expect(statuses.at(-1)).toBe('🎯 Reading the mod docs')
    expect(await focusCommand($, '')).toBe('Focus cleared.')
    expect(statuses.at(-1)).toBe('⏱ <1m in')
  })

  test('the focus ends with the session', async ($, on) => {
    const statuses = world(on)
    await start($)
    await focusCommand($, 'Temporary')
    expect(statuses.at(-1)).toBe('🎯 Temporary')
    await $.session.end({ reason: 'clear' } as never)
    expect(statuses.at(-1)).toBe('⏱ <1m in')
  })
})

type Parked = { toasts: string[]; kindled: Record<string, unknown>[] }

// The focus world plus a band to draw on and a Kindling that saves or errors.
const offerWorld = (on: On, kindleFails = false): Parked => {
  const seen: Parked = { toasts: [], kindled: [] }
  mock.clock(on)
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x/codynd' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('mcp.call', (_$, e) => {
    if (e.tool === 'kindle') {
      seen.kindled.push(e.args)
      return { value: { content: [{ type: 'text', text: kindleFails ? 'down' : 'ok' }], isError: kindleFails } }
    }
    return { value: { content: [{ type: 'text', text: '[]' }], isError: false } }
  })
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__codynd__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  for (const ev of ['ui.log', 'ui.status'] as const) on(ev, () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  return seen
}

const BAND = {
  plugin: 'codynd',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const OFFER = { type: 'Text', text: /Park/ } as const

describe('park offer', () => {
  test('replacing the focus offers the old one; Park sends it to Kindling', async ($, on) => {
    const seen = offerWorld(on)
    await start($)
    await callTool($, 'mcp__codynd__set_focus', { text: 'Debugging Tangle identity' })
    await focusCommand($, 'Reading the mod docs')
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /Debugging Tangle identity/ })).toBeDefined()
    await ui.press({ key: 'park' })
    expect(seen.kindled).toEqual([{ content: 'Debugging Tangle identity', tags: ['parked', 'project:codynd'] }])
    expect(seen.toasts.at(-1)).toBe('🅿️ Parked: Debugging Tangle identity')
    expect(await ui.find(OFFER)).toBeUndefined()
  })

  test('a first focus or a clear offers nothing', async ($, on) => {
    offerWorld(on)
    await start($)
    await focusCommand($, 'First')
    await callTool($, 'mcp__codynd__clear_focus')
    const ui = await $.ui.mount(BAND)
    expect(await ui.find(OFFER)).toBeUndefined()
  })

  test('ignored: gone with the next prompt, and never offered again', async ($, on) => {
    const seen = offerWorld(on)
    await start($)
    await focusCommand($, 'A')
    await focusCommand($, 'B')
    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
    let ui = await $.ui.mount(BAND)
    expect(await ui.find(OFFER)).toBeUndefined()
    await ui.unmount()
    // Back to A: B is new to the offer, so it's offered once; then back to B: A already was.
    await focusCommand($, 'A')
    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
    await focusCommand($, 'B')
    ui = await $.ui.mount(BAND)
    expect(await ui.find(OFFER)).toBeUndefined()
    expect(seen.kindled).toEqual([])
  })

  test('a failed park keeps the offer up', async ($, on) => {
    const seen = offerWorld(on, true)
    await start($)
    await focusCommand($, 'A')
    await focusCommand($, 'B')
    const ui = await $.ui.mount(BAND)
    await ui.press({ key: 'park' })
    expect(seen.toasts.at(-1)).toBe("Couldn't park that one; try again or dismiss.")
    expect(await ui.find(OFFER)).toBeDefined()
  })
})
