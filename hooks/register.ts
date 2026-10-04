import type { Register } from 'claude-code'
import { registerDoneChime } from './done-chime.ts'
import { registerPark } from './park.ts'
import { registerPatchStatus } from './patch-status.ts'
import { registerReentryCard } from './reentry-card.tsx'
import { registerSessionClock } from './session-clock.ts'

export const register: Register = (on, options) => {
  registerPatchStatus(on, options)
  registerDoneChime(on, options)
  registerSessionClock(on, options)
  registerReentryCard(on, options)
  registerPark(on, options)
}
