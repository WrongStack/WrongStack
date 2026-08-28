import type { AgentPipelines } from '@wrongstack/core/agent';
import { getSharedProjectMailbox, type MailboxAgentStatus } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import type { Config, Logger, ModelsRegistry } from '@wrongstack/core/types';
import type {
  BootstrapGovernanceRuntimeOptions,
  GovernanceRuntimeBootstrapCloseResult,
  GovernanceRuntimeBootstrapHandle,
  GovernanceRuntimeBootstrapResult,
} from '@wrongstack/runtime/governance-bootstrap';
import { createGovernanceMutationSnapshotBridge } from '@wrongstack/runtime/governance-mutation-snapshot-bridge';
import { sanitizeGovernanceMessage } from '@wrongstack/runtime/governance-sanitize';
import { createGovernanceShadowBridge } from './boot/governance-shadow-bridge.js';
import { createGovernanceTraceContext } from './boot/governance-trace-context.js';
import { refreshRuntimeModelCatalog } from './context-limit.js';
import { buildPickableProviders } from './provider-helpers.js';

export const WRONGSTACK_GOVERNANCE_ENV = 'WRONGSTACK_GOVERNANCE';

interface BootstrapCliGovernanceOptions extends BootstrapGovernanceRuntimeOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
}

type CliGovernanceBootstrapResult =
  | { readonly mode: 'disabled'; readonly reason: 'feature_flag_off' }
  | GovernanceRuntimeBootstrapResult
  | {
      readonly mode: 'legacy';
      readonly code: 'module_unavailable';
      readonly phase: 'bootstrap';
      readonly message: string;
      readonly cleanup: 'not_required';
    };

interface GovernanceBootstrapModule {
  bootstrapGovernanceRuntime(
    options: BootstrapGovernanceRuntimeOptions,
  ): Promise<GovernanceRuntimeBootstrapResult>;
}

interface BootstrapCliGovernanceDependencies {
  readonly load: () => Promise<GovernanceBootstrapModule>;
}

const DEFAULT_GOVERNANCE_DEPENDENCIES: BootstrapCliGovernanceDependencies = {
  load: () => import('@wrongstack/runtime/governance-bootstrap'),
};

export function governanceRuntimeEnabled(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return environment[WRONGSTACK_GOVERNANCE_ENV]?.trim() === '1';
}

export function governedHandle(
  result: CliGovernanceBootstrapResult,
): GovernanceRuntimeBootstrapHandle | undefined {
  return result.mode === 'governed' ? result.handle : undefined;
}

export interface CliGovernanceRuntimeHandle {
  installToolBoundary(pipelines: AgentPipelines): void;
  close(): Promise<GovernanceRuntimeBootstrapCloseResult>;
}

export async function bootstrapCliGovernance(
  options: BootstrapCliGovernanceOptions,
  dependencies: BootstrapCliGovernanceDependencies = DEFAULT_GOVERNANCE_DEPENDENCIES,
): Promise<CliGovernanceBootstrapResult> {
  if (!governanceRuntimeEnabled(options.environment)) {
    return Object.freeze({ mode: 'disabled', reason: 'feature_flag_off' });
  }
  let loaded: GovernanceBootstrapModule;
  try {
    loaded = await dependencies.load();
  } catch (error) {
    return Object.freeze({
      mode: 'legacy',
      code: 'module_unavailable',
      phase: 'bootstrap',
      message: sanitizeGovernanceMessage(error instanceof Error ? error.message : String(error)),
      cleanup: 'not_required',
    });
  }
  try {
    return await loaded.bootstrapGovernanceRuntime({
      projectRoot: options.projectRoot,
      projectId: options.projectId,
      adminClientId: options.adminClientId,
      modelClientId: options.modelClientId,
      modelCapabilities: options.modelCapabilities,
      ...(options.adminTtlMs === undefined ? {} : { adminTtlMs: options.adminTtlMs }),
      ...(options.modelTtlMs === undefined ? {} : { modelTtlMs: options.modelTtlMs }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.existingAdmin === undefined ? {} : { existingAdmin: options.existingAdmin }),
    });
  } catch (error) {
    return Object.freeze({
      mode: 'legacy',
      code: 'bootstrap_failed',
      phase: 'bootstrap',
      message: sanitizeGovernanceMessage(error instanceof Error ? error.message : String(error)),
      cleanup: 'unavailable',
    });
  }
}

export async function setupCliGovernance(input: {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly contextMeta: Record<string, unknown>;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  readonly events: EventBus;
  readonly planPath: string;
  readonly captureWorkspaceCheckpoint: () => Promise<
    import('@wrongstack/core/types').WorkspaceCheckpointRef | undefined
  >;
}): Promise<CliGovernanceRuntimeHandle | undefined> {
  const result = await bootstrapCliGovernance({
    environment: process.env,
    projectRoot: input.projectRoot,
    projectId: input.projectId,
    adminClientId: `cli-control-${process.pid}-${input.sessionId}`,
    modelClientId: `cli-model-${input.sessionId}`,
    modelCapabilities: ['task_read', 'command_submit', 'shadow_observe'],
  });
  if (result.mode === 'governed') {
    const snapshot = result.handle.snapshot();
    input.contextMeta['governance'] = snapshot;
    input.logger.info(`governance: ${snapshot.source} session-scoped control plane`);
    const trace = await createGovernanceTraceContext({
      sessionId: input.sessionId,
      planPath: input.planPath,
    });
    const shadow = createGovernanceShadowBridge({
      events: input.events,
      sink: result.handle,
      logger: input.logger,
      trace,
    });
    const mutationSnapshots = createGovernanceMutationSnapshotBridge({
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
        shadow.close();
        return result.handle.close();
      },
    });
  } else if (result.mode === 'legacy') {
    input.contextMeta['governance'] = result;
    input.logger.warn(`governance: legacy fallback (${result.code})`, {
      phase: result.phase,
      cleanup: result.cleanup,
      message: result.message,
    });
  }
  return undefined;
}

interface CliMainEventSource {
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
}

export function createTeardownEventRegistrar(
  events: CliMainEventSource,
  teardownHandlers: Array<() => void>,
): (event: string, handler: (...args: unknown[]) => void) => void {
  return (event: string, handler: (...args: unknown[]) => void) => {
    events.on(event, handler);
    teardownHandlers.push(() => events.off(event, handler));
  };
}

export async function loadOnlineAgentsForPrompt(
  projectDir: string,
  skip: boolean,
): Promise<MailboxAgentStatus[]> {
  if (skip) return [];
  try {
    const systemMailbox = getSharedProjectMailbox(projectDir);
    return await systemMailbox.getAgentStatuses();
  } catch {
    return [];
  }
}

export async function getSddRuntimeStateForCli(): Promise<{
  tracker: unknown;
  builder: unknown;
  graphId: string | null;
}> {
  const sdd = await import('./services/sdd-runtime.js');
  return {
    tracker: sdd.getTaskTracker(),
    builder: sdd.getActiveBuilder(),
    graphId: sdd.getTaskGraphId(),
  };
}

export function createPickableProvidersLoader(args: {
  modelsRegistry: ModelsRegistry;
  logger: Logger;
  getConfig: () => Config;
}): () => Promise<Awaited<ReturnType<typeof buildPickableProviders>>> {
  const { modelsRegistry, logger, getConfig } = args;
  return async () => {
    await refreshRuntimeModelCatalog({
      modelsRegistry,
      logger,
      reason: 'model-picker',
    });
    return buildPickableProviders(modelsRegistry, getConfig());
  };
}
