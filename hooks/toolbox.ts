import type { EngineInterface, On } from 'claude-code'
import { truncate } from './patch-status.ts'

// Toolbox manifest: what's installed here (skills, plugins, MCP servers, CodyND's mods), written to
// ~/ChaosToolbox/toolbox-manifest.json for Coru's weekly Chaos Toolbox refresh, which can't read ~/.claude.
// A plain home folder on purpose: Desktop/Documents trigger macOS permission prompts.
// Names and frontmatter only: never env values, headers, tokens or full URLs.
// Built against Claude Code 2.1.289.

const DEBOUNCE_MS = 6 * 60 * 60 * 1000
const SYNCED_KEY = 'toolboxSyncedAt'
const DESCRIPTION_CHARS = 200

export type Skill = { name: string; description: string; path: string }
export type Plugin = { name: string; version?: string; enabled: boolean }
export type McpServer = { name: string; type: string; scope: 'user' | 'project'; host?: string }
export type Mod = { name: string; commands?: string[]; file: string }
export type Manifest = {
  generatedAt: string
  claudeCodeVersion?: string
  skills: Skill[]
  plugins: Plugin[]
  mcpServers: McpServer[]
  mods: Mod[]
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const unquote = (s: string): string => s.replace(/^(["'])([\s\S]*)\1$/, '$2')

// name + description from a SKILL.md's YAML frontmatter: single-line, quoted, or folded (>, >-, |).
export const parseFrontmatter = (text: string): { name?: string; description?: string } => {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  if (block === undefined) return {}
  const lines = block.split(/\r?\n/)
  const field = (key: string): string | undefined => {
    const at = lines.findIndex(l => l.startsWith(`${key}:`))
    if (at < 0) return undefined
    const inline = (lines[at] ?? '').slice(key.length + 1).trim()
    if (!/^[>|][-+]?$/.test(inline)) return unquote(inline)
    const rest: string[] = []
    for (const l of lines.slice(at + 1)) {
      if (l.trim() !== '' && !/^\s/.test(l)) break
      rest.push(l.trim())
    }
    return rest.filter(Boolean).join(' ')
  }
  const name = field('name')
  const description = field('description')
  return { ...(name ? { name } : {}), ...(description ? { description: description.replace(/\s+/g, ' ') } : {}) }
}

// Host only: no scheme, credentials, port, path or query.
export const hostOf = (url: string): string | undefined => /^[a-z][\w+.-]*:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i.exec(url)?.[1]

export const mcpEntries = (servers: unknown, scope: McpServer['scope']): McpServer[] =>
  isRecord(servers)
    ? Object.entries(servers).map(([name, cfg]) => {
        const entry = isRecord(cfg) ? cfg : {}
        const url = typeof entry.url === 'string' ? entry.url : undefined
        const type = typeof entry.type === 'string' ? entry.type : url !== undefined ? 'http' : 'stdio'
        const host = url === undefined ? undefined : hostOf(url)
        return { name, type, scope, ...(host === undefined ? {} : { host }) }
      })
    : []

// installed_plugins.json's { plugins: { "name@marketplace": [{ version }] } }, plus settings' enabledPlugins.
export const pluginEntries = (installed: unknown, enabled: unknown): Plugin[] => {
  const byKey = isRecord(installed) && isRecord(installed.plugins) ? installed.plugins : {}
  const on = isRecord(enabled) ? enabled : {}
  return [...new Set([...Object.keys(byKey), ...Object.keys(on)])].sort().map(name => {
    const installs = byKey[name]
    const first: unknown = Array.isArray(installs) ? installs[0] : undefined
    const version = isRecord(first) && typeof first.version === 'string' ? first.version : undefined
    return { name, ...(version === undefined ? {} : { version }), enabled: on[name] === true }
  })
}

// The slash commands a hooks file registers, read from its source.
export const commandsIn = (source: string): string[] =>
  [...source.matchAll(/command\s*\.register\(\{\s*name:\s*'([^']+)'/g)].map(m => m[1] ?? '').filter(Boolean)

export const countItems = (m: Manifest): number => m.skills.length + m.plugins.length + m.mcpServers.length + m.mods.length

const readJson = async ($: EngineInterface, path: string): Promise<unknown> => {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    // Missing or unreadable config just means nothing of that kind to list.
    return undefined
  }
}

const toolboxSkills = async ($: EngineInterface, home: string): Promise<Skill[]> => {
  const dir = `${home}/.claude/skills`
  const entries = await $.fs.list(dir).catch(() => [])
  const skills: Skill[] = []
  for (const entry of entries) {
    if (entry.kind === 'file') continue
    const path = `${dir}/${entry.name}/SKILL.md`
    const text = await $.fs.read(path).catch(() => undefined)
    if (text === undefined) continue
    const front = parseFrontmatter(text)
    skills.push({ name: front.name ?? entry.name, description: truncate(front.description ?? '', DESCRIPTION_CHARS), path })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

const toolboxMods = async ($: EngineInterface): Promise<Mod[]> => {
  const dir = `${$.plugin.root}/hooks`
  const files = (await $.fs.list(dir))
    .map(f => f.name)
    .filter(n => /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) && n !== 'register.ts')
    .sort()
  const mods: Mod[] = []
  for (const file of files) {
    const commands = commandsIn(await $.fs.read(`${dir}/${file}`))
    mods.push({ name: file.replace(/\.tsx?$/, ''), ...(commands.length === 0 ? {} : { commands }), file: `hooks/${file}` })
  }
  return mods
}

const buildToolbox = async ($: EngineInterface): Promise<{ manifest: Manifest; path: string }> => {
  const home = await $.env.get('HOME')
  if (home === undefined || home === '') throw new Error('HOME is not set')
  const root = await $.session.root()
  const config = await readJson($, `${home}/.claude.json`)
  const settings = await readJson($, `${home}/.claude/settings.json`)
  const projectMcp = await readJson($, `${root}/.mcp.json`)
  const local = isRecord(config) && isRecord(config.projects) ? config.projects[root] : undefined
  const version = await $.session.version().then(
    v => v.version,
    () => undefined,
  )
  const manifest: Manifest = {
    generatedAt: new Date(await $.clock.now()).toISOString(),
    ...(version === undefined ? {} : { claudeCodeVersion: version }),
    skills: await toolboxSkills($, home),
    plugins: pluginEntries(
      await readJson($, `${home}/.claude/plugins/installed_plugins.json`),
      isRecord(settings) ? settings.enabledPlugins : undefined,
    ),
    mcpServers: [
      ...mcpEntries(isRecord(config) ? config.mcpServers : undefined, 'user'),
      ...mcpEntries(isRecord(projectMcp) ? projectMcp.mcpServers : undefined, 'project'),
      ...mcpEntries(isRecord(local) ? local.mcpServers : undefined, 'project'),
    ],
    mods: await toolboxMods($),
  }
  return { manifest, path: `${home}/ChaosToolbox/toolbox-manifest.json` }
}

// Temp file + rename, so the refresh never reads a half-written manifest.
const writeToolbox = async ($: EngineInterface): Promise<number> => {
  const { manifest, path } = await buildToolbox($)
  const tmp = `${path}.tmp`
  await $.fs.write(tmp, `${JSON.stringify(manifest, null, 2)}\n`)
  const moved = await $.process.run(['mv', '-f', tmp, path])
  if (moved.exitCode !== 0) throw new Error(`mv failed: ${moved.stderr.trim()}`)
  await $.store.set(SYNCED_KEY, await $.clock.now())
  return countItems(manifest)
}

// At most once per 6h; failures go to the debug log only.
const syncToolboxOnStart = async ($: EngineInterface): Promise<void> => {
  try {
    const last = await $.store.get(SYNCED_KEY)
    if (typeof last === 'number' && (await $.clock.now()) - last < DEBOUNCE_MS) return
    await writeToolbox($)
  } catch (err) {
    $.ui.log(`toolbox: manifest not written: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

const syncToolboxNow = async ($: EngineInterface): Promise<{ text?: string }> => {
  try {
    const n = await writeToolbox($)
    $.ui.toast(`Toolbox manifest updated · ${n} items`)
    return {}
  } catch (err) {
    return { text: `Couldn't write the toolbox manifest: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export const registerToolbox = (on: On): void => {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'toolbox-sync', description: "Write this machine's skills, plugins, MCPs and mods to ~/ChaosToolbox" })
    void syncToolboxOnStart($)
    return result
  })

  on('command.run', { command: 'toolbox-sync' }, async $ => syncToolboxNow($))
}
