import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { ATTENTION_CHIME, QUIET_MS, isQuiet, needsAttention } from './attention-chime.ts'

describe('helpers', () => {
  test('approvals, questions and MCP input chime; idle and the rest do not', () => {
    expect(needsAttention('permission_prompt')).toBe(true)
    expect(needsAttention('elicitation_dialog')).toBe(true)
    expect(needsAttention('agent_needs_input')).toBe(true)
    expect(needsAttention('idle_prompt')).toBe(false)
    expect(needsAttention('auth_success')).toBe(false)
  })

  test('quiet for a few seconds after a chime', () => {
    expect(isQuiet({ lastChimeAt: undefined }, 0)).toBe(false)
    expect(isQuiet({ lastChimeAt: 1_000 }, 1_000 + QUIET_MS - 1)).toBe(true)
    expect(isQuiet({ lastChimeAt: 1_000 }, 1_000 + QUIET_MS)).toBe(false)
  })
})

// Records only the attention chime; answers everything else the mods touch.
const world = (on: On): { sounds: string[]; clock: ReturnType<typeof mock.clock> } => {
  const sounds: string[] = []
  const clock = mock.clock(on)
  on('audio.play', (_$, e) => {
    if (e.clip.asset === ATTENTION_CHIME) sounds.push(e.clip.asset)
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/x/codynd' }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '[]' }], isError: false } }))
  on('tool.call', () => ({ result: 'answered' }))
  on('classic.Notification', () => ({}))
  for (const ev of ['ui.status', 'ui.log', 'ui.toast'] as const) on(ev, () => ({ value: undefined }))
  return { sounds, clock }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}

const notify = async ($: Engine, type: string): Promise<void> => {
  await $.classic.Notification({
    hook_event_name: 'Notification',
    session_id: 's',
    transcript_path: '/x/t.jsonl',
    cwd: '/x/codynd',
    message: 'Claude needs your permission',
    notification_type: type,
  } as never)
  await settle()
}

const ask = async ($: Engine): Promise<void> => {
  const callTool = $.tool.call as unknown as (input: { tool: string; questions: unknown[] }) => Promise<unknown>
  await callTool({ tool: 'AskUserQuestion', questions: [] })
  await settle()
}

describe('attention chime', () => {
  test('a permission prompt chimes; idle does not', async ($, on) => {
    const { sounds } = world(on)
    await notify($, 'idle_prompt')
    expect(sounds).toEqual([])
    await notify($, 'permission_prompt')
    expect(sounds).toEqual([ATTENTION_CHIME])
  })

  test('a question chimes', async ($, on) => {
    const { sounds } = world(on)
    await ask($)
    expect(sounds).toEqual([ATTENTION_CHIME])
  })

  test('back-to-back asks chime once, then again after the quiet spell', async ($, on) => {
    const { sounds, clock } = world(on)
    await ask($)
    await notify($, 'permission_prompt')
    expect(sounds).toEqual([ATTENTION_CHIME])
    await clock.advance(QUIET_MS)
    await notify($, 'permission_prompt')
    expect(sounds).toEqual([ATTENTION_CHIME, ATTENTION_CHIME])
  })

  test('turned off: silent', { options: { attentionChimeSound: false } }, async ($, on) => {
    const { sounds } = world(on)
    await notify($, 'permission_prompt')
    await ask($)
    expect(sounds).toEqual([])
  })
})