import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { DEFAULT_SERVER, matchesRepo, parseAliases, truncate, type Aliases } from './patch-status.ts'

// #13 /patch: file a ChaosPatch patch from a rough thought, drafted from the session, without interrupting Cody.
// Built against Claude Code 2.1.289.

type Priority = 'low' | 'medium' | 'high'
type Energy = 'low' | 'med' | 'high'
export type Draft = { title: string; summary: string; acceptance: string[]; priority: Priority; energy?: Energy }
type Project = { name: string; slug: string }

const DRAFT_TIMEOUT_MS = 30_000
const PRIORITIES: readonly string[] = ['low', 'medium', 'high']
// Plain ChaosPatch tags (energy:low|med|high); /fried lists the low ones.
const ENERGIES: readonly string[] = ['low', 'med', 'high']

export const draftPrompt = (rough: string): string =>
  [
    'Nae just typed a quick patch idea mid-session. Turn it into a ChaosPatch patch, using this session for context.',
    'Reply with ONLY a JSON object, no prose and no code fence:',
    '{"title": string (under 80 chars), "summary": string (one line), "acceptance": string[] (2-4 short criteria), "priority": "low" | "medium" | "high", "energy": "low" | "med" | "high"}',
    'Priority is "medium" unless her text clearly says otherwise. Stay true to what she wrote; don\'t add scope.',
    'Energy is your guess at the focus it takes: "low" for a small copy, CSS, config or test tweak in one place; "high" for a new feature across files or an open design question; "med" otherwise.',
    '',
    `Her words: ${rough}`,
  ].join('\n')

// Strict on shape, lenient on wrapping: takes the outermost {...} in the reply.
export const parseDraft = (reply: string): Draft | undefined => {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const d = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>
    const acceptance = Array.isArray(d.acceptance) ? d.acceptance.filter((a): a is string => typeof a === 'string' && a.trim() !== '') : []
    if (typeof d.title !== 'string' || d.title.trim() === '' || typeof d.summary !== 'string') return undefined
    const priority = typeof d.priority === 'string' && PRIORITIES.includes(d.priority) ? (d.priority as Priority) : 'medium'
    const energy = typeof d.energy === 'string' && ENERGIES.includes(d.energy) ? (d.energy as Energy) : undefined
    return { title: truncate(d.title.trim(), 100), summary: d.summary.trim(), acceptance, priority, ...(energy === undefined ? {} : { energy }) }
  } catch {
    return undefined
  }
}

// Nae's words always ride along in `spec`, drafted or not.
export const patchArgs = (projectSlug: string, rough: string, draft: Draft | undefined): Record<string, unknown> =>
  draft === undefined
    ? { project_slug: projectSlug, title: truncate(rough, 100), notes: rough, priority: 'medium', tags: ['quick-capture', 'rough'], spec: `Nae's words: ${rough}` }
    : {
        project_slug: projectSlug,
        title: draft.title,
        notes: [draft.summary, ...(draft.acceptance.length > 0 ? ['AC:', ...draft.acceptance.map(a => `- ${a}`)] : [])].join('\n'),
        priority: draft.priority,
        tags: ['quick-capture', ...(draft.energy === undefined ? [] : [`energy:${draft.energy}`])],
        spec: `Nae's words: ${rough}`,
      }

const textOf = (result: { content: { text?: string }[] }): string => result.content.map(b => b.text ?? '').join('')

// The fork sees the session (what we're working on); a brand-new session falls back to Haiku on her words alone.
const draftPatch = async ($: EngineInterface, rough: string): Promise<Draft | undefined> => {
  const prompt = draftPrompt(rough)
  const forked = await $.model.fork({ prompt })
  const reply =
    forked.isAnswered
      ? forked
      : forked.reason === 'nothing-to-fork'
        ? await $.model.complete({ model: 'haiku', prompt, effort: 'low', timeoutMs: DRAFT_TIMEOUT_MS })
        : forked
  if (!reply.isAnswered) {
    $.ui.log(`patch: draft failed (${reply.reason}), filing raw`, { to: 'debug' })
    return undefined
  }
  return parseDraft(reply.text)
}

const repoProject = async ($: EngineInterface, server: string, aliases: Aliases): Promise<Project | undefined> => {
  const cwd = await $.session.cwd()
  const result = await $.mcp.call(server, 'cp_list_projects', {})
  if (result.isError) throw new Error(textOf(result))
  const projects = JSON.parse(textOf(result)) as Project[]
  return projects.find(p => matchesRepo(p.slug, p.name, cwd, aliases))
}

// Runs after the command returns, so the prompt is free at once. Every failure keeps her words on screen.
const fileQuickPatch = async ($: EngineInterface, server: string, aliases: Aliases, rough: string): Promise<void> => {
  try {
    const project = await repoProject($, server, aliases)
    if (project === undefined) {
      $.ui.toast('No ChaosPatch project for this repo; kept your words.')
      $.ui.log(`Not filed (no matching project). Your words: ${rough}`)
      return
    }
    const drafted = await draftPatch($, rough).catch((err: unknown) => {
      $.ui.log(`patch: draft threw: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
      return undefined
    })
    const args = patchArgs(project.slug, rough, drafted)
    const added = await $.mcp.call(server, 'cp_add_patch', args)
    if (added.isError) throw new Error(textOf(added))
    $.ui.toast(`🩹 Filed: ${truncate(String(args.title), 50)}${drafted === undefined ? ' (rough)' : ''}`)
  } catch (err) {
    $.ui.log(`patch: filing failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    $.ui.toast("Couldn't file that patch; your words are in the transcript.")
    $.ui.log(`Not filed. Your words: ${rough}`)
  }
}

export const registerQuickPatch = (on: On, options: PluginOptions): void => {
  const server = typeof options.chaospatchServer === 'string' ? options.chaospatchServer : DEFAULT_SERVER
  const aliases = parseAliases(options.projectAliases)

  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const result = await next(e)
    // Immediate: runs mid-turn, so a quick patch never waits on (or interrupts) Cody.
    await $.command.register({
      name: 'patch',
      description: 'File a ChaosPatch patch from a rough thought: /patch <idea>',
      argumentHint: '<idea>',
      immediate: true,
    })
    return result
  })

  on('command.run', { command: 'patch' }, async ($, e) => {
    const rough = e.args.trim()
    if (rough === '') return { text: 'Usage: /patch <rough idea>' }
    $.ui.toast('Drafting a patch…')
    void fileQuickPatch($, server, aliases, rough)
    return {}
  })
}
