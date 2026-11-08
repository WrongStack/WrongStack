import type { createAgentServices } from './backend-services.js';
import type { createPreContextServices } from './pre-context-services.js';
import type { WebuiDeps, WebuiMutableState } from './routes.js';
import { startStandaloneDepWatcher } from './standalone-dep-watcher.js';
import { startStandaloneHqPresence } from './standalone-hq-presence.js';
import type { createRunLockControl } from './start-webui-session-runtime.js';

type PreContext = Awaited<ReturnType<typeof createPreContextServices>>;
type AgentServices = Awaited<ReturnType<typeof createAgentServices>>;

export interface StandaloneHostServices {
  /** The engine's project switched: HQ presence re-registers under the new root. */
  switchProject(projectRoot: string): void;
  dispose(): void;
}

/**
 * The host-level services the CLI starts around its agent and the standalone engine (desktop)
 * did not: HQ control + presence (`standalone-hq-presence.ts`) and the dependency watcher's
 * automatic tech-stack audits (`standalone-dep-watcher.ts`). Started once the routes exist;
 * disposed before the fleet host they spawn through.
 *
 * The dependency watcher stays on the boot project: its mailbox is keyed by the boot
 * project's slug, and the CLI it mirrors never switches project.
 */
export function startStandaloneHostServices(input: {
  state: WebuiMutableState;
  deps: WebuiDeps;
  preContext: PreContext;
  agentServices: AgentServices;
  runLockControl: ReturnType<typeof createRunLockControl>;
  paths: { globalRoot: string; projectSlug: string };
}): StandaloneHostServices {
  const { state, deps, preContext, agentServices, runLockControl } = input;
  const bootSessionId = preContext.session.id;
  const host = agentServices.delegation?.host;

  const stopDepWatcher = startStandaloneDepWatcher({
    config: state.getConfig(),
    paths: input.paths,
    projectRoot: state.getProjectRoot(),
    events: preContext.events,
    logger: deps.logger,
    host,
    sessionId: bootSessionId,
  });

  const hq = startStandaloneHqPresence({
    projectRoot: state.getProjectRoot(),
    getConfig: () => state.getConfig(),
    events: preContext.events,
    bootSessionId,
    getSessionId: () => state.getSession().id,
    clients: state.getClients(),
    isRunning: (sessionId) => runLockControl.has(sessionId),
    abortRun: (sessionId) => runLockControl.abortRunLock(sessionId),
    ownsSession: (sessionId) =>
      agentServices.isSessionLive?.(sessionId) === true || deps.hasSession?.(sessionId) === true,
    getSessionWriter: (sessionId) => deps.peekAgent?.(sessionId)?.ctx.session,
    ...(host ? { getDirector: () => host.getDirector() } : {}),
    onPublisher: (publisher) => preContext.sessionIdentity.bindHqPublisher(publisher),
  });

  return {
    switchProject: (projectRoot) => hq.switchProject(projectRoot),
    dispose: () => {
      hq.dispose();
      stopDepWatcher();
    },
  };
}
