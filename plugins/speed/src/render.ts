import type { FirstToken, RecentSpeed } from './service'

/** Whole tokens: the standard error runs to a few percent, so a decimal is noise. */
function formatTps(tps: number): string {
  return `${Math.round(tps)} tok/s`
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

function recentTps(recent: RecentSpeed): string {
  return `${recent.provisional ? '~' : ''}${formatTps(recent.tps)}`
}

export function recentText(recent: RecentSpeed): string {
  return `${recentTps(recent)} · TTFT ${formatMs(recent.ttftMs)}`
}

/**
 * Throughput stays on screen mid-stream because it describes the model, not the
 * in-flight request, and moves only once real token counts arrive.
 */
export function streamingText(
  recent: RecentSpeed | undefined,
  firstToken: FirstToken,
): string {
  const ttft = `TTFT ${formatMs(firstToken.ttftMs)}`
  return recent === undefined ? ttft : `${recentTps(recent)} · ${ttft}`
}
