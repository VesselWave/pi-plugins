import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { runHandler } from '@pi-plugins/shared/run'
import { Array, Effect, Option, pipe, Schema } from 'effect'
import { Snapshotter, SnapshotterError } from './snapshot'

/** `customType` of the hidden session entries that carry a snapshot tree hash. */
const CHECKPOINT_TYPE = 'file-checkpoint'

/** User-facing choices when navigating to a point with a different file state. */
const CHOICE_CONVERSATION = 'Conversation only (keep files as they are)'
const CHOICE_RESTORE = 'Conversation and files'
const CHOICE_CANCEL = 'Cancel navigation'

/** The tree hash stored on `entry`, if it is one of our checkpoint entries. */
function checkpointOf(entry: SessionEntry | undefined): string | undefined {
  if (entry?.type !== 'custom' || entry.customType !== CHECKPOINT_TYPE) {
    return undefined
  }

  return pipe(
    Schema.decodeUnknownOption(Schema.Struct({ tree: Schema.String }))(entry.data),
    Option.map((data) => data.tree),
    Option.getOrUndefined,
  )
}

/** Nearest checkpoint at or above `fromId` in the session tree. */
function nearestCheckpoint(
  session: ExtensionContext['sessionManager'],
  fromId: string | null,
): string | undefined {
  for (let id = fromId; id !== null;) {
    const entry = session.getEntry(id)
    if (!entry) {
      return undefined
    }

    const tree = checkpointOf(entry)
    if (tree) {
      return tree
    }

    id = entry.parentId
  }

  return undefined
}

/**
 * The file state associated with navigating to `targetId`: a checkpoint
 * directly below the target, or the nearest ancestor checkpoint.
 */
function restoreTree(
  session: ExtensionContext['sessionManager'],
  targetId: string,
): string | undefined {
  return pipe(
    session.getEntries(),
    Array.findFirst((entry) =>
      entry.parentId === targetId
        ? Option.fromUndefinedOr(checkpointOf(entry))
        : Option.none(),
    ),
    Option.getOrElse(() => nearestCheckpoint(session, targetId)),
  )
}

export default function checkpoint(pi: ExtensionAPI) {
  let snapshotter: Snapshotter['Service'] | undefined

  pi.on('session_start', async (_event, ctx) => {
    // Only active inside git worktrees.
    snapshotter = await runHandler(
      Snapshotter.make(ctx.cwd).pipe(
        Effect.provide(NodeServices.layer),
        // Being outside a worktree is the normal way to have no snapshotter.
        Effect.catchIf(
          (error) =>
            error instanceof SnapshotterError && error.kind === 'NotAWorktree',
          () => Effect.succeed(undefined),
        ),
      ),
      {
        onError: (message) => {
          if (ctx.hasUI) {
            ctx.ui.notify(`Checkpoints disabled: ${message}`, 'warning')
          }
          return undefined
        },
      },
    )
  })

  /**
   * Records the current file state as a checkpoint at the current leaf,
   * skipping entries when the branch already ends in an identical state.
   * Running on both `turn_start` and `turn_end` brackets every turn with a
   * before/after snapshot pair.
   */
  const recordCheckpoint = async (ctx: ExtensionContext) => {
    if (!snapshotter) {
      return
    }
    // Current worktree state as a tree hash, or undefined when tracking fails.
    const tree = await runHandler(snapshotter.track())
    if (!tree) {
      return
    }
    const session = ctx.sessionManager
    if (nearestCheckpoint(session, session.getLeafId()) !== tree) {
      pi.appendEntry(CHECKPOINT_TYPE, { tree })
    }
  }

  pi.on('turn_start', async (_event, ctx) => recordCheckpoint(ctx))
  pi.on('turn_end', async (_event, ctx) => recordCheckpoint(ctx))

  pi.registerCommand('checkpoint-cleanup', {
    description: 'Delete stored file checkpoint history for this worktree',
    handler: async (_args, ctx) => {
      await ctx.waitForIdle()
      if (!snapshotter || !ctx.hasUI) {
        return undefined
      }

      if (
        !(await ctx.ui.confirm(
          'Delete file checkpoints?',
          'This removes the stored file history for every session in this worktree. Conversation history is not affected.',
        ))
      ) {
        return undefined
      }

      await runHandler(
        snapshotter.cleanup().pipe(
          Effect.tap((tree) =>
            Effect.sync(() => {
              const session = ctx.sessionManager
              if (nearestCheckpoint(session, session.getLeafId()) !== tree) {
                pi.appendEntry(CHECKPOINT_TYPE, { tree })
              }
              ctx.ui.notify('File checkpoint history cleaned up', 'info')
            }),
          ),
        ),
        {
          onError: (message) => {
            ctx.ui.notify(`Checkpoint cleanup failed: ${message}`, 'error')
          },
        },
      )
    },
  })

  pi.on('session_before_tree', async (event, ctx) => {
    if (!snapshotter || !ctx.hasUI) {
      return undefined
    }
    const session = ctx.sessionManager
    const target = restoreTree(session, event.preparation.targetId)
    if (!target) {
      return undefined
    }

    const current = await runHandler(snapshotter.track())
    if (!current || current === target) {
      return undefined
    }

    const choice = await ctx.ui.select(
      'Files changed since that point in the conversation. What should be restored?',
      [CHOICE_CONVERSATION, CHOICE_RESTORE, CHOICE_CANCEL],
    )
    if (choice !== CHOICE_RESTORE) {
      return choice === CHOICE_CANCEL ? { cancel: true } : undefined
    }

    // Preserve the abandoned state on the old branch so that navigating back
    // to it can restore the files again (redo).
    if (nearestCheckpoint(session, session.getLeafId()) !== current) {
      pi.appendEntry(CHECKPOINT_TYPE, { tree: current })
    }

    return runHandler(
      snapshotter.restore(target).pipe(
        Effect.map(() => {
          ctx.ui.notify('Files restored to the selected point', 'info')
          return undefined
        }),
      ),
      {
        onError: (message) => {
          ctx.ui.notify(`File restore failed: ${message}`, 'error')
          return { cancel: true }
        },
      },
    )
  })
}
