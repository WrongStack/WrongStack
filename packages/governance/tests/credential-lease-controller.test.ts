import { describe, expect, it } from 'vitest';
import {
  GOVERNANCE_SERVICE_PROTOCOL_VERSION,
  GovernanceCredentialLeaseController,
  type GovernanceCredentialLeaseScheduler,
  type GovernanceServiceCredential,
  type GovernanceServiceResponse,
} from '../src/index.js';

const START = Date.parse('2026-08-01T12:00:00.000Z');
const OLD_TOKEN = 'wsg_admin-1.0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
const NEW_TOKEN = 'wsg_admin-2.1123456789abcdefghijklmnopqrstuvwxyzABCDEFG';

class FakeScheduler implements GovernanceCredentialLeaseScheduler {
  private sequence = 0;
  readonly tasks = new Map<number, { readonly callback: () => void; readonly delayMs: number }>();

  schedule(callback: () => void, delayMs: number): unknown {
    this.sequence += 1;
    this.tasks.set(this.sequence, { callback, delayMs });
    return this.sequence;
  }

  cancel(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  delays(): number[] {
    return [...this.tasks.values()].map((task) => task.delayMs);
  }
}

function credential(token = OLD_TOKEN): GovernanceServiceCredential {
  return { token, projectId: 'project-1', clientId: 'admin-client' };
}

function rotatedResponse(requestId: string): GovernanceServiceResponse {
  return {
    ok: true,
    requestId,
    result: {
      type: 'capability_grant_rotated',
      previousGrantId: 'admin-1',
      grant: {
        grantId: 'admin-2',
        projectId: 'project-1',
        clientId: 'admin-client',
        issuedBy: 'admin-client',
        capabilities: ['audit_read', 'capability_admin'],
        issuedAt: new Date(START).toISOString(),
        expiresAt: new Date(START + 20_000).toISOString(),
        status: 'active',
      },
      credential: credential(NEW_TOKEN),
    },
  };
}

describe('governance credential lease controller', () => {
  it('schedules renewal and swaps its process-local client after validated self-rotation', async () => {
    const scheduler = new FakeScheduler();
    const clientCredentials: GovernanceServiceCredential[] = [];
    const requests: unknown[] = [];
    const controller = new GovernanceCredentialLeaseController({
      projectRoot: 'C:/project',
      projectId: 'project-1',
      grantId: 'admin-1',
      expiresAt: new Date(START + 10_000).toISOString(),
      credential: credential(),
      rotationTtlMs: 20_000,
      renewBeforeMs: 5_000,
      retryDelayMs: 1_000,
      maxAttempts: 3,
      now: () => START,
      scheduler,
      requestIdFactory: () => 'rotation-cycle-1',
      clientFactory: (current) => {
        clientCredentials.push(current);
        return {
          async request(input) {
            requests.push(input);
            const type =
              input && typeof input === 'object' && 'type' in input ? input.type : undefined;
            if (type === 'rotate_capability_grant') return rotatedResponse('rotation-cycle-1');
            return {
              ok: true,
              requestId: 'health',
              result: {
                type: 'health',
                projectId: 'project-1',
                protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
                status: 'ready',
              },
            };
          },
        };
      },
    });

    expect(controller.start()).toMatchObject({
      state: 'scheduled',
      grantId: 'admin-1',
      nextActionAt: new Date(START + 5_000).toISOString(),
    });
    expect(scheduler.delays()).toEqual([5_000]);
    const rotated = await controller.rotateNow();
    expect(rotated).toMatchObject({
      state: 'scheduled',
      grantId: 'admin-2',
      expiresAt: new Date(START + 20_000).toISOString(),
      rotationAttempt: 0,
    });
    expect(scheduler.delays()).toEqual([15_000]);
    expect(clientCredentials.map((item) => item.token)).toEqual([OLD_TOKEN, NEW_TOKEN]);
    expect(requests[0]).toMatchObject({
      requestId: 'rotation-cycle-1',
      type: 'rotate_capability_grant',
      grantId: 'admin-1',
    });
    await expect(
      controller.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'health',
        type: 'health',
      }),
    ).resolves.toMatchObject({ ok: true, result: { status: 'ready' } });
    expect(JSON.stringify(controller.snapshot())).not.toContain('wsg_');
    expect(controller.stop()).toMatchObject({ state: 'stopped', stopReason: 'stopped_by_owner' });
    expect(scheduler.tasks.size).toBe(0);
  });

