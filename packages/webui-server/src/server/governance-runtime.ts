import type { AgentPipelines } from '@wrongstack/core/agent';
import type { EventBus } from '@wrongstack/core/kernel';
import type { Logger, WorkspaceCheckpointRef } from '@wrongstack/core/types';
import type {
  BootstrapGovernanceRuntimeOptions,
  GovernanceRuntimeBootstrapCloseResult,
  GovernanceRuntimeBootstrapResult,
} from '@wrongstack/runtime/governance-bootstrap';
import {
  createGovernanceMutationSnapshotBridge,
  type GovernanceMutationSnapshotBridge,
} from '@wrongstack/runtime/governance-mutation-snapshot-bridge';
import { sanitizeGovernanceMessage } from '@wrongstack/runtime/governance-sanitize';

export const WRONGSTACK_GOVERNANCE_ENV = 'WRONGSTACK_GOVERNANCE';

interface GovernanceBootstrapModule {
  bootstrapGovernanceRuntime(
    options: BootstrapGovernanceRuntimeOptions,
  ): Promise<GovernanceRuntimeBootstrapResult>;
}

interface WebUiGovernanceDependencies {
  readonly load: () => Promise<GovernanceBootstrapModule>;
  readonly createMutationBridge: typeof createGovernanceMutationSnapshotBridge;
}

const DEFAULT_DEPENDENCIES: WebUiGovernanceDependencies = {
  load: () => import('@wrongstack/runtime/governance-bootstrap'),
  createMutationBridge: createGovernanceMutationSnapshotBridge,
};

interface WebUiGovernanceRuntimeHandle {
  installToolBoundary(pipelines: AgentPipelines): void;
  close(): Promise<GovernanceRuntimeBootstrapCloseResult>;
}

export function webUiGovernanceRuntimeEnabled(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return environment[WRONGSTACK_GOVERNANCE_ENV]?.trim() === '1';
}

export async function setupWebUiGovernance(
  input: {
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly projectRoot: string;
    readonly projectId: string;
    readonly sessionId: string;
    readonly contextMeta: Record<string, unknown>;
    readonly events: EventBus;
    readonly logger: Pick<Logger, 'info' | 'warn'>;
    readonly captureWorkspaceCheckpoint: () => Promise<WorkspaceCheckpointRef | undefined>;
  },
  dependencies: WebUiGovernanceDependencies = DEFAULT_DEPENDENCIES,
): Promise<WebUiGovernanceRuntimeHandle | undefined> {
  if (!webUiGovernanceRuntimeEnabled(input.environment)) return undefined;

  let loaded: GovernanceBootstrapModule;
  try {
    loaded = await dependencies.load();
  } catch (error) {
    input.logger.warn('governance: standalone WebUI runtime module unavailable', {
      message: sanitizeGovernanceMessage(error instanceof Error ? error.message : String(error)),
    });
    return undefined;
  }

  let result: GovernanceRuntimeBootstrapResult;
  try {
    result = await loaded.bootstrapGovernanceRuntime({
      projectRoot: input.projectRoot,
      projectId: input.projectId,
      adminClientId: `webui-control-${process.pid}-${input.sessionId}`,
      modelClientId: `webui-model-${input.sessionId}`,
      modelCapabilities: ['task_read', 'command_submit', 'shadow_observe'],
    });
  } catch (error) {
    input.logger.warn('governance: standalone WebUI bootstrap failed open', {
      message: sanitizeGovernanceMessage(error instanceof Error ? error.message : String(error)),
    });
    return undefined;
  }

  if (result.mode !== 'governed') {
    input.contextMeta['governance'] = result;
    input.logger.warn(`governance: standalone WebUI legacy fallback (${result.code})`, {
      phase: result.phase,
      cleanup: result.cleanup,
      message: result.message,
    });
    return undefined;
  }

  const snapshot = result.handle.snapshot();
  input.contextMeta['governance'] = snapshot;
  input.logger.info(`governance: ${snapshot.source} standalone WebUI control plane`);
  const mutationSnapshots: GovernanceMutationSnapshotBridge = dependencies.createMutationBridge({
    events: input.events,
    sink: result.handle,
    captureWorkspaceCheckpoint: input.captureWorkspaceCheckpoint,
    logger: input.logger,
  });

  return Object.freeze({
    installToolBoundary: (pipelines: AgentPipelines) =>
      mutationSnapshots.installToolBoundary(pipelines),
    close: async () => {
      await mutationSnapshots.close();
      return result.handle.close();
    },
  });
}
