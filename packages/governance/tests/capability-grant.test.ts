import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
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
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
});
