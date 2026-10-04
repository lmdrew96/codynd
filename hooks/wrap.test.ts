import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import { autoNote, uncommittedLine, wrapKey } from './wrap.ts'
import { parseLeftOff } from './reentry-card.tsx'

const CWD = '/x/codynd'
const PATCH = { title: '#10 /wrap', project_slug: 'codynd', project_name: 'CodyND', started_at: null }

describe('helpers', () => {
  test('bare /wrap saves the patch, else the focus, else nothing', () => {
    expect(autoNote([PATCH], 'Side quest')).toBe('🩹 #10 /wrap')
    expect(autoNote([], 'Side quest')).toBe('🎯 Side quest')
    expect(autoNote([], null)).toBeNull()
  })

  test('uncommitted files are counted, never warned about', () => {
    expect(uncommittedLine(' M hooks/wrap.ts\n?? hooks/wrap.test.ts\n')).toBe('2 uncommitted files.')
    expect(uncommittedLine(' M README.md\n')).toBe('1 uncommitted file.')
    expect(uncommittedLine('')).toBeNull()
  })

  test('only a well-formed note is read back', () => {
    expect(parseLeftOff({ note: 'n', savedAt: 5 })).toEqual({ note: 'n', savedAt: 5 })
    expect(parseLeftOff({ note: 'n' })).toBeNull()
    expect(parseLeftOff(undefined)).toBeNull()
  })
})

// The engine beneath the plugin: a store in memory, a dirty or clean tree, no patches.
const world = (on: On, porcelain = '', store: Record<string, unknown> = {}) => {
  const clock = mock.clock(on)
  // The store in memory, readable by the test (the kit's $ has no store noun).
  on('store.get', (_$, e) => ({ value: store[e.key] }))
  on('store.set', (_$, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('process.run', (_$, e) => ({
    value: {
      exitCode: e.argv[1] === 'status' ? 0 : 1,
      stdout: e.argv[1] === 'status' ? porcelain : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '[]' }], isError: false } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__codynd__${e.name}` } }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
  for (const ev of ['ui.status', 'ui.log', 'ui.toast'] as const) on(ev, () => ({ value: undefined }))
  return { clock, store }
}

const run = async ($: Engine, command: string, args: string): Promise<string | undefined> =>
  (await $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })).text

const start = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

describe('/wrap', () => {
  test('saves a typed note and mentions uncommitted files', async ($, on) => {
    const { store } = world(on, ' M hooks/wrap.ts\n')
    await start($)
    expect(await run($, 'wrap', '  halfway through the card line  ')).toBe(
      'Saved for next time: halfway through the card line\n1 uncommitted file.',
    )
    expect(store[wrapKey(CWD)]).toMatchObject({ note: 'halfway through the card line' })
  })

  test('bare /wrap saves the focus on a non-patch day', async ($, on) => {
    world(on)
    await start($)
    await run($, 'topic', 'Debugging Tangle identity')
    expect(await run($, 'wrap', '')).toBe('Saved for next time: 🎯 Debugging Tangle identity')
  })

  test('with nothing current, bare /wrap asks for a note', async ($, on) => {
    world(on)
    await start($)
    expect(await run($, 'wrap', '')).toBe('Nothing to save yet. Add a note: /wrap <where you left off>')
  })

  test('next session, the card shows where you left off', async ($, on) => {
    const twoHours = 2 * 60 * 60_000
    const { clock } = world(on, '', { [wrapKey(CWD)]: { note: 'halfway through the card line', savedAt: 1_000 } })
    await clock.set(1_000 + twoHours)
    await start($)
    const ui = await $.ui.mount({
      plugin: 'codynd',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: /Left off:/ }))?.text).toContain('halfway through the card line · 2h ago')
  })
})
