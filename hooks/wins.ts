import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { DEFAULT_SERVER, matchesRepo, parseAliases, truncate, type Aliases } from './patch-status.ts'

// #9 /wins: what got done today. `/wins` for this repo (patches + commits), `/wins-all` for every project's patches,
// `/wins-week` for every project's patches since Monday.
// Built against Claude Code 2.1.289.

export type DonePatch = { title: string; project_name: string; project_slug: string; completed_at: string | null }

const EMPTY = "Nothing closed yet today. Plenty of day left (or not, and that's fine too)."

// Patches closed at or after local midnight. completed_at is UTC; the boundary is the local day's.
export const closedSince = (patches: DonePatch[], midnightMs: number): DonePatch[] =>
  patches.filter(p => p.completed_at !== null && Date.parse(p.completed_at) >= midnightMs)

// Same repo matching as the status line: folder name (or its alias) vs project slug or name.
export const forRepo = (patches: DonePatch[], cwd: string, aliases: Aliases = {}): DonePatch[] =>
  patches.filter(p => matchesRepo(p.project_slug, p.project_name, cwd, aliases))

const section = (heading: string, lines: string[], mark: string): string[] =>
  lines.length === 0 ? [] : [`${heading} (${lines.length})`, ...lines.map(l => `  ${mark} ${truncate(l, 70)}`)]

export const formatRepoWins = (repo: string, patches: DonePatch[], commits: string[], note?: string): string => {
  const body = [...section('Closed', patches.map(p => p.title), '✓'), ...section('Commits', commits, '•')]
  return [`🏆 Today in ${repo}`, ...(body.length === 0 ? [EMPTY] : body), ...(note ? [note] : [])].join('\n')
}

