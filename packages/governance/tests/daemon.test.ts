import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { launchGovernanceProjectDaemonWithRuntime } from '../src/daemon-launcher.js';
import {
  decodeGovernanceDaemonBootstrapMessage,
  decodeGovernanceDaemonBootstrapRequest,
  GOVERNANCE_DAEMON_BOOTSTRAP_PROTOCOL_VERSION,
  GOVERNANCE_SERVICE_PROTOCOL_VERSION,
  GovernanceProjectClient,
  type GovernanceServiceCapability,
  governanceDaemonEnvironment,
  governanceDaemonStartupLeasePath,
  inspectGovernanceDaemon,
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
      process.kill(pid, 'SIGTERM');
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
        observations: [
          { category: 'capability_grant_issued', source: 'governance-capability-registry' },
        ],
      },
    });
    expect(JSON.stringify(audit)).not.toContain(launched.credential.token);
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
        grants: [{ clientId: 'bootstrap-admin', issuedBy: 'governance-daemon-bootstrap' }],
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
        grants: [{ clientId: 'model-reader', issuedBy: 'bootstrap-admin' }],
      },
    });
    if (secondPage.ok && secondPage.result.type === 'capability_grants') {
      expect(secondPage.result.nextCursor).toBeUndefined();
    }
    await expect(
      admin.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'revoke-model-reader',
        type: 'revoke_capability_grant',
        grantId: issued.result.grant.grantId,
        reason: 'model session ended',
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: { type: 'capability_grant_revoked', revoked: true },
    });
    await expect(model.request(request('health', 'revoked-health'))).resolves.toMatchObject({
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
            category: 'capability_grant_revoked',
            payload: expect.objectContaining({
              reason: 'model session ended',
              revokedBy: 'bootstrap-admin',
            }),
          }),
        ]),
      },
    });
    expect(JSON.stringify(audit)).not.toContain(issued.result.credential.token);
  });
});
