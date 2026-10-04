import type { EngineInterface, On } from 'claude-code'
import { isTestCommand, testRunFailed } from './done-chime.ts'
import { truncate } from './patch-status.ts'

// Error decoder: when a build, typecheck, test or lint run fails, one toast says what broke and the
// likely cause in plain English. Regex first; a small Haiku call only when no pattern matches.
// Built against Claude Code 2.1.289.

const BASH_TOOL = /^Bash$/

// Checks beyond tests, anywhere in the command (cd … && pnpm build | tail). Bare tsc/eslint count
// only as a command, so `cat eslint.config.js` isn't a run.
const CHECK_COMMAND =
  /\b(?:(?:pnpm|npm|yarn|bun)(?:\s+-\S+)*\s+(?:run\s+)?(?:build|typecheck|type-check|lint|check|validate)|npx\s+(?:tsc|eslint|next\s+build)|next\s+build|cargo\s+(?:build|check|clippy)|go\s+(?:build|vet)|claude\s+plugin\s+validate)\b|(?:^|[;&|]\s*)(?:tsc|eslint)\b/

// A pipe (| tail) hides the exit code, so the output's own failure markers count too.
const FAILURE_MARK = /\berror TS\d+|ELIFECYCLE|Failed to compile|Build failed|✖ \d+ problems?/

export const DECODE_TOAST_MS = 8000
// The same decoded error again within this window stays quiet.
export const REPEAT_MS = 5 * 60_000
const MODEL_TIMEOUT_MS = 6000

export const isCheckCommand = (command: string): boolean => isTestCommand(command) || CHECK_COMMAND.test(command)

export const checkFailed = (isError: boolean, output: string): boolean =>
  testRunFailed(isError, output) || FAILURE_MARK.test(output)

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '')

const basename = (path: string): string => path.split('/').pop() ?? path

// The first file:line the output names, as " (in wins.ts:81)".
const where = (output: string): string => {
  const m = /([\w./-]+\.[cm]?[jt]sx?)(?:\((\d+),\d+\)|:(\d+):\d+)/.exec(output)
  return m ? ` (in ${basename(m[1]!)}:${m[2] ?? m[3]})` : ''
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

// One plain-English line for the common failures, or undefined to ask the model.
export const decode = (raw: string): string | undefined => {
  const output = stripAnsi(raw)
  const at = where(output)

  const name = /error TS2304: Cannot find name '([^']+)'/.exec(output)
  if (name) return `TypeScript can't find \`${name[1]}\`, probably a missing import or a typo${at}.`

  const mod = /Cannot find module '([^']+)'|Can't resolve '([^']+)'/.exec(output)
  if (mod) return `Can't find module \`${mod[1] ?? mod[2]}\`: not installed, or the import path is off${at}.`

  const prop = /error TS2339: Property '([^']+)' does not exist on type '([^']+)'/.exec(output)
  if (prop) return `\`${prop[1]}\` isn't on \`${truncate(prop[2]!, 30)}\`: a typo, or the type needs the new field${at}.`

  if (/error TS(?:2322|2345):/.test(output)) return `A value's type doesn't match what the code expects${at}.`

  const tsErrors = output.match(/error TS\d+/g)
  if (tsErrors) {
    const first = /error TS\d+: (.+)/.exec(output)?.[1] ?? ''
    return `${plural(tsErrors.length, 'TypeScript error')}${at}: ${truncate(first, 60)}`
  }

  const failCount = /\b([1-9]\d*)\s+(?:fail|failed|failing)\b/i.exec(output)
  if (failCount) {
    const n = Number(failCount[1])
    const first = /\(fail\) (.+?)(?: \[[\d.]+m?s\])?$|^\s*[✗×] (.+)$|^FAIL\s+(\S+)/m.exec(output)
    const named = first ? first[1] ?? first[2] ?? first[3] : undefined
    return `${plural(n, 'test')} failing${named ? `, first: ${truncate(named.trim(), 60)}` : ''}.`
  }

  const lint = /✖ (\d+) problems?/.exec(output)
  if (lint) return `Lint found ${plural(Number(lint[1]), 'problem')}${at}.`

  const syntax = /SyntaxError: (.+)/.exec(output)
  if (syntax) return `Syntax error${at}: ${truncate(syntax[1]!, 60)}`

  return undefined
}

const askModel = async ($: EngineInterface, command: string, output: string): Promise<string | undefined> => {
  const prompt = [
    'A build, test or lint command failed. In one plain-English sentence under 110 characters, say what broke and the',
    'likely cause, naming the file if the output does. No preamble, no code blocks.',
    '',
    `Command: ${command}`,
    '',
    'Output (last part):',
    stripAnsi(output).slice(-3000),
  ].join('\n')
  const reply = await $.model.complete({ model: 'haiku', prompt, effort: 'low', maxTokens: 120, timeoutMs: MODEL_TIMEOUT_MS })
  if (!reply.isAnswered) {
    $.ui.log(`error-decoder: no model reply: ${reply.reason}`, { to: 'debug' })
    return undefined
  }
  const line = reply.text.trim().split('\n')[0]?.trim()
  return line ? truncate(line, 120) : undefined
}

// Core's text when it set it; else Bash's own result, a string or { stdout, stderr }.
const outputOf = (ran: { text?: string; result?: unknown }): string => {
  if (ran.text !== undefined) return ran.text
  if (typeof ran.result === 'string') return ran.result
  const r = (ran.result ?? {}) as { stdout?: unknown; stderr?: unknown }
  return [r.stdout, r.stderr].filter((s): s is string => typeof s === 'string').join('\n')
}

// The first line that looks like the error: a repeat key for failures no pattern decodes.
const errorLine = (output: string): string =>
  stripAnsi(output).split('\n').find(l => /error|fail|✖|×/i.test(l))?.trim() ?? ''

export const registerErrorDecoder = (on: On): void => {
  // Module state: a reload just forgets recent errors, so one might toast twice.
  const lastShown = new Map<string, number>()

  const isRepeat = (key: string, now: number): boolean => {
    const seen = lastShown.get(key)
    if (seen !== undefined && now - seen < REPEAT_MS) return true
    lastShown.set(key, now)
    return false
  }

  // Awaited inside the hook so toast-queue.ts sees the toast and holds it behind a done toast.
  on('tool.call', { tool: BASH_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    const command = (e as { command?: unknown }).command
    if (ran.deny !== undefined || typeof command !== 'string' || !isCheckCommand(command)) return ran
    const output = outputOf(ran)
    if (!checkFailed(ran.isError === true, output)) return ran
    try {
      const now = await $.clock.now()
      const decoded = decode(output)
      if (isRepeat(decoded ?? `${command}\n${errorLine(output)}`, now)) return ran
      const line = decoded ?? (await askModel($, command, output))
      if (line !== undefined) $.ui.toast(`🧩 ${line}`, { timeoutMs: DECODE_TOAST_MS })
    } catch (err) {
      $.ui.log(`error-decoder: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    }
    return ran
  })
}
