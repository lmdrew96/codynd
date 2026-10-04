import type { Register } from 'claude-code'
import { registerDoneChime } from './done-chime.ts'
import { registerPark } from './park.ts'
import { registerPatchStatus } from './patch-status.ts'
import { registerPatchesPane } from './patches-pane.tsx'
import { registerQuickPatch } from './quick-patch.ts'
import { registerReentryCard } from './reentry-card.tsx'
import { registerSessionClock } from './session-clock.ts'
import { registerToastQueue } from './toast-queue.ts'
import { registerWins } from './wins.ts'

export const register: Register = (on, options) => {
  registerPatchStatus(on, options)
  registerDoneChime(on, options)
  registerSessionClock(on, options)
  registerReentryCard(on, options)
  registerPark(on, options)
  registerPatchesPane(on, options)
  registerWins(on, options)
  registerQuickPatch(on, options)
  registerToastQueue(on)
}
