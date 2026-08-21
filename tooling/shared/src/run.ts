import { Cause, Effect, Exit, Inspectable } from 'effect'

// What pi's own tools throw for a cancelled run, so interrupted plugin runs
// read like interrupted builtins.
const ABORT_MESSAGE = 'Operation aborted'

export interface RunOptions {
  readonly signal?: AbortSignal | undefined
}

// Defects keep their stack because they are bugs, and win over failures in a
// mixed cause.
function causeMessage(cause: Cause.Cause<unknown>): string {
  if (Cause.hasInterruptsOnly(cause)) {
    return ABORT_MESSAGE
  }
  if (Cause.hasDies(cause)) {
    return Cause.pretty(cause)
  }
  return cause.reasons
    .filter(Cause.isFailReason)
    .map(({ error }) => {
      if (error instanceof Error) {
        return error.message || error.name
      }
      return typeof error === 'string' ? error : Inspectable.toStringUnknown(error)
    })
    .join('\n')
}

/**
 * Failure rejects with an `Error` whose message is what the model reads back
 * as the tool result, so it is written for the model rather than for a log.
 */
export async function runTool<A, E>(
  effect: Effect.Effect<A, E>,
  options?: RunOptions,
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, options)
  if (Exit.isFailure(exit)) {
    throw new Error(causeMessage(exit.cause))
  }
  return exit.value
}

export interface RunHandlerOptions<B> {
  readonly onError?: (message: string) => B
}

/**
 * For boundaries pi does not report failures from (event hooks, commands,
 * background work). Never rejects. Without `onError`, failures vanish and
 * defects log to stderr.
 */
export async function runHandler<A, E, B = undefined>(
  effect: Effect.Effect<A, E>,
  options?: RunHandlerOptions<B>,
): Promise<A | B> {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) {
    return exit.value
  }
  if (options?.onError) {
    return options.onError(causeMessage(exit.cause))
  }
  if (Cause.hasDies(exit.cause)) {
    console.error(causeMessage(exit.cause))
  }
  return undefined as B
}
