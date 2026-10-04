import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions } from 'claude-code'
import type { NextEvent } from '../types'
import { truncate } from './patch-status.ts'

// Next-event countdown: the next ControlledChaos event in the status line, so time stays visible
// during hyperfocus. Visibility only: one heads-up at 15 minutes (a toast and a cabin "bing-bong"),
// never a repeat.
// Built against Claude Code 2.1.289.

const DEFAULT_SERVER = 'claude.ai ControlledChaos'
const REFRESH_MS = 5 * 60_000
const TICK_MS = 60_000
export const WINDOW_MS = 3 * 60 * 60_000
export const SOON_MS = 15 * 60_000
// An airline cabin chime, to go with "Start landing the plane"; unlike the done chimes and the yoo-hoo.
export const LANDING_CHIME = 'sounds/landing.wav'

const nextEvent = atom({ plugin: 'codynd', key: 'nextEvent' } as const, null)

// cc_list_calendar prints times in Nae's timezone with its abbreviation; these are the US zones.
const ZONE_OFFSET_H: Record<string, number> = {
  UTC: 0, GMT: 0, EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7, AKST: -9, AKDT: -8, HST: -10,
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "Mon, Oct 5, 2026, 10:20 AM EDT" → ms. Undefined for anything else, so an odd line is skipped, not misplaced.
export const parseCalendarTime = (text: string): number | undefined => {
  const m = /^\w{3}, (\w{3}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) (AM|PM) ([A-Z]{2,4})$/.exec(text.trim())
  if (m === null) return undefined
  const [, mon, day, year, hour, minute, half, zone] = m as unknown as [string, string, string, string, string, string, string, string]
  const month = MONTHS.indexOf(mon)
  const offset = ZONE_OFFSET_H[zone]
  if (month === -1 || offset === undefined) return undefined
  const h = (Number(hour) % 12) + (half === 'PM' ? 12 : 0)
  return Date.UTC(Number(year), month, Number(day), h, Number(minute)) - offset * 3_600_000
}

// The soonest timed event still ahead. All-day and tentative events don't count: no "in 40m" for
// an all-day one, and a tentative one's time is free. Planned work blocks aren't requested.
export const parseNextEvent = (markdown: string, now: number): NextEvent | null => {
  const events = markdown.split('## Planned Work')[0] ?? ''
  let soonest: NextEvent | null = null
  for (const block of events.split(/^### /m).slice(1)) {
    if (/^All day event$/m.test(block) || /^Commitment: TENTATIVE/m.test(block)) continue
    const title = /^\d+\. \*\*(.+?)\*\*/.exec(block)?.[1]
    const id = /^ID: `([^`]+)`/m.exec(block)?.[1]
    const start = /^Start: (.+)$/m.exec(block)?.[1]
    const startsAt = start === undefined ? undefined : parseCalendarTime(start)
    if (title === undefined || id === undefined || startsAt === undefined || startsAt <= now) continue
    if (soonest === null || startsAt < soonest.startsAt) {
      soonest = { id, title, startsAt, category: /^Category: (\w+)/m.exec(block)?.[1] ?? null }
    }
  }
  return soonest
}

export const landingToast = (event: NextEvent, minutes: number): string =>
  `🛬 ${truncate(event.title, 40)} in ${minutes}m. Start landing the plane.`

// Unreachable or odd output: no segment, a debug log line, nothing on screen. Writing nextEvent
// redraws the line (patch-status.ts's state.set hook).
const refresh = async ($: EngineInterface, server: string): Promise<void> => {
  try {
    const now = await $.clock.now()
    const result = await $.mcp.call(server, 'cc_list_calendar', {
      start_date: new Date(now).toISOString(),
      end_date: new Date(now + WINDOW_MS).toISOString(),
      include_planned: false,
    })
    if (result.isError) throw new Error(result.content.map(b => b.text ?? '').join(' '))
    const event = parseNextEvent(result.content.map(b => b.text ?? '').join(''), now)
    await update($, nextEvent, () => event)
  } catch (err) {
    $.ui.log(`next-event: refresh failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    await update($, nextEvent, () => null).catch(() => undefined)
  }
}

// Detached: the heads-up never waits on the sound.
const playLanding = async ($: EngineInterface): Promise<void> => {
  try {
    await $.audio.play({ asset: LANDING_CHIME })
  } catch (err) {
    $.ui.log(`next-event: sound failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

// One heads-up per event, the first tick it's within 15 minutes.
const checkSoon = async ($: EngineInterface, warned: Set<string>, withSound: boolean): Promise<void> => {
  try {
    const event = await read($, nextEvent)
    if (event === null || warned.has(event.id)) return
    const left = event.startsAt - (await $.clock.now())
    if (left <= 0 || left > SOON_MS) return
    warned.add(event.id)
    $.ui.toast(landingToast(event, Math.ceil(left / 60_000)), { timeoutMs: 10_000 })
    if (withSound) void playLanding($)
  } catch (err) {
    $.ui.log(`next-event: heads-up failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

export const registerNextEvent = (on: On, options: PluginOptions): void => {
  const server = typeof options.controlledChaosServer === 'string' ? options.controlledChaosServer : DEFAULT_SERVER
  const warned = new Set<string>()
  const withSound = options.landingChimeSound !== false

  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const result = await next(e)
    void refresh($, server)
    $.clock.every(REFRESH_MS, () => void refresh($, server))
    // Minutes tick locally (patch-status.ts redraws the line each minute); this only watches for 15m.
    $.clock.every(TICK_MS, () => void checkSoon($, warned, withSound))
    return result
  })
}
