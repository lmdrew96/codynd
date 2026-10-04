import type { Register } from 'claude-code'
import { registerAttentionChime } from './attention-chime.ts'
import { registerDoneChime } from './done-chime.ts'
import { registerErrorDecoder } from './error-decoder.ts'
import { registerFocus } from './focus.tsx'
import { registerInstructions } from './instructions.ts'
import { registerNextEvent } from './next-event.ts'
import { registerPark } from './park.ts'
import { registerPatchStatus } from './patch-status.ts'
import { registerPatchesPane } from './patches-pane.tsx'
import { registerQuickPatch } from './quick-patch.ts'
import { registerReentryCard } from './reentry-card.tsx'
import { registerSessionClock } from './session-clock.ts'
import { registerSoundtrack } from './soundtrack.ts'
import { registerToastQueue } from './toast-queue.ts'
import { registerToolbox } from './toolbox.ts'
import { registerWhatChanged } from './whatchanged.ts'
import { registerWins } from './wins.ts'
import { registerWrap } from './wrap.ts'

export const register: Register = (on, options) => {
  registerPatchStatus(on, options)
  registerDoneChime(on, options)
  registerSoundtrack(on, options)
  registerAttentionChime(on, options)
  registerErrorDecoder(on)
  registerSessionClock(on, options)
  registerReentryCard(on, options)
  registerPark(on, options)
  registerPatchesPane(on, options)
  registerWins(on, options)
  registerQuickPatch(on, options)
  registerToastQueue(on)
  registerFocus(on, options)
  registerWrap(on)
  registerWhatChanged(on)
  registerNextEvent(on, options)
  registerInstructions(on)
  registerToolbox(on)
}
