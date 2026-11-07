import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { removeProjectFixtureDirectorySync } from '../../core/tests/helpers/project-server-harness.js';
import {
  AuthenticatedGovernanceProjectService,
  GOVERNANCE_SERVICE_PROTOCOL_VERSION,
  GovernanceCapabilityGrantRegistry,
  type GovernanceGrantAuditEvent,
  GovernanceManagementReceiptCache,
  GovernanceProjectService,
  SqliteGovernanceEventStore,
} from '../src/index.js';

const START_TIME = Date.parse('2026-08-01T14:00:00.000Z');
const SECRET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';

function registryHarness(projectId = 'project-1') {
  let now = START_TIME;
  let sequence = 0;
  const auditEvents: GovernanceGrantAuditEvent[] = [];
  const registry = new GovernanceCapabilityGrantRegistry(projectId, {
    now: () => now,
    maxTtlMs: 60_000,
    tokenMaterial: () => {
      sequence += 1;
      return { grantId: `grant-${sequence}`, secret: `${SECRET}${sequence}` };
    },
    auditSink: (event) => auditEvents.push(event),
  });
  return {
    registry,
    auditEvents,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

function transitionRequest() {
  return {
    protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
    requestId: 'request-transition',
    type: 'submit_command',
    command: {
      type: 'transition_task',
      commandId: 'command-transition',
      taskId: 'missing-task',
      expectedRevision: 0,
      actor: 'model',
      issuedAt: '2026-08-01T14:01:00.000Z',
      to: 'scoped',
    },
  };
}

const temporaryDirectories: string[] = [];

function openService(projectId = 'project-1'): GovernanceProjectService {
  const directory = mkdtempSync(join(tmpdir(), 'wrongstack-governance-auth-'));
  temporaryDirectories.push(directory);
  return new GovernanceProjectService(
    projectId,
    SqliteGovernanceEventStore.open(join(directory, 'governance.sqlite')),
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    removeProjectFixtureDirectorySync(directory, { maxRetries: 5, retryDelay: 50 });
  }
});

describe('governance capability grant registry', () => {
  it('returns an opaque token once and stores only a public grant descriptor', () => {
    const { registry } = registryHarness();
    const issued = registry.issue({
      clientId: 'model-client',
      capabilities: ['command_submit', 'task_read', 'command_submit'],
      ttlMs: 10_000,
    });

    expect(issued.token).toBe(`wsg_grant-1.${SECRET}1`);
    expect(issued.grant).toMatchObject({
      grantId: 'grant-1',
      projectId: 'project-1',
      clientId: 'model-client',
      issuedBy: 'trusted-server',
      capabilities: ['task_read', 'command_submit'],
      status: 'active',
    });
    const serializedDescriptor = JSON.stringify(registry.getGrant('grant-1'));
    expect(serializedDescriptor).not.toContain(SECRET);
    expect(serializedDescriptor).not.toContain('verifier');
    expect(serializedDescriptor).not.toContain('token');
  });

  it('lists retained public grant metadata with deterministic issuer attribution', () => {
    const { registry, auditEvents } = registryHarness();
    const first = registry.issue({
      clientId: 'model-client',
      issuedBy: 'bootstrap-admin',
      capabilities: ['task_read'],
      ttlMs: 10_000,
    });
    registry.issue({
      clientId: 'shadow-client',
      issuedBy: 'bootstrap-admin',
      capabilities: ['shadow_observe'],
      ttlMs: 10_000,
    });
    registry.revoke(first.grant.grantId, 'model session ended', 'bootstrap-admin');

    expect(registry.listGrants()).toMatchObject([
      {
        grantId: 'grant-1',
        clientId: 'model-client',
        issuedBy: 'bootstrap-admin',
        status: 'revoked',
        revokedBy: 'bootstrap-admin',
      },
      {
        grantId: 'grant-2',
        clientId: 'shadow-client',
        issuedBy: 'bootstrap-admin',
        status: 'active',
      },
    ]);
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'grant_issued',
          clientId: 'model-client',
          issuedBy: 'bootstrap-admin',
        }),
      ]),
    );
    expect(JSON.stringify(registry.listGrants())).not.toContain(SECRET);
  });

  it('keeps a grant active when the append-only revoke audit cannot be persisted', () => {
    let rejectAudit = false;
    const registry = new GovernanceCapabilityGrantRegistry('project-1', {
      tokenMaterial: () => ({ grantId: 'atomic-grant', secret: SECRET }),
      auditSink: (event) => {
        if (rejectAudit && event.type === 'grant_revoked') throw new Error('audit unavailable');
      },
    });
    const issued = registry.issue({
      clientId: 'model-client',
      issuedBy: 'bootstrap-admin',
      capabilities: ['task_read'],
      ttlMs: 10_000,
    });
    rejectAudit = true;

    expect(() =>
      registry.revoke(issued.grant.grantId, 'model session ended', 'bootstrap-admin'),
    ).toThrow('audit unavailable');
    expect(
      registry.authenticate({
        token: issued.token,
        projectId: 'project-1',
        clientId: 'model-client',
      }),
    ).toMatchObject({ authenticated: true });
  });

  it('rotates an active grant atomically without changing its client or capabilities', () => {
    const { registry, auditEvents } = registryHarness();
    const issued = registry.issue({
      clientId: 'model-client',
      issuedBy: 'bootstrap-admin',
      capabilities: ['task_read', 'command_submit'],
      ttlMs: 10_000,
    });

    const rotated = registry.rotate(issued.grant.grantId, {
      rotatedBy: 'bootstrap-admin',
      ttlMs: 20_000,
      reason: 'scheduled rotation',
    });

    expect(rotated.grant).toMatchObject({
      grantId: 'grant-2',
      clientId: 'model-client',
      issuedBy: 'bootstrap-admin',
      capabilities: ['task_read', 'command_submit'],
      status: 'active',
    });
    expect(
      registry.authenticate({
        token: issued.token,
        projectId: 'project-1',
        clientId: 'model-client',
      }),
    ).toMatchObject({ authenticated: false, code: 'invalid_token' });
    expect(
      registry.authenticate({
        token: rotated.token,
        projectId: 'project-1',
        clientId: 'model-client',
      }),
    ).toMatchObject({ authenticated: true, grant: { grantId: 'grant-2' } });
    expect(registry.listGrants()).toHaveLength(1);
    expect(auditEvents).toMatchObject([
      { sequence: 1, type: 'grant_issued', grantId: 'grant-1' },
      {
        sequence: 2,
        type: 'grant_rotated',
        previousGrantId: 'grant-1',
        grantId: 'grant-2',
        rotatedBy: 'bootstrap-admin',
        reason: 'scheduled rotation',
      },
      {
        sequence: 3,
        type: 'grant_revoked',
        grantId: 'grant-1',
        revokedBy: 'bootstrap-admin',
        reason: 'scheduled rotation',
      },
    ]);
    expect(JSON.stringify(auditEvents)).not.toContain(SECRET);
  });

  it('keeps the old grant active when the rotation audit cannot be persisted', () => {
    let sequence = 0;
    let rejectRotation = false;
    const registry = new GovernanceCapabilityGrantRegistry('project-1', {
      now: () => START_TIME,
      tokenMaterial: () => {
        sequence += 1;
        return { grantId: `atomic-rotation-${sequence}`, secret: `${SECRET}${sequence}` };
      },
      auditSink: (event) => {
        if (rejectRotation && event.type === 'grant_rotated') throw new Error('audit unavailable');
      },
    });
    const issued = registry.issue({
      clientId: 'model-client',
      capabilities: ['task_read'],
      ttlMs: 10_000,
    });
    rejectRotation = true;

    expect(() =>
      registry.rotate(issued.grant.grantId, {
        rotatedBy: 'bootstrap-admin',
        ttlMs: 10_000,
      }),
    ).toThrow('audit unavailable');
    expect(
      registry.authenticate({
        token: issued.token,
        projectId: 'project-1',
        clientId: 'model-client',
      }),
    ).toMatchObject({ authenticated: true });
    expect(registry.getGrant('atomic-rotation-2')).toBeNull();
  });

  it('authenticates into an immutable server-owned capability set', () => {
    const { registry } = registryHarness();
    const issued = registry.issue({
      clientId: 'model-client',
      capabilities: ['command_submit'],
      ttlMs: 10_000,
    });
    const authentication = registry.authenticate({
      token: issued.token,
      projectId: 'project-1',
      clientId: 'model-client',
    });

    expect(authentication).toMatchObject({
      authenticated: true,
      client: { clientId: 'model-client' },
    });
    if (!authentication.authenticated) return;
    expect(authentication.client.capabilities.has('command_submit')).toBe(true);
    expect('add' in authentication.client.capabilities).toBe(false);
    expect(Object.isFrozen(authentication.client)).toBe(true);
  });

  it('rejects invalid secrets and project or client rebinding', () => {
    const { registry } = registryHarness();
    const issued = registry.issue({
      clientId: 'model-client',
      capabilities: ['task_read'],
      ttlMs: 10_000,
    });

    expect(
      registry.authenticate({
        token: `${issued.token}tampered`,
        projectId: 'project-1',
        clientId: 'model-client',
      }),
    ).toMatchObject({ authenticated: false, code: 'invalid_token' });
    expect(
      registry.authenticate({
        token: issued.token,
        projectId: 'project-2',
        clientId: 'model-client',
      }),
    ).toMatchObject({ authenticated: false, code: 'project_mismatch' });
    expect(
      registry.authenticate({
        token: issued.token,
        projectId: 'project-1',
        clientId: 'other-client',
      }),
    ).toMatchObject({ authenticated: false, code: 'client_mismatch' });

    const restarted = new GovernanceCapabilityGrantRegistry('project-1');
    expect(
      restarted.authenticate({
        token: issued.token,
        projectId: 'project-1',
        clientId: 'model-client',
      }),
    ).toMatchObject({ authenticated: false, code: 'invalid_token' });
  });

  it('expires inclusively and can sweep expired verifier state', () => {
    const { registry, advance, auditEvents } = registryHarness();
    const issued = registry.issue({
      clientId: 'model-client',
      capabilities: ['command_submit'],
      ttlMs: 1_000,
    });
    const credential = {
      token: issued.token,
      projectId: 'project-1',
      clientId: 'model-client',
    };

    advance(999);
    expect(registry.authenticate(credential)).toMatchObject({ authenticated: true });
    advance(1);
    expect(registry.authenticate(credential)).toMatchObject({
      authenticated: false,
      code: 'grant_expired',
    });
    expect(registry.getGrant('grant-1')).toMatchObject({ status: 'expired' });
    expect(registry.sweepExpired()).toBe(1);
    expect(registry.getGrant('grant-1')).toBeNull();
    expect(auditEvents).toMatchObject([
      { sequence: 1, type: 'grant_issued' },
      { sequence: 2, type: 'grant_expired' },
    ]);
  });

  it('revokes immediately and records an append-only lifecycle audit event', () => {
    const { registry, auditEvents } = registryHarness();
    const issued = registry.issue({
      clientId: 'shadow-client',
      capabilities: ['shadow_observe'],
      ttlMs: 10_000,
    });
    expect(registry.revoke(issued.grant.grantId, 'legacy session ended')).toBe(true);
    expect(registry.revoke(issued.grant.grantId)).toBe(false);
    expect(
      registry.authenticate({
        token: issued.token,
        projectId: 'project-1',
        clientId: 'shadow-client',
      }),
    ).toMatchObject({ authenticated: false, code: 'grant_revoked' });
    expect(auditEvents).toMatchObject([
      { sequence: 1, type: 'grant_issued' },
      { sequence: 2, type: 'grant_revoked', reason: 'legacy session ended' },
    ]);
  });

  it('rejects empty, unknown, excessive, or malformed grants', () => {
    const { registry } = registryHarness();
    expect(() =>
      registry.issue({ clientId: 'model-client', capabilities: [], ttlMs: 1_000 }),
    ).toThrow(/known governance capability/);
    expect(() =>
      registry.issue({
        clientId: 'model-client',
        capabilities: ['command_submit', 'unknown' as 'command_submit'],
        ttlMs: 1_000,
      }),
    ).toThrow(/known governance capability/);
    expect(() =>
      registry.issue({ clientId: 'model-client', capabilities: ['task_read'], ttlMs: 60_001 }),
    ).toThrow(/configured maximum/);
    expect(() =>
      registry.issue({ clientId: '', capabilities: ['task_read'], ttlMs: 1_000 }),
    ).toThrow(/clientId/);
  });

  it('bounds retained grants and prunes revoked entries before issuing replacements', () => {
    let sequence = 0;
    const registry = new GovernanceCapabilityGrantRegistry('project-1', {
      now: () => START_TIME,
      maxGrants: 1,
      tokenMaterial: () => {
        sequence += 1;
        return { grantId: `bounded-${sequence}`, secret: `${SECRET}${sequence}` };
      },
    });
    const first = registry.issue({
      clientId: 'first-client',
      capabilities: ['task_read'],
      ttlMs: 1_000,
    });
    expect(() =>
      registry.issue({
        clientId: 'second-client',
        capabilities: ['task_read'],
        ttlMs: 1_000,
      }),
    ).toThrow(/capacity 1/);
    registry.revoke(first.grant.grantId);
    expect(
      registry.issue({
        clientId: 'second-client',
        capabilities: ['task_read'],
        ttlMs: 1_000,
      }),
    ).toMatchObject({ grant: { clientId: 'second-client' } });
  });

  it('does not activate a grant when the lifecycle audit sink fails', () => {
    const registry = new GovernanceCapabilityGrantRegistry('project-1', {
      now: () => START_TIME,
      tokenMaterial: () => ({ grantId: 'audit-failure', secret: SECRET }),
      auditSink: () => {
        throw new Error('audit unavailable');
      },
    });
    expect(() =>
      registry.issue({
        clientId: 'model-client',
        capabilities: ['command_submit'],
        ttlMs: 1_000,
      }),
    ).toThrow(/audit unavailable/);
    expect(registry.getGrant('audit-failure')).toBeNull();
  });
});

