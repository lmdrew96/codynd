import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { closedSince, formatAllWins, formatRepoWins, forRepo, type DonePatch } from './wins.ts'

// Local midnight on the evening of 2026-10-03 (New York) / morning of 2026-10-04 (Tokyo), from `date -v0H -v0M -v0S +%s`.
const NY_MIDNIGHT = 1791000000 * 1000 // 2026-10-03 00:00 -0400
const TOKYO_MIDNIGHT = 1791039600 * 1000 // 2026-10-04 00:00 +0900

const done = (title: string, completed_at: string | null, project_name = 'CodyND'): DonePatch => ({
  title,
  project_name,
  project_slug: project_name.toLowerCase().replace(/ /g, '-'),
  completed_at,
})

describe('the local day boundary', () => {
  const lateEvening = done('late evening', '2026-10-04T02:16:13Z') // 22:16 NY Oct 3 · 11:16 Tokyo Oct 4
  const morningNY = done('morning NY', '2026-10-03T14:00:00Z') // 10:00 NY Oct 3 · 23:00 Tokyo Oct 3
  const yesterdayNY = done('yesterday NY', '2026-10-03T03:59:00Z') // 23:59 NY Oct 2

  test('New York: a UTC-tomorrow close still counts as today', () => {
    expect(closedSince([lateEvening, morningNY, yesterdayNY], NY_MIDNIGHT).map(p => p.title)).toEqual([
      'late evening',
      'morning NY',
    ])
  })

  test('Tokyo: the same closes split differently', () => {
    expect(closedSince([lateEvening, morningNY, yesterdayNY], TOKYO_MIDNIGHT).map(p => p.title)).toEqual(['late evening'])
  })

  test('a patch closed exactly at midnight counts; one with no close time does not', () => {
    expect(closedSince([done('edge', '2026-10-03T04:00:00Z'), done('open', null)], NY_MIDNIGHT).map(p => p.title)).toEqual(['edge'])
  })
})

describe('helpers', () => {
  test("keeps only this repo's patches, by folder name", () => {
    const patches = [done('#7', 'x'), done('Archive mode', 'x', 'Chicken Scratch')]
    expect(forRepo(patches, '/x/ChickenScratch').map(p => p.title)).toEqual(['Archive mode'])
    expect(forRepo(patches, '/x/elsewhere')).toEqual([])
  })

  test('repo wins list patches and commits, and stay gentle when empty', () => {
    expect(formatRepoWins('codynd', [done('#7 Patch timer', 'x')], ['v0.6.0: add patch timer'])).toBe(
      '🏆 Today in codynd\nClosed (1)\n  ✓ #7 Patch timer\nCommits (1)\n  • v0.6.0: add patch timer',
    )
    expect(formatRepoWins('codynd', [], [])).toBe(
      "🏆 Today in codynd\nNothing closed yet today. Plenty of day left (or not, and that's fine too).",
    )
  })

  test('all-project wins group by project', () => {
    expect(formatAllWins([done('#7', 'x'), done('Archive mode', 'x', 'Chicken Scratch'), done('#11', 'x')])).toBe(
      '🏆 Today across all projects\nCodyND (2)\n  ✓ #7\n  ✓ #11\nChicken Scratch (1)\n  ✓ Archive mode',
    )
  })
})

// The host and ChaosPatch beneath the plugin: New York midnight, one commit, two patches closed today.
const world = (on: On, chaosPatchDown = false): Record<string, unknown>[] => {
  const calls: Record<string, unknown>[] = []
  mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x/codynd' }))
  on('process.run', (_$, e) => {
    const stdout = e.argv[0] === 'date' ? `${NY_MIDNIGHT / 1000}\n` : 'v0.7.1: document the new mods\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('mcp.call', (_$, e) => {
    calls.push({ tool: e.tool, ...e.args })
    if (chaosPatchDown) return { value: { content: [{ type: 'text', text: 'down' }], isError: true } }
    // cp_get_velocity filters on the server; '#1 old' checks the client-side guard too.
    const velocity = {
      completed_since: e.args.completed_since,
      count: 3,
      patches: [
        done('#11 /patches', '2026-10-04T03:22:49Z'),
        done('Archive mode', '2026-10-03T15:00:00Z', 'Chicken Scratch'),
        done('#1 old', '2026-09-30T12:00:00Z'),
      ],
    }
    const text = e.tool === 'cp_get_velocity' ? JSON.stringify(velocity) : '[]'
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__codynd__${e.name}` } }))
  for (const ev of ['ui.status', 'ui.log', 'ui.toast'] as const) on(ev, () => ({ value: undefined }))
  return calls
}

const run = async ($: Engine, args: string, command = 'wins'): Promise<string | undefined> => {
  await $.session.start({ cwd: '/x/codynd', surface: 'terminal', isInteractive: true })
  const result = await $.command.run({
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  return result.text
}

describe('/wins', () => {
  test("this repo: today's closed patches and commits", async ($, on) => {
    const calls = world(on)
    expect(await run($, '')).toBe(
      '🏆 Today in codynd\nClosed (1)\n  ✓ #11 /patches\nCommits (1)\n  • v0.7.1: document the new mods',
    )
    expect(calls).toContainEqual({ tool: 'cp_get_velocity', completed_since: '2026-10-03T04:00:00.000Z' })
  })

  test('/wins-all: patches across projects, grouped (and /wins all still works)', async ($, on) => {
    world(on)
    expect(await run($, 'all')).toBe(await run($, '', 'wins-all'))
    expect(await run($, '', 'wins-all')).toBe(
      '🏆 Today across all projects\nCodyND (1)\n  ✓ #11 /patches\nChicken Scratch (1)\n  ✓ Archive mode',
    )
  })

  test('ChaosPatch down: commits still show, with a note', async ($, on) => {
    world(on, true)
    expect(await run($, '')).toBe(
      "🏆 Today in codynd\nCommits (1)\n  • v0.7.1: document the new mods\n(Couldn't reach ChaosPatch, so closed patches are missing.)",
    )
  })
})
