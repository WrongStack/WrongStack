import * as path from 'node:path';
import { AgentStatusTracker, FleetNotifier } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import { getSessionRegistry, type SessionResumeClaim } from '@wrongstack/core/storage';
import type { Config, Logger } from '@wrongstack/core/types';
import { WebSocket } from 'ws';

interface StandaloneSessionIdentityPaths {
  globalRoot: string;
  projectRoot: string;
  projectSlug: string;
}

interface StandaloneSessionIdentityOptions {
  config: Config;
  events: EventBus;
  logger: Logger;
  paths: StandaloneSessionIdentityPaths;
  workingDir: string;
  initialSessionId: string;
  sessionRegistry?: SessionIdentityRegistry | undefined;
  /** Test/embedding escape hatch; production defaults to enabled. */
  enableHqTelemetry?: boolean | undefined;
}

interface SessionIdentityRegistry {
  register(entry: Parameters<ReturnType<typeof getSessionRegistry>['register']>[0]): Promise<void>;
  updateAgents(
    agents: Parameters<ReturnType<typeof getSessionRegistry>['updateAgents']>[0],
  ): Promise<void>;
  markClosing(): Promise<void>;
  unregister(): Promise<void>;
  reserveResume?: ReturnType<typeof getSessionRegistry>['reserveResume'] | undefined;
}

export interface SessionIdentityTarget {
  projectSlug: string;
  projectRoot: string;
  projectName: string;
  workingDir: string;
}

