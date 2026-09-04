import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  readStoredCredential,
} from '@earendil-works/pi-coding-agent'
import type { AutocompleteItem } from '@earendil-works/pi-tui'
import { loadExtensionConfig } from '@pi-plugins/shared/config'
import { runHandler } from '@pi-plugins/shared/run'
import { setStatuslineSegment } from '@pi-plugins/shared/statusline'
import { Effect, Schema } from 'effect'
import {
  claudeSection,
  codexSection,
  renderSections,
  type UsageSection,
} from './render'
import { UsageService, type UsageServiceError } from './service'
import {
  claudeWidgetLimits,
  codexWidgetLimits,
  widgetText,
  type WidgetLimit,
} from './widget'

const EXTENSION_ID = 'usage'
const WIDGET_REFRESH_MS = 30_000

const UsageConfig = Schema.Struct({
  showWidget: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
})

type WidgetProvider = 'claude' | 'codex'

function widgetProvider(
  model: ExtensionContext['model'],
): WidgetProvider | undefined {
  switch (model?.provider) {
    case 'anthropic':
      return 'claude'
    case 'openai-codex':
      return 'codex'
    default:
      return undefined
  }
}

function saveExtensionConfig(conf: typeof UsageConfig.Type): void {
  try {
    const dir = path.join(getAgentDir(), 'extensions')
    fs.mkdirSync(dir, { recursive: true })
    const configFile = path.join(dir, `${EXTENSION_ID}.json`)
    fs.writeFileSync(configFile, JSON.stringify(conf, null, 2))
  } catch {
    // Ignore write failures
  }
}

function section<A>(
  title: string,
  fetch: Effect.Effect<A, UsageServiceError>,
  toSection: (usage: A) => UsageSection,
): Effect.Effect<UsageSection> {
  return fetch.pipe(
    Effect.map(toSection),
    Effect.catch((error) => Effect.succeed({ title, error: error.message })),
  )
}

