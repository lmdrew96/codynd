import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { Patch } from '../types'
import { truncate } from './patch-status.ts'

// /whatchanged: what this session changed, in plain language, without reading diffs. The summary comes
// from a fork of the session (so it knows the why) and stays out of the main conversation; the file
// list and the heads-up come straight from git.
// Built against Claude Code 2.1.289.

const DIFF_CHARS = 12_000
const SUMMARY_TIMEOUT_MS = 30_000
const MAX_NAMES = 8

// Written once per session; a hot reload's session.start keeps the first.
const sessionStart = atom({ plugin: 'codynd', key: 'sessionStart' } as const, null)
const activePatches = atom({ plugin: 'codynd', key: 'activePatches' } as const, [])

export type Changes = { files: string[]; deleted: string[]; commits: string[] }

const basename = (path: string): string => path.split('/').pop() ?? path

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

// `git diff --name-status <base>` rows; a rename counts as its new path.
export const parseNameStatus = (stdout: string): { files: string[]; deleted: string[] } => {
  const files: string[] = []
  const deleted: string[] = []
  for (const row of stdout.split('\n').filter(Boolean)) {
    const [status = '', ...paths] = row.split('\t')
    const path = paths[paths.length - 1]
    if (path === undefined) continue
    files.push(path)
    if (status.startsWith('D')) deleted.push(path)
  }
  return { files, deleted }
}

const RISKY: readonly [RegExp, string][] = [
  [/(?:^|\/)(?:package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|Cargo\.toml|go\.mod)$/, 'dependencies'],
  [/(?:^|\/)(?:\.env[^/]*|wrangler\.(?:toml|jsonc?)|vercel\.json|tsconfig[^/]*\.json|[^/]*\.config\.[cm]?[jt]s|plugin\.json|hooks\.json)$/, 'config'],
  [/(?:^|\/)[^/]*(?:auth|clerk|login|password)[^/]*$|(?:^|\/)middleware\.[jt]s$/i, 'auth'],
  [/migrat|(?:^|\/)drizzle\/|(?:^|\/)schema\.(?:ts|sql|prisma)$/i, 'database'],
]

// Things worth a second look, from file names alone; null when there are none.
export const headsUp = (changes: Changes): string | null => {
  const hits = new Map<string, string[]>()
  for (const file of changes.files) {
    if (changes.deleted.includes(file)) continue
    for (const [pattern, label] of RISKY) if (pattern.test(file)) hits.set(label, [...(hits.get(label) ?? []), basename(file)])
  }
  const parts = [...hits].map(([label, names]) => `${label} (${names.join(', ')})`)
  if (changes.deleted.length > 0) parts.push(`${plural(changes.deleted.length, 'deletion')} (${changes.deleted.map(basename).join(', ')})`)
  return parts.length === 0 ? null : `⚠️ Heads up: ${parts.join('; ')}`
}

export const filesLine = (files: string[]): string => {
  const shown = files.slice(0, MAX_NAMES).join(', ')
  return `Files (${files.length}): ${shown}${files.length > MAX_NAMES ? `, +${files.length - MAX_NAMES} more` : ''}`
}

export const NOTHING = "Nothing's changed since this session started. A clean slate. 🌱"

export const formatChanges = (summary: string | undefined, changes: Changes): string => {
  if (changes.files.length === 0) return NOTHING
  const warn = headsUp(changes)
  return [summary ?? "(Couldn't get a summary this time; here's what git sees.)", filesLine(changes.files), ...(warn === null ? [] : [warn])].join('\n')
}

// At most three lines of plain text, whatever the model wrapped them in.
export const cleanSummary = (reply: string): string | undefined => {
  const lines = reply
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 3)
  return lines.length === 0 ? undefined : lines.map(l => truncate(l, 160)).join('\n')
}

