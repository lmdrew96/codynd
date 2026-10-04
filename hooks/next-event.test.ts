import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { LANDING_CHIME, landingToast, parseCalendarTime, parseNextEvent } from './next-event.ts'
import { eventSegment, statusLine } from './patch-status.ts'

// Shaped like real cc_list_calendar output: an all-day event, a timed one, a tentative one, planned work.
const CALENDAR = `## Calendar Events (4 found)

### 1. **Flea comb Nugget + log count**
ID: \`a1\`
Source: controlledchaos
Start: Mon, Oct 5, 2026, 12:00 AM EDT
End: Tue, Oct 6, 2026, 12:00 AM EDT
Category: personal
All day event

---

### 2. **LATN 101 - Elementary Latin I**
ID: \`a2\`
Source: controlledchaos
Start: Mon, Oct 5, 2026, 1:50 PM EDT
End: Mon, Oct 5, 2026, 2:45 PM EDT
Category: school

---

### 3. **CGSC 451 (sit-in)**
ID: \`a3\`
Start: Mon, Oct 5, 2026, 1:20 PM EDT
Category: school
Commitment: TENTATIVE (the user might go; the time counts as free)

---

### 4. **Office Hours**
ID: \`a4\`
Start: Mon, Oct 5, 2026, 11:20 AM EDT
Category: school

## Planned Work (1 found)
- **Latin drills** — Mon, Oct 5, 2026, 1:00 PM EDT (15 min)
`

// 1:50 PM EDT = 17:50 UTC.
const LATIN = Date.UTC(2026, 9, 5, 17, 50)
const MIN = 60_000

describe('helpers', () => {
  test('reads the calendar time in its own zone', () => {
    expect(parseCalendarTime('Mon, Oct 5, 2026, 1:50 PM EDT')).toBe(LATIN)
    expect(parseCalendarTime('Mon, Oct 5, 2026, 12:00 AM EDT')).toBe(Date.UTC(2026, 9, 5, 4, 0))
    expect(parseCalendarTime('Mon, Oct 5, 2026, 12:30 PM EDT')).toBe(Date.UTC(2026, 9, 5, 16, 30))
    expect(parseCalendarTime('Tue, Jan 5, 2027, 9:05 AM PST')).toBe(Date.UTC(2027, 0, 5, 17, 5))
    expect(parseCalendarTime('Mon, Oct 5, 2026, 1:50 PM XYZ')).toBeUndefined()
    expect(parseCalendarTime('tomorrow-ish')).toBeUndefined()
  })

  test('next event: timed, committed and still ahead; planned work never counts', () => {
    // 12:00 EDT: office hours (11:20) has passed, the tentative sit-in is skipped, Latin is next.
    const noon = Date.UTC(2026, 9, 5, 16, 0)
    expect(parseNextEvent(CALENDAR, noon)).toEqual({ id: 'a2', title: 'LATN 101 - Elementary Latin I', startsAt: LATIN, category: 'school' })
    expect(parseNextEvent(CALENDAR, LATIN)).toBeNull()
    expect(parseNextEvent('## Calendar Events (0 found)', noon)).toBeNull()
    expect(parseNextEvent('[]', noon)).toBeNull()
  })

  test('the segment counts down, goes 🟠 at 15m, and hides outside the window', () => {
    const latin = { id: 'a2', title: 'Latin', startsAt: LATIN, category: 'school' }
    expect(eventSegment(latin, LATIN - 40 * MIN)).toBe('📚 Latin in 40m')
    expect(eventSegment(latin, LATIN - 39.5 * MIN)).toBe('📚 Latin in 40m')
    expect(eventSegment(latin, LATIN - 85 * MIN)).toBe('📚 Latin in 1h 25m')
    expect(eventSegment(latin, LATIN - 15 * MIN)).toBe('🟠 Latin in 15m')
    expect(eventSegment({ ...latin, category: null }, LATIN - 40 * MIN)).toBe('📅 Latin in 40m')
    expect(eventSegment(latin, LATIN)).toBeUndefined()
    expect(eventSegment(latin, LATIN - 4 * 60 * MIN)).toBeUndefined()
  })

  test('it rides alongside the patch or focus, never replacing them', () => {
    const latin = { id: 'a2', title: 'Latin', startsAt: LATIN, category: 'school' }
    const now = LATIN - 40 * MIN
    expect(statusLine({ patches: [], focus: 'Side quest', now, event: latin })).toBe('📚 Latin in 40m │ 🎯 Side quest')
    expect(statusLine({ patches: [], focus: null, now, event: latin })).toBe('📚 Latin in 40m')
    expect(statusLine({ patches: [], focus: 'Side quest', now, event: null })).toBe('🎯 Side quest')
    expect(landingToast(latin, 15)).toBe('🛬 Latin in 15m. Start landing the plane.')
  })
})

