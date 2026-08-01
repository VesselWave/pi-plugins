import { Array, Context, Effect, Number, Order, pipe, Record } from 'effect'

const MAX_SAMPLES = 1000

/**
 * Decay half-life of the live throughput estimate. In generated tokens rather
 * than requests, where a burst of tiny tool-call steps would flush a well-measured
 * estimate, or wall-clock, where the number would drift while the session idles.
 */
const HALF_LIFE_TOKENS = 4000

const MIN_WEIGHT = 1e-3

export interface Sample {
  readonly model: string
  readonly ttftMs: number
  readonly generationMs: number
  readonly outputTokens: number
}

export interface RecentSpeed {
  readonly model: string
  readonly tps: number
  readonly ttftMs: number
  /** Fewer than one half-life of evidence so far; the figure is still settling. */
  readonly provisional: boolean
}

export interface ModelStats {
  readonly model: string
  readonly requests: number
  readonly tps: number
  readonly totalTokens: number
  readonly ttft: TailSummary
  readonly requestTps: TailSummary
}

export interface TailSummary {
  readonly p50: number | undefined
  readonly p95: number | undefined
  readonly worst: number
}

export interface FirstToken {
  readonly ttftMs: number
}

export interface SessionReport {
  readonly requestCount: number
  readonly recent: RecentSpeed | undefined
  readonly last: Sample | undefined
  readonly stats: readonly ModelStats[]
}

export interface RequestOutcome {
  readonly model: string
  readonly stopReason: string
  readonly outputTokens: number
}

interface InflightRequest {
  readonly requestStart: number
  firstTokenAt?: number
}

/**
 * A quantile is reported only when at least this many samples lie strictly
 * beyond its rank, so it is genuinely interior rather than a relabeled
 * (near-)max. Yields gates of n ≥ 4 for p50 and n ≥ 40 for p95.
 */
const MIN_SAMPLES_BEYOND = 2

/** Nearest-rank quantile of a sorted array (worse tail last); `NaN` when empty. */
export function quantile(sorted: readonly number[], q: number): number {
  const index = Math.min(
    Math.max(Math.ceil(q * sorted.length) - 1, 0),
    sorted.length - 1,
  )
  return sorted[index] ?? globalThis.Number.NaN
}

export function tailSummary(
  values: readonly number[],
  worse: 'high' | 'low',
): TailSummary {
  // Worse tail last, so nearest-rank treats latency and throughput symmetrically.
  const sorted = Array.sort(
    values,
    worse === 'high' ? Order.Number : Order.flip(Order.Number),
  )
  const gated = (q: number) =>
    sorted.length - Math.ceil(q * sorted.length) >= MIN_SAMPLES_BEYOND
      ? quantile(sorted, q)
      : undefined
  return {
    p50: gated(0.5),
    p95: gated(0.95),
    worst: quantile(sorted, 1),
  }
}

export function tokensPerSecond(sample: Sample): number {
  return sample.outputTokens / (sample.generationMs / 1000)
}

/**
 * Tokens and milliseconds are summed separately and divided once, so a request
 * counts in proportion to the evidence it carries. Averaging per-request rates
 * instead would give a 30-token tool-call step — mostly fixed per-request
 * overhead — the same say as a 1500-token answer.
 */
function recentSpeed(samples: readonly Sample[]): RecentSpeed | undefined {
  const latest = samples.at(-1)
  if (latest === undefined) {
    return undefined
  }

  // Only the model that answered last: blending two models' rate curves would
  // describe neither.
  const model = latest.model
  const ttfts: number[] = []
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
    tokens += weight * sample.outputTokens
    millis += weight * sample.generationMs
    distance += sample.outputTokens
    ttfts.push(sample.ttftMs)
  }

  return {
    model,
    // `latest` always matches and `generationMs` has a 1ms floor, so millis > 0.
    tps: (tokens / millis) * 1000,
    // Median, not latest: a retried request charges its whole backoff to TTFT.
    ttftMs: quantile(Array.sort(ttfts, Order.Number), 0.5),
    provisional: tokens < HALF_LIFE_TOKENS,
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

      /** One LLM request is about to go out; the TTFT start anchor. */
      function beginRequest(): void {
        inflight = { requestStart: performance.now() }
      }

      /**
       * Marks the first streamed delta of the in-flight request. Returns the
       * measured TTFT exactly once (on that first delta), undefined otherwise.
       * Tokens/sec is intentionally not estimated mid-stream: real token counts
       * only arrive with the provider usage at message end.
       */
      function recordDelta(): FirstToken | undefined {
        const request = inflight
        if (request === undefined || request.firstTokenAt !== undefined) {
          return undefined
        }

        request.firstTokenAt = performance.now()
        return { ttftMs: request.firstTokenAt - request.requestStart }
      }

      function endRequest(outcome: RequestOutcome): void {
        const request = inflight
        inflight = undefined
        const end = performance.now()

        if (
          request?.firstTokenAt === undefined ||
          outcome.stopReason === 'error' ||
          outcome.stopReason === 'aborted' ||
          outcome.outputTokens <= 0
        ) {
          // Nothing measurable or an interrupted stream: drop the measurement.
          return
        }

        samples.push({
          model: outcome.model,
          ttftMs: request.firstTokenAt - request.requestStart,
          generationMs: Math.max(end - request.firstTokenAt, 1),
          outputTokens: outcome.outputTokens,
        })
        if (samples.length >= MAX_SAMPLES * 2) {
          // Amortized trim: let the buffer grow to twice the window, then cut
          // back in one splice instead of shifting on every append.
          samples.splice(0, samples.length - MAX_SAMPLES)
        }
      }

      function recent(): RecentSpeed | undefined {
        return recentSpeed(samples)
      }

      function reset(): void {
        samples.length = 0
        inflight = undefined
      }

      function report(): SessionReport {
        return {
          requestCount: samples.length,
          recent: recentSpeed(samples),
          last: samples.at(-1),
          // Grouped by model, most-used model first.
          stats: pipe(
            Record.toEntries(Array.groupBy(samples, (sample) => sample.model)),
            Array.map(([model, group]): ModelStats => {
              const totalTokens = Number.sumAll(
                group.map((sample) => sample.outputTokens),
              )
              return {
                model,
                requests: group.length,
                tps:
                  totalTokens /
                  (Number.sumAll(group.map((sample) => sample.generationMs)) / 1000),
                totalTokens,
                ttft: tailSummary(
                  group.map((sample) => sample.ttftMs),
                  'high',
                ),
                requestTps: tailSummary(group.map(tokensPerSecond), 'low'),
              }
            }),
            Array.sortWith(
              (stats: ModelStats) => stats.requests,
              Order.flip(Order.Number),
            ),
          ),
        }
      }

      return {
        beginRequest,
        recordDelta,
        endRequest,
        recent,
        reset,
        report,
      } as const
    }),
  },
) {}
