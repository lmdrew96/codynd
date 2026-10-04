import { describe, expect, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { CHIMES, DONE_OPENERS, doneMessage, isDoneToast, nextCelebration, patchTitle, pickOther } from './done-chime.ts'

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
const completePatch = async ($: Engine): Promise<void> => {
  const callTool = $.tool.call as unknown as (input: { tool: string; patch_id: string }) => Promise<unknown>
  await callTool({ tool: 'mcp__claude_ai_ChaosPatch__cp_complete_patch', patch_id: 'x' })
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

  test('toast only when the sound is turned off', { options: { doneChimeSound: false } }, async ($, on) => {
    const seen = world(on, { isError: false })
    await completePatch($)
    expect(seen.toasts).toEqual(['🎉 Patch done!'])
    expect(seen.sounds).toEqual([])
  })
})
