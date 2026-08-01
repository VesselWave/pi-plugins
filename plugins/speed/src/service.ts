import { Array, Context, Effect, Order } from 'effect'

const MAX_SAMPLES = 1000

/**
 * Decay half-life of the live throughput estimate. In generated tokens rather
 * than requests, where a burst of tiny tool-call steps would flush a well-measured
 * estimate, or wall-clock, where the number would drift while the session idles.
 */
const HALF_LIFE_TOKENS = 4000

const MIN_WEIGHT = 1e-3

/**
 * Ceiling on how old a sample may be. Token-space decay ages a model only while
 * that same model is generating, so a window left behind by a model switch — or
 * by an idle session — would otherwise still read as current hours later.
 */
const MAX_SAMPLE_AGE_MS = 30 * 60 * 1000

/**
 * Effective sample size below which the error estimate is itself too noisy to act
 * on. Measured by leverage, not by request count: for a ratio, a window of twenty
 * tool-call steps beside one long answer is worth barely more than one
 * observation, and counting requests would call it twenty.
 */
const MIN_EFFECTIVE_SAMPLES = 5

/** Hysteresis: one threshold flickered as heavy requests left the window. */
const SETTLED_RELATIVE_ERROR = 0.05
const UNSETTLED_RELATIVE_ERROR = 0.15

/** Bartlett lags for the serial-correlation term. Past two the weights are noise. */
const HAC_LAGS = 2

/** A sample carrying the whole window leaves no residual to correct against. */
const MAX_LEVERAGE = 0.99

/**
 * Share of the billed reasoning the streamed thinking must account for before it
 * counts as having streamed whole. Characters per token swings by a fifth or so
 * between prose, code and JSON, and comparing the two sides of one request
 * compounds that; anything under this gap is a summary, not measurement noise.
 */
const REASONING_STREAMED = 0.6

/**
 * Below this the chunks were flushed from a buffer, not generated. A floor in ms
 * rather than a ceiling on implied rate, which would truncate the fast tail.
 */
const MIN_OBSERVED_MS = 2

export type DeltaKind = 'thinking' | 'visible'

interface Sample {
  readonly model: string
  /** Monotonic, for the staleness horizon only; a wall clock can step backwards. */
  readonly recordedAt: number
  readonly ttftMs: number
  /** First delta to last delta; provider teardown falls outside. */
  readonly generationMs: number
  /** Billed tokens shown to have crossed the wire within `generationMs`. */
  readonly tokens: number
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
  /** A subset of `outputTokens`; undefined where the provider reports no split. */
  readonly reasoningTokens: number | undefined
}

