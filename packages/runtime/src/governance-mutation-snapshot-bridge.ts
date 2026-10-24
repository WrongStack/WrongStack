import type { EventBus } from '@wrongstack/contracts/kernel';
import type { WorkspaceCheckpointRef } from '@wrongstack/contracts/types';
import type { AgentPipelines, ToolCallPipelinePayload } from '@wrongstack/core/agent';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { GovernanceRuntimeWorkspaceSnapshotResult } from './governance-bootstrap.js';

export const MAX_PENDING_GOVERNANCE_MUTATION_SNAPSHOTS = 64;

export interface GovernanceWorkspaceSnapshotSink {
  recordWorkspaceSnapshot(manifestHash: string): Promise<GovernanceRuntimeWorkspaceSnapshotResult>;
}

export interface GovernanceMutationSnapshotBridge {
  installToolBoundary(pipelines: AgentPipelines): void;
  close(): Promise<void>;
}

export function createGovernanceMutationSnapshotBridge(input: {
  readonly events: EventBus;
  readonly sink: GovernanceWorkspaceSnapshotSink;
  readonly captureWorkspaceCheckpoint: () => Promise<WorkspaceCheckpointRef | undefined>;
  readonly logger: { warn(message: string, context?: unknown): void };
}): GovernanceMutationSnapshotBridge {
  let closed = false;
  const warned = new Set<string>();
  let pending = 0;
  let tail: Promise<void> = Promise.resolve();
  const installedPipelines = new WeakSet<AgentPipelines>();
  const awaitedCompletions = new Set<string>();

  const warnOnce = (message: string, context?: unknown): void => {
    if (warned.has(message)) return;
    warned.add(message);
    if (context === undefined) input.logger.warn(message);
    else input.logger.warn(message, context);
  };

  const completionKey = (
    sessionId: string | undefined,
    toolCallId: string | undefined,
  ): string | undefined =>
    sessionId === undefined || toolCallId === undefined ? undefined : `${sessionId}\0${toolCallId}`;

  const rememberAwaitedCompletion = (key: string | undefined): void => {
    if (key === undefined || awaitedCompletions.has(key)) return;
    awaitedCompletions.add(key);
    // Set order tracks only outstanding acknowledgements. A separate history
    // can retain a consumed key and later evict a newer use of that same id.
    if (awaitedCompletions.size > 512) {
      const oldest = awaitedCompletions.values().next().value;
      if (oldest !== undefined) awaitedCompletions.delete(oldest);
    }
  };

  const enqueueSnapshot = async (
    completion: { readonly ok: boolean; readonly mutating: boolean },
    awaitedBoundary = false,
  ): Promise<void> => {
    if (closed || !completion.ok || !completion.mutating) return;
    while (pending >= MAX_PENDING_GOVERNANCE_MUTATION_SNAPSHOTS) {
      if (awaitedBoundary) {
        await tail;
        if (closed) return;
        continue;
      }
      warnOnce('governance: mutation snapshot queue reached bounded capacity', {
        capacity: MAX_PENDING_GOVERNANCE_MUTATION_SNAPSHOTS,
      });
      return;
    }
    pending += 1;
    const settled = tail
      .then(async () => {
        const checkpoint = await input.captureWorkspaceCheckpoint();
        if (!checkpoint || !/^[a-f0-9]{64}$/u.test(checkpoint.manifestHash)) {
          warnOnce('governance: failed to capture a valid post-mutation workspace identity');
          return;
        }
        const result = await input.sink.recordWorkspaceSnapshot(checkpoint.manifestHash);
        if (!result.recorded) {
          warnOnce('governance: post-mutation workspace snapshot was not recorded', {
            code: result.code,
            message: result.message,
          });
        }
      })
      .catch((error) => {
        warnOnce('governance: post-mutation workspace snapshot failed open', {
          message: toErrorMessage(error),
        });
      })
      .finally(() => {
        pending -= 1;
      });
    tail = settled;
    await settled;
  };

  const dispose = input.events.on('tool.executed', (event) => {
    const key = completionKey(event.sessionId, event.id);
    if (key !== undefined && awaitedCompletions.delete(key)) return;
    void enqueueSnapshot({ ok: event.ok, mutating: event.mutating === true });
  });

  return Object.freeze({
    installToolBoundary: (pipelines: AgentPipelines) => {
      if (closed || installedPipelines.has(pipelines)) return;
      pipelines.toolCall.prepend({
        name: 'GovernanceWorkspaceSnapshotFence',
        owner: 'governance-compatibility',
        handler: async (
          payload: ToolCallPipelinePayload,
          next: (value: ToolCallPipelinePayload) => Promise<ToolCallPipelinePayload>,
        ) => {
          let completed = payload;
          let succeeded = false;
          try {
            completed = await next(payload);
            succeeded = true;
            return completed;
          } finally {
            const sessionId = completed.ctx.activeRunSessionId ?? completed.ctx.session?.id;
            const key = completionKey(sessionId, completed.toolUse.id);
            await enqueueSnapshot(
              {
                ok: succeeded && !completed.result?.is_error,
                mutating: completed.tool?.mutating === true,
              },
              true,
            );
            rememberAwaitedCompletion(key);
          }
        },
      });
      // A failed registration must remain retryable after its conflict is removed.
      installedPipelines.add(pipelines);
    },
    close: async () => {
      if (!closed) {
        closed = true;
        dispose();
      }
      await tail;
    },
  });
}
