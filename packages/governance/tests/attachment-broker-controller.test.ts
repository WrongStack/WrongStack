import { describe, expect, it } from 'vitest';
import {
  createGovernanceDaemonMetadata,
  GovernanceAttachmentBrokerController,
  type GovernanceAttachmentBrokerLifecycleEvent,
  type GovernanceAttachmentBrokerScheduler,
  type GovernanceDaemonAttachmentBrokerRecord,
} from '../src/index.js';

const START = Date.parse('2026-08-02T10:00:00.000Z');
const SECRET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';

function harness() {
  let now = START;
  let sequence = 0;
  let failPublish = false;
  let failRevoke = false;
  let failAudit = false;
  let published: GovernanceDaemonAttachmentBrokerRecord | null = null;
  const order: string[] = [];
  const issuedCapabilities: string[][] = [];
  const events: GovernanceAttachmentBrokerLifecycleEvent[] = [];
  const scheduled = new Map<number, { readonly callback: () => void; readonly delayMs: number }>();
  let scheduleSequence = 0;
  const scheduler: GovernanceAttachmentBrokerScheduler = {
    schedule(callback, delayMs) {
      scheduleSequence += 1;
      scheduled.set(scheduleSequence, { callback, delayMs });
      return scheduleSequence;
    },
    cancel(handle) {
      scheduled.delete(handle as number);
    },
  };
  const metadata = createGovernanceDaemonMetadata({
    projectRoot: process.cwd(),
    projectId: 'project-one',
    pid: 123,
    instanceId: 'daemon-instance',
    startedAt: new Date(START).toISOString(),
  });
  const controller = new GovernanceAttachmentBrokerController({
    projectRoot: process.cwd(),
    metadata,
    ttlMs: 60_000,
    renewBeforeMs: 15_000,
    retryMs: 5_000,
    now: () => now,
    scheduler,
    grants: {
      issueGrant(options) {
        sequence += 1;
        const grantId = `broker-${sequence}`;
        order.push(`issue:${grantId}`);
        issuedCapabilities.push([...options.capabilities]);
        return {
          token: `wsg_${grantId}.${SECRET}${sequence}`,
          grant: {
            grantId,
            projectId: 'project-one',
            clientId: options.clientId,
            issuedBy: options.issuedBy ?? 'trusted-server',
            capabilities: Object.freeze([...options.capabilities]),
            issuedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + options.ttlMs).toISOString(),
            status: 'active',
          },
        };
      },
      revokeGrant(grantId) {
        order.push(`revoke:${grantId}`);
        if (failRevoke) throw new Error('simulated broker revocation failure');
        return true;
      },
    },
    publish: async (broker) => {
      order.push(`publish:${broker.grantId}`);
      if (failPublish) throw new Error('simulated broker publication failure');
      published = broker;
    },
    remove: async () => {
      order.push('remove');
      published = null;
      return true;
    },
    onEvent: (event) => {
      if (failAudit) {
        throw new Error(`simulated audit failure ${`wsg_${SECRET}.sensitive`}`);
      }
      events.push(event);
    },
  });
  return {
    controller,
    order,
    scheduled,
    events,
    issuedCapabilities,
    published: () => published,
    advance(ms: number) {
      now += ms;
    },
    setPublishFailure(value: boolean) {
      failPublish = value;
    },
    setRevokeFailure(value: boolean) {
      failRevoke = value;
    },
    setAuditFailure(value: boolean) {
      failAudit = value;
    },
  };
}

