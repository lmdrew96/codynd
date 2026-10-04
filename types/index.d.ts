export type ReentryCard = {
  lastCommit: { subject: string; when: string } | null
  next: { title: string; isInProgress: boolean } | null
}

declare module 'claude-code' {
  interface PluginState {
    codynd: { reentryCard: ReentryCard | null; reentryHidden: boolean }
  }
}
