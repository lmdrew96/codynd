import { atom, read } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

// Instruction hooks: reminders aimed at Cody, so CLAUDE.md rules don't fade in long sessions.
// Everything here rides as model-only context; Nae never sees a toast or a warning.
// Built against Claude Code 2.1.289.

const EDIT_TOOL = /^(?:Edit|Write|MultiEdit|NotebookEdit)$/
const COMPLETE_TOOL = /__cp_complete_patch$/

// Nae's rule list, edited without code. Read once per conversation (again after /clear or compaction).
export const RULES_FILE = 'rules.md'
export const RULES_BLOCK = 'codyndRules'

export const PATCH_OR_FOCUS =
  'CodyND reminder: no patch is in progress here and no focus is set. Before more code changes, start the patch (cp_start_patch) or name the work (set_focus).'
export const COMPLETION_NOTE =
  'CodyND reminder: that patch closed without a completion note. Add one with cp_add_note: what shipped, and the version.'

// The same state patch-status.ts and focus.tsx write (atoms are declared per file).
const activePatches = atom({ plugin: 'codynd', key: 'activePatches' } as const, [])
const focus = atom({ plugin: 'codynd', key: 'focus' } as const, null)

export const hasNote = (note: unknown): boolean => typeof note === 'string' && note.trim() !== ''

const loadRules = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    const text = (await $.fs.read(`${$.plugin.root}/${RULES_FILE}`)).trim()
    return text === '' ? undefined : text
  } catch (err) {
    $.ui.log(`instructions: reading ${RULES_FILE} failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return undefined
  }
}

// Covered: a patch in progress for this repo, or a named focus.
const isCovered = async ($: EngineInterface): Promise<boolean> => {
  try {
    return (await read($, activePatches)).length > 0 || (await read($, focus)) !== null
  } catch (err) {
    $.ui.log(`instructions: reading the patch and focus failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return true
  }
}

export const registerInstructions = (on: On): void => {
  // Once per topic: cleared with each new conversation (/clear, compaction), when the focus
  // changes or clears, or when a patch completes.
  // Module state: a reload just forgets, which at worst reminds once more.
  let reminded = false

  on('prompt.context', async ($, e, next) => {
    reminded = false
    const result = await next(e)
    const rules = await loadRules($)
    if (rules === undefined) return result
    return { ...result, blocks: [...result.blocks.filter(b => b.name !== RULES_BLOCK), { name: RULES_BLOCK, text: rules }] }
  })

  on('state.set', { plugin: 'codynd', key: 'focus' }, async ($, e, next) => {
    reminded = false
    return next(e)
  })

  on('tool.call', { tool: EDIT_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || reminded || (await isCovered($))) return ran
    reminded = true
    return { ...ran, context: [...(ran.context ?? []), PATCH_OR_FOCUS] }
  })

  on('tool.call', { tool: COMPLETE_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    reminded = false
    if (hasNote((e as { note?: unknown }).note)) return ran
    return { ...ran, context: [...(ran.context ?? []), COMPLETION_NOTE] }
  })
}
