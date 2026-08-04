import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { launchGovernanceProjectDaemonWithRuntime } from '../src/daemon-launcher.js';
import {
  connectGovernanceAdminSessionFromLaunch,
  connectGovernanceProjectClient,
  decodeGovernanceDaemonBootstrapMessage,
  decodeGovernanceDaemonBootstrapRequest,
  GOVERNANCE_DAEMON_BOOTSTRAP_PROTOCOL_VERSION,
  GOVERNANCE_SERVICE_PROTOCOL_VERSION,
  GovernanceCredentialLeaseController,
  GovernanceProjectClient,
  type GovernanceServiceCapability,
  governanceDaemonAttachmentBrokerPath,
  governanceDaemonEnvironment,
  governanceDaemonStartupLeasePath,
  inspectGovernanceDaemon,
  readGovernanceDaemonAttachmentBroker,
  readGovernanceDaemonMetadata,
  resolveGovernanceDaemonAvailability,
} from '../src/index.js';

const repositoryRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const daemonEntrypoint = new URL('../src/project-daemon.ts', import.meta.url);
const temporaryDirectories: string[] = [];
const daemonPids = new Set<number>();

function projectRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'wrongstack-governance-daemon-'));
  temporaryDirectories.push(root);
  return root;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopDaemon(pid: number): Promise<void> {
  if (isAlive(pid)) {
    try {
      // SIGKILL: the stale-metadata tests need the daemon to die WITHOUT
      // running its graceful shutdown cleanup (which removes the metadata
      // file, producing 'missing'). On POSIX, SIGTERM would let the daemon
      // clean up after itself; on Windows, any signal is a forceful kill,
      // which is why this only failed deterministically on Linux CI.
      process.kill(pid, 'SIGKILL');
    } catch {
      // It exited between the liveness check and signal delivery.
    }
  }
  const deadline = Date.now() + 5_000;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (isAlive(pid)) throw new Error(`Governance test daemon ${pid} did not stop.`);
  // Windows can report the process gone just before SQLite releases its final directory handle.
  await new Promise((resolve) => setTimeout(resolve, 300));
  daemonPids.delete(pid);
}