describe('governance attachment broker controller', () => {
  it('publishes the replacement before revoking the prior broker and schedules renewal', async () => {
    const test = harness();
    await test.controller.start();
    expect(test.issuedCapabilities).toEqual([['runtime_attach', 'daemon_status_read']]);
    expect(test.controller.snapshot()).toMatchObject({
      state: 'active',
      health: 'healthy',
      grantId: 'broker-1',
      expiresAt: '2026-08-02T10:01:00.000Z',
      consecutiveFailures: 0,
      nextActionAt: '2026-08-02T10:00:45.000Z',
    });
    expect([...test.scheduled.values()].map((entry) => entry.delayMs)).toEqual([45_000]);

    test.advance(45_000);
    await test.controller.rotateNow();

    expect(test.published()).toMatchObject({ grantId: 'broker-2' });
    expect(test.order.indexOf('publish:broker-2')).toBeLessThan(
      test.order.indexOf('revoke:broker-1'),
    );
    expect(test.controller.snapshot()).toMatchObject({
      state: 'active',
      grantId: 'broker-2',
      nextActionAt: '2026-08-02T10:01:30.000Z',
    });
    expect(JSON.stringify(test.controller.snapshot())).not.toContain('wsg_');
    expect(test.events.map((event) => event.type)).toEqual(['published', 'published']);
  });

  it('keeps the published broker, revokes an unpublished replacement, and retries', async () => {
    const test = harness();
    await test.controller.start();
    test.advance(45_000);
    test.setPublishFailure(true);

    await expect(test.controller.rotateNow()).rejects.toThrow('publication failure');

    expect(test.published()).toMatchObject({ grantId: 'broker-1' });
    expect(test.controller.snapshot()).toMatchObject({
      state: 'retry_wait',
      health: 'healthy',
      grantId: 'broker-1',
      consecutiveFailures: 1,
      nextActionAt: '2026-08-02T10:00:50.000Z',
      lastFailure: 'simulated broker publication failure',
    });
    expect(test.order).toContain('revoke:broker-2');
    expect([...test.scheduled.values()].map((entry) => entry.delayMs)).toEqual([5_000]);

    test.setPublishFailure(false);
    test.advance(5_000);
    await test.controller.rotateNow();
    expect(test.published()).toMatchObject({ grantId: 'broker-3' });
    expect(test.order.indexOf('publish:broker-3')).toBeLessThan(
      test.order.indexOf('revoke:broker-1'),
    );
    expect(test.controller.snapshot()).toMatchObject({
      state: 'active',
      grantId: 'broker-3',
      consecutiveFailures: 0,
    });
  });

  it('becomes degraded at the deterministic failure threshold and records recovery', async () => {
    const test = harness();
    await test.controller.start();
    test.setPublishFailure(true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      test.advance(attempt === 0 ? 45_000 : 5_000);
      await expect(test.controller.rotateNow()).rejects.toThrow('publication failure');
    }
    expect(test.controller.snapshot()).toMatchObject({
      state: 'retry_wait',
      health: 'degraded',
      consecutiveFailures: 3,
      pendingRevocations: 0,
    });
    expect(test.events.map((event) => event.type)).toEqual([
      'published',
      'renewal_failed',
      'degraded',
    ]);

    test.setPublishFailure(false);
    test.advance(5_000);
    await test.controller.rotateNow();
    expect(test.controller.snapshot()).toMatchObject({
      state: 'active',
      health: 'healthy',
      consecutiveFailures: 0,
    });
    expect(test.events.at(-1)?.type).toBe('recovered');
  });

  it('surfaces failed revocation and audit persistence without exposing credentials', async () => {
    const test = harness();
    test.setAuditFailure(true);
    await test.controller.start();
    expect(test.controller.snapshot()).toMatchObject({
      state: 'active',
      health: 'degraded',
      auditHealthy: false,
    });
    expect(JSON.stringify(test.controller.snapshot())).not.toContain('wsg_');

    test.setAuditFailure(false);
    test.setRevokeFailure(true);
    test.advance(45_000);
    await test.controller.rotateNow();
    expect(test.controller.snapshot()).toMatchObject({
      health: 'degraded',
      auditHealthy: true,
      pendingRevocations: 1,
      lastFailure: 'simulated broker revocation failure',
    });
    expect(test.events.map((event) => event.type)).toContain('revocation_failed');

    test.setRevokeFailure(false);
    test.advance(45_000);
    await test.controller.rotateNow();
    expect(test.controller.snapshot()).toMatchObject({
      health: 'healthy',
      pendingRevocations: 0,
    });
    expect(test.events.map((event) => event.type)).toContain('recovered');
    expect(JSON.stringify(test.events)).not.toContain('wsg_');
  });

  it('fails initial startup without publishing or retaining the rejected grant', async () => {
    const test = harness();
    test.setPublishFailure(true);

    await expect(test.controller.start()).rejects.toThrow('publication failure');

    expect(test.published()).toBeNull();
    expect(test.order).toEqual(['issue:broker-1', 'publish:broker-1', 'revoke:broker-1']);
    expect(test.scheduled.size).toBe(0);
    expect(test.controller.snapshot()).toMatchObject({
      state: 'idle',
      grantId: null,
      consecutiveFailures: 1,
    });
    await test.controller.stop();
  });

  it('cancels renewal, removes publication, and revokes the active grant on stop', async () => {
    const test = harness();
    await test.controller.start();

    await expect(test.controller.stop()).resolves.toMatchObject({
      state: 'stopped',
      grantId: null,
    });
    expect(test.controller.snapshot()).not.toHaveProperty('nextActionAt');
    expect(test.scheduled.size).toBe(0);
    expect(test.published()).toBeNull();
    expect(test.order.slice(-2)).toEqual(['remove', 'revoke:broker-1']);
    await expect(test.controller.rotateNow()).rejects.toThrow('stopped');
  });

  it('rejects invalid renewal bounds before issuing credentials', () => {
    const test = harness();
    expect(
      () =>
        new GovernanceAttachmentBrokerController({
          projectRoot: process.cwd(),
          metadata: createGovernanceDaemonMetadata({
            projectRoot: process.cwd(),
            projectId: 'project-one',
            pid: 123,
            instanceId: 'daemon-instance',
            startedAt: new Date(START).toISOString(),
          }),
          grants: {
            issueGrant: () => {
              throw new Error('must not issue');
            },
            revokeGrant: () => false,
          },
          ttlMs: 10_000,
          renewBeforeMs: 10_000,
        }),
    ).toThrow('less than ttlMs');
    expect(test.order).toEqual([]);
  });
});