type Seen = { statuses: (string | undefined)[]; toasts: string[]; sounds: string[]; calls: Record<string, unknown>[] }

// ControlledChaos answers with the calendar above, or errors; ChaosPatch has nothing in progress.
const world = (on: On, calendar: { text: string; isError: boolean }): Seen => {
  const seen: Seen = { statuses: [], toasts: [], sounds: [], calls: [] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/x/codynd' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('mcp.call', (_$, e) => {
    if (e.tool !== 'cc_list_calendar') return { value: { content: [{ type: 'text', text: '[]' }], isError: false } }
    seen.calls.push(e.args)
    return { value: { content: [{ type: 'text', text: calendar.text }], isError: calendar.isError } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__codynd__${e.name}` } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', (_$, e) => {
    if (e.clip.asset !== undefined) seen.sounds.push(e.clip.asset)
    return { value: undefined }
  })
  return seen
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

const start = async ($: Engine): Promise<void> => {
  await $.session.start({ cwd: '/x/codynd', surface: 'terminal', isInteractive: true })
  await settle()
}

describe('next-event countdown', () => {
  test('shows the countdown, ticks it, and gives one heads-up at 15m', async ($, on) => {
    const clock = mock.clock(on, { now: LATIN - 40 * MIN })
    const seen = world(on, { text: CALENDAR, isError: false })
    await start($)
    expect(seen.calls[0]).toMatchObject({ include_planned: false })
    expect(seen.statuses.at(-1)).toBe('📚 LATN 101 - Elementary Latin I in 40m │ ⏱ <1m in')
    await clock.advance(25 * MIN)
    await settle()
    // 25 minutes without a prompt is a break, so the stretch has stepped aside.
    expect(seen.statuses.at(-1)).toBe('🟠 LATN 101 - Elementary Latin I in 15m')
    await clock.advance(5 * MIN)
    await settle()
    expect(seen.toasts.filter(t => t.startsWith('🛬'))).toEqual(['🛬 LATN 101 - Elementary Latin I in 15m. Start landing the plane.'])
    // The cabin chime rings with it, once.
    expect(seen.sounds).toEqual([LANDING_CHIME])
    await clock.advance(5 * MIN)
    await settle()
    expect(seen.sounds).toEqual([LANDING_CHIME])
  })

  test('landing chime turned off: the toast alone', { options: { landingChimeSound: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: LATIN - 16 * MIN })
    const seen = world(on, { text: CALENDAR, isError: false })
    await start($)
    await clock.advance(2 * MIN)
    await settle()
    expect(seen.toasts.filter(t => t.startsWith('🛬'))).toHaveLength(1)
    expect(seen.sounds).toEqual([])
  })

  test('ControlledChaos unreachable: no segment, nothing on screen', async ($, on) => {
    mock.clock(on, { now: LATIN - 40 * MIN })
    const seen = world(on, { text: 'down', isError: true })
    await start($)
    expect(seen.statuses.every(s => s === undefined || s === '⏱ <1m in')).toBe(true)
    expect(seen.toasts).toEqual([])
  })
})
