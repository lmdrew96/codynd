import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { parseDraft, patchArgs } from './quick-patch.ts'

const GOOD = JSON.stringify({
  title: 'Queue toasts so a done toast is never hidden',
  summary: 'Hold new toasts while a done toast is showing.',
  acceptance: ['Done toast shows its full 10s', 'Later toasts appear after it'],
  priority: 'low',
})

describe('helpers', () => {
  test('parses a draft, even wrapped in a fence or prose', () => {
    expect(parseDraft(GOOD)?.title).toBe('Queue toasts so a done toast is never hidden')
    expect(parseDraft('Sure!\n```json\n' + GOOD + '\n```')?.priority).toBe('low')
  })

  test('rejects drafts without a title; unknown priority becomes medium', () => {
    expect(parseDraft('{"summary": "x", "acceptance": []}')).toBeUndefined()
    expect(parseDraft('not json at all')).toBeUndefined()
    expect(parseDraft('{"title": "T", "summary": "S", "acceptance": ["a"], "priority": "urgent"}')?.priority).toBe('medium')
  })

  test("Nae's words always ride along in spec", () => {
    const drafted = patchArgs('codynd', 'toasts fight', parseDraft(GOOD))
    expect(drafted).toMatchObject({ tags: ['quick-capture'], priority: 'low', spec: "Nae's words: toasts fight" })
    expect(drafted.notes).toBe('Hold new toasts while a done toast is showing.\nAC:\n- Done toast shows its full 10s\n- Later toasts appear after it')
    expect(patchArgs('codynd', 'toasts fight', undefined)).toEqual({
      project_slug: 'codynd',
      title: 'toasts fight',
      notes: 'toasts fight',
      priority: 'medium',
      tags: ['quick-capture', 'rough'],
      spec: "Nae's words: toasts fight",
    })
  })
})

type Seen = { added: Record<string, unknown>[]; toasts: string[]; logs: string[]; completes: number }
type Fork = { isAnswered: true; text: string } | { isAnswered: false; reason: 'nothing-to-fork' | 'api-error' }

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

// ChaosPatch and the model beneath the plugin; the fork answers as given.
const world = (on: On, fork: Fork, cwd = '/x/codynd'): Seen => {
  const seen: Seen = { added: [], toasts: [], logs: [], completes: 0 }
  mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: cwd }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('mcp.call', (_$, e) => {
    if (e.tool === 'cp_add_patch') seen.added.push(e.args)
    const text = e.tool === 'cp_list_projects' ? JSON.stringify([{ name: 'CodyND', slug: 'codynd' }]) : '[]'
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('model.fork', () => ({ value: { ...fork, usage: USAGE } as never }))
  on('model.complete', () => {
    seen.completes += 1
    return { value: { isAnswered: true, text: GOOD, usage: USAGE } as never }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__codynd__${e.name}` } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    if (e.to !== 'debug') seen.logs.push(e.text)
    return { value: undefined }
  })
  return seen
}

const quickPatch = async ($: Engine, text: string, cwd = '/x/codynd'): Promise<void> => {
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'patch', args: text, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  // Filing runs after the command returns; let it settle.
  for (let i = 0; i < 300; i++) await Promise.resolve()
}

describe('/patch', () => {
  test('drafts from the session and files it, tagged quick-capture', async ($, on) => {
    const seen = world(on, { isAnswered: true, text: GOOD })
    await quickPatch($, 'toasts fight, queue them maybe')
    expect(seen.added).toEqual([expect.objectContaining({ project_slug: 'codynd', tags: ['quick-capture'], priority: 'low' })])
    expect(seen.toasts).toEqual(['Drafting a patch…', '🩹 Filed: Queue toasts so a done toast is never hidden'])
  })

  test('a brand-new session drafts with Haiku instead', async ($, on) => {
    const seen = world(on, { isAnswered: false, reason: 'nothing-to-fork' })
    await quickPatch($, 'toasts fight')
    expect(seen.completes).toBe(1)
    expect(seen.added[0]?.tags).toEqual(['quick-capture'])
  })

  test('a failed draft files her raw words, tagged rough', async ($, on) => {
    const seen = world(on, { isAnswered: false, reason: 'api-error' })
    await quickPatch($, 'toasts fight')
    expect(seen.added).toEqual([expect.objectContaining({ title: 'toasts fight', tags: ['quick-capture', 'rough'] })])
    expect(seen.toasts.at(-1)).toBe('🩹 Filed: toasts fight (rough)')
  })

  test('a garbled draft also files raw', async ($, on) => {
    const seen = world(on, { isAnswered: true, text: 'I think this is a great idea!' })
    await quickPatch($, 'toasts fight')
    expect(seen.added[0]?.tags).toEqual(['quick-capture', 'rough'])
  })

  test('no matching project: nothing filed, words echoed back', async ($, on) => {
    const seen = world(on, { isAnswered: true, text: GOOD }, '/x/elsewhere')
    await quickPatch($, 'toasts fight', '/x/elsewhere')
    expect(seen.added).toEqual([])
    expect(seen.logs).toEqual(['Not filed (no matching project). Your words: toasts fight'])
  })
})
