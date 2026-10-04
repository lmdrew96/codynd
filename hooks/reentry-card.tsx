import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import type { ReentryCard } from '../types'
import { DEFAULT_SERVER, formatElapsed, parsePatches, patchesForCwd, truncate, type Patch } from './patch-status.ts'
import { wrapKey, type LeftOff } from './wrap.ts'

// #4 Context re-entry card: "last time / next" band above the prompt when a session opens.
// Built against Claude Code 2.1.289.

const card = atom({ plugin: 'codynd', key: 'reentryCard' } as const, null)
const isHidden = atom({ plugin: 'codynd', key: 'reentryHidden' } as const, false)

const UNIT = '\u001f'

// `git log` line: subject, unit separator, relative date ("2 hours ago").
export const parseLastCommit = (stdout: string): ReentryCard['lastCommit'] => {
  const [subject, when] = stdout.trim().split(UNIT)
  return subject && when ? { subject, when } : null
}

// Store values are untyped JSON: accept only a well-formed /wrap note.
export const parseLeftOff = (value: unknown): LeftOff | null => {
  const v = value as Partial<LeftOff> | undefined
  return typeof v?.note === 'string' && typeof v.savedAt === 'number' ? { note: v.note, savedAt: v.savedAt } : null
}

export const pickNext = (inProgress: Patch[], open: Patch[]): ReentryCard['next'] => {
  const [active] = inProgress
  if (active !== undefined) return { title: active.title, isInProgress: true }
  const [upNext] = open
  return upNext === undefined ? null : { title: upNext.title, isInProgress: false }
}

const listPatches = async ($: EngineInterface, server: string, args: Record<string, unknown>, cwd: string): Promise<Patch[]> => {
  const result = await $.mcp.call(server, 'cp_list_all_patches', args)
  if (result.isError) throw new Error(result.content.map(b => b.text ?? '').join(' '))
  return patchesForCwd(parsePatches(result.content.map(b => b.text ?? '').join('')), cwd)
}

// Each source fails on its own: a repo with no git history still gets its next step, and vice versa.
// Resolves whether there was anything to show; nothing clears the card, so a stale one never lingers.
const loadCard = async ($: EngineInterface, server: string): Promise<boolean> => {
  const cwd = await $.session.cwd()
  let lastCommit: ReentryCard['lastCommit'] = null
  let leftOff: ReentryCard['leftOff'] = null
  let next: ReentryCard['next'] = null
  try {
    const git = await $.process.run(['git', 'log', '-1', `--format=%s${UNIT}%cr`])
    if (git.exitCode === 0) lastCommit = parseLastCommit(git.stdout)
  } catch (err) {
    $.ui.log(`reentry-card: git failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
  try {
    const inProgress = await listPatches($, server, { status: 'in_progress' }, cwd)
    // patchesForCwd re-sorts by started_at (null for open patches), keeping the priority order.
    const open = inProgress.length > 0 ? [] : await listPatches($, server, { status: 'open', sort_by: 'priority' }, cwd)
    next = pickNext(inProgress, open)
  } catch (err) {
    $.ui.log(`reentry-card: ChaosPatch failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
  try {
    leftOff = parseLeftOff(await $.store.get(wrapKey(cwd)))
  } catch (err) {
    $.ui.log(`reentry-card: reading /wrap note failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
  const hasAny = leftOff !== null || lastCommit !== null || next !== null
  await update($, card, () => (hasAny ? { leftOff, lastCommit, next } : null))
  return hasAny
}

const hide = async ($: EngineInterface): Promise<void> => {
  await update($, isHidden, () => true)
}

export const registerReentryCard = (on: On, options: PluginOptions): void => {
  const server = typeof options.chaospatchServer === 'string' ? options.chaospatchServer : DEFAULT_SERVER

  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const result = await next(e)
    void loadCard($, server)
    await $.command
      .register({
        name: 'recap',
        description: 'Bring the welcome-back card up again: left-off note, last commit, next patch',
        immediate: true,
      })
      .catch((err: unknown) => $.ui.log(`reentry-card: /recap not registered: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' }))
    return result
  })

  // For a window left open: reload the card fresh and show it until Dismiss or the next prompt.
  on('command.run', { command: 'recap' }, async $ => {
    if (!(await loadCard($, server))) return { text: 'Nothing to recap here yet.' }
    await update($, isHidden, () => false)
    return {}
  })

  // The card is for re-entry: once Nae types her first prompt, it has done its job.
  on('prompt.submit', { origin: { kind: 'composer' } }, async ($, e, next) => {
    await hide($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const shown = await read($, card)
    if (shown === null || e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    return (
      <Box borderStyle="round" borderDimColor flexDirection="column" paddingX={1}>
        <Text bold>↩ Welcome back</Text>
        {shown.leftOff !== null && (
          <Text>
            <Text dimColor>Left off: </Text>
            {shown.leftOff.note} <Text dimColor>· {formatElapsed(now - shown.leftOff.savedAt)} ago</Text>
          </Text>
        )}
        {shown.lastCommit !== null && (
          <Text wrap="truncate-end">
            <Text dimColor>Last time: </Text>
            {truncate(shown.lastCommit.subject)} <Text dimColor>· {shown.lastCommit.when}</Text>
          </Text>
        )}
        {shown.next !== null && (
          <Text wrap="truncate-end">
            <Text dimColor>{shown.next.isInProgress ? 'In progress: ' : 'Up next: '}</Text>
            🩹 {truncate(shown.next.title)}
          </Text>
        )}
        <Box>
          <Button key="dismiss" role="dismiss" onPress={() => hide($)}>
            Dismiss
          </Button>
        </Box>
      </Box>
    )
  })
}
