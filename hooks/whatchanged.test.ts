import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { cleanSummary, filesLine, formatChanges, headsUp, NOTHING, parseNameStatus } from './whatchanged.ts'

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }

describe('helpers', () => {
  test('name-status rows: renames count as the new path, deletions are noted', () => {
    expect(parseNameStatus('M\thooks/a.ts\nR087\thooks/old.ts\thooks/new.ts\nD\thooks/gone.ts\n')).toEqual({
      files: ['hooks/a.ts', 'hooks/new.ts', 'hooks/gone.ts'],
      deleted: ['hooks/gone.ts'],
    })
  })

  test('heads-up names deps, config, auth, database and deletions; ordinary files stay quiet', () => {
    expect(
      headsUp({
        files: ['package.json', 'wrangler.jsonc', 'lib/auth.ts', 'drizzle/0003_add.sql', 'hooks/session-clock.ts', 'old.ts'],
        deleted: ['old.ts'],
        commits: [],
      }),
    ).toBe('⚠️ Heads up: dependencies (package.json); config (wrangler.jsonc); auth (auth.ts); database (0003_add.sql); 1 deletion (old.ts)')
    expect(headsUp({ files: ['hooks/wins.ts', 'README.md'], deleted: [], commits: [] })).toBeNull()
  })

  test('files line caps the names', () => {
    expect(filesLine(['a', 'b'])).toBe('Files (2): a, b')
    expect(filesLine(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])).toBe('Files (10): 1, 2, 3, 4, 5, 6, 7, 8, +2 more')
  })

  test('summary: at most three plain lines; nothing changed is a friendly line', () => {
    expect(cleanSummary('One.\n```ts\ncode\n```\nTwo.\n\nThree.\nFour.')).toBe('One.\nTwo.\nThree.')
    expect(formatChanges('Adds X.', { files: [], deleted: [], commits: [] })).toBe(NOTHING)
    expect(formatChanges(undefined, { files: ['a.ts'], deleted: [], commits: [] })).toBe(
      "(Couldn't get a summary this time; here's what git sees.)\nFiles (1): a.ts",
    )
  })
})

type Seen = { prompts: string[]; repo: { isChanged: boolean } }

// A repo that started at abc123 with .idea untracked; once `isChanged`, one commit, an edit, a deletion and a new file.
const world = (on: On, fork: { isAnswered: boolean; text?: string; reason?: string }): Seen => {
  const seen: Seen = { prompts: [], repo: { isChanged: false } }
  mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x/codynd' }))
  on('process.run', (_$, e) => {
    const [cmd, sub, arg] = e.argv
    let stdout = ''
    if (cmd === 'git' && sub === 'rev-parse') stdout = 'abc123\n'
    else if (cmd === 'git' && sub === 'ls-files') stdout = seen.repo.isChanged ? '.idea/x.iml\nhooks/whatchanged.ts\n' : '.idea/x.iml\n'
    else if (cmd === 'git' && sub === 'diff' && arg === '--name-status')
      stdout = seen.repo.isChanged ? 'M\thooks/register.ts\nM\tpackage.json\nD\thooks/old.ts\n' : ''
    else if (cmd === 'git' && sub === 'log' && arg === '--format=%s') stdout = seen.repo.isChanged ? 'v0.23.0: add /whatchanged\n' : ''
    else if (cmd === 'git' && sub === 'diff') stdout = '+registerWhatChanged(on)\n'
    else if (cmd === 'date') stdout = '1791000000\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '[]' }], isError: false } }))
  on('model.fork', (_$, e) => {
    seen.prompts.push(e.prompt)
    return { value: { ...fork, usage: USAGE } as never }
  })
  on('model.complete', (_$, e) => {
    seen.prompts.push(`haiku:${e.prompt}`)
    return { value: { isAnswered: true, text: 'From Haiku.', usage: USAGE } as never }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__codynd__${e.name}` } }))
  for (const ev of ['ui.status', 'ui.log', 'ui.toast'] as const) on(ev, () => ({ value: undefined }))
  return seen
}

const start = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: '/x/codynd', surface: 'terminal', isInteractive: true })
}

const run = async ($: Engine, args = ''): Promise<string | undefined> => {
  const result = await $.command.run({
    command: 'whatchanged',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  return result.text
}

describe('/whatchanged', () => {
  test('nothing changed yet: a friendly line, no model call', async ($, on) => {
    const seen = world(on, { isAnswered: true, text: 'unused' })
    await start($)
    expect(await run($)).toBe(NOTHING)
    expect(seen.prompts).toEqual([])
  })

  test("summary, then files (new untracked ones, not the session's old ones), then the heads-up", async ($, on) => {
    const seen = world(on, { isAnswered: true, text: '/whatchanged now explains a session in plain words.' })
    await start($)
    seen.repo.isChanged = true
    expect(await run($)).toBe(
      [
        '/whatchanged now explains a session in plain words.',
        'Files (4): hooks/register.ts, package.json, hooks/old.ts, hooks/whatchanged.ts',
        '⚠️ Heads up: dependencies (package.json); 1 deletion (old.ts)',
      ].join('\n'),
    )
    expect(seen.prompts[0]).toContain('Commits this session: v0.23.0: add /whatchanged')
    expect(seen.prompts[0]).not.toContain('Only describe')
  })

  test('a named patch scopes the summary; a brand-new session falls back to Haiku', async ($, on) => {
    const seen = world(on, { isAnswered: false, reason: 'nothing-to-fork' })
    await start($)
    seen.repo.isChanged = true
    expect((await run($, 'error decoder'))?.split('\n')[0]).toBe('From Haiku.')
    expect(seen.prompts[1]).toMatch(/^haiku:.*Only describe the work for this patch: error decoder\./s)
  })
})