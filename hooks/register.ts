import type { Register } from 'claude-code'
import { registerPatchStatus } from './patch-status.ts'

export const register: Register = (on, options) => {
  registerPatchStatus(on, options)
}
