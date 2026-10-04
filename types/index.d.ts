export type ReentryCard = {
  // From /wrap last session: the note and when it was saved (ms).
  leftOff: { note: string; savedAt: number } | null
  lastCommit: { subject: string; when: string } | null
  next: { title: string; isInProgress: boolean } | null
}

// An in-progress ChaosPatch patch, as cp_list_all_patches returns it.
export type Patch = {
  title: string
  project_slug: string
  project_name: string
  started_at: string | null
}

// The last done celebration's picks: indexes into the chime and toast-opener pools.
export type Celebration = { sound: number; opener: number }

// The next timed ControlledChaos event within 3h, for the status-line countdown (startsAt in ms).
export type NextEvent = { id: string; title: string; startsAt: number; category: string | null }

// The session clock's current stretch of work (ms), for the always-on status line.
export type WorkStretch = { start: number; lastActive: number }

export type BoardRow = { id: string; title: string }

// A /fried row: a low-energy patch from any project; isHere when it belongs to this repo.
export type FriedRow = BoardRow & { project: string; isHere: boolean }

// /fried's pane, like Board: null while loading.
export type FriedBoard = { rows: FriedRow[]; error?: string }

// null while loading; `error` when ChaosPatch couldn't be reached.
export type Board = { inProgress: BoardRow[]; open: BoardRow[]; error?: string }

declare module 'claude-code' {
  interface PluginState {
    codynd: {
      reentryCard: ReentryCard | null
      reentryHidden: boolean
      board: Board | null
      friedBoard: FriedBoard | null
      // This repo's in-progress patches: the status line draws from it, /patches writes it too.
      activePatches: Patch[]
      // The non-patch work Cody named with set_focus (or Nae with /focus); shown when no patch is active.
      focus: string | null
      // The focus just replaced, offered once to /park; null when there's no offer showing.
      parkOffer: string | null
      // So the next win sounds and reads different; null until the session's first.
      lastCelebration: Celebration | null
      // Whether the session's latest test command failed; null until one runs (for the stopping point).
      lastTestFailed: boolean | null
      // Cached every 5 minutes; the countdown ticks from it locally.
      nextEvent: NextEvent | null
      // Written by session-clock.ts; null outside an interactive session.
      workStretch: WorkStretch | null
    }
  }
}
