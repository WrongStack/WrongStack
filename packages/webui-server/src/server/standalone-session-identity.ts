import * as path from 'node:path';
import type { EventBus } from '@wrongstack/core/kernel';
import {
  AgentStatusTracker,
  FleetNotifier,
  getSessionRegistry,
  type SessionRegistry,
} from '@wrongstack/core/storage';
import type { Config, Logger } from '@wrongstack/core/types';
import { WebSocket } from 'ws';

export interface StandaloneSessionIdentityPaths {
  globalRoot: string;
  projectRoot: string;
  projectSlug: string;
}

export interface StandaloneSessionIdentityOptions {
  config: Config;
  events: EventBus;
  logger: Logger;
  paths: StandaloneSessionIdentityPaths;
  workingDir: string;
  initialSessionId: string;
  sessionRegistry?: SessionRegistry | undefined;
  /** Test/embedding escape hatch; production defaults to enabled. */
  enableHqTelemetry?: boolean | undefined;
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
  let pendingClaim: { sessionId: string; previousSessionId: string; token: symbol } | undefined;
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
        pendingClaim = undefined;
      } else {
        await register(sessionId, true, target);
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
    const previousSessionId = activeSessionId;
    const previousTarget = activeTarget;
    const token = Symbol(sessionId);
    await register(sessionId, true, target);
    pendingClaim = { sessionId, previousSessionId, token };
    return async () => {
      if (pendingClaim?.token !== token) return;
      await register(previousSessionId, true, previousTarget);
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
