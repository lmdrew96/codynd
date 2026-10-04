import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { kindleArgs, parkTags } from './park.ts'

const CWD = '/x/CodyND'

describe('helpers', () => {
  test('tags carry the repo folder', () => {
    expect(parkTags(CWD)).toEqual(['parked', 'project:codynd'])
    expect(parkTags('/')).toEqual(['parked'])
  })

  test('only long thoughts get a title', () => {
    expect(kindleArgs('short one', CWD)).toEqual({ content: 'short one', tags: ['parked', 'project:codynd'] })
    expect(kindleArgs('x'.repeat(130), CWD).title).toBe(`${'x'.repeat(59)}…`)
  })
})

type Seen = { toasts: string[]; kindled: Record<string, unknown>[] }

// Answers what the plugin touches beneath it; Kindling saves or errors.
const world = (on: On, kindleFails = false): Seen => {
  const seen: Seen = { toasts: [], kindled: [] }
  mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('mcp.call', (_$, e) => {
    if (e.tool === 'kindle') {
      seen.kindled.push(e.args)
      return { value: { content: [{ type: 'text', text: kindleFails ? 'down' : 'ok' }], isError: kindleFails } }
    }
    return { value: { content: [{ type: 'text', text: '[]' }], isError: false } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

const park = async ($: Engine, args: string): Promise<{ text?: string }> => {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  return $.command.run({
    command: 'park',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
}

describe('/park', () => {
  test('saves to Kindling with repo tags and toasts', async ($, on) => {
    const seen = world(on)
    const result = await park($, '  what if the chime had a hat  ')
    expect(seen.kindled).toEqual([{ content: 'what if the chime had a hat', tags: ['parked', 'project:codynd'] }])
    expect(seen.toasts).toEqual(['🅿️ Parked: what if the chime had a hat'])
    expect(result.text).toBeUndefined()
  })

  test('echoes the thought back when Kindling fails', async ($, on) => {
    const seen = world(on, true)
    const result = await park($, 'do not lose me')
    expect(result.text).toBe('Not saved to Kindling. Your thought: do not lose me')
    expect(seen.toasts).toEqual(["Couldn't park that one; it's in the transcript."])
  })

  test('empty /park shows usage and saves nothing', async ($, on) => {
    const seen = world(on)
    const result = await park($, '   ')
    expect(result.text).toBe('Usage: /park <thought>')
    expect(seen.kindled).toEqual([])
  })
})