export default function usage(pi: ExtensionAPI): void {
  let config = Schema.decodeUnknownSync(UsageConfig)({})
  const limitsCache = new Map<WidgetProvider, readonly WidgetLimit[]>()
  const fetchedAt = new Map<WidgetProvider, number>()
  const inFlight = new Set<WidgetProvider>()

  function recordLimits(
    provider: WidgetProvider,
    limits: readonly WidgetLimit[],
  ): void {
    limitsCache.set(provider, limits)
    fetchedAt.set(provider, Date.now())
  }

  function renderWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) {
      return
    }
    const provider = config.showWidget ? widgetProvider(ctx.model) : undefined
    const text =
      provider === undefined
        ? undefined
        : widgetText(limitsCache.get(provider), new Date())
    setStatuslineSegment(
      ctx,
      EXTENSION_ID,
      text === undefined ? undefined : { text, align: 'right' },
    )
  }

  async function refreshWidget(ctx: ExtensionContext): Promise<void> {
    renderWidget(ctx)
    if (!ctx.hasUI || !config.showWidget) {
      return
    }

    const provider = widgetProvider(ctx.model)
    if (provider === undefined || inFlight.has(provider)) {
      return
    }
    const last = fetchedAt.get(provider)
    if (last !== undefined && Date.now() - last < WIDGET_REFRESH_MS) {
      return
    }

    inFlight.add(provider)
    const program = Effect.gen(function* () {
      const service = yield* UsageService
      return provider === 'claude'
        ? claudeWidgetLimits(yield* service.claude())
        : codexWidgetLimits(yield* service.codex(), new Date())
    }).pipe(Effect.provide(UsageService.layer(ctx.modelRegistry)))

    let limits: WidgetLimit[] | undefined
    try {
      limits = await runHandler(program)
    } finally {
      inFlight.delete(provider)
      // Stamped on failure too, so a broken provider (e.g. not logged in) is not
      // re-queried on every event.
      fetchedAt.set(provider, Date.now())
    }
    if (limits !== undefined) {
      limitsCache.set(provider, limits)
      renderWidget(ctx)
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    config = await loadExtensionConfig(ctx, UsageConfig, EXTENSION_ID, config)
    await refreshWidget(ctx)
  })

  pi.on('model_select', async (_event, ctx) => {
    await refreshWidget(ctx)
  })

  // Past retries, auto-compaction and queued follow-ups, unlike agent_end.
  pi.on('agent_settled', async (_event, ctx) => {
    await refreshWidget(ctx)
  })

  async function toggleWidget(
    ctx: ExtensionContext,
    targetState?: boolean,
  ): Promise<void> {
    const next = targetState !== undefined ? targetState : !config.showWidget
    config = { ...config, showWidget: next }
    saveExtensionConfig(config)
    renderWidget(ctx)
    if (config.showWidget) {
      fetchedAt.delete('claude')
      fetchedAt.delete('codex')
      await refreshWidget(ctx)
    }
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Usage widget ${config.showWidget ? 'enabled' : 'disabled'}`,
        'info',
      )
    }
  }

  const toggleHandler = async (
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    const trimmed = args.trim().toLowerCase()
    if (trimmed === 'on' || trimmed === 'show') {
      await toggleWidget(ctx, true)
    } else if (trimmed === 'off' || trimmed === 'hide') {
      await toggleWidget(ctx, false)
    } else {
      await toggleWidget(ctx)
    }
  }

  pi.registerCommand('usage-toggle', {
    description: 'Toggle the usage statusline widget on or off',
    handler: toggleHandler,
  })

  pi.registerCommand('usage', {
    description:
      'Show subscription usage/rate limits for Claude and OpenAI Codex plans (or "/usage toggle")',
    getArgumentCompletions: (prefix) => {
      const options: AutocompleteItem[] = [
        {
          value: 'toggle',
          label: 'toggle',
          description: 'Toggle the statusline widget on or off',
        },
        { value: 'show', label: 'show', description: 'Show the statusline widget' },
        { value: 'hide', label: 'hide', description: 'Hide the statusline widget' },
      ]
      return options.filter((o) => o.value.startsWith(prefix.trim().toLowerCase()))
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim().toLowerCase()
      if (['toggle', 'on', 'off', 'show', 'hide', 'widget'].includes(trimmed)) {
        await toggleHandler(trimmed === 'widget' ? 'toggle' : trimmed, ctx)
        return
      }
      const now = new Date()
      const program = Effect.gen(function* () {
        const service = yield* UsageService
        const sectionsToFetch = []

        if (readStoredCredential('anthropic')?.type === 'oauth') {
          sectionsToFetch.push(
            section(
              'Claude',
              service
                .claude()
                .pipe(
                  Effect.tap((data) =>
                    Effect.sync(() =>
                      recordLimits('claude', claudeWidgetLimits(data)),
                    ),
                  ),
                ),
              claudeSection,
            ),
          )
        }

        sectionsToFetch.push(
          section(
            'OpenAI Codex',
            service
              .codex()
              .pipe(
                Effect.tap((data) =>
                  Effect.sync(() =>
                    recordLimits('codex', codexWidgetLimits(data, now)),
                  ),
                ),
              ),
            (data) => codexSection(data, now),
          ),
        )

        const sections = yield* Effect.all(sectionsToFetch, {
          concurrency: 'unbounded',
        })
        // The UI shows one message per severity, so sections are grouped by outcome.
        const rendered = renderSections(sections, now)
        const grouped = { info: [] as string[], warning: [] as string[] }
        sections.forEach((usageSection, index) => {
          if ('error' in usageSection) {
            // Claude warnings disabled
            if (usageSection.title !== 'Claude') {
              grouped.warning.push(rendered[index] ?? '')
            }
          } else {
            grouped.info.push(rendered[index] ?? '')
          }
        })
        return (['info', 'warning'] as const)
          .filter((severity) => grouped[severity].length > 0)
          .map((severity) => ({
            report: grouped[severity].join('\n\n'),
            severity,
          }))
      }).pipe(Effect.provide(UsageService.layer(ctx.modelRegistry)))

      const messages = await runHandler(program, {
        onError: (message) => {
          ctx.ui.notify(`Failed to fetch usage: ${message}`, 'error')
          return []
        },
      })
      for (const { report, severity } of messages) {
        ctx.ui.notify(report, severity)
      }
      renderWidget(ctx)
    },
  })
}
