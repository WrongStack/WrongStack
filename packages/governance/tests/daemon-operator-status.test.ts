import { describe, expect, it } from 'vitest';
import {
  type GovernanceDaemonControlStatus,
  projectGovernanceDaemonOperatorStatus,
} from '../src/index.js';

function daemonStatus(
  broker: GovernanceDaemonControlStatus['attachmentBroker'],
): GovernanceDaemonControlStatus {
  return {
    projectId: 'project-1',
    pid: 4242,
    instanceId: 'daemon-1',
    startedAt: '2026-08-02T12:00:00.000Z',
    ...(broker ? { attachmentBroker: broker } : {}),
  };
}

describe('governance daemon operator status', () => {
  it('projects healthy broker state without credential or raw failure fields', () => {
    const status = projectGovernanceDaemonOperatorStatus(
      daemonStatus({
        state: 'active',
        health: 'healthy',
        grantId: 'broker-grant-secret-adjacent',
        expiresAt: '2026-08-02T13:00:00.000Z',
        consecutiveFailures: 0,
        pendingRevocations: 0,
        auditHealthy: true,
        lastFailure: 'failed with wsg_grant.secret-material',
      }),
    );

    expect(status.signal).toEqual({
      level: 'healthy',
      code: 'attachment_broker_healthy',
      message: 'Attachment broker publication and audit persistence are healthy.',
      operatorAction: 'none',
      executionDisposition: 'continue',
    });
    expect(status.attachmentBroker).not.toHaveProperty('grantId');
    expect(status.attachmentBroker).not.toHaveProperty('lastFailure');
    expect(JSON.stringify(status)).not.toContain('wsg_');
  });

  it('emits a deterministic advisory warning while keeping execution active', () => {
    const status = projectGovernanceDaemonOperatorStatus(
      daemonStatus({
        state: 'retry_wait',
        health: 'degraded',
        grantId: 'broker-grant',
        expiresAt: '2026-08-02T13:00:00.000Z',
        consecutiveFailures: 3,
        pendingRevocations: 0,
        auditHealthy: true,
      }),
    );

    expect(status.signal).toMatchObject({
      level: 'warning',
      code: 'attachment_broker_degraded',
      operatorAction: 'investigate',
      executionDisposition: 'continue',
    });
  });

  it('prioritizes audit and revocation integrity signals over generic degradation', () => {
    const audit = projectGovernanceDaemonOperatorStatus(
      daemonStatus({
        state: 'active',
        health: 'degraded',
        grantId: 'broker-grant',
        expiresAt: '2026-08-02T13:00:00.000Z',
        consecutiveFailures: 3,
        pendingRevocations: 1,
        auditHealthy: false,
      }),
    );
    expect(audit.signal.code).toBe('attachment_broker_audit_unhealthy');

    const revocation = projectGovernanceDaemonOperatorStatus(
      daemonStatus({
        state: 'active',
        health: 'degraded',
        grantId: 'broker-grant',
        expiresAt: '2026-08-02T13:00:00.000Z',
        consecutiveFailures: 3,
        pendingRevocations: 1,
        auditHealthy: true,
      }),
    );
    expect(revocation.signal.code).toBe('attachment_broker_revocation_pending');
  });

  it('keeps older daemons compatible with a non-blocking unavailable notice', () => {
    const status = projectGovernanceDaemonOperatorStatus(daemonStatus(undefined));
    expect(status).toMatchObject({
      attachmentBroker: null,
      signal: {
        level: 'notice',
        code: 'attachment_broker_status_unavailable',
        operatorAction: 'observe',
        executionDisposition: 'continue',
      },
    });
  });
});
