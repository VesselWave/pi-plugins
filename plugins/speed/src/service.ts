import { Array, Context, Effect, Order } from 'effect'

const MAX_SAMPLES = 1000

/**
 * Decay half-life of the live throughput estimate. In generated tokens rather
 * than requests, where a burst of tiny tool-call steps would flush a well-measured
 * estimate, or wall-clock, where the number would drift while the session idles.
 */
const HALF_LIFE_TOKENS = 4000

const MIN_WEIGHT = 1e-3

/** Below this the error estimate is itself too noisy to act on. */
const MIN_EFFECTIVE_SAMPLES = 10

/** Hysteresis: one threshold flickered as heavy requests left the window. */
const SETTLED_RELATIVE_ERROR = 0.05
const UNSETTLED_RELATIVE_ERROR = 0.15

/**
 * Below this the chunks were flushed from a buffer, not generated. A floor in ms
 * rather than a ceiling on implied rate, which would truncate the fast tail.
 */
const MIN_OBSERVED_MS = 2

interface Sample {
  readonly model: string
  readonly ttftMs: number
  /** First delta to last delta; provider teardown falls outside. */
  readonly generationMs: number
  readonly outputTokens: number
  /** Share of `outputTokens` that arrived within `generationMs`. */
  readonly streamedTokens: number
}

export interface RecentSpeed {
  readonly model: string
  readonly tps: number
  readonly ttftMs: number
  /** The spread across recent requests is still too wide to stand behind. */
  readonly provisional: boolean
}

export interface FirstToken {
  readonly ttftMs: number
}

export interface RequestOutcome {
  readonly model: string
  readonly stopReason: string
  readonly outputTokens: number
}

interface InflightRequest {
  readonly requestStart: number
  firstTokenAt?: number
  lastDeltaAt?: number
  deltas: number
}

interface WeightedValue {
  readonly value: number
  readonly weight: number
}

/** Median that splits total weight rather than count; `NaN` when empty. */
function weightedMedian(entries: readonly WeightedValue[]): number {
  const sorted = Array.sort(
    entries,
    Order.mapInput(Order.Number, (entry: WeightedValue) => entry.value),
  )
  const half = sorted.reduce((total, entry) => total + entry.weight, 0) / 2
  let seen = 0
  for (const entry of sorted) {
    seen += entry.weight
    if (seen >= half) {
      return entry.value
    }
  }
  return Number.NaN
}

/**
 * Tokens and milliseconds are summed separately and divided once, so a request
 * counts in proportion to the evidence it carries. Averaging per-request rates
 * instead would give a 30-token tool-call step — mostly fixed per-request
 * overhead — the same say as a 1500-token answer.
 */
function recentSpeed(
  samples: readonly Sample[],
  settled: boolean,
): RecentSpeed | undefined {
  const latest = samples.at(-1)
  if (latest === undefined) {
    return undefined
  }

  // Only the model that answered last: blending two models' rate curves would
  // describe neither.
  const model = latest.model
  const window: { readonly weight: number; readonly sample: Sample }[] = []
  let tokens = 0
  let millis = 0
  let distance = 0

  for (let index = samples.length - 1; index >= 0; index--) {
    const sample = samples[index]!
    if (sample.model !== model) {
      continue
    }
    const weight = 0.5 ** (distance / HALF_LIFE_TOKENS)
    if (weight < MIN_WEIGHT) {
      break
    }
    window.push({ weight, sample })
    tokens += weight * sample.streamedTokens
    millis += weight * sample.generationMs
    distance += sample.outputTokens
  }

  // `latest` always matches and every sample clears MIN_OBSERVED_MS, so millis > 0.
  const rate = tokens / millis

  // Taylor-linearized standard error of the ratio estimator, relative to the rate.
  let residuals = 0
  let weights = 0
  let weightsSquared = 0
  for (const { weight, sample } of window) {
    const residual = sample.streamedTokens - rate * sample.generationMs
    residuals += weight * weight * residual * residual
    weights += weight
    weightsSquared += weight * weight
  }
  const effectiveSamples = (weights * weights) / weightsSquared
  // ESS stands in for n in the usual n/(n-1) correction. At one sample the
  // residual is zero by construction, which would read as perfect precision.
  const relativeError =
    effectiveSamples > 1
      ? Math.sqrt((effectiveSamples / (effectiveSamples - 1)) * residuals) / tokens
      : Number.POSITIVE_INFINITY

  return {
    model,
    tps: rate * 1000,
    // Median, not latest: a retried request charges its whole backoff to TTFT.
    ttftMs: weightedMedian(
      window.map((entry) => ({ value: entry.sample.ttftMs, weight: entry.weight })),
    ),
    provisional: !(settled
      ? relativeError <= UNSETTLED_RELATIVE_ERROR
      : relativeError <= SETTLED_RELATIVE_ERROR &&
        effectiveSamples >= MIN_EFFECTIVE_SAMPLES),
  }
}

