import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { commandsIn, hostOf, mcpEntries, parseFrontmatter, pluginEntries, type Manifest } from './toolbox.ts'

const HOUR = 60 * 60 * 1000

describe('helpers', () => {
  test('frontmatter: plain, quoted and folded descriptions; no frontmatter is empty', () => {
    expect(parseFrontmatter('---\nname: ship\ndescription: Ship it.\n---\nbody')).toEqual({ name: 'ship', description: 'Ship it.' })
    expect(parseFrontmatter('---\nname: "theme"\ndescription: "Brand colors."\n---')).toEqual({ name: 'theme', description: 'Brand colors.' })
    expect(parseFrontmatter('---\nname: x\ndescription: >-\n  One line,\n  and another.\nlicense: MIT\n---')).toEqual({
      name: 'x',
      description: 'One line, and another.',
    })
    expect(parseFrontmatter('# just a heading')).toEqual({})
  })

  test('MCP servers: host only, never env, headers, tokens or query strings', () => {
    const servers = {
      tangle: { type: 'http', url: 'https://user:pw@tangle.adhdesigns.dev:443/mcp?token=SECRET', headers: { Authorization: 'Bearer SECRET' } },
      local: { command: 'node', args: ['--key', 'SECRET'], env: { API_KEY: 'SECRET' } },
      events: { type: 'sse', url: 'http://localhost:3000/sse' },
    }
    const entries = mcpEntries(servers, 'user')
    expect(entries).toEqual([
      { name: 'tangle', type: 'http', scope: 'user', host: 'tangle.adhdesigns.dev' },
      { name: 'local', type: 'stdio', scope: 'user' },
      { name: 'events', type: 'sse', scope: 'user', host: 'localhost' },
    ])
    expect(JSON.stringify(entries)).not.toContain('SECRET')
    expect(hostOf('not a url')).toBeUndefined()
    expect(mcpEntries(undefined, 'project')).toEqual([])
  })

  test('plugins: installed and enabled merged, sorted', () => {
    expect(
      pluginEntries(
        { version: 2, plugins: { 'b@m': [{ version: '1.2.0', installPath: '/x' }], 'a@m': [{ version: '0.1.0' }] } },
        { 'a@m': true, 'b@m': false, 'c@inline': true },
      ),
    ).toEqual([
      { name: 'a@m', version: '0.1.0', enabled: true },
      { name: 'b@m', version: '1.2.0', enabled: false },
      { name: 'c@inline', enabled: true },
    ])
  })

  test('commands registered in a hooks file, across both call styles', () => {
    const source = `await $.command.register({ name: 'wins', description: 'x' })\n$.command\n  .register({ name: 'soundtrack' })\nawait $.command.register({\n  name: 'patch',\n})`
    expect(commandsIn(source)).toEqual(['wins', 'soundtrack', 'patch'])
  })
})

const FILES: Record<string, string> = {
  '/home/nae/.claude/skills/ship/SKILL.md': '---\nname: ship\ndescription: Ship it.\n---\n',
  '/home/nae/.claude.json': JSON.stringify({
    mcpServers: { tangle: { type: 'http', url: 'https://tangle.adhdesigns.dev/mcp' } },
    projects: { '/x/codynd': { mcpServers: { scratch: { command: 'npx' } } } },
  }),
  '/home/nae/.claude/settings.json': JSON.stringify({ enabledPlugins: { 'upstash@upstash': true }, env: { SECRET: 'no' } }),
  '/home/nae/.claude/plugins/installed_plugins.json': JSON.stringify({ plugins: { 'upstash@upstash': [{ version: '1.0.0' }] } }),
}

type Seen = { written: Record<string, string>; moves: string[][]; toasts: string[]; logs: string[]; store: Record<string, unknown>; failWrite: boolean }

