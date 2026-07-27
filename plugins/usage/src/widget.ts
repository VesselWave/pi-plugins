import type { ClaudeUsage, UsageWindow } from './provider/anthropic'
import type { CodexUsage } from './provider/openai'
import { codexResetsAt, formatCompactDuration, parseResetsAt } from './reset'

/** One compact rate-limit entry shown on the shared status line. */
export interface WidgetLimit {
  /** Short window label, e.g. "5h" or "wk". */
  readonly label: string
  /** Percentage used, 0-100. */
  readonly percent: number
  /** When the window rolls over, if the provider reported it. */
  readonly resetsAt?: Date | null | undefined
}

const BAR_WIDTH = 5

function bar(percent: number): string {
  const clamped = Math.min(Math.max(percent, 0), 100)
  const filled = Math.round((clamped / 100) * BAR_WIDTH)
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`
}

function reset(limit: WidgetLimit, now: Date): string {
  if (!limit.resetsAt) {
    return ''
  }
  const delta = limit.resetsAt.getTime() - now.getTime()
  return ` (${delta > 0 ? formatCompactDuration(delta) : 'now'})`
}

/** "5h ██░░░ 41% (2h) · wk ███░░ 62% (4d)", or `undefined` when there is nothing to show. */
export function widgetText(
  limits: readonly WidgetLimit[] | undefined,
  now: Date,
): string | undefined {
  if (limits === undefined || limits.length === 0) {
    return undefined
  }
  return limits
    .map(
      (limit) =>
        `${limit.label} ${bar(limit.percent)} ${Math.round(limit.percent)}%` +
        reset(limit, now),
    )
    .join(' · ')
}

// ─── Claude ──────────────────────────────────────────────────────────────────

/** Short label for a unified-limit kind; model-scoped weekly limits are skipped. */
function claudeLimitLabel(kind: string): string | undefined {
  switch (kind) {
    case 'session':
      return '5h'
    case 'weekly_all':
      return 'wk'
    default:
      return undefined
  }
}

export function claudeWidgetLimits(usage: ClaudeUsage): WidgetLimit[] {
  const limits = usage.limits ?? []
  if (limits.length > 0) {
    // The unified `limits` array supersedes the flat windows when present.
    return limits.flatMap((limit) => {
      const label = claudeLimitLabel(limit.kind)
      return label !== undefined && typeof limit.percent === 'number'
        ? [
            {
              label,
              percent: limit.percent,
              resetsAt: parseResetsAt(limit.resets_at),
            },
          ]
        : []
    })
  }

  const windows: [string, UsageWindow | null | undefined][] = [
    ['5h', usage.five_hour],
    ['wk', usage.seven_day],
  ]
  return windows.flatMap(([label, window]) =>
    typeof window?.utilization === 'number'
      ? [
          {
            label,
            percent: window.utilization,
            resetsAt: parseResetsAt(window.resets_at),
          },
        ]
      : [],
  )
}

// ─── OpenAI Codex ────────────────────────────────────────────────────────────

function codexWindowLabel(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || seconds <= 0) {
    return '?'
  }
  if (seconds >= 604_800 * 0.9) {
    return 'wk'
  }
  if (seconds >= 86_400) {
    return `${Math.round(seconds / 86_400)}d`
  }
  return `${Math.round(seconds / 3600)}h`
}

export function codexWidgetLimits(usage: CodexUsage, now: Date): WidgetLimit[] {
  const details = usage.rate_limit
  return [details?.primary_window, details?.secondary_window].flatMap((window) =>
    window
      ? [
          {
            label: codexWindowLabel(window.limit_window_seconds),
            percent: window.used_percent,
            resetsAt: codexResetsAt(window, now),
          },
        ]
      : [],
  )
}
