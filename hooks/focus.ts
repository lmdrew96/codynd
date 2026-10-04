import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import { statusLine, truncate } from './patch-status.ts'

// #12 Focus slot: Cody names the current non-patch work; the status line shows "🎯 <focus>" when no patch is active.
// /topic is the manual override.
// Built against Claude Code 2.1.289.

const MAX_FOCUS = 40
// Matched by pattern, not literal: a literal tool name sends tsc through every known tool's types (out of memory).
const SET_TOOL = /^mcp__codynd__set_focus$/
const CLEAR_TOOL = /^mcp__codynd__clear_focus$/

// The same state patch-status.ts and patches-pane.tsx read (atoms are declared per file).
const focus = atom({ plugin: 'codynd', key: 'focus' } as const, null)
const activePatches = atom({ plugin: 'codynd', key: 'activePatches' } as const, [])

// Short and plain: one line, trimmed, capped at 40 characters.
export const cleanFocus = (text: string): string | null => {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine === '' ? null : truncate(oneLine, MAX_FOCUS)
}

const setFocus = async ($: EngineInterface, label: string | null): Promise<void> => {
  await update($, focus, () => label)
  $.ui.status(statusLine(await read($, activePatches), label, await $.clock.now()))
}

export const registerFocus = (on: On): void => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const result = await next(e)
    await $.tool.register({
      name: 'set_focus',
      description:
        "Set the status-line focus to a short plain label (40 chars max) naming the non-patch work you and Nae are doing now. Call it when Nae brings a new topic that isn't an in-progress ChaosPatch patch, or when the topic changes. Don't call it for patch work: an in-progress patch already shows and always wins.",
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The label, e.g. "Debugging Tangle identity"' } },
        required: ['text'],
      },
    })
    await $.tool.register({
      name: 'clear_focus',
      description: 'Clear the status-line focus when the non-patch work wraps up.',
    })
    // Not /focus: that's a built-in, and a session start refuses the name. A refusal here mustn't
    // undo the tools above, so it's logged rather than thrown.
    await $.command
      .register({
        name: 'topic',
        description: 'Set the status-line focus by hand: /topic <label>, or /topic alone to clear',
        argumentHint: '[label]',
        immediate: true,
      })
      .catch((err: unknown) => $.ui.log(`focus: /topic not registered: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' }))
    return result
  })

  on('tool.call', { tool: SET_TOOL }, async ($, e) => {
    const text = (e as { text?: unknown }).text
    const label = cleanFocus(typeof text === 'string' ? text : '')
    if (label === null) return { result: 'Focus not set: the label was empty.', isError: true }
    await setFocus($, label)
    return { result: `Focus set: ${label}` }
  })

  on('tool.call', { tool: CLEAR_TOOL }, async $ => {
    await setFocus($, null)
    return { result: 'Focus cleared.' }
  })

  on('command.run', { command: 'topic' }, async ($, e) => {
    const label = cleanFocus(e.args)
    await setFocus($, label)
    return { text: label === null ? 'Focus cleared.' : `Focus: ${label}` }
  })

  // /clear ends the session's context, so the focus goes with it. No session.start follows a
  // /clear, so redraw the line here rather than waiting for one.
  on('session.end', async ($, e, next) => {
    await setFocus($, null)
    return next(e)
  })
}
