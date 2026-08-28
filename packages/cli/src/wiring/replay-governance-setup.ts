import type { Container, EventBus } from '@wrongstack/core/kernel';
import type { WstackPaths } from '@wrongstack/core/utils';
import type { Logger, MemoryPort, SessionStore } from '@wrongstack/core/types';
import { setupCliGovernance } from '../cli-main-helpers.js';
import { configureSimpleUiRuntimeContext, type CliFlags } from '../boot/simpleui-full-auto.js';

interface SetupReplayAndGovernanceOptions {
  flags: CliFlags;
  container: Container;
  wpaths: WstackPaths;
  projectRoot: string;
  session: { id: string };
  sessionRef: { current: { id: string } | undefined };
  logger: Logger;
  events: EventBus;
  planPath: string;
  sessionStore: SessionStore;
  context: { meta: Record<string, unknown> };
  traceId?: string | undefined;
  memoryStore: MemoryPort;
}

export async function setupReplayAndGovernance({
  flags,
  container,
  wpaths,
  projectRoot,
  session,
  sessionRef,
  logger,
  events,
  planPath,
  sessionStore,
  context,
  traceId,
  memoryStore,
}: SetupReplayAndGovernanceOptions) {
  const replayFlag = flags['replay'];
  const recordFlag = flags['record'];
  if (typeof replayFlag === 'string' || recordFlag === true) {
    const { bindReplayToContainer } = await import('./replay.js');
    const mode = recordFlag === true ? 'record' : 'replay';
    bindReplayToContainer({
      container,
      wpaths,
      sessionId: typeof replayFlag === 'string' ? replayFlag : () => sessionRef.current?.id ?? '',
      mode,
      logger,
    });
    logger.info(
      `replay: ProviderRunner bound in '${mode}' mode for session ${
        typeof replayFlag === 'string' ? replayFlag : session.id
      }`,
    );
  }

  const governanceHandle = await setupCliGovernance({
    projectRoot,
    projectId: wpaths.projectSlug ?? '',
    sessionId: session.id,
    contextMeta: context.meta,
    logger,
    events,
    planPath,
    captureWorkspaceCheckpoint: async () =>
      sessionStore.captureWorkspaceCheckpoint?.(session.id, 0),
  });

  configureSimpleUiRuntimeContext(context.meta, flags);

  if (traceId) {
    memoryStore.withTraceId(traceId);
  }

  return { governanceHandle };
}
