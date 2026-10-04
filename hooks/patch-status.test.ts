import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { formatStatus, normalize, patchesForCwd, type Patch } from './patch-status.ts'

const patch = (title: string, project_slug: string, project_name: string, started_at: string): Patch => ({
  title,
  project_slug,
  project_name,
  started_at,
})

const PATCHES: Patch[] = [
  patch('#1 Patch status line', 'codynd', 'CodyND', '2026-10-04T02:07:31Z'),
  patch('Archive mode', 'chicken-scratch', 'Chicken Scratch', '2026-10-03T05:51:49Z'),
  patch('overhaul play UI', 'duelingchaos', 'DuelingChaos', '2026-08-09T07:23:35Z'),
]

const CWD = '/Users/nae/Desktop/DevelopmentProjects/codynd'

describe('helpers', () => {
  test('normalize folds case and punctuation', () => {
    expect(normalize('Chicken Scratch')).toBe(normalize('chicken-scratch'))
    expect(normalize('ChickenScratch')).toBe('chickenscratch')
  })

  test('only patches for this repo match', () => {
    expect(patchesForCwd(PATCHES, CWD).map(p => p.title)).toEqual(['#1 Patch status line'])
    expect(patchesForCwd(PATCHES, '/x/ChickenScratch').map(p => p.title)).toEqual(['Archive mode'])
    expect(patchesForCwd(PATCHES, '/x/unrelated')).toEqual([])
  })

  test('status shows the newest patch, counts the rest, truncates long titles', () => {
    const older = patch('older', 'codynd', 'CodyND', '2026-10-01T00:00:00Z')
    expect(formatStatus(patchesForCwd([older, ...PATCHES], CWD))).toBe('🩹 #1 Patch status line (+1)')
    expect(formatStatus([])).toBeUndefined()
    const long = formatStatus([patch('x'.repeat(80), 'codynd', 'CodyND', '')])
    expect(long?.replace('🩹 ', '').length).toBe(60)
    expect(long?.endsWith('…')).toBe(true)
  })
})

// Answers the engine nouns the mod reads, and records what it puts on the status line.
const world = (on: On, answer: () => { text: string; isError: boolean }): (string | undefined)[] => {
  const statuses: (string | undefined)[] = []
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('mcp.call', (_$, e) => {
    const { text, isError } = answer()
    const value = e.tool === 'cp_list_all_patches' ? { content: [{ type: 'text', text }], isError } : { content: [], isError: true }
    return { value }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  return statuses
}

const startSession = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
}

describe('status line', () => {
  test('shows the patch in progress for this repo on session start', async ($, on) => {
    const clock = mock.clock(on)
    const statuses = world(on, () => ({ text: JSON.stringify(PATCHES), isError: false }))
    await startSession($)
    await clock.advance(10)
    expect(statuses.at(-1)).toBe('🩹 #1 Patch status line')
  })

  test('clears quietly when ChaosPatch errors', async ($, on) => {
    const clock = mock.clock(on)
    const statuses = world(on, () => ({ text: 'unreachable', isError: true }))
    await startSession($)
    await clock.advance(10)
    expect(statuses.at(-1)).toBeUndefined()
  })

  test('refreshes after a patch is completed', async ($, on) => {
    const clock = mock.clock(on)
    let current = PATCHES
    const statuses = world(on, () => ({ text: JSON.stringify(current), isError: false }))
    on('tool.call', () => ({ result: 'ok' }))
    await startSession($)
    await clock.advance(10)
    current = PATCHES.slice(1)
    // Loosely typed: tsc gives up expanding every connected MCP tool's input types here.
    const callTool = $.tool.call as unknown as (input: { tool: string; patch_id: string }) => Promise<unknown>
    await callTool({ tool: 'mcp__claude_ai_ChaosPatch__cp_complete_patch', patch_id: 'x' })
    await clock.advance(10)
    expect(statuses.at(-1)).toBeUndefined()
  })
})
