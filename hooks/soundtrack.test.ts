import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { DEFAULT_PLAYLIST, FADE_SCRIPT, SOUNDTRACK_KEY, START_SCRIPT, parseSoundtrackArg, playlistUri } from './soundtrack.ts'

const CWD = '/x/codynd'

describe('helpers', () => {
  test('takes a spotify: URI or a share link; anything else is the default', () => {
    expect(playlistUri('spotify:playlist:abc123')).toBe('spotify:playlist:abc123')
    expect(playlistUri(' https://open.spotify.com/playlist/abc123?si=xyz ')).toBe('spotify:playlist:abc123')
    expect(playlistUri('spotify:playlist:abc" & do shell script "x')).toBe(DEFAULT_PLAYLIST)
    expect(playlistUri('')).toBe(DEFAULT_PLAYLIST)
    expect(playlistUri(undefined)).toBe(DEFAULT_PLAYLIST)
  })

  test('/soundtrack reads on, off, or bare for status', () => {
    expect(parseSoundtrackArg(' ON ')).toBe('on')
    expect(parseSoundtrackArg('off')).toBe('off')
    expect(parseSoundtrackArg('')).toBe('status')
    expect(parseSoundtrackArg('loud')).toBeUndefined()
  })
})

// Spotify answers each script as `spotify` says; every osascript call is recorded.
type Spotify = { start: string; fade: string; exitCode: number }
type Seen = { scripts: string[][] }

const world = (on: On, spotify: Spotify, store: Record<string, unknown> = {}): Seen => {
  const seen: Seen = { scripts: [] }
  mock.clock(on)
  on('store.get', (_$, e) => ({ value: store[e.key] }))
  on('store.set', (_$, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('process.run', (_$, e) => {
    const isSpotify = e.argv[0] === 'osascript'
    if (isSpotify) seen.scripts.push([...e.argv])
    const answer = e.argv[2] === START_SCRIPT ? spotify.start : spotify.fade
    return {
      value: {
        exitCode: isSpotify ? spotify.exitCode : 0,
        stdout: isSpotify ? `${answer}\n` : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '[]' }], isError: false } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__codynd__${e.name}` } }))
  on('tool.call', () => ({ result: JSON.stringify({ title: '#20 Soundtrack' }) }))
  for (const ev of ['ui.status', 'ui.log', 'ui.toast', 'audio.play'] as const) on(ev, () => ({ value: undefined }))
  return seen
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

const start = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await settle()
}

const run = async ($: Engine, args: string): Promise<string | undefined> =>
  (await $.command.run({ command: 'soundtrack', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })).text

// Loosely typed: tsc gives up expanding every connected MCP tool's input types here.
const patchTool = async ($: Engine, tool: 'cp_start_patch' | 'cp_complete_patch'): Promise<void> => {
  const callTool = $.tool.call as unknown as (input: { tool: string; patch_id: string }) => Promise<unknown>
  await callTool({ tool: `mcp__claude_ai_ChaosPatch__${tool}`, patch_id: 'x' })
  await settle()
}

const scriptsRun = (seen: Seen): string[] => seen.scripts.map(argv => (argv[2] === START_SCRIPT ? 'start' : argv[2] === FADE_SCRIPT ? 'fade' : '?'))

describe('/soundtrack', () => {
  test('off by default, and the toggle is kept in the store', async ($, on) => {
    const store: Record<string, unknown> = {}
    world(on, { start: 'started', fade: 'faded', exitCode: 0 }, store)
    await start($)
    expect(await run($, '')).toBe('Soundtrack is off. /soundtrack on|off')
    expect(await run($, 'on')).toContain('Soundtrack on')
    expect(store[SOUNDTRACK_KEY]).toBe(true)
    expect(await run($, 'off')).toBe('Soundtrack off.')
    expect(store[SOUNDTRACK_KEY]).toBe(false)
    expect(await run($, 'loud')).toBe('Usage: /soundtrack on|off')
  })

  test('off: patches start and finish without touching Spotify', async ($, on) => {
    const seen = world(on, { start: 'started', fade: 'faded', exitCode: 0 })
    await start($)
    await patchTool($, 'cp_start_patch')
    await patchTool($, 'cp_complete_patch')
    expect(seen.scripts).toEqual([])
  })

  test('on: a start plays the playlist, and done fades what it started', async ($, on) => {
    const seen = world(on, { start: 'started', fade: 'faded', exitCode: 0 }, { [SOUNDTRACK_KEY]: true })
    await start($)
    await patchTool($, 'cp_start_patch')
    expect(seen.scripts[0]).toEqual(['osascript', '-e', START_SCRIPT, DEFAULT_PLAYLIST])
    await patchTool($, 'cp_complete_patch')
    expect(scriptsRun(seen)).toEqual(['start', 'fade'])
    // Faded once: a second done has nothing of ours to fade.
    await patchTool($, 'cp_complete_patch')
    expect(scriptsRun(seen)).toEqual(['start', 'fade'])
  })

  test("music Nae already had on is hers: done doesn't fade it", async ($, on) => {
    const seen = world(on, { start: 'busy', fade: 'faded', exitCode: 0 }, { [SOUNDTRACK_KEY]: true })
    await start($)
    await patchTool($, 'cp_start_patch')
    await patchTool($, 'cp_complete_patch')
    expect(scriptsRun(seen)).toEqual(['start'])
  })

  test('the configured playlist is what plays', { options: { soundtrackPlaylist: 'https://open.spotify.com/playlist/mine42' } }, async ($, on) => {
    const seen = world(on, { start: 'started', fade: 'faded', exitCode: 0 }, { [SOUNDTRACK_KEY]: true })
    await start($)
    await patchTool($, 'cp_start_patch')
    expect(seen.scripts[0]?.[3]).toBe('spotify:playlist:mine42')
  })

  test('fade turned off: done leaves the music playing', { options: { soundtrackFadeOnDone: false } }, async ($, on) => {
    const seen = world(on, { start: 'started', fade: 'faded', exitCode: 0 }, { [SOUNDTRACK_KEY]: true })
    await start($)
    await patchTool($, 'cp_start_patch')
    await patchTool($, 'cp_complete_patch')
    expect(scriptsRun(seen)).toEqual(['start'])
  })

  test("Spotify unreachable: the patch still starts, quietly", async ($, on) => {
    const seen = world(on, { start: '', fade: '', exitCode: 1 }, { [SOUNDTRACK_KEY]: true })
    await start($)
    await patchTool($, 'cp_start_patch')
    await patchTool($, 'cp_complete_patch')
    expect(scriptsRun(seen)).toEqual(['start'])
  })

  test('headless runs never touch the music', async ($, on) => {
    const seen = world(on, { start: 'started', fade: 'faded', exitCode: 0 }, { [SOUNDTRACK_KEY]: true })
    await patchTool($, 'cp_start_patch')
    expect(seen.scripts).toEqual([])
  })
})