interface InflightRequest {
  readonly requestStart: number
  firstTokenAt?: number
  lastDeltaAt?: number
  firstDeltaChars: number
  visibleChars: number
  thinkingChars: number
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
 * The billed tokens this stream can account for, narrowed to the ones that arrived
 * inside the measured interval.
 *
 * Reasoning is billed under `output` whether or not the provider streams it. Where
 * it is withheld, or cut down to a summary, the time that produced it lands before
 * the first delta, so counting those tokens here credits the model with work no
 * measured interval covers — enough to read half again to twice too fast. Only the
 * thinking that actually streamed belongs in the numerator, and characters per
 * token, taken from the visible content of this same request, is what converts it
 * back into tokens.
 */
function streamedTokens(
  request: InflightRequest,
  outcome: RequestOutcome,
): number | undefined {
  const chars = request.visibleChars + request.thinkingChars
  const withinInterval = chars - request.firstDeltaChars
  if (withinInterval <= 0) {
    return undefined
  }

  const reasoning = Math.min(outcome.reasoningTokens ?? 0, outcome.outputTokens)
  const visible = outcome.outputTokens - reasoning
  const density = visible > 0 ? request.visibleChars / visible : 0
  // Clamping to the implied count on every request would charge the density noise
  // to models that stream their thinking in full, which is measurable, and add
  // spread the estimate has no reason to carry.
  const implied = density > 0 ? request.thinkingChars / density : 0
  const streamedReasoning =
    density <= 0
      ? request.thinkingChars > 0
        ? reasoning
        : 0
      : implied >= reasoning * REASONING_STREAMED
        ? reasoning
        : implied

  // The first delta predates the interval, so its share is dropped. Prorated by
  // characters rather than by chunk count, which assumed every chunk was equal
  // when the opening one is routinely a fragment.
  return ((visible + streamedReasoning) * withinInterval) / chars
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
  const horizon = latest.recordedAt - MAX_SAMPLE_AGE_MS
  const window: { readonly weight: number; readonly sample: Sample }[] = []
  let tokens = 0
  let millis = 0
  let distance = 0

  for (let index = samples.length - 1; index >= 0; index--) {
    const sample = samples[index]!
    if (sample.model !== model) {
      continue
    }
    if (sample.recordedAt < horizon) {
      break
    }
    const weight = 0.5 ** (distance / HALF_LIFE_TOKENS)
    if (weight < MIN_WEIGHT) {
      break
    }
    window.push({ weight, sample })
    tokens += weight * sample.tokens
    millis += weight * sample.generationMs
    distance += sample.tokens
  }

  // `latest` always matches and every sample clears MIN_OBSERVED_MS, so millis > 0.
  const rate = tokens / millis

  // Taylor-linearized variance of the ratio estimator. Each squared residual is
  // divided by its own leverage: a request holding half the window's time is half
  // of what it is being compared against, and left uncorrected it fits itself and
  // reports a precision the window does not have.
  let independent = 0
  let leverageSquares = 0
  const scores: number[] = []
  for (const { weight, sample } of window) {
    const leverage = (weight * sample.generationMs) / millis
    const score = weight * (sample.tokens - rate * sample.generationMs)
    independent += (score * score) / (1 - Math.min(leverage, MAX_LEVERAGE)) ** 2
    leverageSquares += leverage * leverage
    scores.push(score)
  }

  // Requests in one turn share a provider node, a queue position and a context
  // length, so their residuals move together and the independent sum reads far
  // too small. Bartlett-weighted lags add that covariance back; the kernel can
  // come out negative under alternation, hence the floor.
  let variance = independent
  for (let lag = 1; lag <= HAC_LAGS; lag++) {
    let covariance = 0
    for (let index = 0; index + lag < scores.length; index++) {
      covariance += scores[index]! * scores[index + lag]!
    }
    variance += 2 * (1 - lag / (HAC_LAGS + 1)) * covariance
  }

  const relativeError = Math.sqrt(Math.max(variance, independent)) / tokens
  const effectiveSamples = 1 / leverageSquares

  return {
    model,
    tps: rate * 1000,
    // Median, not latest: a retried request charges its whole backoff to TTFT.
    ttftMs: weightedMedian(
      window.map((entry) => ({ value: entry.sample.ttftMs, weight: entry.weight })),
    ),
    // The sample floor gates unconditionally rather than on the way in only: a
    // window rebuilt from one request fits it exactly, leaving a zero residual
    // that reads as perfect precision and would hold the latch open on nothing.
    provisional: !(
      effectiveSamples >= MIN_EFFECTIVE_SAMPLES &&
      relativeError <= (settled ? UNSETTLED_RELATIVE_ERROR : SETTLED_RELATIVE_ERROR)
    ),
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
        inflight = {
          requestStart: performance.now(),
          firstDeltaChars: 0,
          visibleChars: 0,
          thinkingChars: 0,
        }
      }

      /**
       * Returns the measured TTFT exactly once, on the first delta. Tokens/sec is
       * never estimated mid-stream: real token counts arrive only at message end.
       */
      function recordDelta(kind: DeltaKind, length: number): FirstToken | undefined {
        const request = inflight
        if (request === undefined) {
          return undefined
        }

        const now = performance.now()
        if (kind === 'thinking') {
          request.thinkingChars += length
        } else {
          request.visibleChars += length
        }

        if (request.firstTokenAt !== undefined) {
          request.lastDeltaAt = now
          return undefined
        }

        request.firstTokenAt = now
        request.firstDeltaChars = length
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

        const tokens = streamedTokens(request, outcome)
        if (tokens === undefined || tokens <= 0) {
          return
        }

        samples.push({
          model: outcome.model,
          recordedAt: request.lastDeltaAt,
          ttftMs: request.firstTokenAt - request.requestStart,
          generationMs,
          tokens,
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
