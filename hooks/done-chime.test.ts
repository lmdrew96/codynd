import { describe, expect, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { doneMessage, patchTitle } from './done-chime.ts'

describe('helpers', () => {
  test('reads the title from the completed patch', () => {
    expect(patchTitle(JSON.stringify({ title: '#2 Done chime', status: 'done' }))).toBe('#2 Done chime')
    expect(patchTitle('not json')).toBeUndefined()
    expect(patchTitle(undefined)).toBeUndefined()
  })

  test('message falls back when there is no title', () => {
    expect(doneMessage('#2 Done chime')).toBe('🎉 Patch done: #2 Done chime')
    expect(doneMessage(undefined)).toBe('🎉 Patch done!')
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
}

describe('done chime', () => {
  test('toasts and chimes when a patch completes', async ($, on) => {
    const seen = world(on, { isError: false })
    await completePatch($)
    expect(seen.toasts).toEqual(['🎉 Patch done!'])
    expect(seen.sounds).toEqual(['sounds/done.wav'])
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