async function waitForGracefulDaemonStop(root: string, pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (isAlive(pid)) throw new Error(`Governance test daemon ${pid} did not stop gracefully.`);
  while (Date.now() < deadline) {
    if ((await readGovernanceDaemonMetadata(root)).kind === 'missing') {
      daemonPids.delete(pid);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Governance test daemon ${pid} did not remove its owned metadata.`);
}

async function launch(
  root: string,
  clientId: string,
  capabilities: readonly GovernanceServiceCapability[],
) {
  const result = await launchGovernanceProjectDaemonWithRuntime(
    {
      projectRoot: root,
      projectId: 'daemon-project',
      clientId,
      capabilities,
      ttlMs: 60_000,
      timeoutMs: 10_000,
    },
    {
      entrypoint: daemonEntrypoint,
      execArgv: ['--import', 'tsx'],
      cwd: repositoryRoot,
      detached: true,
    },
  );
  daemonPids.add(result.pid);
  return result;
}

function request(
  type: 'health' | 'read_observations' | 'read_audit_observations',
  requestId: string,
) {
  return { protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION, requestId, type };
}

afterEach(async () => {
  for (const pid of [...daemonPids]) await stopDaemon(pid);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('governance project daemon bootstrap', () => {
  it('uses strict handshake schemas and a secret-minimized child environment', () => {
    expect(
      decodeGovernanceDaemonBootstrapRequest({
        type: 'bootstrap',
        protocolVersion: GOVERNANCE_DAEMON_BOOTSTRAP_PROTOCOL_VERSION,
        nonce: 'nonce',
        clientId: 'model-client',
        capabilities: ['task_read'],
        ttlMs: 60_000,
        token: 'injected-token',
      }),
    ).toMatchObject({ decoded: false, issues: [{ path: '$.token' }] });

    expect(
      decodeGovernanceDaemonBootstrapMessage({
        type: 'bootstrap_result',
        protocolVersion: GOVERNANCE_DAEMON_BOOTSTRAP_PROTOCOL_VERSION,
        nonce: 'nonce',
        projectRoot: '/project',
        projectId: 'project',
        pid: 42,
        instanceId: 'instance-42',
        startedAt: '2026-08-01T00:00:00.000Z',
        grantId: 'grant',
        expiresAt: '2026-08-01T00:00:00.000Z',
        credential: {
          token: 'wsg_grant.secret-material-long-enough',
          projectId: 'project',
          clientId: 'model-client',
          capabilities: ['command_submit'],
        },
      }),
    ).toMatchObject({ decoded: false, issues: [{ path: '$.credential.capabilities' }] });

    expect(
      governanceDaemonEnvironment({
        PATH: 'safe-path',
        TEMP: 'safe-temp',
        NODE_OPTIONS: '--import attacker',
        OPENAI_API_KEY: 'secret',
        WRONGSTACK_HOME: '/sensitive',
      }),
    ).toEqual({ PATH: 'safe-path', TEMP: 'safe-temp' });
    expect(resolveGovernanceDaemonAvailability(import.meta.url, () => false)).toEqual({
      kind: 'missing-build',
    });
  });

  it('launches a detached owner and transfers one grant only through the bootstrap channel', async () => {
    const root = projectRoot();
    const launched = await launch(root, 'audit-client', ['task_read', 'audit_read']);
    const client = new GovernanceProjectClient(root, launched.credential);

    const discovered = await connectGovernanceProjectClient({
      projectRoot: root,
      projectId: 'daemon-project',
      credential: launched.credential,
    });
    expect(discovered).toMatchObject({
      connected: true,
      metadata: { pid: launched.pid, instanceId: launched.instanceId },
    });
    await expect(
      connectGovernanceProjectClient({
        projectRoot: root,
        projectId: 'daemon-project',
        credential: { ...launched.credential, token: `${launched.credential.token}tampered` },
      }),
    ).resolves.toMatchObject({ connected: false, code: 'authentication_failed' });

    await expect(readGovernanceDaemonMetadata(root)).resolves.toMatchObject({
      kind: 'valid',
      metadata: {
        pid: launched.pid,
        instanceId: launched.instanceId,
        startedAt: launched.startedAt,
        projectId: 'daemon-project',
      },
    });
    await expect(inspectGovernanceDaemon(root)).resolves.toMatchObject({
      kind: 'live',
      metadata: { pid: launched.pid, instanceId: launched.instanceId },
    });
    expect(existsSync(governanceDaemonStartupLeasePath(root))).toBe(false);
    const brokerRead = await readGovernanceDaemonAttachmentBroker(root);
    expect(brokerRead).toMatchObject({
      kind: 'valid',
      broker: {
        pid: launched.pid,
        instanceId: launched.instanceId,
        projectId: 'daemon-project',
        credential: { clientId: expect.stringContaining('governance-attachment-broker-') },
      },
    });
    if (brokerRead.kind !== 'valid') throw new Error('Expected a valid attachment broker.');
    const operatorStatusClient = new GovernanceProjectClient(root, brokerRead.broker.credential);
    await expect(
      operatorStatusClient.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'broker-operator-status',
        type: 'read_daemon_status',
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        type: 'daemon_status',
        attachmentBroker: { health: 'healthy', auditHealthy: true },
      },
    });
    await expect(
      operatorStatusClient.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'broker-shutdown-denied',
        type: 'request_daemon_shutdown',
        expectedInstanceId: launched.instanceId,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'permission_denied' } });

    await expect(client.request(request('health', 'daemon-health'))).resolves.toMatchObject({
      ok: true,
      result: { type: 'health', projectId: 'daemon-project', status: 'ready' },
    });
    await expect(
      client.request(request('read_observations', 'daemon-ordinary-observations')),
    ).resolves.toMatchObject({
      ok: true,
      result: { type: 'observations', observations: [] },
    });
    const audit = await client.request(
      request('read_audit_observations', 'daemon-audit-observations'),
    );
    expect(audit).toMatchObject({
      ok: true,
      result: {
        type: 'observations',
      },
    });
    if (!audit.ok || audit.result.type !== 'observations') {
      throw new Error('Expected governance audit observations.');
    }
    expect(
      audit.result.observations.filter(
        (observation) => observation.category === 'capability_grant_issued',
      ),
    ).toHaveLength(2);
    expect(audit.result.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'daemon_attachment_broker_lifecycle',
          source: 'governance-daemon-attachment-broker',
          payload: expect.objectContaining({
            type: 'published',
            state: 'active',
            health: 'healthy',
            consecutiveFailures: 0,
            pendingRevocations: 0,
          }),
        }),
      ]),
    );
    expect(audit.result.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'capability_grant_issued',
          source: 'governance-capability-registry',
        }),
      ]),
    );
    expect(JSON.stringify(audit)).not.toContain(launched.credential.token);
    expect(JSON.stringify(audit)).not.toContain('wsg_');
  });

  it('returns the identity-bound shutdown response before graceful process cleanup', async () => {
    const root = projectRoot();
    const launched = await launch(root, 'lifecycle-admin', ['capability_admin', 'daemon_control']);
    const connected = await connectGovernanceAdminSessionFromLaunch(launched, {
      startLease: false,
    });
    expect(connected).toMatchObject({ connected: true });
    if (!connected.connected) throw new Error(connected.message);

    await expect(connected.session.readDaemonStatus()).resolves.toMatchObject({
      ok: true,
      result: {
        type: 'daemon_status',
        projectId: 'daemon-project',
        pid: launched.pid,
        instanceId: launched.instanceId,
        startedAt: launched.startedAt,
        attachmentBroker: {
          state: 'active',
          health: 'healthy',
          grantId: expect.any(String),
          consecutiveFailures: 0,
          pendingRevocations: 0,
          auditHealthy: true,
        },
      },
    });
    await expect(
      connected.session.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'stale-daemon-shutdown',
        type: 'request_daemon_shutdown',
        expectedInstanceId: 'stale-instance',
        reason: 'must not stop the current owner',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'identity_mismatch' } });
    expect(isAlive(launched.pid)).toBe(true);

    await expect(
      connected.session.shutdownDaemon('detached daemon lifecycle test complete'),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        type: 'daemon_shutdown_accepted',
        instanceId: launched.instanceId,
        requestedBy: 'lifecycle-admin',
        reason: 'detached daemon lifecycle test complete',
      },
    });
    await waitForGracefulDaemonStop(root, launched.pid);
    await expect(readGovernanceDaemonMetadata(root)).resolves.toEqual({ kind: 'missing' });
    await expect(readGovernanceDaemonAttachmentBroker(root)).resolves.toEqual({ kind: 'missing' });
    expect(existsSync(governanceDaemonAttachmentBrokerPath(root))).toBe(false);
  });

  it('reports owner conflict without disturbing the current daemon', async () => {
    const root = projectRoot();
    const owner = await launch(root, 'owner-client', ['task_read']);

    await expect(launch(root, 'losing-client', ['task_read'])).rejects.toMatchObject({
      name: 'GovernanceDaemonLaunchError',
      code: 'owner_conflict',
    });

    const client = new GovernanceProjectClient(root, owner.credential);
    await expect(client.request(request('health', 'owner-health'))).resolves.toMatchObject({
      ok: true,
      result: { status: 'ready' },
    });
  });

  it('invalidates the old in-memory grant when a stopped daemon is replaced', async () => {
    const root = projectRoot();
    const first = await launch(root, 'first-client', ['task_read']);
    const oldClient = new GovernanceProjectClient(root, first.credential);
    await stopDaemon(first.pid);
    const stoppedInspection = await inspectGovernanceDaemon(root);
    expect(stoppedInspection.kind).toBe('stale');
    if (stoppedInspection.kind === 'stale') {
      expect(stoppedInspection.metadataState).toBe('dead-owner');
      expect(stoppedInspection.metadata?.instanceId).toBe(first.instanceId);
    }

    const replacement = await launch(root, 'replacement-client', ['task_read']);
    const replacementClient = new GovernanceProjectClient(root, replacement.credential);
    await expect(oldClient.request(request('health', 'stale-health'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'authentication_failed' },
    });
    await expect(
      replacementClient.request(request('health', 'replacement-health')),
    ).resolves.toMatchObject({ ok: true, result: { status: 'ready' } });
  });

  it('lets only the bootstrap admin issue, inspect, and revoke ordinary client grants', async () => {
    const root = projectRoot();
    const launched = await launch(root, 'bootstrap-admin', ['capability_admin', 'audit_read']);
    const admin = new GovernanceProjectClient(root, launched.credential);

    const issued = await admin.request({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'issue-model-reader',
      type: 'issue_capability_grant',
      clientId: 'model-reader',
      capabilities: ['task_read'],
      ttlMs: 30_000,
    });
    expect(issued).toMatchObject({
      ok: true,
      result: {
        type: 'capability_grant_issued',
        grant: {
          clientId: 'model-reader',
          issuedBy: 'bootstrap-admin',
          capabilities: ['task_read'],
        },
        credential: { projectId: 'daemon-project', clientId: 'model-reader' },
      },
    });
    if (!issued.ok || issued.result.type !== 'capability_grant_issued') {
      throw new Error('Expected a capability grant response.');
    }
    const model = new GovernanceProjectClient(root, issued.result.credential);
    await expect(model.request(request('health', 'delegated-health'))).resolves.toMatchObject({
      ok: true,
      result: { status: 'ready' },
    });
    await expect(
      model.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'model-list-grants',
        type: 'list_capability_grants',
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    await expect(
      model.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'model-rotate-grant',
        type: 'rotate_capability_grant',
        grantId: issued.result.grant.grantId,
        ttlMs: 30_000,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    await expect(
      admin.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'delegate-admin',
        type: 'issue_capability_grant',
        clientId: 'second-admin',
        capabilities: ['capability_admin'],
        ttlMs: 30_000,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    const firstPage = await admin.request({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'list-grants-first-page',
      type: 'list_capability_grants',
      limit: 1,
    });
    expect(firstPage).toMatchObject({
      ok: true,
      result: {
        type: 'capability_grants',
        grants: [
          {
            clientId: expect.stringContaining('governance-attachment-broker-'),
            issuedBy: 'governance-daemon-owner',
            capabilities: ['runtime_attach', 'daemon_status_read'],
          },
        ],
        nextCursor: expect.any(String),
      },
    });
    if (!firstPage.ok || firstPage.result.type !== 'capability_grants') {
      throw new Error('Expected a paginated capability grant response.');
    }
    const secondPage = await admin.request({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'list-grants-second-page',
      type: 'list_capability_grants',
      cursor: firstPage.result.nextCursor,
      limit: 1,
    });
    expect(secondPage).toMatchObject({
      ok: true,
      result: {
        type: 'capability_grants',
        grants: [{ clientId: 'bootstrap-admin', issuedBy: 'governance-daemon-bootstrap' }],
        nextCursor: expect.any(String),
      },
    });
    if (!secondPage.ok || secondPage.result.type !== 'capability_grants') {
      throw new Error('Expected a second paginated capability grant response.');
    }
    const thirdPage = await admin.request({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'list-grants-third-page',
      type: 'list_capability_grants',
      cursor: secondPage.result.nextCursor,
      limit: 1,
    });
    expect(thirdPage).toMatchObject({
      ok: true,
      result: {
        type: 'capability_grants',
        grants: [{ clientId: 'model-reader', issuedBy: 'bootstrap-admin' }],
      },
    });
    if (thirdPage.ok && thirdPage.result.type === 'capability_grants') {
      expect(thirdPage.result.nextCursor).toBeUndefined();
    }
    const rotationRequest = {
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'rotate-model-reader',
      type: 'rotate_capability_grant',
      grantId: issued.result.grant.grantId,
      ttlMs: 30_000,
      reason: 'scheduled rotation',
    } as const;
    const rotated = await admin.request(rotationRequest);
    expect(rotated).toMatchObject({
      ok: true,
      result: {
        type: 'capability_grant_rotated',
        previousGrantId: issued.result.grant.grantId,
        grant: { clientId: 'model-reader', capabilities: ['task_read'] },
        credential: { projectId: 'daemon-project', clientId: 'model-reader' },
      },
    });
    if (!rotated.ok || rotated.result.type !== 'capability_grant_rotated') {
      throw new Error('Expected a rotated capability grant response.');
    }
    await expect(admin.request(rotationRequest)).resolves.toEqual(rotated);
    await expect(model.request(request('health', 'old-credential-health'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'authentication_failed' },
    });
    const rotatedModel = new GovernanceProjectClient(root, rotated.result.credential);
    await expect(
      rotatedModel.request(request('health', 'rotated-credential-health')),
    ).resolves.toMatchObject({ ok: true, result: { status: 'ready' } });
    await expect(
      admin.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'revoke-model-reader',
        type: 'revoke_capability_grant',
        grantId: rotated.result.grant.grantId,
        reason: 'model session ended',
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { type: 'capability_grant_revoked', revoked: true },
    });
    await expect(rotatedModel.request(request('health', 'revoked-health'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'authentication_failed' },
    });
    const audit = await admin.request(request('read_audit_observations', 'admin-audit'));
    expect(audit).toMatchObject({
      ok: true,
      result: {
        observations: expect.arrayContaining([
          expect.objectContaining({
            category: 'capability_grant_issued',
            payload: expect.objectContaining({
              clientId: 'model-reader',
              issuedBy: 'bootstrap-admin',
            }),
          }),
          expect.objectContaining({
            category: 'capability_grant_rotated',
            payload: expect.objectContaining({
              previousGrantId: issued.result.grant.grantId,
              grantId: rotated.result.grant.grantId,
              rotatedBy: 'bootstrap-admin',
            }),
          }),
          expect.objectContaining({
            category: 'capability_grant_revoked',
            payload: expect.objectContaining({
              reason: 'model session ended',
              revokedBy: 'bootstrap-admin',
            }),
          }),
        ]),
      },
    });
    if (audit.ok && audit.result.type === 'observations') {
      expect(
        audit.result.observations.filter(
          (observation) => observation.category === 'capability_grant_rotated',
        ),
      ).toHaveLength(1);
    }
    expect(JSON.stringify(audit)).not.toContain(issued.result.credential.token);
    expect(JSON.stringify(audit)).not.toContain(rotated.result.credential.token);
  });

  it('self-rotates an opt-in admin lease and continues through the replacement client', async () => {
    const root = projectRoot();
    const launched = await launch(root, 'lease-admin', ['capability_admin', 'audit_read']);
    const oldClient = new GovernanceProjectClient(root, launched.credential);
    let dropFirstRotationResponse = true;
    const controller = new GovernanceCredentialLeaseController({
      projectRoot: root,
      projectId: 'daemon-project',
      grantId: launched.grantId,
      expiresAt: launched.expiresAt,
      credential: launched.credential,
      rotationTtlMs: 30_000,
      renewBeforeMs: 5_000,
      retryDelayMs: 100,
      maxAttempts: 3,
      clientFactory: (credential) => {
        const client = new GovernanceProjectClient(root, credential);
        return {
          async request(input) {
            const response = await client.request(input);
            const type =
              input && typeof input === 'object' && 'type' in input ? input.type : undefined;
            if (type === 'rotate_capability_grant' && dropFirstRotationResponse) {
              dropFirstRotationResponse = false;
              throw new Error('simulated response loss');
            }
            return response;
          },
        };
      },
    });

    await expect(controller.rotateNow()).resolves.toMatchObject({
      state: 'retry_wait',
      rotationAttempt: 1,
      lastFailure: 'simulated response loss',
    });
    const rotated = await controller.rotateNow();
    expect(rotated).toMatchObject({ state: 'scheduled', rotationAttempt: 0 });
    expect(rotated.grantId).not.toBe(launched.grantId);
    await expect(oldClient.request(request('health', 'old-lease-health'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'authentication_failed' },
    });
    await expect(
      controller.request(request('health', 'rotated-lease-health')),
    ).resolves.toMatchObject({ ok: true, result: { status: 'ready' } });
    const audit = await controller.request(request('read_audit_observations', 'lease-audit'));
    expect(audit).toMatchObject({
      ok: true,
      result: {
        observations: expect.arrayContaining([
          expect.objectContaining({
            category: 'capability_grant_rotated',
            payload: expect.objectContaining({
              previousGrantId: launched.grantId,
              grantId: rotated.grantId,
              rotatedBy: 'lease-admin',
            }),
          }),
        ]),
      },
    });
    if (audit.ok && audit.result.type === 'observations') {
      expect(
        audit.result.observations.filter(
          (observation) => observation.category === 'capability_grant_rotated',
        ),
      ).toHaveLength(1);
    }
    expect(JSON.stringify(controller.snapshot())).not.toContain(launched.credential.token);
    controller.stop();
  });

  it('builds an opt-in verified admin session from a matching launcher result', async () => {
    const root = projectRoot();
    const launched = await launch(root, 'session-admin', ['capability_admin', 'audit_read']);
    const connected = await connectGovernanceAdminSessionFromLaunch(launched, {
      startLease: false,
      rotationTtlMs: 30_000,
      renewBeforeMs: 5_000,
      retryDelayMs: 100,
      maxAttempts: 3,
    });
    expect(connected).toMatchObject({
      connected: true,
      session: expect.any(Object),
    });
    if (!connected.connected) throw new Error('Expected a verified governance admin session.');
    expect(connected.session.snapshot()).toMatchObject({
      mode: 'launched',
      daemon: {
        pid: launched.pid,
        instanceId: launched.instanceId,
        projectId: 'daemon-project',
      },
      lease: {
        state: 'idle',
        grantId: launched.grantId,
        clientId: 'session-admin',
      },
    });
    expect(JSON.stringify(connected.session.snapshot())).not.toContain(launched.credential.token);
    await expect(
      connected.session.request(request('health', 'session-health')),
    ).resolves.toMatchObject({ ok: true, result: { status: 'ready' } });
    const rotated = await connected.session.rotateNow();
    expect(rotated.grantId).not.toBe(launched.grantId);
    await expect(
      connected.session.request(request('health', 'session-health-after-rotation')),
    ).resolves.toMatchObject({ ok: true, result: { status: 'ready' } });
    connected.session.stop();
  });

  it('rejects non-admin and mismatched launcher identities before creating an admin session', async () => {
    const root = projectRoot();
    const reader = await launch(root, 'session-reader', ['task_read']);
    await expect(
      connectGovernanceAdminSessionFromLaunch(reader, { startLease: false }),
    ).resolves.toMatchObject({ connected: false, code: 'admin_required' });
    await expect(
      connectGovernanceAdminSessionFromLaunch(
        { ...reader, instanceId: 'forged-instance' },
        { startLease: false },
      ),
    ).resolves.toMatchObject({ connected: false, code: 'endpoint_invalid' });
  });
});