export const formatAllWins = (patches: DonePatch[]): string => {
  if (patches.length === 0) return `🏆 Today across all projects\n${EMPTY}`
  const byProject = new Map<string, string[]>()
  for (const p of patches) byProject.set(p.project_name, [...(byProject.get(p.project_name) ?? []), p.title])
  const body = [...byProject].flatMap(([project, titles]) => section(project, titles, '✓'))
  return ['🏆 Today across all projects', ...body].join('\n')
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

// The day a close falls on: the last local midnight at or before it. weekStarts[0] is Monday's.
const dayIndex = (completedAt: string, weekStarts: number[]): number =>
  weekStarts.findLastIndex(start => Date.parse(completedAt) >= start)

// Only worth a line when the wins spread over more than one day; the first day wins a tie.
export const busiestDay = (patches: DonePatch[], weekStarts: number[]): { day: string; count: number } | null => {
  const counts = WEEKDAYS.map(() => 0)
  for (const p of patches) if (p.completed_at !== null) counts[dayIndex(p.completed_at, weekStarts)]! += 1
  if (counts.filter(c => c > 0).length < 2) return null
  const best = counts.indexOf(Math.max(...counts))
  return { day: WEEKDAYS[best]!, count: counts[best]! }
}

export const formatWeekWins = (patches: DonePatch[], weekStarts: number[]): string => {
  if (patches.length === 0) return "🏆 This week across all projects\nNothing closed yet this week. Rest and setup count too."
  const header = `${patches.length} patch${patches.length === 1 ? '' : 'es'} shipped this week 🎉`
  const busiest = busiestDay(patches, weekStarts)
  const byProject = new Map<string, string[]>()
  for (const p of patches) byProject.set(p.project_name, [...(byProject.get(p.project_name) ?? []), p.title])
  const body = [...byProject].flatMap(([project, titles]) => section(project, titles, '✓'))
  return [header, ...(busiest ? [`Busiest day: ${busiest.day} (${busiest.count})`] : []), ...body].join('\n')
}

const textOf = (result: { content: { text?: string }[] }): string => result.content.map(b => b.text ?? '').join('')

// cp_get_velocity filters by completed_at on the server: one small call, no page cap.
const closedSinceMs = async ($: EngineInterface, server: string, midnightMs: number): Promise<DonePatch[]> => {
  const result = await $.mcp.call(server, 'cp_get_velocity', { completed_since: new Date(midnightMs).toISOString() })
  if (result.isError) throw new Error(textOf(result))
  const parsed = JSON.parse(textOf(result)) as { patches?: DonePatch[] }
  return closedSince(parsed.patches ?? [], midnightMs)
}

// Local midnight `daysBack` days ago from the system clock, so it follows the person's time zone and DST
// (macOS, then GNU date).
const localMidnight = async ($: EngineInterface, daysBack = 0): Promise<number> => {
  const gnu = daysBack === 0 ? 'today 00:00' : `00:00 ${daysBack} days ago`
  for (const argv of [['date', '-v0H', '-v0M', '-v0S', `-v-${daysBack}d`, '+%s'], ['date', '-d', gnu, '+%s']]) {
    const run = await $.process.run(argv)
    const seconds = Number(run.stdout.trim())
    if (run.exitCode === 0 && Number.isInteger(seconds)) return seconds * 1000
  }
  throw new Error('date could not report local midnight')
}

// Each day's local midnight from Monday through today, read one by one so a DST change mid-week stays exact.
const readWeekStarts = async ($: EngineInterface): Promise<number[]> => {
  const weekday = await $.process.run(['date', '+%u'])
  const iso = Number(weekday.stdout.trim()) // 1 = Monday … 7 = Sunday
  if (weekday.exitCode !== 0 || !Number.isInteger(iso) || iso < 1 || iso > 7) throw new Error('date could not report the weekday')
  const starts: number[] = []
  for (let back = iso - 1; back >= 0; back--) starts.push(await localMidnight($, back))
  return starts
}

const weekWins = async ($: EngineInterface, server: string): Promise<{ text: string }> => {
  let starts: number[]
  try {
    starts = await readWeekStarts($)
  } catch (err) {
    $.ui.log(`wins: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return { text: "Couldn't work out when the week started, so no wins list this time." }
  }
  try {
    return { text: formatWeekWins(await closedSinceMs($, server, starts[0]!), starts) }
  } catch (err) {
    $.ui.log(`wins: ChaosPatch failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return { text: "Couldn't reach ChaosPatch for this week's wins." }
  }
}

const todaysCommits = async ($: EngineInterface, midnightMs: number): Promise<string[]> => {
  const git = await $.process.run(['git', 'log', `--since=@${Math.floor(midnightMs / 1000)}`, '--format=%s'])
  return git.exitCode === 0 ? git.stdout.split('\n').filter(Boolean) : []
}

const repoWins = async ($: EngineInterface, server: string, aliases: Aliases, midnightMs: number): Promise<string> => {
  const cwd = await $.session.cwd()
  const repo = cwd.split('/').filter(Boolean).pop() ?? cwd
  const commits = await todaysCommits($, midnightMs)
  try {
    return formatRepoWins(repo, forRepo(await closedSinceMs($, server, midnightMs), cwd, aliases), commits)
  } catch (err) {
    $.ui.log(`wins: ChaosPatch failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return formatRepoWins(repo, [], commits, "(Couldn't reach ChaosPatch, so closed patches are missing.)")
  }
}

const allWins = async ($: EngineInterface, server: string, midnightMs: number): Promise<string> => {
  try {
    return formatAllWins(await closedSinceMs($, server, midnightMs))
  } catch (err) {
    $.ui.log(`wins: ChaosPatch failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return "Couldn't reach ChaosPatch for today's wins."
  }
}

const wins = async ($: EngineInterface, server: string, aliases: Aliases, args: string): Promise<{ text: string }> => {
  try {
    const midnightMs = await localMidnight($)
    return { text: args.trim() === 'all' ? await allWins($, server, midnightMs) : await repoWins($, server, aliases, midnightMs) }
  } catch (err) {
    $.ui.log(`wins: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return { text: "Couldn't work out when today started, so no wins list this time." }
  }
}

export const registerWins = (on: On, options: PluginOptions): void => {
  const server = typeof options.chaospatchServer === 'string' ? options.chaospatchServer : DEFAULT_SERVER
  const aliases = parseAliases(options.projectAliases)

  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'wins', description: "Today's wins in this repo: closed patches and commits" })
    // Its own command, not an argument: the typeahead lists names, so `/wins all` was undiscoverable.
    await $.command.register({ name: 'wins-all', description: "Today's closed patches across every project" })
    await $.command.register({ name: 'wins-week', description: "This week's closed patches across every project, since Monday" })
    return result
  })

  on('command.run', { command: 'wins' }, async ($, e) => wins($, server, aliases, e.args))
  on('command.run', { command: 'wins-all' }, async $ => wins($, server, aliases, 'all'))
  on('command.run', { command: 'wins-week' }, async $ => weekWins($, server))
}