export const summaryPrompt = (changes: Changes, diff: string, scope: string | undefined): string =>
  [
    'Nae asked what changed in this session. She designs the systems and does not read diffs.',
    'In 1 to 3 short plain-language lines, say what the code does now that it did not before: behavior, not implementation.',
    'No code blocks, no file lists, no preamble.',
    ...(scope === undefined ? [] : [`Only describe the work for this patch: ${scope}. Leave other changes out.`]),
    '',
    `Commits this session: ${changes.commits.length === 0 ? 'none' : changes.commits.join(' | ')}`,
    `Files: ${changes.files.join(', ')}`,
    '',
    'Diff (may be cut off):',
    diff.slice(0, DIFF_CHARS),
  ].join('\n')

const git = async ($: EngineInterface, args: string[]): Promise<string> => {
  const run = await $.process.run(['git', ...args])
  if (run.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.trim()}`)
  return run.stdout
}

const untracked = async ($: EngineInterface): Promise<string[]> =>
  (await git($, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean)

const snapshot = async ($: EngineInterface): Promise<void> => {
  try {
    if ((await read($, sessionStart)) !== null) return
    const head = (await git($, ['rev-parse', 'HEAD'])).trim()
    const files = await untracked($)
    await update($, sessionStart, () => ({ head, untracked: files }))
  } catch (err) {
    // Not a repo, or no commits yet: /whatchanged says so when asked.
    $.ui.log(`whatchanged: no start snapshot: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

// The fork knows why the changes were made; a session with nothing to fork falls back to Haiku on the diff alone.
const summarize = async ($: EngineInterface, prompt: string): Promise<string | undefined> => {
  const forked = await $.model.fork({ prompt })
  const reply =
    !forked.isAnswered && forked.reason === 'nothing-to-fork'
      ? await $.model.complete({ model: 'haiku', prompt, effort: 'low', timeoutMs: SUMMARY_TIMEOUT_MS })
      : forked
  if (!reply.isAnswered) {
    $.ui.log(`whatchanged: no summary (${reply.reason})`, { to: 'debug' })
    return undefined
  }
  return cleanSummary(reply.text)
}

// `/whatchanged patch` scopes to the patch in progress; any other words name the patch.
const scopeOf = (args: string, patches: Patch[]): string | undefined => {
  const typed = args.trim()
  if (typed === '') return undefined
  return typed === 'patch' ? patches[0]?.title : typed
}

const whatChanged = async ($: EngineInterface, args: string): Promise<{ text: string }> => {
  const start = await read($, sessionStart)
  if (start === null) return { text: "I don't know where this session started (not a git repo, or no commits yet), so there's nothing to compare." }
  try {
    const { files, deleted } = parseNameStatus(await git($, ['diff', '--name-status', start.head]))
    const fresh = (await untracked($)).filter(f => !start.untracked.includes(f))
    const commits = (await git($, ['log', '--format=%s', `${start.head}..HEAD`])).split('\n').filter(Boolean)
    const changes: Changes = { files: [...files, ...fresh], deleted, commits }
    if (changes.files.length === 0) return { text: NOTHING }
    $.ui.toast("Reading this session's changes…")
    const diff = await git($, ['diff', start.head])
    const scope = scopeOf(args, await read($, activePatches))
    const summary = await summarize($, summaryPrompt(changes, diff, scope)).catch((err: unknown) => {
      $.ui.log(`whatchanged: summary threw: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
      return undefined
    })
    return { text: formatChanges(summary, changes) }
  } catch (err) {
    $.ui.log(`whatchanged: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return { text: "Couldn't read this session's changes from git." }
  }
}

export const registerWhatChanged = (on: On): void => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const result = await next(e)
    await snapshot($)
    await $.command.register({
      name: 'whatchanged',
      description: "What this session changed, in plain language: /whatchanged, or /whatchanged patch for the active patch's work",
      argumentHint: '[patch]',
    })
    return result
  })

  on('command.run', { command: 'whatchanged' }, async ($, e) => whatChanged($, e.args))
}
