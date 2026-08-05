import * as path from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { ExpandableText, TextPreview } from '@pi-plugins/shared'
import { Effect } from 'effect'
import { Type, type Static } from 'typebox'
import {
  emptyResult,
  runSubagent,
  type SubagentResult,
  type SubagentUsage,
} from './runner'
import {
  capToolOutput,
  formatStats,
  modelPattern,
  subagentSessionDir,
} from './utils'

// Wrapped terminal rows, not source lines, so a row's height is bounded whatever
// the prompt and the output happen to be shaped like.
const PROMPT_PREVIEW_LINES = 3
const OUTPUT_PREVIEW_LINES = 5
const METADATA_LABEL_WIDTH = 9

const subagentSchema = Type.Object({
  description: Type.String({
    description: 'A short (3-5 word) description of the task',
  }),
  prompt: Type.String({
    description: 'The task for the agent to perform',
  }),
  model: Type.Optional(
    Type.String({
      description:
        'Optional model override for this agent (defaults to the current model and thinking level)',
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: 'Working directory for the agent process',
    }),
  ),
})

export type SubagentInput = Static<typeof subagentSchema>

interface SubagentDetails extends SubagentResult {
  cwd?: string | undefined
  model?: string | undefined
  /** Set on the final result when the run failed. */
  failed?: boolean | undefined
  errorMessage?: string | undefined
  stderr?: string | undefined
}

export default function subagent(pi: ExtensionAPI) {
  const pending: SubagentUsage[] = []

  // Fold subagent cost back into the parent session so the footer's cumulative
  // cost includes delegated work.
  pi.on('message_end', ({ message }) => {
    if (
      message.role !== 'assistant' ||
      message.usage.totalTokens <= 0 ||
      pending.length === 0
    ) {
      return undefined
    }
    const cost = { ...message.usage.cost }
    for (const run of pending.splice(0)) {
      // Only `cost.total` is folded. The per-request token fields (input, output,
      // cacheRead, cacheWrite) must stay untouched as they are used by pi's auto-compaction heuristics.
      // Cost is only ever summed for display, so it is safe to fold.
      cost.total += run.cost
    }
    return { message: { ...message, usage: { ...message.usage, cost } } }
  })

  pi.registerTool<typeof subagentSchema, SubagentDetails>({
    name: 'subagent',
    label: 'Subagent',
    description:
      'Delegate a task to a subagent: a fresh headless pi instance with its own isolated context window. ' +
      'The subagent receives only the given prompt (no conversation history) and returns its final response, ' +
      'so include all necessary context in the prompt and describe exactly what it should report back. ' +
      'Use it to keep large exploration or self-contained subtasks out of the main context.',
    promptSnippet:
      'Delegate self-contained tasks to subagents (isolated headless pi instances).',
    parameters: subagentSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // An omitted `model` should mean "same model", not "child default".
      const model =
        params.model ??
        (ctx.model !== undefined
          ? modelPattern(ctx.model, pi.getThinkingLevel())
          : undefined)

      // Resolve relative cwd against the parent session's cwd, not the process
      // cwd (they can differ for resumed/cross-project sessions).
      const cwd =
        params.cwd !== undefined ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd

      // Inherit the parent's active tool set (minus subagent itself) so a
      // restricted parent (e.g. `pi --tools read`) cannot be escaped by
      // delegating to a child with default tools.
      const tools = pi.getActiveTools().filter((name) => name !== 'subagent')

      const program = runSubagent({
        prompt: params.prompt,
        sessionDir: subagentSessionDir(),
        name: params.description,
        model,
        cwd,
        tools,
        // The only live update: each one repaints pi's scrollback once the row
        // has scrolled out of view.
        onSession: (sessionId) => {
          onUpdate?.({
            content: [{ type: 'text', text: '' }],
            details: { ...emptyResult, sessionId, model, cwd },
          })
        },
      }).pipe(
        Effect.map((result) => ({
          content: [
            {
              type: 'text' as const,
              text: result.output ? capToolOutput(result.output) : '(no output)',
            },
          ],
          details: { ...result, model, cwd },
        })),
        Effect.catch((error) => {
          const result = 'result' in error ? error.result : emptyResult
          const label = error._tag === 'SubagentStopError' ? error.reason : 'failed'
          const reason =
            error._tag === 'PlatformError'
              ? `Failed to run subagent: ${error.message}`
              : error.message
          return Effect.succeed({
            content: [
              {
                type: 'text' as const,
                text: `Subagent ${label}: ${capToolOutput(reason)}`,
              },
            ],
            details: {
              ...result,
              model,
              cwd,
              failed: true,
              errorMessage: reason,
              stderr: 'stderr' in error ? error.stderr : undefined,
            },
            isError: true,
          })
        }),
        Effect.tap(({ details }) => Effect.sync(() => pending.push(details.usage))),
        Effect.provide(NodeServices.layer),
      )

      return await Effect.runPromise(program, { signal })
    },
    renderCall(args, theme, { expanded }) {
      const title = new Text(
        theme.fg('toolTitle', theme.bold('subagent ')) +
          theme.fg('accent', args.description ?? '...'),
        0,
        0,
      )
      if (args.prompt === undefined) {
        return title
      }

      const preview = new TextPreview({
        text: args.prompt,
        maxLines: PROMPT_PREVIEW_LINES,
        expanded,
        theme,
      })
      return {
        render: (width) => [...title.render(width), ...preview.render(width)],
        invalidate: () => {
          title.invalidate()
          preview.invalidate()
        },
      }
    },
    renderResult({ details }, { expanded, isPartial }, theme, context) {
      const metadata: Array<[string, string]> = []
      if (details.cwd !== undefined && details.cwd !== context.cwd) {
        metadata.push(['cwd', details.cwd])
      }
      if (details.model !== undefined) {
        metadata.push(['model', details.model])
      }
      if (details.sessionId !== undefined) {
        // Never a prefix: uuidv7 ids share their leading digits across a batch.
        metadata.push(['session', details.sessionId])
      }

      const metadataBlock = metadata
        .map(
          ([label, value]) =>
            theme.fg('dim', label.padEnd(METADATA_LABEL_WIDTH)) +
            theme.fg('muted', value),
        )
        .join('\n')

      // No status line while running: the pending background tint is the indicator.
      if (isPartial) {
        return new Text(metadataBlock ? `\n${metadataBlock}` : '', 0, 0)
      }

      const failed = details.failed === true
      const stats = formatStats(details)
      let status = failed ? theme.fg('error', '✗') : theme.fg('success', '✓')
      if (stats) {
        status += ` ${theme.fg('muted', stats)}`
      }

      const content =
        details.output ||
        (failed ? (details.stderr?.trim() ?? '') : '') ||
        '(no output)'

      let header = metadataBlock ? `\n${metadataBlock}\n\n${status}` : `\n${status}`
      // Skip the error line when it would repeat the rendered content.
      if (failed && details.errorMessage && details.errorMessage !== content) {
        header += `\n${theme.fg('error', `Error: ${details.errorMessage}`)}`
      }

      return new ExpandableText({
        header,
        // Keep the full output in details for explicit expansion, but bound what
        // the collapsed row has to wrap to pi's standard tool-output limits.
        content: expanded ? content : capToolOutput(content),
        maxLines: OUTPUT_PREVIEW_LINES,
        expanded,
        theme,
      })
    },
  })
}
