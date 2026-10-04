import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { KINDLING_SERVER, kindleArgs } from './park.ts'
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
const parkOffer = atom({ plugin: 'codynd', key: 'parkOffer' } as const, null)

// Short and plain: one line, trimmed, capped at 40 characters.
export const cleanFocus = (text: string): string | null => {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine === '' ? null : truncate(oneLine, MAX_FOCUS)
}

// Only a replaced focus is worth rescuing (a clear means the work wrapped up), and each label is
// offered once a session, so switching back and forth never nags.
export const offerFor = (old: string | null, label: string | null, offered: ReadonlySet<string>): string | null =>
  old === null || label === null || old === label || offered.has(old) ? null : old

const setFocus = async ($: EngineInterface, label: string | null): Promise<void> => {
  await update($, focus, () => label)
  $.ui.status(statusLine(await read($, activePatches), label, await $.clock.now()))
}

// A focus change from Cody or /topic: set it, and quietly offer to park the one it replaced.
const changeFocus = async ($: EngineInterface, label: string | null, offered: Set<string>): Promise<void> => {
  const old = await read($, focus)
  await setFocus($, label)
  const offer = offerFor(old, label, offered)
  if (offer === null) return
  offered.add(offer)
  await update($, parkOffer, () => offer)
}

const dismissOffer = async ($: EngineInterface): Promise<void> => {
  await update($, parkOffer, () => null)
}

// Parks the way /park does. A failed save keeps the offer up, so the thread isn't lost and Park can be pressed again.
const parkOld = async ($: EngineInterface, server: string, old: string): Promise<void> => {
  try {
    const result = await $.mcp.call(server, 'kindle', kindleArgs(old, await $.session.cwd()))
    if (result.isError) throw new Error(result.content.map(b => b.text ?? '').join(' '))
    $.ui.toast(`🅿️ Parked: ${truncate(old, 40)}`)
    await dismissOffer($)
  } catch (err) {
    $.ui.log(`focus: parking the old focus failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    $.ui.toast("Couldn't park that one; try again or dismiss.")
  }
}

export const registerFocus = (on: On, options: PluginOptions): void => {
  const server = typeof options.kindlingServer === 'string' ? options.kindlingServer : KINDLING_SERVER
  // Module state: a reload just forgets which labels were offered, which at worst offers one again.
  const offered = new Set<string>()

  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const result = await next(e)
    offered.clear()
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
    await changeFocus($, label, offered)
    return { result: `Focus set: ${label}` }
  })

  on('tool.call', { tool: CLEAR_TOOL }, async $ => {
    await setFocus($, null)
    return { result: 'Focus cleared.' }
  })

  on('command.run', { command: 'topic' }, async ($, e) => {
    const label = cleanFocus(e.args)
    await changeFocus($, label, offered)
    return { text: label === null ? 'Focus cleared.' : `Focus: ${label}` }
  })

  // /clear ends the session's context, so the focus goes with it. No session.start follows a
  // /clear, so redraw the line here rather than waiting for one.
  on('session.end', async ($, e, next) => {
    await setFocus($, null)
    await dismissOffer($)
    return next(e)
  })

  // One chance, never blocking: the offer goes with Nae's next prompt, like the re-entry card.
  on('prompt.submit', { origin: { kind: 'composer' } }, async ($, e, next) => {
    await dismissOffer($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const old = await read($, parkOffer)
    if (old === null || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box borderStyle="round" borderDimColor flexDirection="row" gap={1} paddingX={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            🅿️ <Text dimColor>Park </Text>"{old}"<Text dimColor> in Kindling?</Text>
          </Text>
        </Box>
        <Button key="park" onPress={() => parkOld($, server, old)}>
          Park
        </Button>
        <Button key="dismiss" role="dismiss" onPress={() => dismissOffer($)}>
          Dismiss
        </Button>
      </Box>
    )
  })
}