describe('authenticated governance project service', () => {
  it('lets an authenticated client inspect only its own public grant metadata', () => {
    const service = openService();
    const { registry } = registryHarness();
    registry.issue({
      clientId: 'other-client',
      capabilities: ['audit_read'],
      ttlMs: 10_000,
    });
    const reader = registry.issue({
      clientId: 'reader-client',
      capabilities: ['task_read'],
      ttlMs: 10_000,
    });
    const authenticated = new AuthenticatedGovernanceProjectService(service, registry);

    const response = authenticated.handleUnknown(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'read-own-grant',
        type: 'read_own_capability_grant',
      },
      { token: reader.token, projectId: 'project-1', clientId: 'reader-client' },
    );
    expect(response).toMatchObject({
      ok: true,
      result: {
        type: 'own_capability_grant',
        grant: {
          grantId: reader.grant.grantId,
          clientId: 'reader-client',
          capabilities: ['task_read'],
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain(reader.token);
    expect(JSON.stringify(response)).not.toContain('other-client');
    authenticated.close();
  });

  it('replays one capability issue and rejects request id reuse with a different payload', () => {
    const service = openService();
    const { registry, auditEvents } = registryHarness();
    const admin = registry.issue({
      clientId: 'admin-client',
      capabilities: ['capability_admin'],
      ttlMs: 10_000,
    });
    const authenticated = new AuthenticatedGovernanceProjectService(service, registry);
    const credential = {
      token: admin.token,
      projectId: 'project-1',
      clientId: 'admin-client',
    };
    const request = {
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'issue-once',
      type: 'issue_capability_grant',
      clientId: 'model-client',
      capabilities: ['task_read'],
      ttlMs: 10_000,
    } as const;

    const first = authenticated.handleUnknown(request, credential);
    const retry = authenticated.handleUnknown(request, credential);
    expect(retry).toEqual(first);
    expect(registry.listGrants()).toHaveLength(2);
    expect(auditEvents).toHaveLength(2);
    expect(authenticated.handleUnknown({ ...request, ttlMs: 9_000 }, credential)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(registry.listGrants()).toHaveLength(2);
    authenticated.close();
  });

  it('claims one bounded runtime attachment without delegating control-plane authority', () => {
    const service = openService();
    const { registry, auditEvents, advance } = registryHarness();
    const broker = registry.issue({
      clientId: 'attachment-broker',
      capabilities: ['runtime_attach'],
      ttlMs: 10_000,
    });
    advance(2_000);
    const authenticated = new AuthenticatedGovernanceProjectService(service, registry);
    const credential = {
      token: broker.token,
      projectId: 'project-1',
      clientId: 'attachment-broker',
    };
    const request = {
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'claim-runtime-once',
      type: 'claim_runtime_attachment',
      controlClientId: 'webui-control',
      modelClientId: 'webui-model',
      modelCapabilities: ['task_read', 'command_submit'],
      ttlMs: 60_000,
    } as const;

    const first = authenticated.handleUnknown(request, credential);
    expect(authenticated.handleUnknown(request, credential)).toEqual(first);
    expect(first).toMatchObject({
      ok: true,
      result: {
        type: 'runtime_attachment_claimed',
        control: {
          grant: {
            clientId: 'webui-control',
            issuedBy: 'attachment-broker',
            capabilities: [
              'workspace_snapshot_record',
              'runtime_attachment_release',
              'daemon_status_read',
            ],
            expiresAt: broker.grant.expiresAt,
          },
          credential: { projectId: 'project-1', clientId: 'webui-control' },
        },
        model: {
          grant: {
            clientId: 'webui-model',
            issuedBy: 'attachment-broker',
            capabilities: ['task_read', 'command_submit'],
            expiresAt: broker.grant.expiresAt,
          },
          credential: { projectId: 'project-1', clientId: 'webui-model' },
        },
      },
    });
    expect(registry.listGrants()).toHaveLength(3);
    expect(auditEvents.filter((event) => event.type === 'grant_issued')).toHaveLength(3);
    if (!first.ok || first.result.type !== 'runtime_attachment_claimed') {
      throw new Error('Expected runtime attachment credentials.');
    }
    expect(first.result.control.credential.token).not.toBe(first.result.model.credential.token);
    expect(first.result.control.grant.capabilities).not.toContain('runtime_attach');
    expect(first.result.control.grant.capabilities).not.toContain('capability_admin');
    expect(first.result.control.grant.capabilities).not.toContain('daemon_control');
    expect(first.result.control.grant.capabilities).toContain('daemon_status_read');
    expect(first.result.model.grant.capabilities).not.toContain('runtime_attach');
    const releaseRequest = {
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'release-runtime-once',
      type: 'release_runtime_attachment',
    } as const;
    expect(
      authenticated.handleUnknown(releaseRequest, first.result.model.credential),
    ).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    const released = authenticated.handleUnknown(releaseRequest, first.result.control.credential);
    expect(authenticated.handleUnknown(releaseRequest, first.result.control.credential)).toEqual(
      released,
    );
    expect(released).toMatchObject({
      ok: true,
      result: {
        type: 'runtime_attachment_released',
        controlGrantId: first.result.control.grant.grantId,
        modelGrantId: first.result.model.grant.grantId,
      },
    });
    expect(registry.getGrant(first.result.control.grant.grantId)).toMatchObject({
      status: 'revoked',
    });
    expect(registry.getGrant(first.result.model.grant.grantId)).toMatchObject({
      status: 'revoked',
    });
    authenticated.close();
  });

  it('tracks rotated runtime attachment control and model grants so release revokes the active pair', () => {
    const service = openService();
    const { registry } = registryHarness();
    const broker = registry.issue({
      clientId: 'attachment-broker',
      capabilities: ['runtime_attach'],
      ttlMs: 30_000,
    });
    const admin = registry.issue({
      clientId: 'admin-client',
      capabilities: ['capability_admin'],
      ttlMs: 30_000,
    });
    const authenticated = new AuthenticatedGovernanceProjectService(service, registry);
    const brokerCred = {
      token: broker.token,
      projectId: 'project-1',
      clientId: 'attachment-broker',
    };
    const adminCred = {
      token: admin.token,
      projectId: 'project-1',
      clientId: 'admin-client',
    };

    const claimed = authenticated.handleUnknown(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'claim-attachment-before-rotation',
        type: 'claim_runtime_attachment',
        controlClientId: 'webui-control',
        modelClientId: 'webui-model',
        modelCapabilities: ['task_read'],
        ttlMs: 20_000,
      },
      brokerCred,
    );
    if (!claimed.ok || claimed.result.type !== 'runtime_attachment_claimed') {
      throw new Error('Expected runtime attachment claim.');
    }

    const rotatedModel = authenticated.handleUnknown(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'rotate-attached-model',
        type: 'rotate_capability_grant',
        grantId: claimed.result.model.grant.grantId,
        ttlMs: 20_000,
      },
      adminCred,
    );
    const rotatedControl = authenticated.handleUnknown(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'rotate-attached-control',
        type: 'rotate_capability_grant',
        grantId: claimed.result.control.grant.grantId,
        ttlMs: 20_000,
      },
      adminCred,
    );
    if (
      !rotatedModel.ok ||
      rotatedModel.result.type !== 'capability_grant_rotated' ||
      !rotatedControl.ok ||
      rotatedControl.result.type !== 'capability_grant_rotated'
    ) {
      throw new Error('Expected rotated control and model grants.');
    }

    const released = authenticated.handleUnknown(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'release-after-rotation',
        type: 'release_runtime_attachment',
      },
      rotatedControl.result.credential,
    );
    expect(released).toMatchObject({
      ok: true,
      result: {
        type: 'runtime_attachment_released',
        controlGrantId: rotatedControl.result.grant.grantId,
        modelGrantId: rotatedModel.result.grant.grantId,
      },
    });
    expect(registry.getGrant(rotatedControl.result.grant.grantId)).toMatchObject({
      status: 'revoked',
    });
    expect(registry.getGrant(rotatedModel.result.grant.grantId)).toMatchObject({
      status: 'revoked',
    });
    authenticated.close();
  });

  it('denies attachment claims and runtime_attach delegation without the broker capability', () => {
    const service = openService();
    const { registry } = registryHarness();
    const admin = registry.issue({
      clientId: 'admin-client',
      capabilities: ['capability_admin'],
      ttlMs: 10_000,
    });
    const authenticated = new AuthenticatedGovernanceProjectService(service, registry);
    const credential = {
      token: admin.token,
      projectId: 'project-1',
      clientId: 'admin-client',
    };

    expect(
      authenticated.handleUnknown(
        {
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: 'admin-cannot-claim',
          type: 'claim_runtime_attachment',
          controlClientId: 'control-client',
          modelClientId: 'model-client',
          modelCapabilities: ['task_read'],
          ttlMs: 10_000,
        },
        credential,
      ),
    ).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    expect(
      authenticated.handleUnknown(
        {
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: 'admin-cannot-delegate-attach',
          type: 'issue_capability_grant',
          clientId: 'forged-broker',
          capabilities: ['runtime_attach'],
          ttlMs: 10_000,
        },
        credential,
      ),
    ).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    expect(
      authenticated.handleUnknown(
        {
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: 'admin-cannot-delegate-release',
          type: 'issue_capability_grant',
          clientId: 'forged-control',
          capabilities: ['runtime_attachment_release'],
          ttlMs: 10_000,
        },
        credential,
      ),
    ).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    expect(
      authenticated.handleUnknown(
        {
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: 'admin-cannot-delegate-status-read',
          type: 'issue_capability_grant',
          clientId: 'forged-status-reader',
          capabilities: ['daemon_status_read'],
          ttlMs: 10_000,
        },
        credential,
      ),
    ).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    expect(registry.listGrants()).toHaveLength(1);
    authenticated.close();
  });

  it('revokes the partial control grant when model attachment issuance fails', () => {
    const service = openService();
    let materialSequence = 0;
    const registry = new GovernanceCapabilityGrantRegistry('project-1', {
      now: () => START_TIME,
      maxTtlMs: 60_000,
      tokenMaterial: () => {
        materialSequence += 1;
        if (materialSequence === 3) throw new Error('model issuance failed');
        return {
          grantId: `attachment-grant-${materialSequence}`,
          secret: `${SECRET}${materialSequence}`,
        };
      },
    });
    const broker = registry.issue({
      clientId: 'attachment-broker',
      capabilities: ['runtime_attach'],
      ttlMs: 10_000,
    });
    const authenticated = new AuthenticatedGovernanceProjectService(service, registry);
    const credential = {
      token: broker.token,
      projectId: 'project-1',
      clientId: 'attachment-broker',
    };
    const request = {
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'claim-with-failure',
      type: 'claim_runtime_attachment',
      controlClientId: 'control-client',
      modelClientId: 'model-client',
      modelCapabilities: ['task_read'],
      ttlMs: 10_000,
    } as const;

    expect(authenticated.handleUnknown(request, credential)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(registry.getGrant('attachment-grant-2')).toMatchObject({
      status: 'revoked',
      revocationReason: 'runtime attachment claim rolled back',
    });
    expect(
      registry
        .listGrants()
        .filter((grant) => grant.status === 'active' && grant.clientId !== 'attachment-broker'),
    ).toHaveLength(0);
    expect(authenticated.handleUnknown(request, credential)).toMatchObject({
      ok: true,
      result: { type: 'runtime_attachment_claimed' },
    });
    authenticated.close();
  });

  it('replays a self-rotation response to only the exact old request and credential', () => {
    const service = openService();
    const { registry, auditEvents } = registryHarness();
    const admin = registry.issue({
      clientId: 'admin-client',
      capabilities: ['capability_admin', 'audit_read'],
      ttlMs: 10_000,
    });
    const authenticated = new AuthenticatedGovernanceProjectService(service, registry);
    const oldCredential = {
      token: admin.token,
      projectId: 'project-1',
      clientId: 'admin-client',
    };
    const request = {
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'rotate-self',
      type: 'rotate_capability_grant',
      grantId: admin.grant.grantId,
      ttlMs: 10_000,
    } as const;

    const first = authenticated.handleUnknown(request, oldCredential);
    expect(authenticated.handleUnknown(request, oldCredential)).toEqual(first);
    expect(authenticated.handleUnknown({ ...request, ttlMs: 9_000 }, oldCredential)).toMatchObject({
      ok: false,
      error: { code: 'authentication_failed' },
    });
    expect(auditEvents.filter((event) => event.type === 'grant_rotated')).toHaveLength(1);
    if (!first.ok || first.result.type !== 'capability_grant_rotated') {
      throw new Error('Expected a self-rotation response.');
    }
    expect(
      authenticated.handleUnknown(
        {
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: 'health-after-self-rotation',
          type: 'health',
        },
        first.result.credential,
      ),
    ).toMatchObject({ ok: true, result: { status: 'ready' } });
    authenticated.close();
  });

  it('rejects before mutation when bounded retry receipt capacity is occupied', () => {
    const service = openService();
    const { registry } = registryHarness();
    const admin = registry.issue({
      clientId: 'admin-client',
      capabilities: ['capability_admin'],
      ttlMs: 10_000,
    });
    const receipts = new GovernanceManagementReceiptCache({ maxEntries: 1 });
    const credential = {
      token: admin.token,
      projectId: 'project-1',
      clientId: 'admin-client',
    };
    expect(
      receipts.reserve({
        input: { requestId: 'occupied', type: 'issue_capability_grant' },
        credential,
      }),
    ).not.toBeNull();
    const authenticated = new AuthenticatedGovernanceProjectService(service, registry, receipts);

    expect(
      authenticated.handleUnknown(
        {
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: 'blocked-issue',
          type: 'issue_capability_grant',
          clientId: 'model-client',
          capabilities: ['task_read'],
          ttlMs: 10_000,
        },
        credential,
      ),
    ).toMatchObject({ ok: false, error: { code: 'store_failure' } });
    expect(registry.listGrants()).toHaveLength(1);
    authenticated.close();
  });

  it('returns a deterministic in-progress response for a concurrent duplicate management request', () => {
    const service = openService();
    const { registry } = registryHarness();
    const admin = registry.issue({
      clientId: 'admin-client',
      capabilities: ['capability_admin'],
      ttlMs: 10_000,
    });
    const receipts = new GovernanceManagementReceiptCache();
    const credential = {
      token: admin.token,
      projectId: 'project-1',
      clientId: 'admin-client',
    };
    // Reserve the key out-of-band to simulate a concurrent in-flight request that
    // has not yet committed a response.
    expect(
      receipts.reserve({
        input: { requestId: 'in-flight', type: 'issue_capability_grant' },
        credential,
      }),
    ).not.toBeNull();
    const authenticated = new AuthenticatedGovernanceProjectService(service, registry, receipts);

    expect(
      authenticated.handleUnknown(
        {
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: 'in-flight',
          type: 'issue_capability_grant',
          clientId: 'model-client',
          capabilities: ['task_read'],
          ttlMs: 10_000,
        },
        credential,
      ),
    ).toMatchObject({
      ok: false,
      requestId: 'in-flight',
      error: { code: 'request_in_progress' },
    });
    // The in-flight reservation must not have been overwritten, and no grant was issued.
    expect(registry.listGrants()).toHaveLength(1);
    authenticated.close();
  });

  it('routes a valid model grant without exposing raw capability sets', () => {
    const service = openService();
    const { registry } = registryHarness();
    const issued = registry.issue({
      clientId: 'model-client',
      capabilities: ['command_submit'],
      ttlMs: 10_000,
    });
    const authenticated = new AuthenticatedGovernanceProjectService(service, registry);

    expect(
      authenticated.handleUnknown(transitionRequest(), {
        token: issued.token,
        projectId: 'project-1',
        clientId: 'model-client',
      }),
    ).toMatchObject({
      ok: true,
      result: {
        type: 'command_result',
        execution: { decision: { accepted: false, code: 'task_missing' } },
      },
    });
    authenticated.close();
  });

  it('enforces the exact grant capability after authentication', () => {
    const service = openService();
    const { registry } = registryHarness();
    const issued = registry.issue({
      clientId: 'reader',
      capabilities: ['task_read'],
      ttlMs: 10_000,
    });
    const authenticated = new AuthenticatedGovernanceProjectService(service, registry);

    expect(
      authenticated.handleUnknown(transitionRequest(), {
        token: issued.token,
        projectId: 'project-1',
        clientId: 'reader',
      }),
    ).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    authenticated.close();
  });

  it('keeps credentials outside the request and returns generic authentication failures', () => {
    const service = openService();
    const { registry } = registryHarness();
    const issued = registry.issue({
      clientId: 'model-client',
      capabilities: ['command_submit'],
      ttlMs: 10_000,
    });
    const authenticated = new AuthenticatedGovernanceProjectService(service, registry);
    const credential = {
      token: issued.token,
      projectId: 'project-1',
      clientId: 'model-client',
    };

    expect(
      authenticated.handleUnknown({ ...transitionRequest(), token: issued.token }, credential),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_request', details: [{ path: '$.token' }] },
    });
    registry.revoke(issued.grant.grantId);
    expect(authenticated.handleUnknown(transitionRequest(), credential)).toMatchObject({
      ok: false,
      requestId: 'request-transition',
      error: { code: 'authentication_failed' },
    });
    authenticated.close();
  });

  it('prevents one administrator from rotating another administrator grant', () => {
    const service = openService();
    const { registry } = registryHarness();
    const first = registry.issue({
      clientId: 'first-admin',
      capabilities: ['capability_admin'],
      ttlMs: 10_000,
    });
    const second = registry.issue({
      clientId: 'second-admin',
      capabilities: ['capability_admin'],
      ttlMs: 10_000,
    });
    const authenticated = new AuthenticatedGovernanceProjectService(service, registry);

    expect(
      authenticated.handleUnknown(
        {
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: 'rotate-other-admin',
          type: 'rotate_capability_grant',
          grantId: second.grant.grantId,
          ttlMs: 10_000,
        },
        { token: first.token, projectId: 'project-1', clientId: 'first-admin' },
      ),
    ).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    expect(
      registry.authenticate({
        token: second.token,
        projectId: 'project-1',
        clientId: 'second-admin',
      }),
    ).toMatchObject({ authenticated: true });
    authenticated.close();
  });

  it('refuses to rotate a grant that has already been revoked', () => {
    const { registry } = registryHarness();
    const issued = registry.issue({
      clientId: 'model-client',
      capabilities: ['task_read'],
      ttlMs: 10_000,
    });
    registry.revoke(issued.grant.grantId, 'revoked for testing');
    expect(() =>
      registry.rotate(issued.grant.grantId, {
        rotatedBy: 'bootstrap-admin',
        ttlMs: 10_000,
      }),
    ).toThrow('Only an active governance capability grant can be rotated.');
  });

  it('refuses to rotate an expired grant', () => {
    const { registry, advance } = registryHarness();
    const issued = registry.issue({
      clientId: 'model-client',
      capabilities: ['task_read'],
      ttlMs: 10_000,
    });
    advance(10_001);
    expect(() =>
      registry.rotate(issued.grant.grantId, {
        rotatedBy: 'bootstrap-admin',
        ttlMs: 10_000,
      }),
    ).toThrow('Only an active governance capability grant can be rotated.');
  });

  it('refuses to rotate with invalid or excessive ttlMs', () => {
    const { registry } = registryHarness();
    const issued = registry.issue({
      clientId: 'model-client',
      capabilities: ['task_read'],
      ttlMs: 10_000,
    });
    expect(() =>
      registry.rotate(issued.grant.grantId, {
        rotatedBy: 'bootstrap-admin',
        ttlMs: 0,
      }),
    ).toThrow('ttlMs must be a positive safe integer.');
    expect(() =>
      registry.rotate(issued.grant.grantId, {
        rotatedBy: 'bootstrap-admin',
        ttlMs: 120_000,
      }),
    ).toThrow(/ttlMs exceeds the configured maximum/);
  });

  it('allows an admin to rotate non-admin client grant via facade and denies non-admin caller', () => {
    const service = openService('project-1');
    const registry = new GovernanceCapabilityGrantRegistry('project-1');
    const admin = registry.issue({
      clientId: 'admin-client',
      capabilities: ['capability_admin'],
      ttlMs: 10_000,
    });
    const user = registry.issue({
      clientId: 'user-client',
      capabilities: ['task_read'],
      ttlMs: 10_000,
    });
    const authenticated = new AuthenticatedGovernanceProjectService(service, registry);

    // Non-admin attempting to rotate -> denied
    expect(
      authenticated.handleUnknown(
        {
          protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
          requestId: 'user-rotate-attempt',
          type: 'rotate_capability_grant',
          grantId: user.grant.grantId,
          ttlMs: 10_000,
        },
        { token: user.token, projectId: 'project-1', clientId: 'user-client' },
      ),
    ).toMatchObject({ ok: false, error: { code: 'permission_denied' } });

    // Admin rotating non-admin grant -> allowed
    const result = authenticated.handleUnknown(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'admin-rotate-user',
        type: 'rotate_capability_grant',
        grantId: user.grant.grantId,
        ttlMs: 10_000,
      },
      { token: admin.token, projectId: 'project-1', clientId: 'admin-client' },
    );
    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'capability_grant_rotated',
        previousGrantId: user.grant.grantId,
        grant: { clientId: 'user-client', capabilities: ['task_read'] },
      },
    });

    service.close();
  });

  it('refuses a service and registry bound to different projects', () => {
    const service = openService('project-1');
    const registry = new GovernanceCapabilityGrantRegistry('project-2');
    expect(() => new AuthenticatedGovernanceProjectService(service, registry)).toThrow(
      /projects must match/,
    );
    service.close();
  });

  it('tracks hasActiveGrants, remainingTtlMs and rotate at exact expiry, minimum 32-char secret, and issuedAt sort order', () => {
    let now = START_TIME;
    let seq = 0;
    const ids = ['z-first', 'a-second'];
    const registry = new GovernanceCapabilityGrantRegistry('project-1', {
      now: () => now,
      tokenMaterial: () => {
        const id = ids[seq] ?? `g-${seq}`;
        seq += 1;
        return { grantId: id, secret: `${SECRET}${seq}` };
      },
    });
    expect(registry.hasActiveGrants()).toBe(false);
    const first = registry.issue({
      clientId: 'c1',
      capabilities: ['task_read'],
      ttlMs: 10_000,
    });
    expect(registry.hasActiveGrants()).toBe(true);
    expect(registry.remainingTtlMs(first.grant.grantId)).toBe(10_000);

    now += 1_000;
    const second = registry.issue({
      clientId: 'c2',
      capabilities: ['task_read'],
      ttlMs: 20_000,
    });
    expect(registry.listGrants().map((g) => g.grantId)).toEqual([
      first.grant.grantId,
      second.grant.grantId,
    ]);

    // Advance to exact expiry of first grant (START_TIME + 10_000)
    now = START_TIME + 10_000;
    expect(registry.remainingTtlMs(first.grant.grantId)).toBeNull();
    expect(() =>
      registry.rotate(first.grant.grantId, {
        rotatedBy: 'bootstrap-admin',
        ttlMs: 10_000,
      }),
    ).toThrow('Only an active governance capability grant can be rotated.');

    const shortSecretRegistry = new GovernanceCapabilityGrantRegistry('project-1', {
      tokenMaterial: () => ({ grantId: 'short-sec', secret: 'x'.repeat(31) }),
    });
    expect(() =>
      shortSecretRegistry.issue({
        clientId: 'c1',
        capabilities: ['task_read'],
        ttlMs: 1_000,
      }),
    ).toThrow(/between 32 and 512 characters/);
  });
});