export interface StandaloneSessionIdentityLifecycle {
  readonly statusTracker: AgentStatusTracker | undefined;
  /** Reserve a selected session before its writer is opened. */
  claim(sessionId: string, target?: SessionIdentityTarget): Promise<() => Promise<void>>;
  activate(sessionId: string, target?: SessionIdentityTarget): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Own the cross-surface identity associated with the standalone WebUI's live
 * session writer. Session routes call {@link activate} after swapping writers;
 * shutdown calls {@link stop}. Transitions are serialized and every optional
 * external surface is fail-soft, while identity selection itself stays live.
 */
export async function createStandaloneSessionIdentityLifecycle(
  opts: StandaloneSessionIdentityOptions,
): Promise<StandaloneSessionIdentityLifecycle> {
  const { paths, events, logger } = opts;
  const registry = opts.sessionRegistry ?? getSessionRegistry(paths.globalRoot);
  const fleetNotifier = new FleetNotifier({
    baseDir: paths.globalRoot,
    projectRoot: paths.projectRoot,
    selfPid: process.pid,
  });
  let activeSessionId = opts.initialSessionId;
  let activeTarget: SessionIdentityTarget = {
    projectSlug: paths.projectSlug,
    projectRoot: paths.projectRoot,
    projectName: path.basename(paths.projectRoot),
    workingDir: opts.workingDir,
  };
  let pendingClaim:
    | { sessionId: string; token: symbol; claim: SessionResumeClaim; target: SessionIdentityTarget }
    | undefined;
  let stopped = false;
  let transition = Promise.resolve();

  const statusTracker = new AgentStatusTracker({
    events,
    registry,
    sessionId: () => activeSessionId,
    onUpdate: () => fleetNotifier.notify(),
  });

  const register = async (
    sessionId: string,
    strict = false,
    target: SessionIdentityTarget = activeTarget,
  ): Promise<void> => {
    try {
      await registry.register({
        sessionId,
        ...target,
        clientType: 'webui',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        agents: statusTracker.getAgents(),
      });
      fleetNotifier.notify();
    } catch (err) {
      logger.debug?.(`WebUI session registry update failed: ${errorMessage(err)}`);
      if (strict) throw err;
    }
  };

  const replaceRegisteredIdentity = async (
    sessionId: string,
    target: SessionIdentityTarget,
  ): Promise<void> => {
    const previousSessionId = activeSessionId;
    const previousTarget = activeTarget;
    await registry.unregister();
    try {
      await register(sessionId, true, target);
    } catch (err) {
      await register(previousSessionId, true, previousTarget).catch((restoreErr) => {
        logger.debug?.(`WebUI session registry restore failed: ${errorMessage(restoreErr)}`);
      });
      throw err;
    }
  };

  // Ownership is mandatory even for a newly-created session. Continuing with
  // an unregistered writer would let another process resume it concurrently.
  try {
    await register(activeSessionId, true);
  } catch (err) {
    fleetNotifier.dispose();
    throw err;
  }
  statusTracker.start();

  let stopHqBridges = (): void => {};
  let closeHqPublisher = (): void => {};
  let restartHqBridges = (_sessionId: string): void => {};
  if (opts.enableHqTelemetry !== false) {
    try {
      const core = await import('@wrongstack/core/hq');
      type HqPublisher = NonNullable<ReturnType<typeof core.createHqPublisherFromEnv>>;
      let publisher: HqPublisher | undefined;

      const createPublisher = (target: SessionIdentityTarget): HqPublisher | undefined => {
        const next = core.createHqPublisherFromEnv({
          clientKind: 'webui',
          projectRoot: target.projectRoot,
          projectName: target.projectName,
          appConfig: opts.config as never as Parameters<
            typeof core.createHqPublisherFromEnv
          >[0]['appConfig'],
          socketFactory: (url: string) =>
            new WebSocket(url) as unknown as import('@wrongstack/core/hq').HqSocketLike,
        });
        next?.connect();
        return next;
      };

      closeHqPublisher = () => {
        publisher?.close();
        publisher = undefined;
      };
      restartHqBridges = (sessionId: string) => {
        stopHqBridges();
        if (publisher?.project.projectRoot !== activeTarget.projectRoot) {
          closeHqPublisher();
          publisher = createPublisher(activeTarget);
        }
        const activePublisher = publisher;
        if (!activePublisher) return;

        const stops: Array<() => void> = [];
        const add = (start: () => () => void): void => {
          try {
            stops.push(start());
          } catch {
            /* optional bridge */
          }
        };
        add(() =>
          core.startSessionTelemetryBridge({
            publisher: activePublisher,
            events,
            sessionId,
            projectRoot: activeTarget.projectRoot,
            projectName: activeTarget.projectName,
            globalRoot: paths.globalRoot,
            initialAgents: statusTracker.getAgents(),
            startedAt: new Date().toISOString(),
          }),
        );
        add(() =>
          core.startFleetTelemetryBridge({
            events,
            publisher: activePublisher,
            runId: sessionId,
            sessionId,
          }),
        );
        add(() =>
          core.startBrainTelemetryBridge({
            events,
            publisher: activePublisher,
            sessionId,
          }),
        );
        add(() =>
          core.startWorktreeTelemetryBridge({
            events,
            publisher: activePublisher,
            sessionId,
          }),
        );
        add(() =>
          core.startToolTelemetryBridge({
            events,
            publisher: activePublisher,
            projectRoot: activeTarget.projectRoot,
            sessionId,
          }),
        );
        add(() =>
          core.startCostTelemetryBridge({
            events,
            publisher: activePublisher,
            sessionId,
          }),
        );
        stopHqBridges = () => {
          for (const stop of stops.splice(0)) {
            try {
              stop();
            } catch {
              /* best effort */
            }
          }
        };
      };

      publisher = createPublisher(activeTarget);
      restartHqBridges(activeSessionId);
    } catch (err) {
      logger.debug?.(`WebUI HQ telemetry unavailable: ${errorMessage(err)}`);
    }
  }

  const activate = async (
    sessionId: string,
    target: SessionIdentityTarget = activeTarget,
  ): Promise<void> => {
    if (
      stopped ||
      (sessionId === activeSessionId &&
        target.projectSlug === activeTarget.projectSlug &&
        target.projectRoot === activeTarget.projectRoot &&
        target.workingDir === activeTarget.workingDir)
    ) {
      return;
    }
    transition = transition.then(async () => {
      if (stopped) return;
      if (pendingClaim?.sessionId === sessionId) {
        await pendingClaim.claim.activate({
          sessionId,
          ...target,
          clientType: 'webui',
          pid: process.pid,
          startedAt: new Date().toISOString(),
          agents: statusTracker.getAgents(),
        });
        pendingClaim = undefined;
      } else {
        await replaceRegisteredIdentity(sessionId, target);
      }
      activeSessionId = sessionId;
      activeTarget = target;
      fleetNotifier.setProjectRoot(target.projectRoot);
      try {
        restartHqBridges(sessionId);
      } catch (err) {
        logger.debug?.(`WebUI HQ session swap failed: ${errorMessage(err)}`);
      }
    });
    await transition;
  };

  const claim = async (
    sessionId: string,
    target: SessionIdentityTarget = activeTarget,
  ): Promise<() => Promise<void>> => {
    if (stopped) return async () => {};
    if (pendingClaim) {
      throw new Error(`Session transition to ${pendingClaim.sessionId} is already in progress.`);
    }
    if (sessionId === activeSessionId) return async () => {};
    const token = Symbol(sessionId);
    if ('reserveResume' in registry && typeof registry.reserveResume === 'function') {
      const reservation = await registry.reserveResume({
        sessionId,
        projectSlug: target.projectSlug,
        projectRoot: target.projectRoot,
      });
      pendingClaim = { sessionId, token, claim: reservation, target };
    } else {
      await replaceRegisteredIdentity(sessionId, target);
      pendingClaim = {
        sessionId,
        token,
        target,
        claim: {
          reservation: {
            reservationId: 'legacy',
            targetSessionId: sessionId,
            requesterInstanceId: 'legacy',
            expiresAt: Number.MAX_SAFE_INTEGER,
          },
          activate: async () => undefined,
          // The legacy path holds no reservation, so there is nothing to
          // extend. Report "already settled" rather than pretending a renewal
          // happened — callers use the boolean to decide whether the window is
          // theirs to keep alive.
          renew: async () => false,
          cancel: async () => replaceRegisteredIdentity(activeSessionId, activeTarget),
        },
      };
    }
    return async () => {
      if (pendingClaim?.token !== token) return;
      await pendingClaim.claim.cancel();
      pendingClaim = undefined;
    };
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await transition.catch(() => undefined);
    statusTracker.stop();
    stopHqBridges();
    closeHqPublisher();
    fleetNotifier.dispose();
    try {
      await registry.markClosing();
      await registry.unregister();
    } catch {
      /* best effort */
    }
  };

  return { statusTracker, claim, activate, stop };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
