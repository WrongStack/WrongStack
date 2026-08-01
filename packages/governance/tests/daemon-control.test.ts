import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  GOVERNANCE_SERVICE_PROTOCOL_VERSION,
  type GovernanceDaemonShutdownNotice,
  GovernanceProjectClient,
  GovernanceProjectServer,
} from '../src/index.js';

const temporaryDirectories: string[] = [];
const servers: GovernanceProjectServer[] = [];

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wrongstack-governance-daemon-control-'));
  temporaryDirectories.push(root);
  return root;
}

function client(
  root: string,
  issued: { readonly token: string },
  clientId: string,
): GovernanceProjectClient {
  return new GovernanceProjectClient(root, {
    token: issued.token,
    projectId: 'project-1',
    clientId,
  });
}

afterEach(async () => {
  for (const server of servers.splice(0).reverse()) await server.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('governance daemon control', () => {
  it('binds status and graceful shutdown to a non-delegable control capability', async () => {
    const root = projectRoot();
    let resolveFlushed: ((notice: GovernanceDaemonShutdownNotice) => void) | undefined;
    const flushed = new Promise<GovernanceDaemonShutdownNotice>((resolve) => {
      resolveFlushed = resolve;
    });
    const server = new GovernanceProjectServer({
      projectRoot: root,
      projectId: 'project-1',
      daemonControl: {
        status: () => ({
          projectId: 'project-1',
          pid: 4242,
          instanceId: 'instance-1',
          startedAt: '2026-08-02T12:00:00.000Z',
        }),
      },
      onDaemonShutdownResponseFlushed: (notice) => resolveFlushed?.(notice),
    });
    servers.push(server);
    await server.start();

    const controlGrant = server.issueGrant({
      clientId: 'launcher-admin',
      capabilities: ['daemon_control', 'capability_admin'],
      ttlMs: 60_000,
    });
    const control = client(root, controlGrant, 'launcher-admin');
    await expect(
      control.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'daemon-status',
        type: 'read_daemon_status',
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        type: 'daemon_status',
        projectId: 'project-1',
        pid: 4242,
        instanceId: 'instance-1',
        startedAt: '2026-08-02T12:00:00.000Z',
      },
    });

    const adminOnlyGrant = server.issueGrant({
      clientId: 'ordinary-admin',
      capabilities: ['capability_admin'],
      ttlMs: 60_000,
    });
    const adminOnly = client(root, adminOnlyGrant, 'ordinary-admin');
    await expect(
      adminOnly.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'daemon-status-denied',
        type: 'read_daemon_status',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'permission_denied' } });

    await expect(
      control.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'delegate-daemon-control',
        type: 'issue_capability_grant',
        clientId: 'delegated-controller',
        capabilities: ['daemon_control'],
        ttlMs: 30_000,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'permission_denied' } });

    await expect(
      control.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'shutdown-wrong-instance',
        type: 'request_daemon_shutdown',
        expectedInstanceId: 'instance-stale',
        reason: 'stale client',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'identity_mismatch' } });

    const accepted = await control.request({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'shutdown-current-instance',
      type: 'request_daemon_shutdown',
      expectedInstanceId: 'instance-1',
      reason: 'controlled test shutdown',
    });
    expect(accepted).toMatchObject({
      ok: true,
      result: {
        type: 'daemon_shutdown_accepted',
        instanceId: 'instance-1',
        requestedBy: 'launcher-admin',
        reason: 'controlled test shutdown',
      },
    });
    await expect(flushed).resolves.toEqual({
      requestId: 'shutdown-current-instance',
      expectedInstanceId: 'instance-1',
      requestedBy: 'launcher-admin',
      reason: 'controlled test shutdown',
    });
  });

  it('persists reserved shutdown evidence and prevents model spoofing', async () => {
    const root = projectRoot();
    const server = new GovernanceProjectServer({
      projectRoot: root,
      projectId: 'project-1',
      daemonControl: {
        status: () => ({
          projectId: 'project-1',
          pid: 4242,
          instanceId: 'instance-audit',
          startedAt: '2026-08-02T12:00:00.000Z',
        }),
      },
    });
    servers.push(server);
    await server.start();

    const controlGrant = server.issueGrant({
      clientId: 'launcher-admin',
      capabilities: ['daemon_control'],
      ttlMs: 60_000,
    });
    const control = client(root, controlGrant, 'launcher-admin');
    await expect(
      control.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'shutdown-audited',
        type: 'request_daemon_shutdown',
        expectedInstanceId: 'instance-audit',
        reason: 'audit this request',
      }),
    ).resolves.toMatchObject({ ok: true, result: { type: 'daemon_shutdown_accepted' } });

    const auditGrant = server.issueGrant({
      clientId: 'auditor',
      capabilities: ['audit_read'],
      ttlMs: 60_000,
    });
    const auditor = client(root, auditGrant, 'auditor');
    const audit = await auditor.request({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'read-shutdown-audit',
      type: 'read_audit_observations',
    });
    expect(audit).toMatchObject({
      ok: true,
      result: {
        type: 'observations',
        observations: expect.arrayContaining([
          expect.objectContaining({
            source: 'governance-daemon-control',
            category: 'daemon_shutdown_requested',
            payload: {
              requestId: 'shutdown-audited',
              expectedInstanceId: 'instance-audit',
              requestedBy: 'launcher-admin',
              reason: 'audit this request',
            },
          }),
        ]),
      },
    });
    expect(JSON.stringify(audit)).not.toContain(controlGrant.token);

    const shadowGrant = server.issueGrant({
      clientId: 'model-shadow',
      capabilities: ['shadow_observe'],
      ttlMs: 60_000,
    });
    const shadow = client(root, shadowGrant, 'model-shadow');
    await expect(
      shadow.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'spoof-shutdown-audit',
        type: 'record_observation',
        observation: {
          observationId: 'model-forged-shutdown',
          projectId: 'project-1',
          taskId: null,
          source: 'model-shadow',
          category: 'daemon_shutdown_requested',
          observedAt: '2026-08-02T12:01:00.000Z',
          payload: { expectedInstanceId: 'instance-audit' },
        },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'permission_denied' } });
  });

  it('does not trigger shutdown when the reserved audit record cannot be persisted', async () => {
    const root = projectRoot();
    const flushedNotices: GovernanceDaemonShutdownNotice[] = [];
    const server = new GovernanceProjectServer({
      projectRoot: root,
      projectId: 'project-1',
      daemonControl: {
        status: () => ({
          projectId: 'project-1',
          pid: 4242,
          instanceId: 'instance-conflict',
          startedAt: '2026-08-02T12:00:00.000Z',
        }),
      },
      onDaemonShutdownResponseFlushed: (notice) => flushedNotices.push(notice),
    });
    servers.push(server);
    await server.start();
    const issued = server.issueGrant({
      clientId: 'launcher-admin',
      capabilities: ['daemon_control'],
      ttlMs: 60_000,
    });
    const control = client(root, issued, 'launcher-admin');
    const shutdownRequest = {
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'conflicting-shutdown',
      type: 'request_daemon_shutdown',
      expectedInstanceId: 'instance-conflict',
    } as const;

    await expect(
      control.request({ ...shutdownRequest, reason: 'first accepted reason' }),
    ).resolves.toMatchObject({ ok: true, result: { type: 'daemon_shutdown_accepted' } });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(flushedNotices).toHaveLength(1);
    await expect(
      control.request({ ...shutdownRequest, reason: 'conflicting retry reason' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'store_failure' } });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(flushedNotices).toHaveLength(1);
  });
});
