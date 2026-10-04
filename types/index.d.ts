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

export type BoardRow = { id: string; title: string }

// null while loading; `error` when ChaosPatch couldn't be reached.
export type Board = { inProgress: BoardRow[]; open: BoardRow[]; error?: string }

declare module 'claude-code' {
  interface PluginState {
    codynd: {
      reentryCard: ReentryCard | null
      reentryHidden: boolean
      board: Board | null
      // This repo's in-progress patches: the status line draws from it, /patches writes it too.
      activePatches: Patch[]
      // The non-patch work Cody named with set_focus (or Nae with /focus); shown when no patch is active.
      focus: string | null
      // The focus just replaced, offered once to /park; null when there's no offer showing.
      parkOffer: string | null
    }
  }
}
