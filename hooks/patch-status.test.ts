import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  STARTUP_RETRY_MS,
  formatElapsed,
  formatStatus,
  normalize,
  parseAliases,
  patchesForCwd,
  statusLine,
  stretchSegment,
  type Patch,
} from './patch-status.ts'

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

  test('an alias points a mismatched folder at its project', () => {
    const site = patch('Fix hero', 'adhdesigns', 'ADHDesigns.dev', '2026-10-06T03:59:01Z')
    const cwd = '/x/ADHD-AgenticDevHumanDesigns'
    expect(patchesForCwd([site, ...PATCHES], cwd)).toEqual([])
    const aliases = parseAliases('ADHD-AgenticDevHumanDesigns=adhdesigns, Other Folder = Chicken Scratch')
    expect(patchesForCwd([site, ...PATCHES], cwd, aliases).map(p => p.title)).toEqual(['Fix hero'])
    expect(patchesForCwd(PATCHES, '/x/other-folder', aliases).map(p => p.title)).toEqual(['Archive mode'])
    // An aliased folder no longer matches its own name; unaliased repos match as before.
    expect(patchesForCwd(PATCHES, CWD, { codynd: 'adhdesigns' })).toEqual([])
    expect(patchesForCwd(PATCHES, CWD, aliases).map(p => p.title)).toEqual(['#1 Patch status line'])
  })

  test('parseAliases skips malformed pairs and non-strings', () => {
    expect(parseAliases('=x, y=, nope, a=b')).toEqual({ a: 'b' })
    expect(parseAliases('')).toEqual({})
    expect(parseAliases(undefined)).toEqual({})
  })

  test('status shows the newest patch, counts the rest, truncates long titles', () => {
    const older = patch('older', 'codynd', 'CodyND', '2026-10-01T00:00:00Z')
    expect(formatStatus(patchesForCwd([older, ...PATCHES], CWD))).toBe('🩹 #1 Patch status line (+1)')
    expect(formatStatus([])).toBeUndefined()
    const long = formatStatus([patch('x'.repeat(80), 'codynd', 'CodyND', '')])
    expect(long?.replace('🩹 ', '').length).toBe(60)
    expect(long?.endsWith('…')).toBe(true)
  })

  test('elapsed time reads calmly, whole days past 24h', () => {
    const MIN = 60_000
    expect(formatElapsed(30_000)).toBe('<1m')
    expect(formatElapsed(24 * MIN)).toBe('24m')
    expect(formatElapsed(60 * MIN)).toBe('1h')
    expect(formatElapsed(70 * MIN)).toBe('1h 10m')
    expect(formatElapsed(74 * 60 * MIN)).toBe('3d')
  })

  test('status adds elapsed time before the count', () => {
    const started = Date.parse('2026-10-04T02:07:31Z')
    const both = patchesForCwd([patch('older', 'codynd', 'CodyND', '2026-10-01T00:00:00Z'), ...PATCHES], CWD)
    expect(formatStatus(both, started + 24 * 60_000)).toBe('🩹 #1 Patch status line · 24m (+1)')
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
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__codynd__${e.name}` } }))
  return statuses
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

const startSession = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await settle()
}

describe('status line', () => {
  test('shows the patch in progress for this repo on session start, then ticks', async ($, on) => {
    const clock = mock.clock(on)
    await clock.set(Date.parse('2026-10-04T02:07:31Z') + 5 * 60_000)
    const statuses = world(on, () => ({ text: JSON.stringify(PATCHES), isError: false }))
    await startSession($)
    await clock.advance(10)
    await settle()
    expect(statuses.at(-1)).toBe('🩹 #1 Patch status line · 5m')
    await clock.advance(60_000)
    expect(statuses.at(-1)).toBe('🩹 #1 Patch status line · 6m')
  })

  test('clears quietly when ChaosPatch errors', async ($, on) => {
    const clock = mock.clock(on)
    const statuses = world(on, () => ({ text: 'unreachable', isError: true }))
    await startSession($)
    await clock.advance(10)
    await settle()
    expect(statuses.at(-1)).toBe('⏱ <1m in')
  })

  test('ChaosPatch still connecting at startup: retries soon, not in 5 minutes', async ($, on) => {
    const clock = mock.clock(on)
    await clock.set(Date.parse('2026-10-04T02:07:31Z') + 5 * 60_000)
    let isConnected = false
    const statuses = world(on, () =>
      isConnected ? { text: JSON.stringify(PATCHES), isError: false } : { text: 'not connected', isError: true },
    )
    await startSession($)
    await clock.advance(10)
    await settle()
    expect(statuses.at(-1)).toBe('⏱ <1m in')
    isConnected = true
    await clock.advance(STARTUP_RETRY_MS)
    await settle()
    expect(statuses.at(-1)).toBe('🩹 #1 Patch status line · 5m')
  })

  test('refreshes after a patch is completed', async ($, on) => {
    const clock = mock.clock(on)
    let current = PATCHES
    const statuses = world(on, () => ({ text: JSON.stringify(current), isError: false }))
    on('tool.call', () => ({ result: 'ok' }))
    await startSession($)
    await clock.advance(10)
    await settle()
    current = PATCHES.slice(1)
    // Loosely typed: tsc gives up expanding every connected MCP tool's input types here.
    const callTool = $.tool.call as unknown as (input: { tool: string; patch_id: string }) => Promise<unknown>
    await callTool({ tool: 'mcp__claude_ai_ChaosPatch__cp_complete_patch', patch_id: 'x' })
    await clock.advance(10)
    await settle()
    expect(statuses.at(-1)).toBe('⏱ <1m in')
  })
})

describe('work stretch', () => {
  const MIN = 60_000
  const stretch = { start: 0, lastActive: 40 * MIN }

  test('shows how long the stretch has run, hidden on a break', () => {
    expect(stretchSegment(stretch, 45 * MIN)).toBe('⏱ 45m in')
    expect(stretchSegment(stretch, 130 * MIN)).toBeUndefined()
    expect(stretchSegment({ start: 0, lastActive: 0 }, 30 * 1000)).toBe('⏱ <1m in')
    expect(stretchSegment(null, 45 * MIN)).toBeUndefined()
  })

  test('only when there is no patch or focus', () => {
    expect(statusLine({ patches: [], focus: null, now: 45 * MIN, stretch })).toBe('⏱ 45m in')
    expect(statusLine({ patches: [], focus: 'Side quest', now: 45 * MIN, stretch })).toBe('🎯 Side quest')
    expect(statusLine({ patches: PATCHES.slice(0, 1), focus: null, now: 45 * MIN, stretch })?.startsWith('🩹')).toBe(true)
  })
})
