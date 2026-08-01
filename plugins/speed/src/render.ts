import type { FirstToken, RecentSpeed } from './service'

/** "42.3 tok/s", "128 tok/s" */
function formatTps(tps: number): string {
  return `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} tok/s`
}

/** "830ms", "1.24s", "27.3s", "94s" */
function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`
  }
  const seconds = ms / 1000
  if (seconds < 10) {
    return `${seconds.toFixed(2)}s`
  }
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`
}

/** `~` marks an estimate that has not yet seen a half-life of evidence. */
function recentTps(recent: RecentSpeed): string {
  return `${recent.provisional ? '~' : ''}${formatTps(recent.tps)}`
}

export function recentText(recent: RecentSpeed): string {
  return `${recentTps(recent)} · TTFT ${formatMs(recent.ttftMs)}`
}

/**
 * Throughput stays on screen mid-stream because it describes the model, not the
 * in-flight request. It is never estimated from the running stream — it moves
 * only once a request completes and the provider reports real token counts.
 */
export function streamingText(
  recent: RecentSpeed | undefined,
  firstToken: FirstToken,
): string {
  const ttft = `TTFT ${formatMs(firstToken.ttftMs)}`
  return recent === undefined ? ttft : `${recentTps(recent)} · ${ttft}`
}
