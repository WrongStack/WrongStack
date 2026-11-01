/**
 * Governance telemetry in words. The payload is observational — HQ cannot act
 * on it — so the card's job is to say what the broker reported and what a
 * person on that machine should look at.
 */
import type { HqGovernanceSignalCode, HqGovernanceSnapshotPayload } from '@wrongstack/hq';

const SIGNAL: Record<HqGovernanceSignalCode, { label: string; sentence: string }> = {
  attachment_broker_healthy: {
    label: 'Broker healthy',
    sentence: 'The attachment broker is running and its audit log is healthy.',
  },
  attachment_broker_initializing: {
    label: 'Broker starting',
    sentence: 'The attachment broker is still starting; policy checks wait until it is ready.',
  },
  attachment_broker_status_unavailable: {
    label: 'Broker status unknown',
    sentence: 'The broker is attached but did not report its status.',
  },
  attachment_broker_degraded: {
    label: 'Broker degraded',
    sentence: 'The attachment broker keeps failing and is retrying.',
  },
  attachment_broker_audit_unhealthy: {
    label: 'Audit log unhealthy',
    sentence: 'The broker cannot write its audit log, so decisions are not being recorded.',
  },
  attachment_broker_revocation_pending: {
    label: 'Revocations pending',
    sentence: 'Revoked attachments have not been confirmed as removed yet.',
  },
  attachment_broker_stopped: {
    label: 'Broker stopped',
    sentence: 'The attachment broker has stopped.',
  },
  broker_missing: {
    label: 'No broker',
    sentence: 'No governance broker is running for this project.',
  },
  broker_invalid: {
    label: 'Broker invalid',
    sentence: 'The broker’s registration file is unreadable or malformed.',
  },
  connection_failed: {
    label: 'Cannot reach broker',
    sentence: 'The project could not connect to its governance broker.',
  },
  request_rejected: {
    label: 'Request rejected',
    sentence: 'The broker refused the status request.',
  },
  unexpected_response: {
    label: 'Unexpected answer',
    sentence: 'The broker answered with something the client does not understand.',
  },
};

export function governanceLabel(code: HqGovernanceSignalCode): string {
  return SIGNAL[code]?.label ?? code.replaceAll('_', ' ');
}

export interface GovernanceDetail {
  sentence: string;
  facts: { label: string; value: string; warn?: boolean }[];
}

const clock = (iso: string): string => {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toLocaleString() : iso;
};

export function governanceDetail(payload: HqGovernanceSnapshotPayload): GovernanceDetail {
  const facts: GovernanceDetail['facts'] = [];
  const broker = payload.attachmentBroker;
  if (broker !== undefined && broker !== null) {
    facts.push({
      label: 'Broker',
      value: `${broker.state.replace('_', ' ')} · ${broker.health}`,
      warn: broker.health === 'degraded' || broker.health === 'stopped',
    });
    if (broker.consecutiveFailures > 0)
      facts.push({
        label: 'Failures in a row',
        value: String(broker.consecutiveFailures),
        warn: true,
      });
    if (broker.pendingRevocations > 0)
      facts.push({
        label: 'Pending revocations',
        value: String(broker.pendingRevocations),
        warn: true,
      });
    facts.push({
      label: 'Audit log',
      value: broker.auditHealthy ? 'Healthy' : 'Not writing',
      warn: !broker.auditHealthy,
    });
    if (broker.nextActionAt !== undefined)
      facts.push({ label: 'Next retry', value: clock(broker.nextActionAt) });
    if (broker.expiresAt !== undefined)
      facts.push({ label: 'Lease expires', value: clock(broker.expiresAt) });
  }
  if (payload.daemon !== undefined)
    facts.push({
      label: 'Daemon',
      value: `pid ${payload.daemon.pid} · since ${clock(payload.daemon.startedAt)}`,
    });
  facts.push({ label: 'Observed', value: clock(payload.observedAt) });
  const sentence = SIGNAL[payload.signal.code]?.sentence ?? governanceLabel(payload.signal.code);
  const advice =
    payload.signal.operatorAction === 'investigate'
      ? ' Look at the governance daemon on that machine.'
      : payload.signal.operatorAction === 'observe'
        ? ' Keep an eye on it; it may recover on its own.'
        : '';
  return { sentence: `${sentence}${advice}`, facts };
}