/**
 * Tracks inference speed across one session: measures the in-flight provider
 * request and accumulates completed requests into a bounded sample window.
 */
export class SpeedTracker extends Context.Service<SpeedTracker>()(
  '@pi-plugins/speed/SpeedTracker',
  {
    make: Effect.sync(() => {
      const samples: Sample[] = []
      let inflight: InflightRequest | undefined
      let settled = false

      /**
       * Compaction and branch summarization stream through this hook too without
       * surfacing as assistant messages, so one can fire mid-turn and must not
       * re-anchor a request already streaming.
       */
      function beginRequest(): void {
        if (inflight?.firstTokenAt !== undefined) {
          return
        }
        inflight = { requestStart: performance.now(), deltas: 0 }
      }

      /**
       * Returns the measured TTFT exactly once, on the first delta. Tokens/sec is
       * never estimated mid-stream: real token counts arrive only at message end.
       */
      function recordDelta(): FirstToken | undefined {
        const request = inflight
        if (request === undefined) {
          return undefined
        }

        const now = performance.now()
        request.deltas++
        if (request.firstTokenAt !== undefined) {
          request.lastDeltaAt = now
          return undefined
        }

        request.firstTokenAt = now
        return { ttftMs: now - request.requestStart }
      }

      function endRequest(outcome: RequestOutcome): void {
        const request = inflight
        inflight = undefined

        if (
          request?.firstTokenAt === undefined ||
          request.lastDeltaAt === undefined ||
          outcome.stopReason === 'error' ||
          outcome.stopReason === 'aborted' ||
          outcome.outputTokens <= 0
        ) {
          // Nothing measurable or an interrupted stream. A lone delta spans no
          // interval at all, and timing it would read as thousands of tokens/sec.
          return
        }

        const generationMs = request.lastDeltaAt - request.firstTokenAt
        if (generationMs < MIN_OBSERVED_MS) {
          return
        }

        samples.push({
          model: outcome.model,
          ttftMs: request.firstTokenAt - request.requestStart,
          generationMs,
          outputTokens: outcome.outputTokens,
          // The first delta's tokens predate the interval and its share is
          // unknown, so assume tokens were spread evenly across the deltas.
          streamedTokens:
            (outcome.outputTokens * (request.deltas - 1)) / request.deltas,
        })
        if (samples.length >= MAX_SAMPLES * 2) {
          // Amortized trim: let the buffer grow to twice the window, then cut
          // back in one splice instead of shifting on every append.
          samples.splice(0, samples.length - MAX_SAMPLES)
        }
      }

      /**
       * Advances the settled latch. Idempotent for a given window: a rate that
       * just cleared the settling bar cannot exceed the wider un-settling one.
       */
      function recent(): RecentSpeed | undefined {
        const speed = recentSpeed(samples, settled)
        settled = speed !== undefined && !speed.provisional
        return speed
      }

      function reset(): void {
        samples.length = 0
        inflight = undefined
        settled = false
      }

      return {
        beginRequest,
        recordDelta,
        endRequest,
        recent,
        reset,
      } as const
    }),
  },
) {}
