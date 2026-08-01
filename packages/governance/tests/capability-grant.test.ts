import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthenticatedGovernanceProjectService,
  GOVERNANCE_SERVICE_PROTOCOL_VERSION,
  GovernanceCapabilityGrantRegistry,
  GovernanceProjectService,
  SqliteGovernanceEventStore,
} from '../src/index.js';

const START_TIME = Date.parse('2026-08-01T14:00:00.000Z');
const SECRET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';

function registryHarness(projectId = 'project-1') {
  let now = START_TIME;
  let sequence = 0;
  const auditEvents: unknown[] = [];
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

  it('refuses a service and registry bound to different projects', () => {
    const service = openService('project-1');
    const registry = new GovernanceCapabilityGrantRegistry('project-2');
    expect(() => new AuthenticatedGovernanceProjectService(service, registry)).toThrow(
      /projects must match/,
    );
    service.close();
  });
});
