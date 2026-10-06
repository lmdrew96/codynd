import { describe, expect, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { COMPLETION_NOTE, REVIEW_NOTE, PATCH_OR_FOCUS, RULES_BLOCK, RULES_FILE, hasNote } from './instructions.ts'

const RULES = '- Start the patch or set_focus before touching code.\n'

describe('helpers', () => {
  test('a completion note is any non-blank string', () => {
    expect(hasNote('Shipped in v0.24.0')).toBe(true)
    expect(hasNote('   ')).toBe(false)
    expect(hasNote(undefined)).toBe(false)
  })
})

type Seen = { toasts: string[]; reads: string[] }

// While closed, ChaosPatch's patch list waits until the test opens it.
type Gate = { isClosed: boolean; open: () => void }

// The engine beneath the plugin. `rules` is rules.md's text, or null when it's missing;
// `patches` is what ChaosPatch lists as in progress.
const world = (on: On, rules: string | null = RULES, patches = '[]', gate?: Gate): Seen => {
  const seen: Seen = { toasts: [], reads: [] }
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  for (const ev of ['audio.play', 'ui.status', 'ui.log'] as const) on(ev, () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x/codynd' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('mcp.call', async (_$, e) => {
    if (gate?.isClosed === true && e.tool === 'cp_list_all_patches') await new Promise<void>(resolve => (gate.open = resolve))
    return { value: { content: [{ type: 'text', text: e.tool === 'cp_list_all_patches' ? patches : '[]' }], isError: false } }
  })
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__codynd__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.read', (_$, e) => {
    seen.reads.push(e.path)
    if (rules === null) throw new Error('ENOENT')
    return { value: rules }
  })
  on('prompt.context', (_$, e) => ({ blocks: e.blocks }))
  // Only the outside tools: CodyND's own set_focus / clear_focus run for real.
  on('tool.call', { tool: /^(?:Edit|mcp__claude_ai_ChaosPatch__.+)$/ }, (_$, e) => ({
    result: e.tool.endsWith('cp_complete_patch') ? JSON.stringify({ title: '#X' }) : 'ok',
  }))
  return seen
}

// Cody calling a tool, as the model would. Loosely typed (TS2589 otherwise).
const callTool = async ($: Engine, tool: string, input: Record<string, unknown> = {}): Promise<{ context?: readonly string[] }> => {
  const call = $.tool.call as unknown as (input: Record<string, unknown>) => Promise<{ context?: readonly string[] }>
  const ran = await call({ tool, ...input })
  for (let i = 0; i < 200; i++) await Promise.resolve()
  return ran
}

const edit = ($: Engine): Promise<{ context?: readonly string[] }> =>
  callTool($, 'Edit', { file_path: '/x/codynd/a.ts', old_string: 'a', new_string: 'b' })

describe('rules at the start of a conversation', () => {
  test('rules.md rides as its own block after core’s', async ($, on) => {
    const seen = world(on)
    const { blocks } = await $.prompt.context({ blocks: [{ name: 'currentDate', text: '2026-10-04' }] })
    expect(blocks.map(b => b.name)).toEqual(['currentDate', RULES_BLOCK])
    expect(blocks.at(-1)?.text).toBe(RULES.trim())
    expect(seen.reads.at(-1)?.endsWith(`/${RULES_FILE}`)).toBe(true)
  })

  test('a missing rules file adds nothing', async ($, on) => {
    world(on, null)
    const { blocks } = await $.prompt.context({ blocks: [{ name: 'currentDate', text: '2026-10-04' }] })
    expect(blocks.map(b => b.name)).toEqual(['currentDate'])
  })
})

describe('patch-or-focus reminder', () => {
  test('first edit with no patch and no focus carries it; later edits stay quiet', async ($, on) => {
    world(on)
    expect((await edit($)).context).toEqual([PATCH_OR_FOCUS])
    expect((await edit($)).context ?? []).toEqual([])
  })

  test('a focus set means no reminder', async ($, on) => {
    world(on)
    await callTool($, 'mcp__codynd__set_focus', { text: 'Reading the mod API' })
    expect((await edit($)).context ?? []).toEqual([])
  })

  test('clearing the focus counts as a topic switch: it reminds again', async ($, on) => {
    world(on)
    await edit($)
    await callTool($, 'mcp__codynd__set_focus', { text: 'Reading the mod API' })
    await callTool($, 'mcp__codynd__clear_focus')
    expect((await edit($)).context).toEqual([PATCH_OR_FOCUS])
  })

  test('completing a patch counts as a topic switch too', async ($, on) => {
    world(on)
    await edit($)
    await callTool($, 'mcp__claude_ai_ChaosPatch__cp_complete_patch', { patch_id: 'x', note: 'Shipped' })
    expect((await edit($)).context).toEqual([PATCH_OR_FOCUS])
  })

  test('starting a patch returns only once the patch list is current, so the next edit is covered', async ($, on) => {
    const gate: Gate = { isClosed: false, open: () => undefined }
    const listed = JSON.stringify([{ title: '#X', project_slug: 'codynd', project_name: 'CodyND', started_at: '2026-10-04T17:00:00Z' }])
    world(on, RULES, listed, gate)
    await $.session.start({ cwd: '/x/codynd', surface: 'terminal', isInteractive: true })
    gate.isClosed = true
    const call = $.tool.call as unknown as (input: Record<string, unknown>) => Promise<unknown>
    const started = call({ tool: 'mcp__claude_ai_ChaosPatch__cp_start_patch', patch_id: 'x' })
    const settle = async (): Promise<string> => {
      for (let i = 0; i < 200; i++) await Promise.resolve()
      return 'still waiting'
    }
    // A background refresh would hand the result back now, before the list arrives, and Cody's next edit would race it.
    expect(await Promise.race([started.then(() => 'returned'), settle()])).toBe('still waiting')
    gate.open()
    await started
    expect((await edit($)).context ?? []).toEqual([])
  })

  test('never a toast: it is for Cody only', async ($, on) => {
    const seen = world(on)
    await edit($)
    expect(seen.toasts.filter(t => t.includes('reminder'))).toEqual([])
  })
})

describe('completion note nudge', () => {
  test('closing without a note nudges Cody', async ($, on) => {
    world(on)
    const ran = await callTool($, 'mcp__claude_ai_ChaosPatch__cp_complete_patch', { patch_id: 'x' })
    expect(ran.context).toContain(COMPLETION_NOTE)
  })

  test('sending to review without a note asks for what to check', async ($, on) => {
    world(on)
    const ran = await callTool($, 'mcp__claude_ai_ChaosPatch__cp_request_review', { patch_id: 'x' })
    expect(ran.context).toContain(REVIEW_NOTE)
  })

  test('closing with a note stays quiet', async ($, on) => {
    world(on)
    const ran = await callTool($, 'mcp__claude_ai_ChaosPatch__cp_complete_patch', { patch_id: 'x', note: 'Done in v0.24.0' })
    expect(ran.context ?? []).not.toContain(COMPLETION_NOTE)
  })
})