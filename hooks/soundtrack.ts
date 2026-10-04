import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'

// #20 Patch soundtrack: focus music when a patch starts, a fade-out under the done chime.
// Drives the Spotify desktop app through AppleScript (macOS); the claude.ai Spotify connector
// has no playback control. Off until Nae runs /soundtrack on. Silent whenever Spotify isn't there.
// Built against Claude Code 2.1.289.

const START_TOOL = /__cp_start_patch$/
const COMPLETE_TOOL = /__cp_complete_patch$/

// Spotify's own Deep Focus.
export const DEFAULT_PLAYLIST = 'spotify:playlist:37i9dQZF1DWZeKCadgRdKQ'
// On or off, kept across sessions in the mod's own store.
export const SOUNDTRACK_KEY = 'soundtrack'
// patches-pane.tsx shares this, so a Done there fades music a Start here began, and back.
const soundtrackStarted = atom({ plugin: 'codynd', key: 'soundtrackStarted' } as const, false)

// A spotify: URI, or the open.spotify.com link "Share → Copy link" gives; anything else is refused.
export const playlistUri = (value: unknown): string => {
  if (typeof value !== 'string') return DEFAULT_PLAYLIST
  const trimmed = value.trim()
  if (/^spotify(?::[A-Za-z]+:[A-Za-z0-9]+)+$/.test(trimmed)) return trimmed
  const link = /^https:\/\/open\.spotify\.com\/(playlist|album|artist|track)\/([A-Za-z0-9]+)/.exec(trimmed)
  return link === null ? DEFAULT_PLAYLIST : `spotify:${link[1]}:${link[2]}`
}

// The playlist arrives as argv, never spliced into the script. Never launches Spotify:
// a closed app answers "closed". Already playing means Nae chose that music, so it's left alone.
// `play track` pulls Spotify's window to the front about 0.1s after it returns, so wait for
// that (up to 1.5s), then give the front back to whatever app had it.
export const START_SCRIPT = `on run argv
  if application "Spotify" is not running then return "closed"
  set frontApp to path to frontmost application as text
  tell application "Spotify"
    if player state is playing then return "busy"
    play track (item 1 of argv)
  end tell
  repeat 15 times
    if (path to frontmost application as text) ends with "Spotify.app:" then exit repeat
    delay 0.1
  end repeat
  tell application frontApp to activate
  return "started"
end run`

// About a second of fade, then pause and put the volume back for next time.
export const FADE_SCRIPT = `on run argv
  if application "Spotify" is not running then return "closed"
  tell application "Spotify"
    if player state is not playing then return "idle"
    set v to sound volume
    repeat with i from 1 to 10
      set sound volume to (v * (10 - i) div 10)
      delay 0.1
    end repeat
    pause
    set sound volume to v
    return "faded"
  end tell
end run`

export const parseSoundtrackArg = (args: string): 'on' | 'off' | 'status' | undefined => {
  const word = args.trim().toLowerCase()
  if (word === '') return 'status'
  return word === 'on' || word === 'off' ? word : undefined
}

const isOn = async ($: EngineInterface): Promise<boolean> => (await $.store.get(SOUNDTRACK_KEY)) === true

// osascript's answer, trimmed; undefined when it couldn't run at all.
const spotify = async ($: EngineInterface, script: string, args: string[]): Promise<string | undefined> => {
  try {
    const ran = await $.process.run(['osascript', '-e', script, ...args])
    if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `exit ${ran.exitCode}`)
    return ran.stdout.trim()
  } catch (err) {
    $.ui.log(`soundtrack: spotify unreachable: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return undefined
  }
}

const startMusic = async ($: EngineInterface, uri: string): Promise<void> => {
  try {
    if (!(await isOn($))) return
    const answer = await spotify($, START_SCRIPT, [uri])
    // Music Nae already had on stays hers: a later Done won't fade it.
    await update($, soundtrackStarted, () => answer === 'started')
  } catch (err) {
    $.ui.log(`soundtrack: start failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

// Runs alongside the chime, so the music ducks out under it rather than over it.
const fadeMusic = async ($: EngineInterface): Promise<void> => {
  try {
    if (!(await isOn($)) || !(await read($, soundtrackStarted))) return
    await update($, soundtrackStarted, () => false)
    await spotify($, FADE_SCRIPT, [])
  } catch (err) {
    $.ui.log(`soundtrack: fade failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

const soundtrack = async ($: EngineInterface, args: string): Promise<{ text: string }> => {
  const choice = parseSoundtrackArg(args)
  if (choice === undefined) return { text: 'Usage: /soundtrack on|off' }
  if (choice === 'status') return { text: `Soundtrack is ${(await isOn($)) ? 'on' : 'off'}. /soundtrack on|off` }
  try {
    await $.store.set(SOUNDTRACK_KEY, choice === 'on')
  } catch (err) {
    $.ui.log(`soundtrack: saving the toggle failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    return { text: "Couldn't save that setting." }
  }
  return {
    text: choice === 'on'
      ? '🎧 Soundtrack on: focus music when a patch starts (unless something is already playing).'
      : 'Soundtrack off.',
  }
}

export const registerSoundtrack = (on: On, options: PluginOptions): void => {
  const uri = playlistUri(options.soundtrackPlaylist)
  const fadeOnDone = options.soundtrackFadeOnDone !== false
  // Headless runs (claude -p, scheduled agents) never touch the music.
  const box = { isInteractive: false }

  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const result = await next(e)
    box.isInteractive = true
    await $.command
      .register({ name: 'soundtrack', description: 'Focus music when a patch starts: /soundtrack on|off', argumentHint: 'on|off', immediate: true })
      .catch((err: unknown) => $.ui.log(`soundtrack: /soundtrack not registered: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' }))
    return result
  })

  on('command.run', { command: 'soundtrack' }, async ($, e) => soundtrack($, e.args))

  // Detached: the tool result never waits on Spotify.
  on('tool.call', { tool: START_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (box.isInteractive && ran.deny === undefined && ran.isError !== true) void startMusic($, uri)
    return ran
  })

  on('tool.call', { tool: COMPLETE_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (box.isInteractive && fadeOnDone && ran.deny === undefined && ran.isError !== true) void fadeMusic($)
    return ran
  })
}