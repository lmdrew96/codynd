import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { checkFailed, decode, isCheckCommand, REPEAT_MS } from './error-decoder.ts'

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }

describe('which runs count', () => {
  test('builds, typechecks, tests and lints count; grep and cat do not', () => {
    for (const c of ['pnpm build', 'cd x && npx tsc --noEmit | tail', 'pnpm typecheck', 'npm run lint', 'pnpm test', 'claude plugin validate .'])
      expect(isCheckCommand(c)).toBe(true)
    for (const c of ['grep -rn foo hooks', 'cat tsconfig.json', 'ls build', 'git diff']) expect(isCheckCommand(c)).toBe(false)
  })

  test('a piped run that hid its exit code still fails on its own markers', () => {
    expect(checkFailed(false, "hooks/x.ts(3,1): error TS2304: Cannot find name 'clock'.")).toBe(true)
    expect(checkFailed(false, ' 105 pass\n 0 fail\n')).toBe(false)
  })
})

describe('decode', () => {
  test('TypeScript: the common errors read as plain English with where', () => {
    expect(decode("hooks/wins.ts(81,3): error TS2304: Cannot find name 'clock'.")).toBe(
      "TypeScript can't find `clock`, probably a missing import or a typo (in wins.ts:81).",
    )
    expect(decode("src/a.ts(2,20): error TS2307: Cannot find module 'zod' or its corresponding type declarations.")).toBe(
      "Can't find module `zod`: not installed, or the import path is off (in a.ts:2).",
    )
    expect(decode("src/a.ts:9:5 - error TS2339: Property 'titel' does not exist on type 'Patch'.")).toBe(
      "`titel` isn't on `Patch`: a typo, or the type needs the new field (in a.ts:9).",
    )
    expect(decode('\x1b[31msrc/a.ts(4,1): error TS2554: Expected 1 arguments, but got 2.\x1b[0m')).toBe(
      '1 TypeScript error (in a.ts:4): Expected 1 arguments, but got 2.',
    )
  })

  test('tests: the count and the first failing name', () => {
    expect(decode('(fail) /wins > lists today [12.40ms]\n 104 pass\n 1 fail\n')).toBe('1 test failing, first: /wins > lists today.')
    expect(decode(' × adds two numbers\n Tests  3 failed | 9 passed')).toBe('3 tests failing, first: adds two numbers.')
  })

  test('lint and syntax; anything else goes to the model', () => {
    expect(decode('/x/src/a.ts\n  3:7  error  no-unused-vars\n\n✖ 4 problems (4 errors, 0 warnings)')).toBe(
      'Lint found 4 problems.',
    )
    expect(decode('SyntaxError: Unexpected token }')).toBe('Syntax error: Unexpected token }')
    expect(decode('Segmentation fault (core dumped)')).toBeUndefined()
  })
})

type Seen = { toasts: string[]; asks: number; clock: ReturnType<typeof mock.clock> }

// Bash beneath the plugin answers with `bash.output`, failed or not; Haiku answers when asked.
const world = (on: On, bash: { output: string; isError: boolean }): Seen => {
  const seen: Seen = { toasts: [], asks: 0, clock: mock.clock(on) }
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  for (const ev of ['ui.status', 'ui.log'] as const) on(ev, () => ({ value: undefined }))
  on('model.complete', () => {
    seen.asks += 1
    return { value: { isAnswered: true, text: 'The build ran out of memory.\nMore detail.', usage: USAGE } as never }
  })
  on('tool.call', () => (bash.isError ? { result: bash.output, isError: true } : { result: { stdout: bash.output, stderr: '' } }))
  return seen
}

const runBash = async ($: Engine, command: string): Promise<void> => {
  const callTool = $.tool.call as unknown as (input: { tool: string; command: string }) => Promise<unknown>
  await callTool({ tool: 'Bash', command })
}

describe('the toast', () => {
  test('one decoded line per failing run; the same error again stays quiet for a while', async ($, on) => {
    const seen = world(on, { output: "hooks/wins.ts(81,3): error TS2304: Cannot find name 'clock'.", isError: true })
    await runBash($, 'pnpm typecheck')
    await runBash($, 'pnpm typecheck')
    expect(seen.toasts).toEqual(["🧩 TypeScript can't find `clock`, probably a missing import or a typo (in wins.ts:81)."])
    await seen.clock.advance(REPEAT_MS)
    await runBash($, 'pnpm typecheck')
    expect(seen.toasts).toHaveLength(2)
    expect(seen.asks).toBe(0)
  })

  test('silent for non-check commands and passing runs', async ($, on) => {
    const bash = { output: 'no matches', isError: true }
    const seen = world(on, bash)
    await runBash($, 'grep -rn nothing hooks')
    bash.output = ' 105 pass\n 0 fail\n'
    bash.isError = false
    await runBash($, 'pnpm test')
    expect(seen.toasts).toEqual([])
  })

  test('no pattern: Haiku names it in one line', async ($, on) => {
    const seen = world(on, { output: 'FATAL ERROR: Reached heap limit Allocation failed', isError: true })
    await runBash($, 'pnpm build')
    expect(seen.toasts).toEqual(['🧩 The build ran out of memory.'])
    expect(seen.asks).toBe(1)
  })
})
