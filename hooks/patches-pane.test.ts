import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import { handoffPrompt, mcpToolName, toRows } from './patches-pane.tsx'

const CWD = '/x/codynd'
const row = (id: string, title: string, started_at: string | null = null) => ({
  id,
  title,
  project_slug: 'codynd',
  project_name: 'CodyND',
  started_at,
})

describe('helpers', () => {
  test('MCP tool names follow the server name', () => {
    expect(mcpToolName('claude.ai ChaosPatch', 'cp_start_patch')).toBe('mcp__claude_ai_ChaosPatch__cp_start_patch')
  })

  test('rows keep id and title, dropping patches without an id', () => {
    const { id: _, ...noId } = row('x', 'no id')
    expect(toRows([row('a', 'A'), noId])).toEqual([{ id: 'a', title: 'A' }])
  })

  test('hand-off prompt names the patch and its id', () => {
    expect(handoffPrompt({ id: 'a1', title: '#9 /wins' })).toBe('Start ChaosPatch patch "#9 /wins" (id a1).')
  })
})

type Seen = {
  toolCalls: Record<string, unknown>[]
  prompts: string[]
  closed: string[]
  toasts: string[]
  sounds: string[]
  statuses: (string | undefined)[]
}

// ChaosPatch beneath the plugin: one patch in progress, two open; a Done moves #11 out.
const world = (on: On): Seen => {
  const seen: Seen = { toolCalls: [], prompts: [], closed: [], toasts: [], sounds: [], statuses: [] }
  let inProgress = [row('p11', '#11 /patches', '2026-10-04T03:00:00Z')]
  const open = [row('p9', '#9 /wins'), row('p10', '#10 /wrap')]
  mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('mcp.call', (_$, e) => {
    const patches = e.args.status === 'in_progress' ? inProgress : open
    return { value: { content: [{ type: 'text', text: JSON.stringify(patches) }], isError: false } }
  })
  on('tool.call', (_$, e) => {
    seen.toolCalls.push({ ...e })
    if (e.tool.endsWith('cp_complete_patch')) inProgress = []
    return { result: '{}' }
  })
  on('prompt.submit', (_$, e) => {
    seen.prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', (_$, e) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as RenderElement
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__codynd__${e.name}` } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', (_$, e) => {
    if (e.clip.asset !== undefined) seen.sounds.push(e.clip.asset)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  return seen
}

const openBoard = async ($: Engine) => {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'patches',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  // loadBoard runs unawaited after the command; let its calls settle.
  for (let i = 0; i < 200; i++) await Promise.resolve()
  return $.ui.mount({
    plugin: 'codynd',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'codynd-patches',
    props: {
      title: 'Patches',
      isFocused: true,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20 },
    },
  } as never)
}

describe('/patches', () => {
  test('lists in-progress and open patches for this repo', async ($, on) => {
    world(on)
    const ui = await openBoard($)
    expect(await ui.find({ type: 'Text', text: /#11 \/patches/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#9 \/wins/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#10 \/wrap/ })).toBeDefined()
  })

  test('Done completes through tool.call with consent, then reloads', async ($, on) => {
    const seen = world(on)
    const ui = await openBoard($)
    await ui.press({ key: 'done-p11' })
    expect(seen.toolCalls[0]).toMatchObject({
      tool: 'mcp__claude_ai_ChaosPatch__cp_complete_patch',
      patch_id: 'p11',
      consent: 'Nae pressed "Done" on "#11 /patches" in /patches',
    })
    expect(await ui.find({ type: 'Text', text: /#11 \/patches/ })).toBeUndefined()
    // Its own tool.call hooks never see this call, so the pane chimes and clears the line itself.
    for (let i = 0; i < 50; i++) await Promise.resolve()
    expect(seen.toasts).toContain('🎉 Patch done: #11 /patches')
    expect(seen.sounds).toEqual(['sounds/done.wav'])
    expect(seen.statuses.at(-1)).toBeUndefined()
  })

  test('→ Cody closes the pane and queues the hand-off prompt', async ($, on) => {
    const seen = world(on)
    const ui = await openBoard($)
    await ui.press({ key: 'cody-p9' })
    expect(seen.closed).toEqual(['codynd-patches'])
    expect(seen.prompts).toEqual(['Start ChaosPatch patch "#9 /wins" (id p9).'])
  })
})