const world = (on: On, now: number): Seen => {
  const seen: Seen = { written: {}, moves: [], toasts: [], logs: [], store: {}, failWrite: false }
  mock.clock(on, { now })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x/codynd' }))
  on('session.root', () => ({ value: '/x/codynd' }))
  on('session.version', () => ({ value: { version: '2.1.289' } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/nae' : undefined }))
  on('store.get', (_$, e) => ({ value: seen.store[e.key] }))
  on('store.set', (_$, e) => {
    seen.store[e.key] = e.value
    return { value: undefined }
  })
  on('fs.list', (_$, e) => {
    const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })
    if (e.path === '/home/nae/.claude/skills') return { value: [entry('ship', 'dir'), entry('synced', 'dir'), entry('.DS_Store', 'file')] }
    if (e.path.endsWith('/hooks')) return { value: [entry('wins.ts', 'file'), entry('wins.test.ts', 'file'), entry('register.ts', 'file'), entry('focus.tsx', 'file')] }
    return { deny: 'ENOENT' }
  })
  on('fs.read', (_$, e) => {
    if (e.path.endsWith('/hooks/wins.ts')) return { value: "$.command.register({ name: 'wins' })\n$.command.register({ name: 'wins-all' })" }
    if (e.path.endsWith('/hooks/focus.tsx')) return { value: "$.tool.register({ name: 'set_focus' })" }
    const text = FILES[e.path]
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.write', (_$, e) => {
    if (seen.failWrite) return { deny: 'EACCES' }
    seen.written[e.path] = e.text
    return { value: undefined }
  })
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__codynd__${e.name}` } }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '[]' }], isError: false } }))
  // Other CodyND hooks run git here too; only the manifest's mv is recorded and carried out.
  on('process.run', (_$, e) => {
    if (e.argv[0] !== 'mv') return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    seen.moves.push([...e.argv])
    const [, , from = '', to = ''] = e.argv
    seen.written[to] = seen.written[from] ?? ''
    delete seen.written[from]
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  return seen
}

const OUT = '/home/nae/ChaosToolbox/toolbox-manifest.json'
const NOW = Date.parse('2026-10-04T19:00:00Z')

const start = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: '/x/codynd', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 300; i++) await Promise.resolve()
}

const sync = async ($: Engine): Promise<string | undefined> =>
  (await $.command.run({ command: 'toolbox-sync', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })).text

describe('toolbox manifest', () => {
  test('session start writes the manifest via temp file + mv, with no secrets', async ($, on) => {
    const seen = world(on, NOW)
    await start($)
    expect(seen.moves).toEqual([['mv', '-f', `${OUT}.tmp`, OUT]])
    const manifest = JSON.parse(seen.written[OUT] ?? '{}') as Manifest
    expect(manifest).toEqual({
      generatedAt: '2026-10-04T19:00:00.000Z',
      claudeCodeVersion: '2.1.289',
      skills: [{ name: 'ship', description: 'Ship it.', path: '/home/nae/.claude/skills/ship/SKILL.md' }],
      plugins: [{ name: 'upstash@upstash', version: '1.0.0', enabled: true }],
      mcpServers: [
        { name: 'tangle', type: 'http', scope: 'user', host: 'tangle.adhdesigns.dev' },
        { name: 'scratch', type: 'stdio', scope: 'project' },
      ],
      mods: [
        { name: 'focus', file: 'hooks/focus.tsx' },
        { name: 'wins', commands: ['wins', 'wins-all'], file: 'hooks/wins.ts' },
      ],
    })
    expect(seen.written[OUT]).not.toContain('SECRET')
    expect(seen.toasts).toEqual([])
  })

  test('session start skips within 6h of the last write; /toolbox-sync always writes and toasts', async ($, on) => {
    const seen = world(on, NOW)
    seen.store.toolboxSyncedAt = NOW - 2 * HOUR
    await start($)
    expect(seen.moves).toEqual([])
    expect(await sync($)).toBeUndefined()
    expect(seen.moves).toHaveLength(1)
    expect(seen.toasts).toEqual(['Toolbox manifest updated · 6 items'])
    expect(seen.store.toolboxSyncedAt).toBe(NOW)
  })

  test('a failed write is quiet at session start and reported by /toolbox-sync', async ($, on) => {
    const seen = world(on, NOW)
    seen.failWrite = true
    await start($)
    expect(seen.toasts).toEqual([])
    expect(seen.logs.some(l => l.startsWith('toolbox: manifest not written:') && l.includes('EACCES'))).toBe(true)
    expect(await sync($)).toMatch(/^Couldn't write the toolbox manifest: .*EACCES$/)
    expect(seen.toasts).toEqual([])
  })
})
