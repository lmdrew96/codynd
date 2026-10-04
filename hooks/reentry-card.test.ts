import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import { parseLastCommit, pickNext } from './reentry-card.tsx'
import { STARTUP_RETRY_MS, type Patch } from './patch-status.ts'

const CWD = '/x/codynd'
const patch = (title: string, started_at: string | null = null): Patch => ({
  title,
  project_slug: 'codynd',
  project_name: 'CodyND',
  started_at,
})

describe('helpers', () => {
  test('parses the git log line', () => {
    expect(parseLastCommit('v0.3.0: add session clock\u001f2 hours ago\n')).toEqual({
      subject: 'v0.3.0: add session clock',
      when: '2 hours ago',
    })
    expect(parseLastCommit('')).toBeNull()
  })

  test('in-progress patch wins, then the top open one', () => {
    expect(pickNext([patch('#4 Card', 'now')], [patch('#5 Tripwire')])).toEqual({ title: '#4 Card', isInProgress: true })
    expect(pickNext([], [patch('#5 Tripwire'), patch('#6 Later')])).toEqual({ title: '#5 Tripwire', isInProgress: false })
    expect(pickNext([], [])).toBeNull()
  })
})

// Answers what the plugin touches beneath it: one commit, an in-progress patch or only open ones.
// ChaosPatch errors while `chaospatch.isConnected` is false.
const world = (on: On, inProgress: Patch[], open: Patch[], gitExit = 0, chaospatch = { isConnected: true }): ReturnType<typeof mock.clock> => {
  const clock = mock.clock(on)
  // Stands in for the engine's own drawing when the band has nothing to show.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as RenderElement
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('process.run', () => ({
    value: {
      exitCode: gitExit,
      stdout: gitExit === 0 ? 'v0.3.0: add session clock\u001f2 hours ago\n' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('mcp.call', (_$, e) => {
    if (!chaospatch.isConnected) return { value: { content: [{ type: 'text', text: 'not connected' }], isError: true } }
    const patches = e.args.status === 'in_progress' ? inProgress : open
    return { value: { content: [{ type: 'text', text: JSON.stringify(patches) }], isError: false } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__codynd__${e.name}` } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  return clock
}

const BAND = {
  plugin: 'codynd',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const start = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  // loadCard runs unawaited after session.start; let its calls settle.
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

describe('re-entry band', () => {
  test('shows last commit and the in-progress patch, then dismisses', async ($, on) => {
    world(on, [patch('#4 Context re-entry card', 'now')], [])
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /v0\.3\.0: add session clock/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /In progress:/ })).toBeDefined()
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'dismiss' })
    expect(await ui.find({ type: 'Text', text: /Welcome back/ })).toBeUndefined()
  })

  test('falls back to the top open patch, without git history', async ($, on) => {
    world(on, [], [patch('#5 Scope-creep tripwire')], 128)
    await start($)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Up next:/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Last time/ })).toBeUndefined()
  })

  test('ChaosPatch still connecting at startup: Up next fills in on a retry', async ($, on) => {
    const chaospatch = { isConnected: false }
    const clock = world(on, [], [patch('#5 Scope-creep tripwire')], 0, chaospatch)
    await start($)
    let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /v0\.3\.0: add session clock/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Up next:/ })).toBeUndefined()
    await ui.unmount()
    chaospatch.isConnected = true
    await clock.advance(STARTUP_RETRY_MS)
    for (let i = 0; i < 200; i++) await Promise.resolve()
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Up next:/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /v0\.3\.0: add session clock/ })).toBeDefined()
  })

  test('a retry after the first prompt leaves the card hidden', async ($, on) => {
    const chaospatch = { isConnected: false }
    const clock = world(on, [], [patch('#5 Scope-creep tripwire')], 0, chaospatch)
    await start($)
    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
    chaospatch.isConnected = true
    await clock.advance(STARTUP_RETRY_MS)
    for (let i = 0; i < 200; i++) await Promise.resolve()
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Welcome back/ })).toBeUndefined()
  })

  test('hides after the first prompt', async ($, on) => {
    world(on, [patch('#4 Context re-entry card', 'now')], [])
    await start($)
    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Welcome back/ })).toBeUndefined()
  })
})

const recap = async ($: Engine): Promise<string | undefined> =>
  (await $.command.run({ command: 'recap', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })).text

describe('/recap', () => {
  test('brings the card back after the first prompt, freshly loaded', async ($, on) => {
    const inProgress = [patch('#4 Context re-entry card', 'now')]
    world(on, inProgress, [])
    await start($)
    await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
    inProgress[0] = patch('/recap', 'later')
    expect(await recap($)).toBeUndefined()
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Welcome back/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\/recap/ })).toBeDefined()
    await ui.press({ key: 'dismiss' })
    expect(await ui.find({ type: 'Text', text: /Welcome back/ })).toBeUndefined()
  })

  test('says so in one line when there is nothing to show', async ($, on) => {
    world(on, [], [], 128)
    await start($)
    expect(await recap($)).toBe('Nothing to recap here yet.')
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Welcome back/ })).toBeUndefined()
  })
})