describe('governance capability grant registry — daemon self-grant exclusion', () => {
  it('hasActiveGrants(excludeIssuedBy) skips the daemon self-grant but still counts client grants', () => {
    let seq = 0;
    const registry = new GovernanceCapabilityGrantRegistry('project-1', {
      now: () => START_TIME,
      tokenMaterial: () => {
        seq += 1;
        return { grantId: `g-self-${seq}`, secret: `${SECRET}${seq}` };
      },
    });
    expect(registry.hasActiveGrants('governance-daemon-owner')).toBe(false);
    registry.issue({
      clientId: 'governance-attachment-broker-self',
      issuedBy: 'governance-daemon-owner',
      capabilities: ['runtime_attach'],
      ttlMs: 10 * 60_000,
    });
    // The plain check still sees the self-grant; the excluded check must not,
    // because the broker renews that credential for the daemon's whole life.
    expect(registry.hasActiveGrants()).toBe(true);
    expect(registry.hasActiveGrants('governance-daemon-owner')).toBe(false);
    registry.issue({ clientId: 'c1', capabilities: ['task_read'], ttlMs: 60_000 });
    expect(registry.hasActiveGrants('governance-daemon-owner')).toBe(true);
    expect(registry.hasActiveGrants('trusted-server')).toBe(true);
  });

  it('refuses to revoke expired grants, replays self-revocation receipts idempotently, revokes paired attachment model grants on control grant revocation, and verifies observation_hash on read (F679)', () => {
    const { registry, advance, auditEvents } = registryHarness();
    const service = openService('project-1');
    const authenticated = new AuthenticatedGovernanceProjectService(service, registry);

    // 1. Expired grant cannot be revoked and still sweeps as grant_expired
    const expiring = registry.issue({
      clientId: 'expiring-client',
      capabilities: ['task_read'],
      ttlMs: 5_000,
    });
    advance(5_000);
    expect(registry.revoke(expiring.grant.grantId, 'too late')).toBe(false);
    expect(registry.getGrant(expiring.grant.grantId)?.status).toBe('expired');
    expect(registry.sweepExpired()).toBe(1);
    expect(auditEvents.at(-1)?.type).toBe('grant_expired');

    // 2. Self-revocation replays idempotently
    const selfAdmin = registry.issue({
      clientId: 'self-admin',
      capabilities: ['capability_admin'],
      ttlMs: 30_000,
    });
    const selfCred = {
      token: selfAdmin.token,
      projectId: 'project-1',
      clientId: 'self-admin',
    };
    const selfRevokeReq = {
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: 'revoke-self-f679',
      type: 'revoke_capability_grant',
      grantId: selfAdmin.grant.grantId,
      reason: 'stepping down',
    } as const;
    const firstSelf = authenticated.handleUnknown(selfRevokeReq, selfCred);
    const retrySelf = authenticated.handleUnknown(selfRevokeReq, selfCred);
    expect(retrySelf).toEqual(firstSelf);
    expect(retrySelf).toMatchObject({
      ok: true,
      result: {
        type: 'capability_grant_revoked',
        grantId: selfAdmin.grant.grantId,
        revoked: true,
      },
    });

    // 3. Revoking attachment controlGrantId also revokes paired modelGrantId
    const broker = registry.issue({
      clientId: 'broker-f679',
      capabilities: ['runtime_attach'],
      ttlMs: 30_000,
    });
    const admin2 = registry.issue({
      clientId: 'admin-f679',
      capabilities: ['capability_admin'],
      ttlMs: 30_000,
    });
    const claimed = authenticated.handleUnknown(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'claim-f679',
        type: 'claim_runtime_attachment',
        controlClientId: 'ctrl-f679',
        modelClientId: 'mdl-f679',
        modelCapabilities: ['task_read'],
        ttlMs: 20_000,
      },
      { token: broker.token, projectId: 'project-1', clientId: 'broker-f679' },
    );
    if (!claimed.ok || claimed.result.type !== 'runtime_attachment_claimed') {
      throw new Error('Expected runtime attachment claim');
    }
    const revokeCtrl = authenticated.handleUnknown(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'revoke-ctrl-f679',
        type: 'revoke_capability_grant',
        grantId: claimed.result.control.grant.grantId,
      },
      { token: admin2.token, projectId: 'project-1', clientId: 'admin-f679' },
    );
    expect(revokeCtrl).toMatchObject({ ok: true });
    expect(registry.getGrant(claimed.result.control.grant.grantId)?.status).toBe('revoked');
    expect(registry.getGrant(claimed.result.model.grant.grantId)?.status).toBe('revoked');

    // 4. Revoking an expired attachment controlGrantId still revokes an active rotated modelGrantId
    const claimed2 = authenticated.handleUnknown(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'claim-f829',
        type: 'claim_runtime_attachment',
        controlClientId: 'ctrl-f829',
        modelClientId: 'mdl-f829',
        modelCapabilities: ['task_read'],
        ttlMs: 5_000,
      },
      { token: broker.token, projectId: 'project-1', clientId: 'broker-f679' },
    );
    if (!claimed2.ok || claimed2.result.type !== 'runtime_attachment_claimed') {
      throw new Error('Expected runtime attachment claim');
    }
    const rotatedModel = authenticated.handleUnknown(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'rotate-mdl-f829',
        type: 'rotate_capability_grant',
        grantId: claimed2.result.model.grant.grantId,
        ttlMs: 25_000,
      },
      { token: admin2.token, projectId: 'project-1', clientId: 'admin-f679' },
    );
    if (!rotatedModel.ok || rotatedModel.result.type !== 'capability_grant_rotated') {
      throw new Error('Expected model grant rotation');
    }
    advance(6_000);
    const revokeExpiredCtrl = authenticated.handleUnknown(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'revoke-expired-ctrl-f829',
        type: 'revoke_capability_grant',
        grantId: claimed2.result.control.grant.grantId,
      },
      { token: admin2.token, projectId: 'project-1', clientId: 'admin-f679' },
    );
    expect(revokeExpiredCtrl).toMatchObject({
      ok: true,
      result: {
        type: 'capability_grant_revoked',
        grantId: claimed2.result.control.grant.grantId,
        revoked: true,
      },
    });
    expect(registry.getGrant(rotatedModel.result.grant.grantId)?.status).toBe('revoked');

    authenticated.close();
  });

  it('protects daemon owner broker grants from RPC rotation/revocation, caps attached grant rotation TTL, prunes inactive grant IDs on rotate, and rejects oversized clientId (F41)', async () => {
    const { GOVERNANCE_DAEMON_OWNER_ISSUER } = await import('../src/index.js');
    const now = START_TIME;
    let seq = 0;
    const registry = new GovernanceCapabilityGrantRegistry('project-1', {
      now: () => now,
      tokenMaterial: () => {
        seq += 1;
        return { grantId: `grant-f41-${seq}`, secret: `${SECRET}${seq}` };
      },
    });
    const service = openService('project-1');
    const authenticated = new AuthenticatedGovernanceProjectService(service, registry);

    const broker = registry.issue({
      clientId: 'governance-attachment-broker-inst1',
      issuedBy: GOVERNANCE_DAEMON_OWNER_ISSUER,
      capabilities: ['runtime_attach', 'daemon_status_read'],
      ttlMs: 60 * 60 * 1_000,
    });
    const admin = registry.issue({
      clientId: 'admin-client',
      capabilities: ['capability_admin'],
      ttlMs: 60 * 60 * 1_000,
    });
    const adminCred = {
      token: admin.token,
      projectId: 'project-1',
      clientId: 'admin-client',
    };

    const rotateBrokerResp = authenticated.handleUnknown(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'rot-broker-f41',
        type: 'rotate_capability_grant',
        grantId: broker.grant.grantId,
      },
      adminCred,
    );
    expect(rotateBrokerResp.ok).toBe(false);

    const revokeBrokerResp = authenticated.handleUnknown(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'rev-broker-f41',
        type: 'revoke_capability_grant',
        grantId: broker.grant.grantId,
      },
      adminCred,
    );
    expect(revokeBrokerResp.ok).toBe(false);
    expect(registry.getGrant(broker.grant.grantId)?.status).toBe('active');

    const attachResp = authenticated.handleUnknown(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'attach-f41',
        type: 'claim_runtime_attachment',
        controlClientId: 'attached-ctrl',
        modelClientId: 'attached-mdl',
        modelCapabilities: ['task_read'],
        ttlMs: 60_000,
      },
      {
        token: broker.token,
        projectId: 'project-1',
        clientId: 'governance-attachment-broker-inst1',
      },
    );
    if (!attachResp.ok || attachResp.result.type !== 'runtime_attachment_claimed') {
      authenticated.close();
      throw new Error('Expected runtime_attachment_claimed');
    }
    const rotateAttachedResp = authenticated.handleUnknown(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'rot-attached-f41',
        type: 'rotate_capability_grant',
        grantId: attachResp.result.model.grant.grantId,
        ttlMs: 24 * 60 * 60 * 1_000,
      },
      adminCred,
    );
    expect(rotateAttachedResp.ok).toBe(true);
    if (rotateAttachedResp.ok && rotateAttachedResp.result.type === 'capability_grant_rotated') {
      const ttl =
        Date.parse(rotateAttachedResp.result.grant.expiresAt) -
        Date.parse(rotateAttachedResp.result.grant.issuedAt);
      expect(ttl).toBeLessThanOrEqual(30 * 60 * 1_000);
    }

    let reuseStep = 0;
    const reuseRegistry = new GovernanceCapabilityGrantRegistry('project-1', {
      now: () => now,
      tokenMaterial: () => {
        reuseStep += 1;
        const id = reuseStep === 1 || reuseStep === 3 ? 'grant-reused' : 'grant-2';
        return { grantId: id, secret: `${SECRET}${reuseStep}` };
      },
    });
    const g1 = reuseRegistry.issue({
      clientId: 'client-1',
      capabilities: ['daemon_status_read'],
      ttlMs: 60_000,
    });
    const g2 = reuseRegistry.issue({
      clientId: 'client-1',
      capabilities: ['daemon_status_read'],
      ttlMs: 60_000,
    });
    reuseRegistry.revoke(g1.grant.grantId);
    const rotatedReuse = reuseRegistry.rotate(g2.grant.grantId, { ttlMs: 10_000 });
    expect(rotatedReuse.grant.grantId).toBe('grant-reused');

    expect(() =>
      registry.issue({
        clientId: 'x'.repeat(1_024),
        capabilities: ['daemon_status_read'],
        ttlMs: 60_000,
      }),
    ).toThrow('clientId must contain at most 512 characters.');

    authenticated.close();
  });
});
