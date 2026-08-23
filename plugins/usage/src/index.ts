import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { loadExtensionConfig } from '@pi-plugins/shared/config'
import { runHandler } from '@pi-plugins/shared/run'
import { setStatuslineSegment } from '@pi-plugins/shared/statusline'
import { Effect, type Fiber, Schedule, Schema, Semaphore } from 'effect'
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

const UsageConfig = Schema.Struct({
  /** Show rate-limit bars above the editor for the active model's provider. */
  showWidget: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
})

/** Subscription the widget reports on, derived from the active model. */
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

/**
 * Turns a provider fetch into a report section, mapping failures to an
 * inline message so one provider failing never hides the other.
 */
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
  /** Latest widget limits per provider; kept across model switches. */
  const limitsCache = new Map<WidgetProvider, readonly WidgetLimit[]>()
  const fetchedAt = new Map<WidgetProvider, number>()
  const fetchLock = Semaphore.makeUnsafe(1)

  function recordLimits(
    provider: WidgetProvider,
    limits: readonly WidgetLimit[],
  ): void {
    limitsCache.set(provider, limits)
    fetchedAt.set(provider, Date.now())
  }

  function activeProvider(ctx: ExtensionContext): WidgetProvider | undefined {
    return ctx.hasUI && config.showWidget ? widgetProvider(ctx.model) : undefined
  }

  /** Redraws the segment from cache for the active model's provider. */
  function renderWidget(ctx: ExtensionContext): void {
    const provider = activeProvider(ctx)
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

  /** Refetches the active provider into the cache and repaints. */
  function fetchLimits(
    ctx: ExtensionContext,
    floorMs = 30_000,
  ): Effect.Effect<void, UsageServiceError> {
    // Inside the lock: whoever waited must re-judge the cache that fetch left.
    return fetchLock.withPermit(
      Effect.suspend(() => {
        const provider = activeProvider(ctx)
        if (provider === undefined) {
          return Effect.void
        }
        if (Date.now() - (fetchedAt.get(provider) ?? 0) < floorMs) {
          return Effect.void
        }

        return Effect.gen(function* () {
          const service = yield* UsageService
          recordLimits(
            provider,
            provider === 'claude'
              ? claudeWidgetLimits(yield* service.claude())
              : codexWidgetLimits(yield* service.codex(), new Date()),
          )
          renderWidget(ctx)
        }).pipe(
          Effect.provide(UsageService.layer(ctx.modelRegistry)),
          // Stamped on failure too, so a broken provider is not re-queried by
          // every event. Retrying is the poll loop's job, at its backed-off pace.
          Effect.onExit(() =>
            Effect.sync(() => fetchedAt.set(provider, Date.now())),
          ),
        )
      }),
    )
  }

  /** Redraws from cache, then refetches in the background when the data is stale. */
  async function refreshWidget(
    ctx: ExtensionContext,
    floorMs?: number,
  ): Promise<void> {
    renderWidget(ctx)
    // On failure keep whatever is shown. /usage reports errors explicitly.
    await runHandler(fetchLimits(ctx, floorMs))
  }

  let backgroundLoops: Fiber.Fiber<void, UsageServiceError> | undefined

  function startBackground(ctx: ExtensionContext): void {
    backgroundLoops?.interruptUnsafe()

    // Countdowns are baked into the segment text, so nothing else repaints them.
    const repaint = Effect.suspend(() => {
      renderWidget(ctx)
      const provider = activeProvider(ctx)
      if (provider === undefined) {
        return Effect.void
      }
      // A window that reset since the last attempt zeroed what is on screen.
      const now = Date.now()
      const attemptedAt = fetchedAt.get(provider) ?? 0
      const rolledOver = (limitsCache.get(provider) ?? []).some(
        ({ resetsAt }) =>
          resetsAt != null &&
          resetsAt.getTime() <= now &&
          resetsAt.getTime() > attemptedAt,
      )
      return rolledOver ? Effect.ignore(fetchLimits(ctx)) : Effect.void
    }).pipe(Effect.repeat(Schedule.fixed('1 minute')))

    // min() takes the shorter delay, capping the backoff at 30 minutes.
    const poll = fetchLimits(ctx).pipe(
      Effect.retry(
        Schedule.jittered(
          Schedule.min([
            Schedule.exponential('5 minutes'),
            Schedule.spaced('30 minutes'),
          ]),
        ),
      ),
      Effect.repeat(Schedule.spaced('5 minutes')),
    )

    backgroundLoops = Effect.runFork(
      Effect.all([repaint, poll], { concurrency: 'unbounded', discard: true }),
    )
  }

  pi.on('session_start', async (_event, ctx) => {
    config = await loadExtensionConfig(ctx, UsageConfig, EXTENSION_ID, config)
    await refreshWidget(ctx)
    if (ctx.hasUI && config.showWidget) {
      startBackground(ctx)
    }
  })

  pi.on('session_shutdown', () => {
    backgroundLoops?.interruptUnsafe()
    backgroundLoops = undefined
  })

  pi.on('model_select', async (_event, ctx) => {
    await refreshWidget(ctx)
  })

  // The one moment the numbers are known to have moved, so it skips the floor.
  pi.on('agent_settled', async (_event, ctx) => {
    await refreshWidget(ctx, 0)
  })

  pi.registerCommand('usage', {
    description:
      'Show subscription usage/rate limits for Claude and OpenAI Codex plans',
    handler: async (_args, ctx) => {
      const now = new Date()
      const program = Effect.gen(function* () {
        const service = yield* UsageService
        const sections = yield* Effect.all(
          [
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
          ],
          { concurrency: 'unbounded' },
        )
        // The UI only shows one message per severity, so group sections by
        // outcome: all successes in one info message, all failures in one
        // warning message.
        const rendered = renderSections(sections, now)
        const grouped = { info: [] as string[], warning: [] as string[] }
        sections.forEach((usageSection, index) => {
          grouped['error' in usageSection ? 'warning' : 'info'].push(
            rendered[index] ?? '',
          )
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
      // The command fetched fresh data for both providers — reuse it.
      renderWidget(ctx)
    },
  })
}
