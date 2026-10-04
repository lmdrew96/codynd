import type { EngineInterface, On, PluginOptions } from 'claude-code'

// #21 Attention chime: a "yoo-hoo!" when Cody needs Nae: a permission prompt, a question, or an
// MCP server asking for input. Not on idle_prompt: "done, and you've been away" isn't a decision.
// Built against Claude Code 2.1.289.

export const ATTENTION_CHIME = 'sounds/attention.wav'
// Claude Code's Notification types that mean "waiting on you to decide something".
export const ATTENTION_TYPES = ['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'] as const
// A question that also raises a permission notification, or parallel prompts, chime once.
export const QUIET_MS = 3_000
// The docs don't say whether AskUserQuestion raises a Notification, so it's hooked directly.
const QUESTION_TOOL = /^AskUserQuestion$/

export const needsAttention = (notificationType: string): boolean =>
  (ATTENTION_TYPES as readonly string[]).includes(notificationType)

type Box = { lastChimeAt: number | undefined }

export const isQuiet = (box: Box, now: number): boolean => box.lastChimeAt !== undefined && now - box.lastChimeAt < QUIET_MS

// Detached by its callers: a prompt never waits on the sound.
const chime = async ($: EngineInterface, box: Box): Promise<void> => {
  try {
    const now = await $.clock.now()
    if (isQuiet(box, now)) return
    box.lastChimeAt = now
    await $.audio.play({ asset: ATTENTION_CHIME })
  } catch (err) {
    $.ui.log(`attention-chime: sound failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

export const registerAttentionChime = (on: On, options: PluginOptions): void => {
  if (options.attentionChimeSound === false) return
  const box: Box = { lastChimeAt: undefined }

  on('classic.Notification', async ($, e, next) => {
    if (needsAttention(e.notification_type)) void chime($, box)
    return next(e)
  })

  // Before next: the question shows, and waits for Nae, inside it.
  on('tool.call', { tool: QUESTION_TOOL }, async ($, e, next) => {
    void chime($, box)
    return next(e)
  })
}