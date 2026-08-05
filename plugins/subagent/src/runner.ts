import * as fs from 'node:fs'
import * as path from 'node:path'
import { Data, Effect, Fiber, Filter, Schema, Stream } from 'effect'
import type { PlatformError } from 'effect/PlatformError'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

/** Cap on buffered stderr (in characters) so a pathological child can't exhaust memory. */
const STDERR_CAP = 50 * 1024

/** Grace period between SIGTERM and SIGKILL when terminating the child. */
const FORCE_KILL_AFTER = '5 seconds'

/** Aggregated token/cost statistics across all turns of a subagent run. */
export interface SubagentUsage {
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  contextTokens: number
}

/**
 * What a subagent run produced: the child's final output plus what it took to
 * get there. Errors carry the partial result of the work done before failing.
 */
export interface SubagentResult {
  output: string
  toolCalls: number
  usage: SubagentUsage
  /** Child's pi session id, read from the `session` header of its event stream. */
  sessionId?: string | undefined
  /** Wall-clock duration of the child process, in milliseconds. */
  durationMs?: number | undefined
}

export const emptyResult: SubagentResult = {
  output: '',
  toolCalls: 0,
  usage: {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
  },
}

/**
 * The subagent stopped without completing its task: the child reported an
 * `error` or `aborted` stop reason on its final assistant message.
 */
export class SubagentStopError extends Data.TaggedError('SubagentStopError')<{
  readonly reason: 'error' | 'aborted'
  /** Error detail reported by the child, if any. */
  readonly errorMessage?: string | undefined
  readonly stderr: string
  /** Progress made up to the failure. */
  readonly result: SubagentResult
}> {
  override readonly message: string =
    this.errorMessage ||
    this.stderr.trim() ||
    this.result.output ||
    `run stopped (${this.reason})`
}

/** The pi child process exited with a nonzero exit code. */
export class SubagentExitError extends Data.TaggedError('SubagentExitError')<{
  readonly exitCode: number
  readonly stderr: string
  /** Progress made up to the failure. */
  readonly result: SubagentResult
}> {
  override readonly message: string =
    this.stderr.trim() ||
    this.result.output ||
    `pi exited with code ${this.exitCode}`
}

/**
 * The child exited cleanly but emitted no assistant messages, meaning it
 * produced no usable output (wrong invocation, polluted stdout, JSON format
 * drift, ...).
 */
export class SubagentNoOutputError extends Data.TaggedError(
  'SubagentNoOutputError',
)<{
  readonly stderr: string
  /** Progress made up to the failure. */
  readonly result: SubagentResult
}> {
  override readonly message: string =
    'Subagent produced no assistant messages (unexpected or empty JSON event stream)' +
    (this.stderr.trim() ? `\nstderr: ${this.stderr.trim()}` : '')
}

/** The session header pi prints as the first line of a `--mode json` stream. */
const SessionHeader = Schema.Struct({
  type: Schema.Literal('session'),
  id: Schema.String,
})

/** A completed assistant message. */
const AssistantMessageEnd = Schema.Struct({
  type: Schema.Literal('message_end'),
  message: Schema.Struct({
    role: Schema.Literal('assistant'),
    content: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.optional(Schema.String),
      }),
    ),
    usage: Schema.optional(
      Schema.Struct({
        input: Schema.optional(Schema.Number),
        output: Schema.optional(Schema.Number),
        cacheRead: Schema.optional(Schema.Number),
        cacheWrite: Schema.optional(Schema.Number),
        totalTokens: Schema.optional(Schema.Number),
        cost: Schema.optional(
          Schema.Struct({ total: Schema.optional(Schema.Number) }),
        ),
      }),
    ),
    stopReason: Schema.optional(Schema.String),
    errorMessage: Schema.optional(Schema.String),
  }),
})

/**
 * The `--mode json` event lines we care about (see pi docs/json.md): the
 * session header and completed assistant messages.
 */
const SubagentEvent = Schema.fromJsonString(
  Schema.Union([SessionHeader, AssistantMessageEnd]),
)

type AssistantMessage = (typeof AssistantMessageEnd)['Type']['message']

/** Fold state: the public result plus the child's last reported stop info. */
interface RunState {
  result: SubagentResult
  stopReason?: string | undefined
  errorMessage?: string | undefined
}

const initialState: RunState = { result: emptyResult }

/** Folds one completed assistant message into the run state. */
function foldMessage(state: RunState, message: AssistantMessage): RunState {
  const { result } = state
  let toolCalls = result.toolCalls
  const texts: string[] = []
  for (const part of message.content) {
    if (part.type === 'text' && part.text !== undefined) {
      texts.push(part.text)
    } else if (part.type === 'toolCall') {
      toolCalls += 1
    }
  }
  const text = texts.join('\n\n').trim()
  const output = text.length > 0 ? text : result.output

  const usage = message.usage
  return {
    result: {
      ...result,
      output,
      toolCalls,
      usage: {
        turns: result.usage.turns + 1,
        input: result.usage.input + (usage?.input ?? 0),
        output: result.usage.output + (usage?.output ?? 0),
        cacheRead: result.usage.cacheRead + (usage?.cacheRead ?? 0),
        cacheWrite: result.usage.cacheWrite + (usage?.cacheWrite ?? 0),
        cost: result.usage.cost + (usage?.cost?.total ?? 0),
        contextTokens: usage?.totalTokens ?? result.usage.contextTokens,
      },
    },
    stopReason: message.stopReason ?? state.stopReason,
    errorMessage: message.errorMessage ?? state.errorMessage,
  }
}

