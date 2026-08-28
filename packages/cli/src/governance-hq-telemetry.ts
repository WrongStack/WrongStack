import type { HqGovernanceSnapshotPayload, HqPublisher } from '@wrongstack/core/hq';
import {
  type GovernanceDaemonOperatorStatusReadResult,
  readGovernanceDaemonOperatorStatus,
} from '@wrongstack/runtime/governance-bootstrap';

const GOVERNANCE_HQ_SNAPSHOT_INTERVAL_MS = 15_000;

interface GovernanceHqTelemetryOptions {
  readonly publisher: Pick<HqPublisher, 'project' | 'publishEvent'>;
  readonly projectRoot: string;
  readonly intervalMs?: number;
  readonly now?: () => string;
  readonly readStatus?: (projectRoot: string) => Promise<GovernanceDaemonOperatorStatusReadResult>;
}

function unavailableAction(
  code: Exclude<GovernanceDaemonOperatorStatusReadResult, { available: true }>['code'],
): 'observe' | 'investigate' {
  return code === 'broker_missing' ? 'observe' : 'investigate';
}

export function projectGovernanceHqSnapshot(
  projectId: string,
  observedAt: string,
  result: GovernanceDaemonOperatorStatusReadResult,
): HqGovernanceSnapshotPayload {
  if (!result.available) {
    return {
      schemaVersion: 1,
      projectId,
      observedAt,
      available: false,
      signal: {
        level: 'unavailable',
        code: result.code,
        operatorAction: unavailableAction(result.code),
        executionDisposition: 'continue',
      },
    };
  }
  const status = result.status;
  return {
    schemaVersion: 1,
    projectId,
    observedAt,
    available: true,
    signal: {
      level: status.signal.level,
      code: status.signal.code,
      operatorAction: status.signal.operatorAction,
      executionDisposition: 'continue',
    },
    daemon: { pid: status.pid, startedAt: status.startedAt },
    attachmentBroker:
      status.attachmentBroker === null
        ? null
        : {
            state: status.attachmentBroker.state,
            health: status.attachmentBroker.health,
            consecutiveFailures: status.attachmentBroker.consecutiveFailures,
            pendingRevocations: status.attachmentBroker.pendingRevocations,
            auditHealthy: status.attachmentBroker.auditHealthy,
            ...(status.attachmentBroker.expiresAt
              ? { expiresAt: status.attachmentBroker.expiresAt }
              : {}),
            ...(status.attachmentBroker.nextActionAt
              ? { nextActionAt: status.attachmentBroker.nextActionAt }
              : {}),
          },
  };
}

/**
 * Publish a compact project-owner governance observation to HQ. Failures are
 * represented as advisory snapshots and never stop task or model execution.
 */
export function startGovernanceHqTelemetry(options: GovernanceHqTelemetryOptions): () => void {
  const now = options.now ?? (() => new Date().toISOString());
  const readStatus = options.readStatus ?? readGovernanceDaemonOperatorStatus;
  let stopped = false;
  let inFlight = false;

  const publish = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      let result: GovernanceDaemonOperatorStatusReadResult;
      try {
        result = await readStatus(options.projectRoot);
      } catch {
        result = {
          available: false,
          code: 'connection_failed',
          message: 'Governance status reader failed.',
        };
      }
      if (stopped) return;
      const payload = projectGovernanceHqSnapshot(
        options.publisher.project.projectId,
        now(),
        result,
      );
      options.publisher.publishEvent({ type: 'governance.snapshot', payload });
    } finally {
      inFlight = false;
    }
  };

  void publish();
  const timer = setInterval(
    () => void publish(),
    options.intervalMs ?? GOVERNANCE_HQ_SNAPSHOT_INTERVAL_MS,
  );
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
