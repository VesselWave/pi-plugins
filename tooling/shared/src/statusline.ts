import { createRequire } from 'node:module'
import * as path from 'node:path'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Array, Order, pipe, String } from 'effect'

export interface StatuslineSegment {
  /** Plain text: the whole row is dimmed uniformly across plugins. */
  readonly text: string
  readonly align: 'left' | 'right'
}

const WIDGET_KEY = 'pi-plugins:statusline'

// Each plugin bundles its own copy of this module; `Symbol.for` on
// `globalThis` gives them all the same registry inside one pi process.
const REGISTRY_KEY = Symbol.for('@pi-plugins/statusline-registry')
const HOOKED_KEY = Symbol.for('@pi-plugins/editor-border-hooked')

type Registry = Map<string, StatuslineSegment>

function side(segments: Registry, align: StatuslineSegment['align']): string {
  return pipe(
    Array.fromIterable(segments),
    Array.filter(([, segment]) => segment.align === align),
    Array.sortBy(
      Order.mapInput(
        Order.String,
        ([key]: readonly [string, StatuslineSegment]) => key,
      ),
    ),
    Array.map(([, segment]) => segment.text),
    Array.join(' · '),
  )
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

function textWidth(text: string): number {
  return Array.fromIterable(stripAnsi(text)).length
}

interface CustomEditorLike {
  prototype: {
    renderTopBorder(width: number, hiddenLineCount: number): string
  }
}

function findCustomEditor(): CustomEditorLike | undefined {
  const req = createRequire(import.meta.url)

  if (typeof process !== 'undefined' && process.argv?.[1]) {
    try {
      const cliDir = path.dirname(process.argv[1])
      const bundleIndex = path.join(cliDir, 'index.js')
      const mod = req(bundleIndex) as { CustomEditor?: CustomEditorLike }
      if (mod.CustomEditor) {
        return mod.CustomEditor
      }
    } catch {
      // Ignore
    }
  }

  try {
    const resolved = req.resolve('@earendil-works/pi-coding-agent')
    const mod = req(resolved) as { CustomEditor?: CustomEditorLike }
    if (mod.CustomEditor) {
      return mod.CustomEditor
    }
  } catch {
    // Ignore
  }

  try {
    const fallback =
      '/home/user/.local/share/pnpm/global/v11/b1fd2-1a06d456c3a/node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js'
    const mod = req(fallback) as { CustomEditor?: CustomEditorLike }
    if (mod.CustomEditor) {
      return mod.CustomEditor
    }
  } catch {
    // Ignore
  }

  return undefined
}

function ensureBorderHooked(): boolean {
  const store = globalThis as {
    [HOOKED_KEY]?: boolean
    [REGISTRY_KEY]?: Registry
  }
  if (store[HOOKED_KEY]) {
    return true
  }

  const CustomEditor = findCustomEditor()
  if (!CustomEditor?.prototype?.renderTopBorder) {
    return false
  }

  const origRenderTopBorder = CustomEditor.prototype.renderTopBorder

  CustomEditor.prototype.renderTopBorder = function (
    this: {
      borderColor?: (text: string) => string
      theme?: { fg: (color: string, text: string) => string }
      embedWorkingStatus?: boolean
      workingStatusIndicator?: {
        renderInBorder: (width: number) => string
      }
    },
    width: number,
    hiddenLineCount: number,
  ): string {
    const segments = (globalThis as { [REGISTRY_KEY]?: Registry })[REGISTRY_KEY]
    if (!segments || segments.size === 0 || width <= 0) {
      return origRenderTopBorder.call(this, width, hiddenLineCount)
    }

    const leftText = side(segments, 'left')
    const rightText = side(segments, 'right')

    if (!leftText && !rightText) {
      return origRenderTopBorder.call(this, width, hiddenLineCount)
    }

    const color = this.borderColor ?? ((t: string) => t)
    const dimColor = this.theme?.fg
      ? (t: string) => this.theme!.fg('dim', t)
      : (t: string) => `\x1B[2m${t}\x1B[0m`

    const isWorking = Boolean(this.embedWorkingStatus && this.workingStatusIndicator)
    let status = ''
    let statusWidth = 0
    if (isWorking && this.workingStatusIndicator) {
      status = this.workingStatusIndicator.renderInBorder(Math.max(1, width - 5))
      statusWidth = textWidth(status)
    }

    const rightPartWidth = rightText ? textWidth(rightText) + 4 : 0
    const rightPart = rightText
      ? color(' ') + dimColor(rightText) + color(' ──')
      : ''

    const overflowLabel =
      hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined
    const overflowWidth = overflowLabel ? textWidth(overflowLabel) : 0

    if (isWorking && statusWidth > 0) {
      const leftPart = color('── ') + status + color(' ')
      const leftPartWidth = 3 + statusWidth + 1

      if (rightText && width >= leftPartWidth + rightPartWidth + 2) {
        const middleSpace = width - leftPartWidth - rightPartWidth
        let middle = ''
        if (overflowLabel && middleSpace >= overflowWidth + 2) {
          const rem = middleSpace - overflowWidth
          const d1 = Math.floor(rem / 2)
          const d2 = rem - d1
          middle = color('─'.repeat(d1)) + overflowLabel + color('─'.repeat(d2))
        } else {
          middle = color('─'.repeat(middleSpace))
        }
        return leftPart + middle + rightPart
      }
      return origRenderTopBorder.call(this, width, hiddenLineCount)
    }

    // Idle mode
    const leftPartWidth = leftText ? textWidth(leftText) + 4 : 0
    const leftPart = leftText ? color('── ') + dimColor(leftText) + color(' ') : ''

    if (width >= leftPartWidth + rightPartWidth + 2) {
      const middleSpace = width - leftPartWidth - rightPartWidth
      let middle = ''
      if (overflowLabel && middleSpace >= overflowWidth + 2) {
        const rem = middleSpace - overflowWidth
        const d1 = Math.floor(rem / 2)
        const d2 = rem - d1
        middle = color('─'.repeat(d1)) + overflowLabel + color('─'.repeat(d2))
      } else {
        middle = color('─'.repeat(middleSpace))
      }
      return leftPart + middle + rightPart
    }

    return origRenderTopBorder.call(this, width, hiddenLineCount)
  }

  store[HOOKED_KEY] = true
  return true
}

export function setStatuslineSegment(
  ctx: ExtensionContext,
  key: string,
  segment: StatuslineSegment | undefined,
): void {
  const store = globalThis as { [REGISTRY_KEY]?: Registry }
  store[REGISTRY_KEY] ??= new Map()
  const segments = store[REGISTRY_KEY]
  if (segment === undefined) {
    segments.delete(key)
  } else {
    segments.set(key, segment)
  }

  if (!ctx.hasUI) {
    return
  }

  const borderHooked = ensureBorderHooked()
  if (borderHooked) {
    // Top border rendering is hooked: clear widget above editor and trigger render
    ctx.ui.setWidget(WIDGET_KEY, undefined)
    ctx.ui.setStatus('pi-plugins:statusline-render', undefined)
    return
  }

  if (segments.size === 0) {
    ctx.ui.setWidget(WIDGET_KEY, undefined)
    return
  }

  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
    invalidate: () => {},
    render: (width: number) => {
      const left = side(segments, 'left')
      const right = side(segments, 'right')

      // Left indented one column like pi's widget rows, right flush like pi's footer.
      const margin = Math.min(width, 1)
      const inner = width - margin
      const gap = inner - textWidth(left) - textWidth(right)
      const minGap = String.isNonEmpty(left) && String.isNonEmpty(right) ? 2 : 0

      const line =
        String.isNonEmpty(right) && gap >= minGap
          ? `${left}${' '.repeat(gap)}${right}`
          : pipe(
              [left, right],
              Array.filter(String.isNonEmpty),
              Array.join(' · '),
              Array.fromIterable,
              Array.take(Math.max(inner, 0)),
              Array.join(''),
            )

      return [' '.repeat(margin) + theme.fg('dim', line)]
    },
  }))
}