  it('reuses one request id for bounded retries and stops after exhaustion', async () => {
    const scheduler = new FakeScheduler();
    const requestIds: string[] = [];
    const controller = new GovernanceCredentialLeaseController({
      projectRoot: 'C:/project',
      projectId: 'project-1',
      grantId: 'admin-1',
      expiresAt: new Date(START + 10_000).toISOString(),
      credential: credential(),
      rotationTtlMs: 20_000,
      renewBeforeMs: 5_000,
      retryDelayMs: 1_000,
      maxAttempts: 3,
      now: () => START,
      scheduler,
      requestIdFactory: () => 'stable-retry-id',
      clientFactory: () => ({
        async request(input) {
          if (input && typeof input === 'object' && 'requestId' in input) {
            requestIds.push(String(input.requestId));
          }
          throw new Error(`transport unavailable ${OLD_TOKEN}`);
        },
      }),
    });

    await expect(controller.rotateNow()).resolves.toMatchObject({
      state: 'retry_wait',
      rotationAttempt: 1,
      lastFailure: 'transport unavailable [credential]',
    });
    await controller.rotateNow();
    await expect(controller.rotateNow()).resolves.toMatchObject({
      state: 'stopped',
      rotationAttempt: 3,
      stopReason: 'retry_exhausted',
    });
    expect(requestIds).toEqual(['stable-retry-id', 'stable-retry-id', 'stable-retry-id']);
    expect(JSON.stringify(controller.snapshot())).not.toContain(OLD_TOKEN);
    expect(scheduler.tasks.size).toBe(0);
    await expect(controller.rotateNow()).resolves.toMatchObject({
      state: 'stopped',
      rotationAttempt: 3,
    });
  });

  it('holds normal requests until an in-flight rotation installs the replacement client', async () => {
    let finishRotation: ((response: GovernanceServiceResponse) => void) | undefined;
    const clientTokens: string[] = [];
    const controller = new GovernanceCredentialLeaseController({
      projectRoot: 'C:/project',
      projectId: 'project-1',
      grantId: 'admin-1',
      expiresAt: new Date(START + 10_000).toISOString(),
      credential: credential(),
      rotationTtlMs: 20_000,
      renewBeforeMs: 5_000,
      now: () => START,
      requestIdFactory: () => 'serialized-rotation',
      clientFactory: (current) => {
        clientTokens.push(current.token);
        return {
          request(input) {
            const type =
              input && typeof input === 'object' && 'type' in input ? input.type : undefined;
            if (type === 'rotate_capability_grant') {
              return new Promise((resolve) => {
                finishRotation = resolve;
              });
            }
            return Promise.resolve({
              ok: true,
              requestId: 'health-after-wait',
              result: {
                type: 'health',
                projectId: 'project-1',
                protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
                status: 'ready',
              },
            });
          },
        };
      },
    });

    const rotation = controller.rotateNow();
    let healthCompleted = false;
    const health = controller
      .request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: 'health-after-wait',
        type: 'health',
      })
      .then((result) => {
        healthCompleted = true;
        return result;
      });
    await Promise.resolve();
    expect(healthCompleted).toBe(false);
    if (!finishRotation) throw new Error('Expected the rotation request to be in flight.');
    finishRotation(rotatedResponse('serialized-rotation'));
    await rotation;
    await expect(health).resolves.toMatchObject({ ok: true, result: { status: 'ready' } });
    expect(clientTokens).toEqual([OLD_TOKEN, NEW_TOKEN]);
    controller.stop();
  });

  it('expires without attempting rotation when the initial credential is already stale', () => {
    let requests = 0;
    const controller = new GovernanceCredentialLeaseController({
      projectRoot: 'C:/project',
      projectId: 'project-1',
      grantId: 'admin-1',
      expiresAt: new Date(START).toISOString(),
      credential: credential(),
      rotationTtlMs: 20_000,
      renewBeforeMs: 5_000,
      now: () => START,
      clientFactory: () => ({
        async request() {
          requests += 1;
          throw new Error('must not run');
        },
      }),
    });

    expect(controller.start()).toMatchObject({
      state: 'expired',
      stopReason: 'credential_expired',
    });
    expect(requests).toBe(0);
  });

  it('rejects a retry policy that can outlive the server receipt window', () => {
    expect(
      () =>
        new GovernanceCredentialLeaseController({
          projectRoot: 'C:/project',
          projectId: 'project-1',
          grantId: 'admin-1',
          expiresAt: new Date(START + 60_000).toISOString(),
          credential: credential(),
          rotationTtlMs: 60_000,
          renewBeforeMs: 5_000,
          retryDelayMs: 6_000,
          requestTimeoutMs: 5_000,
          maxAttempts: 4,
          now: () => START,
          clientFactory: () => ({
            async request() {
              throw new Error('must not run');
            },
          }),
        }),
    ).toThrow(/retry window must fit/);
  });
});
