import type { Config } from '@wrongstack/contracts/types';
import { startOtlpExport } from '@wrongstack/core/observability';
import { createCompatibilityTrustBoundary } from '@wrongstack/core/security';
import { createAgentServices } from './backend-services.js';
import { setupWebUiGovernance } from './governance-runtime.js';
import type { createPreContextServices } from './pre-context-services.js';
import { createStandaloneAgentPipelines } from './standalone-pipelines.js';
import type { WebUIOptions } from './types.js';

type PreContext = Awaited<ReturnType<typeof createPreContextServices>>;
type AgentServicesInput = Parameters<typeof createAgentServices>[0];

export interface StandaloneAgentServices {
  trustBoundary: AgentServicesInput['trustBoundary'];
  governanceHandle: Awaited<ReturnType<typeof setupWebUiGovernance>>;
  otlpExport: ReturnType<typeof startOtlpExport>;
  agentServices: Awaited<ReturnType<typeof createAgentServices>>;
}

export interface StandaloneAgentServicesInput {
  opts: WebUIOptions;
  /** Config value at service-construction time. */
  config: Config;
  /** Live config reader (the binding `startWebUI` reassigns). */
  getConfig: () => Config;
  wpaths: AgentServicesInput['wpaths'];
  logger: AgentServicesInput['logger'];
  projectRoot: string;
  workingDir: string;
  preContext: PreContext;
  /** SAGE store, possibly wrapped by the vector mirror. */
  memoryStore: PreContext['memoryStore'];
  getSession: () => PreContext['session'];
  getSessionStore: () => PreContext['sessionStore'];
  sessionRunLocks: Map<string, AbortController>;
  isDisplayed: (sessionId: string) => boolean;
  /** Sends a frame to every connected client (called only after the server is listening). */
  broadcastToClients?: AgentServicesInput['broadcastToClients'];
  updateGlobalConfig: (
    mutate: (cfg: Record<string, unknown>) => void,
    errorLabel: string,
  ) => Promise<void>;
}

/**
 * Post-context agent services phase of `startWebUI` (pipelines, compaction,
 * agent, Brain, per-feature WS handlers) plus the trust boundary, the
 * governance runtime, and OTLP export they are built with.
 */
export async function createStandaloneAgentServices(
  input: StandaloneAgentServicesInput,
): Promise<StandaloneAgentServices> {
  const {
    opts,
    config,
    getConfig,
    wpaths,
    logger,
    projectRoot,
    workingDir,
    preContext,
    memoryStore,
    getSession,
    getSessionStore,
    sessionRunLocks,
    isDisplayed,
    updateGlobalConfig,
  } = input;
  const {
    modelsRegistry,
    container,
    providerRegistry,
    toolRegistry,
    events,
    mcpRegistry,
    sessionReader,
    annotationsStore,
    tokenCounter,
    modeStore,
    customModeStore,
    skillLoader,
    skillInstaller,
    modelCapabilitiesRef,
    provider,
    context,
  } = preContext;
  const trustBoundary =
    opts.trustBoundary ??
    createCompatibilityTrustBoundary({ policyId: 'webui-trusted-host-compat-v1' });
  const governanceHandle =
    opts.installToolBoundary === undefined
      ? await setupWebUiGovernance({
          environment: process.env,
          projectRoot,
          projectId: wpaths.projectSlug,
          sessionId: getSession().id,
          contextMeta: context.meta,
          events,
          logger,
          captureWorkspaceCheckpoint: async () =>
            getSessionStore().captureWorkspaceCheckpoint?.(getSession().id, 0),
        })
      : undefined;
  const installToolBoundary = opts.installToolBoundary ?? governanceHandle?.installToolBoundary;
  const otlpExport = startOtlpExport(config.observability, { logger });
  const agentPipelines = createStandaloneAgentPipelines({
    getConfig,
    getProvider: () => context.provider,
    modelsRegistry,
    events,
    logger,
  });
  const agentServices = await createAgentServices({
    tracer: otlpExport?.tracer,
    trustBoundary,
    config,
    getConfig,
    wpaths,
    logger,
    projectRoot,
    workingDir,
    broadcastToClients: input.broadcastToClients,
    context,
    provider,
    container,
    toolRegistry,
    providerRegistry,
    modelsRegistry,
    events,
    mcpRegistry,
    memoryStore,
    modeStore,
    customModeStore,
    skillLoader,
    skillInstaller,
    tokenCounter,
    pipelines: agentPipelines,
    ...(installToolBoundary ? { installToolBoundary } : {}),
    modelCapabilitiesRef,
    sessionGetter: getSession,
    // Never evict a session agent that is mid-run (see the registry cap).
    isRunActive: (sessionId: string) => sessionRunLocks.has(sessionId),
    // A tab still on screen outlives one that was closed, whatever order their
    // agents happened to be created in.
    isDisplayed,
    sessionReader,
    annotationsStore,
    // Brain settings persist to the GLOBAL config only (config.brain is on
    // the in-project deny list), serialized behind the shared write lock.
    persistBrainConfig: (brainConfig) =>
      updateGlobalConfig((decrypted) => {
        decrypted['brain'] = brainConfig;
      }, 'brain.config'),
  });
  return { trustBoundary, governanceHandle, otlpExport, agentServices };
}