/**
 * Resolves how to re-invoke the running pi harness: the current entry script
 * via the current runtime, the executable itself (compiled binaries), or
 * `pi` on PATH.
 */
function resolvePiInvocation(args: ReadonlyArray<string>): {
  command: string
  args: ReadonlyArray<string>
} {
  const currentScript = process.argv[1]
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/')
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] }
  }

  const execName = path.basename(process.execPath).toLowerCase()
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
  if (!isGenericRuntime) {
    return { command: process.execPath, args }
  }

  return { command: 'pi', args }
}

/**
 * Runs one headless pi instance for the given prompt and folds its JSONL
 * event stream into a `SubagentResult`.
 */
export function runSubagent(options: {
  prompt: string
  /** Directory the child persists its session into. */
  sessionDir: string
  /** Display name for the child's session. */
  name?: string | undefined
  /** Optional model override, passed to `pi --model`. */
  model?: string | undefined
  /** Working directory for the spawned pi process. */
  cwd?: string | undefined
  /** Tool allowlist for the child. */
  tools?: ReadonlyArray<string> | undefined
  /** Called once, when the child reports the id of the session it writes to. */
  onSession?: ((sessionId: string) => void) | undefined
}): Effect.Effect<
  SubagentResult,
  SubagentStopError | SubagentExitError | SubagentNoOutputError | PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.scoped(
    Effect.gen(function* () {
      // `--exclude-tools subagent` prevents children from recursively
      // spawning their own subagents.
      const args = [
        '--mode',
        'json',
        '-p',
        '--session-dir',
        options.sessionDir,
        '--exclude-tools',
        'subagent',
      ]
      // pi rejects an empty --name, and an unnamed run is still identifiable
      // by its prompt in the session picker.
      const name = options.name?.trim()
      if (name) {
        args.push('--name', name)
      }
      // Inherit the parent's active tool set so a restricted parent
      // (e.g. `--tools read`) cannot be escaped through the child.
      if (options.tools !== undefined) {
        if (options.tools.length > 0) {
          args.push('--tools', options.tools.join(','))
        } else {
          args.push('--no-tools')
        }
      }
      if (options.model !== undefined) {
        args.push('--model', options.model)
      }
      const invocation = resolvePiInvocation(args)
      const startedAt = Date.now()
      const handle = yield* ChildProcess.make(
        invocation.command,
        [...invocation.args],
        {
          cwd: options.cwd,
          // Override a process-wide long retention setting. The explicit short
          // value also tells @pi-plugins/claude-oauth not to extend child TTLs.
          env: { PI_CACHE_RETENTION: 'short' },
          extendEnv: true,
          stdin: Stream.make(new TextEncoder().encode(options.prompt)),
          forceKillAfter: FORCE_KILL_AFTER,
        },
      )

      const stderrFiber = yield* Effect.forkScoped(
        handle.stderr.pipe(
          Stream.decodeText,
          Stream.runFold(
            () => '',
            (acc, chunk) =>
              acc.length >= STDERR_CAP
                ? acc
                : acc + chunk.slice(0, STDERR_CAP - acc.length),
          ),
        ),
      )

      const state = yield* handle.stdout.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filterMap(
          Filter.fromPredicateOption(Schema.decodeUnknownOption(SubagentEvent)),
        ),
        Stream.runFoldEffect(
          () => initialState,
          (previous, event) =>
            Effect.sync(() => {
              if (event.type === 'session') {
                // The first header wins: reporting a later one would cost the
                // row the extra render this whole design avoids.
                if (previous.result.sessionId !== undefined) {
                  return previous
                }
                options.onSession?.(event.id)
                return {
                  ...previous,
                  result: { ...previous.result, sessionId: event.id },
                }
              }
              return foldMessage(previous, event.message)
            }),
        ),
      )

      const exitCode = Number(yield* handle.exitCode)
      const stderr = yield* Fiber.join(stderrFiber)
      const result = { ...state.result, durationMs: Date.now() - startedAt }

      if (state.stopReason === 'error' || state.stopReason === 'aborted') {
        return yield* new SubagentStopError({
          reason: state.stopReason,
          errorMessage: state.errorMessage,
          stderr,
          result,
        })
      }
      if (exitCode !== 0) {
        return yield* new SubagentExitError({ exitCode, stderr, result })
      }
      if (result.usage.turns === 0) {
        return yield* new SubagentNoOutputError({ stderr, result })
      }

      return result
    }),
  )
}
