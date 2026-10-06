import { describe, expect, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { CHIMES, DONE_OPENERS, STOP_TOAST, doneMessage, isCleanStop, isDoneToast, isTestCommand, nextCelebration, patchTitle, pickOther, reviewMessage, testRunFailed } from './done-chime.ts'

describe('helpers', () => {
  test('reads the title from the completed patch', () => {
    expect(patchTitle(JSON.stringify({ title: '#2 Done chime', status: 'done' }))).toBe('#2 Done chime')
    expect(patchTitle('not json')).toBeUndefined()
    expect(patchTitle(undefined)).toBeUndefined()
  })

  test('message falls back when there is no title', () => {
    expect(doneMessage('#2 Done chime')).toBe('🎉 Patch done: #2 Done chime')
    expect(doneMessage(undefined)).toBe('🎉 Patch done!')
    expect(doneMessage('#8 Chime variety', 1)).toBe('✨ Shipped: #8 Chime variety')
  })

  test('every opener reads as a done toast; nothing else does', () => {
    for (const opener of DONE_OPENERS) expect(isDoneToast(doneMessage('x', DONE_OPENERS.indexOf(opener)))).toBe(true)
    expect(isDoneToast('🅿️ Parked: hi')).toBe(false)
  })

  test('the first pick is the classic; after that, never the last one', () => {
    expect(nextCelebration(null, [0.9, 0.9])).toEqual({ sound: 0, opener: 0 })
    for (const roll of [0, 0.3, 0.6, 0.999]) {
      for (let last = 0; last < CHIMES.length; last++) {
        const n = pickOther(CHIMES.length, last, roll)
        expect(n).not.toBe(last)
        expect(n >= 0 && n < CHIMES.length).toBe(true)
      }
    }
    // Low and high rolls reach both ends of the pool.
    expect(pickOther(4, 0, 0)).toBe(1)
    expect(pickOther(4, 3, 0.999)).toBe(2)
    expect(pickOther(4, 1, 0.999)).toBe(3)
  })
})

type Seen = { toasts: string[]; sounds: string[] }

// Answers what the mod touches beneath it, and records toasts and sounds.
const world = (on: On, answer: { isError: boolean }): Seen => {
  const seen: Seen = { toasts: [], sounds: [] }
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', (_$, e) => {
    if (e.clip.asset !== undefined) seen.sounds.push(e.clip.asset)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/x/codynd' }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '[]' }], isError: false } }))
  const result = JSON.stringify({ title: '#2 Done chime' })
  on('tool.call', () => (answer.isError ? { result, isError: true } : { result }))
  return seen
}

// Loosely typed: tsc gives up expanding every connected MCP tool's input types here.
const completePatch = async ($: Engine, tool = 'cp_complete_patch'): Promise<void> => {
  const callTool = $.tool.call as unknown as (input: { tool: string; patch_id: string }) => Promise<unknown>
  await callTool({ tool: `mcp__claude_ai_ChaosPatch__${tool}`, patch_id: 'x' })
  // The celebration runs unawaited after the call; let it settle.
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

describe('done chime', () => {
  test('toasts and chimes when a patch completes', async ($, on) => {
    const seen = world(on, { isError: false })
    await completePatch($)
    expect(seen.toasts).toEqual(['🎉 Patch done!'])
    expect(seen.sounds).toEqual(['sounds/done.wav'])
  })

  test('back-to-back wins sound and read different', async ($, on) => {
    const seen = world(on, { isError: false })
    await completePatch($)
    await completePatch($)
    expect(seen.sounds[0]).toBe('sounds/done.wav')
    expect(seen.sounds[1]).not.toBe(seen.sounds[0])
    expect(seen.toasts[0]).toBe('🎉 Patch done!')
    expect(seen.toasts[1]).not.toBe(seen.toasts[0])
  })

    test('stays quiet when completing fails', async ($, on) => {
    const seen = world(on, { isError: true })
    await completePatch($)
    expect(seen.toasts).toEqual([])
    expect(seen.sounds).toEqual([])
  })

  test('a patch sent to review gets its own toast and chime', async ($, on) => {
    const seen = world(on, { isError: false })
    await completePatch($, 'cp_request_review')
    expect(seen.toasts).toEqual(['👀 Ready for review!'])
    expect(seen.sounds).toEqual(['sounds/review.wav'])
  })

  test('toast only when the sound is turned off', { options: { doneChimeSound: false } }, async ($, on) => {
    const seen = world(on, { isError: false })
    await completePatch($)
    expect(seen.toasts).toEqual(['🎉 Patch done!'])
    expect(seen.sounds).toEqual([])
  })
})

describe('review toast', () => {
  test('names the patch, and holds the line like a done toast', () => {
    expect(reviewMessage('#2 Done chime')).toBe('👀 Ready for review: #2 Done chime')
    expect(isDoneToast(reviewMessage(undefined))).toBe(true)
  })
})

describe('stopping point helpers', () => {
  test('spots test runs inside longer commands', () => {
    expect(isTestCommand('cd /x/codynd && pnpm -s test 2>&1 | tail -3')).toBe(true)
    expect(isTestCommand('cd /x/codynd && pnpm test | tail -3')).toBe(true)
    expect(isTestCommand('npm run test')).toBe(true)
    expect(isTestCommand('npx vitest run')).toBe(true)
    expect(isTestCommand('pytest -q')).toBe(true)
    expect(isTestCommand('git status')).toBe(false)
    expect(isTestCommand('cat hooks/done-chime.test.ts')).toBe(false)
    expect(isTestCommand('cat vitest.config.ts')).toBe(false)
    expect(isTestCommand('cd app && vitest run')).toBe(true)
  })

  test('a failed run is an error or a failure count in the output', () => {
    expect(testRunFailed(true, '')).toBe(true)
    expect(testRunFailed(false, ' 78 pass\n 1 fail\n')).toBe(true)
    expect(testRunFailed(false, 'Tests  2 failed | 40 passed')).toBe(true)
    expect(testRunFailed(false, ' 82 pass\n 0 fail\n')).toBe(false)
  })

  test('clean: committed, and no failing run (none run is fine)', () => {
    expect(isCleanStop('', null)).toBe(true)
    expect(isCleanStop('', false)).toBe(true)
    expect(isCleanStop('', true)).toBe(false)
    expect(isCleanStop(' M hooks/done-chime.ts\n', null)).toBe(false)
  })
})

// A repo whose tree is clean or dirty, and a test command that passes or fails.
const stopWorld = (on: On, tree: { porcelain: string }, tests: { output: string; isError: boolean }): Seen => {
  const seen: Seen = { toasts: [], sounds: [] }
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  for (const ev of ['audio.play', 'ui.status', 'ui.log'] as const) on(ev, () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/x/codynd' }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '[]' }], isError: false } }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: tree.porcelain, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('tool.call', (_$, e) => {
    if (e.tool !== 'Bash') return { result: JSON.stringify({ title: '#S Stop' }) }
    return tests.isError ? { result: tests.output, isError: true } : { result: { stdout: tests.output, stderr: '' } }
  })
  return seen
}

const runBash = async ($: Engine, command: string): Promise<void> => {
  const callTool = $.tool.call as unknown as (input: { tool: string; command: string }) => Promise<unknown>
  await callTool({ tool: 'Bash', command })
}

describe('clean stopping point', () => {
  test('clean tree, no tests run: permission to stop, after the win', async ($, on) => {
    const seen = stopWorld(on, { porcelain: '' }, { output: '', isError: false })
    await completePatch($)
    expect(seen.toasts).toEqual(['🎉 Patch done!', STOP_TOAST])
  })

  test('uncommitted changes: silent', async ($, on) => {
    const seen = stopWorld(on, { porcelain: ' M hooks/x.ts\n' }, { output: '', isError: false })
    await completePatch($)
    expect(seen.toasts).toEqual(['🎉 Patch done!'])
  })

  test('the latest test run decides: failing is silent, passing again is clean', async ($, on) => {
    const tests = { output: 'Exit code 1', isError: true }
    const seen = stopWorld(on, { porcelain: '' }, tests)
    await runBash($, 'pnpm test')
    await completePatch($)
    expect(seen.toasts).not.toContain(STOP_TOAST)
    tests.isError = false
    tests.output = ' 82 pass\n 0 fail\n'
    await runBash($, 'pnpm test')
    await completePatch($)
    expect(seen.toasts.at(-1)).toBe(STOP_TOAST)
  })

  test('a piped run that exits 0 but reports failures is still a failure', async ($, on) => {
    const seen = stopWorld(on, { porcelain: '' }, { output: ' 40 pass\n 2 fail\n', isError: false })
    await runBash($, 'pnpm test | tail -3')
    await completePatch($)
    expect(seen.toasts).toEqual(['🎉 Patch done!'])
  })
})
