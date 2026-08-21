import * as path from 'node:path'
import { getAgentDir, truncateHead } from '@earendil-works/pi-coding-agent'
import { formatTruncationNotice } from '@pi-plugins/shared/ui'
import type { SubagentResult } from './runner'

/**
 * Beside pi's per-project session directories, which are always `--<cwd>--`, so
 * child sessions stay out of `pi -c` / `pi -r` but resolve by id from anywhere.
 */
export function subagentSessionDir(): string {
  return path.join(getAgentDir(), 'sessions', 'subagents')
}

/** Caps text to pi's standard tool-output limits, appending a notice when truncated. */
export function capToolOutput(text: string): string {
  const truncation = truncateHead(text)
  return truncation.truncated
    ? `${truncation.content}\n\n${formatTruncationNotice(truncation)}`
    : truncation.content
}

/** Formats a token count compactly (e.g. `950`, `1.2k`, `45k`, `1.3M`). */
export function formatTokens(count: number): string {
  if (count < 1000) {
    return count.toString()
  }
  if (count < 10000) {
    return `${(count / 1000).toFixed(1)}k`
  }
  if (count < 1000000) {
    return `${Math.round(count / 1000)}k`
  }
  return `${(count / 1000000).toFixed(1)}M`
}

/** Formats a duration compactly (e.g. `9s`, `1m22s`, `2h07m30s`). */
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }

  const seconds = `${totalSeconds % 60}`.padStart(2, '0')
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  return hours > 0
    ? `${hours}h${`${minutes}`.padStart(2, '0')}m${seconds}s`
    : `${minutes}m${seconds}s`
}

/** Formats a finished run as one line: turns, tools, tokens, cost, duration. */
export function formatStats(result: SubagentResult): string {
  const { usage, toolCalls } = result
  const parts: string[] = []
  if (usage.turns > 0) {
    parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`)
  }
  if (toolCalls > 0) {
    parts.push(`${toolCalls} tool${toolCalls > 1 ? 's' : ''}`)
  }
  if (usage.input > 0) {
    parts.push(`↑${formatTokens(usage.input)}`)
  }
  if (usage.output > 0) {
    parts.push(`↓${formatTokens(usage.output)}`)
  }
  if (usage.cacheRead > 0) {
    parts.push(`R${formatTokens(usage.cacheRead)}`)
  }
  if (usage.cacheWrite > 0) {
    parts.push(`W${formatTokens(usage.cacheWrite)}`)
  }
  if (usage.cost > 0) {
    parts.push(`$${usage.cost.toFixed(4)}`)
  }
  if (result.durationMs !== undefined) {
    parts.push(formatDuration(result.durationMs))
  }
  return parts.join(' ')
}

/** Builds a `pi --model` pattern (`provider/id:<thinking>`) pinning model and thinking level. */
export function modelPattern(
  model: { provider: string; id: string },
  thinkingLevel?: string,
): string {
  const base = `${model.provider}/${model.id}`
  return thinkingLevel !== undefined ? `${base}:${thinkingLevel}` : base
}
