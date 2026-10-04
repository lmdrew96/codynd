import type { Register } from 'claude-code'
import { registerDoneChime } from './done-chime.ts'
import { registerPatchStatus } from './patch-status.ts'

export const register: Register = (on, options) => {
  registerPatchStatus(on, options)
  registerDoneChime(on, options)
}
