import type {
  AgentToolResult,
  Theme,
  ThemeColor,
  TruncationResult,
} from '@earendil-works/pi-coding-agent'
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  keyHint,
} from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'
import { Text, truncateToWidth } from '@earendil-works/pi-tui'

/** pi's standard hint for content hidden behind the expand keybinding. */
function expandHint(hidden: number, theme: Theme): string {
  return `${theme.fg('muted', `... (${hidden} more lines,`)} ${keyHint(
    'app.tools.expand',
    'to expand',
  )})`
}

export interface TextPreviewOptions {
  text: string
  /** Visual lines to show before the rest is folded behind the expand hint. */
  maxLines: number
  expanded: boolean
  theme: Theme
  /** Theme color applied to the preview body. */
  color?: ThemeColor
}

/**
 * Previews `text` capped at `maxLines` *visual* lines: lines as the terminal
 * wraps them at the actual render width, so one long paragraph previews as its
 * first wrapped lines instead of a wall of text.
 */
export class TextPreview implements Component {
  private readonly body: Text
  private readonly maxLines: number
  private readonly expanded: boolean
  private readonly theme: Theme

  constructor({
    text,
    maxLines,
    expanded,
    theme,
    color = 'dim',
  }: TextPreviewOptions) {
    // Color per source line; wrapping carries the codes onto each visual line.
    const styled = text
      .split('\n')
      .map((line) => theme.fg(color, line))
      .join('\n')
    this.body = new Text(styled, 0, 0)
    this.maxLines = maxLines
    this.expanded = expanded
    this.theme = theme
  }

  invalidate(): void {
    this.body.invalidate()
  }

  render(width: number): string[] {
    const lines = this.body.render(width)
    const hidden = lines.length - this.maxLines
    if (this.expanded || hidden <= 0) {
      return lines
    }
    return [
      ...lines.slice(0, this.maxLines),
      truncateToWidth(expandHint(hidden, this.theme), width, '...'),
    ]
  }
}

/** Joins all text blocks of a tool result into one string, stripping carriage returns. */
export function getTextOutput(
  result: Pick<AgentToolResult<unknown>, 'content'>,
): string {
  return result.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text.replace(/\r/g, ''))
    .join('\n')
}

/**
 * Renders a `header` above its `content`. Trailing blank lines are dropped and
 * the body is capped to a 10-line preview unless `expanded`; when the preview
 * hides lines a "... (N more lines, ... to expand)" hint is appended. A
 * `truncation` notice footer is added when provided.
 */
export function renderExpandableText({
  header,
  content,
  expanded,
  theme,
  truncation,
}: {
  header: string
  content: string
  expanded: boolean
  theme: Theme
  truncation?: TruncationResult
}): string {
  const lines = content.split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  const maxLines = expanded ? lines.length : 10
  const displayLines = lines.slice(0, maxLines)
  const remaining = lines.length - maxLines

  let text = header

  if (displayLines.length > 0) {
    text += `\n${displayLines
      .map((line) => theme.fg('toolOutput', line.replace(/\t/g, '   ')))
      .join('\n')}`
  } else {
    text += `\n${theme.fg('dim', '(empty response)')}`
  }

  if (remaining > 0) {
    text += `\n${expandHint(remaining, theme)}`
  }

  if (truncation) {
    const notice = formatTruncationNotice(truncation)
    if (notice) {
      text += `\n${theme.fg('warning', notice)}`
    }
  }

  return text
}

/**
 * Builds a human-readable notice describing how a result was truncated (by line
 * or byte limit), or an empty string when it was not truncated.
 */
export function formatTruncationNotice(truncation: TruncationResult): string {
  let result = ''

  if (truncation.truncated) {
    if (truncation.firstLineExceedsLimit) {
      result = `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`
    }

    if (truncation.truncatedBy === 'lines') {
      result = `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`
    } else if (truncation.truncatedBy === 'bytes') {
      result = `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`
    }
  }

  return result
}
