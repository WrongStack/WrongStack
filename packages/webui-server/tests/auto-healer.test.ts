import type { Logger } from '@wrongstack/core/types';
import type { TrustBoundary } from '@wrongstack/core/security';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_HEAL_ENV_FLAG,
  AUTO_HEAL_DEFAULT_COOLDOWN_MS,
  createAutoHealer,
  isAutoHealEnabled,
} from '../src/server/connections/auto-healer.js';
import type {
  ConnectionHealthService,
  ConnectionsHealthReport,
  ServiceActionResult,
} from '../src/server/connections/types.js';

function makeLogger(): Logger {
  return {
    level: 'warn',
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => makeLogger()),
  } as unknown as Logger;
}

function makeBoundary(kind: 'allow' | 'deny' = 'allow'): TrustBoundary {
  return {
    evaluate: vi.fn(async () => ({ kind, reason: kind === 'allow' ? 'allowed' : 'denied' })),
  } as unknown as TrustBoundary;
}

function service(
  id: ConnectionHealthService['id'],
  status: ConnectionHealthService['status'],
  extra: Partial<ConnectionHealthService> = {},
): ConnectionHealthService {
  return {
    id,
    label: id,
    status,
    required: true,
    mode: 'project-server',
    detail: `${id} ${status}`,
    ...extra,
  };
}

function report(
  services: ConnectionHealthService[],
  overall: ConnectionsHealthReport['overall'] = 'degraded',
): ConnectionsHealthReport {
  return {
    checkedAt: Date.now(),
    overall,
    backend: 'standalone',
    projectRoot: '/project',
    services,
  };
}

const okResult = (serviceId: ConnectionHealthService['id']): ServiceActionResult => ({
  serviceId,
  action: 'restart',
  success: true,
  message: 'restarted',
});

describe('auto-healer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('is disabled unless the env flag (or explicit enabled) turns it on', () => {
    vi.stubEnv(AUTO_HEAL_ENV_FLAG, '0');
    expect(isAutoHealEnabled()).toBe(false);
    vi.stubEnv(AUTO_HEAL_ENV_FLAG, '1');
    expect(isAutoHealEnabled()).toBe(true);
  });

  it('does nothing while disabled', async () => {
    const collect = vi.fn(async () => report([service('kanban', 'error')]));
    const execute = vi.fn(async () => okResult('kanban'));
    const healer = createAutoHealer({
      projectRoot: () => '/project',
      indexDir: () => undefined,
      trustBoundary: makeBoundary(),
      collect,
      execute,
      enabled: false,
    });
    healer.start();
    expect(healer.isRunning()).toBe(false);
    await healer.tick();
    expect(collect).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('restarts a service stuck in error once per cooldown window', async () => {
    const collect = vi.fn(async () => report([service('kanban', 'error')]));
    const execute = vi.fn(async () => okResult('kanban'));
    const healer = createAutoHealer({
      projectRoot: () => '/project',
      indexDir: () => '/index',
      trustBoundary: makeBoundary(),
      collect,
      execute,
      enabled: true,
    });

    await healer.tick();
    expect(execute).toHaveBeenCalledExactlyOnceWith('kanban', 'restart', '/project', '/index');
    expect(execute).toHaveBeenCalledTimes(1);

    // Second tick inside the cooldown window must not re-restart.
    await healer.tick();
    expect(execute).toHaveBeenCalledTimes(1);

    const snapshot = healer.getSnapshot();
    expect(snapshot.services['kanban']?.lastSuccess).toBe(true);
    expect(snapshot.services['kanban']?.lastAttemptAt).not.toBeNull();
  });

  it('never restarts offline/unavailable/degraded/healthy services', async () => {
    const collect = vi.fn(async () =>
      report([
        service('sage', 'offline'),
        service('codebase-index', 'unavailable'),
        service('chronicle', 'degraded'),
        service('mailbox', 'healthy'),
      ]),
    );
    const execute = vi.fn(async () => okResult('mailbox'));
    const healer = createAutoHealer({
      projectRoot: () => '/project',
      indexDir: () => undefined,
      trustBoundary: makeBoundary(),
      collect,
      execute,
      enabled: true,
    });

    await healer.tick();
    expect(execute).not.toHaveBeenCalled();
  });

  it('skips non-restartable services even when they report error', async () => {
    const collect = vi.fn(async () =>
      report([
        service('webui', 'error'),
        service('session-catalog', 'error'),
        service('governance', 'error'),
      ]),
    );
    const execute = vi.fn(async () => okResult('webui'));
    const healer = createAutoHealer({
      projectRoot: () => '/project',
      indexDir: () => undefined,
      trustBoundary: makeBoundary(),
      collect,
      execute,
      enabled: true,
    });

    await healer.tick();
    expect(execute).not.toHaveBeenCalled();
  });

  it('escalates after maxAttempts consecutive failures and re-arms on recovery', async () => {
    const collect = vi.fn(async () => report([service('kanban', 'error')]));
    const execute = vi.fn(
      async (): Promise<ServiceActionResult> => ({
        serviceId: 'kanban',
        action: 'restart',
        success: false,
        message: 'verification failed',
      }),
    );
    const healer = createAutoHealer({
      projectRoot: () => '/project',
      indexDir: () => undefined,
      trustBoundary: makeBoundary(),
      collect,
      execute,
      enabled: true,
      cooldownMs: 0,
      maxAttempts: 2,
    });

    await healer.tick();
    await healer.tick();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(healer.getSnapshot().services['kanban']?.consecutiveFailures).toBe(2);
    expect(healer.getSnapshot().services['kanban']?.escalated).toBe(true);

    // Escalated: no further attempts while still in error.
    await healer.tick();
    expect(execute).toHaveBeenCalledTimes(2);

    // A healthy observation re-arms the watchdog.
    collect.mockResolvedValue(report([service('kanban', 'healthy')]));
    await healer.tick();
    expect(healer.getSnapshot().services['kanban']?.consecutiveFailures).toBe(0);
    expect(healer.getSnapshot().services['kanban']?.escalated).toBe(false);
  });

  it('respects a policy refusal without executing or counting it as a failure', async () => {
    const collect = vi.fn(async () => report([service('kanban', 'error')]));
    const execute = vi.fn(async () => okResult('kanban'));
    const boundary = makeBoundary('deny');
    const healer = createAutoHealer({
      projectRoot: () => '/project',
      indexDir: () => undefined,
      trustBoundary: boundary,
      collect,
      execute,
      enabled: true,
      cooldownMs: 0,
    });

    await healer.tick();
    expect(execute).not.toHaveBeenCalled();
    expect(healer.getSnapshot().services['kanban']?.consecutiveFailures).toBe(0);
    expect(healer.getSnapshot().services['kanban']?.lastMessage).toContain('refused by policy');
  });

  it('does not act at all when no trust boundary is configured', async () => {
    const collect = vi.fn(async () => report([service('kanban', 'error')]));
    const execute = vi.fn(async () => okResult('kanban'));
    const healer = createAutoHealer({
      projectRoot: () => '/project',
      indexDir: () => undefined,
      collect,
      execute,
      enabled: true,
    });

    await healer.tick();
    expect(collect).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('single-flights overlapping ticks', async () => {
    let resolveCollect: ((r: ConnectionsHealthReport) => void) | null = null;
    const collect = vi.fn(
      () =>
        new Promise<ConnectionsHealthReport>((resolve) => {
          resolveCollect = resolve;
        }),
    );
    const execute = vi.fn(async () => okResult('kanban'));
    const healer = createAutoHealer({
      projectRoot: () => '/project',
      indexDir: () => undefined,
      trustBoundary: makeBoundary(),
      collect,
      execute,
      enabled: true,
      cooldownMs: 0,
    });

    const first = healer.tick();
    const second = healer.tick();
    expect(collect).toHaveBeenCalledTimes(1);
    resolveCollect!(report([service('kanban', 'error')]));
    await first;
    await second;
    expect(collect).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('start() ticks immediately then on the interval; stop() halts', async () => {
    const collect = vi.fn(async () => report([service('kanban', 'error')]));
    const execute = vi.fn(async () => okResult('kanban'));
    const healer = createAutoHealer({
      projectRoot: () => '/project',
      indexDir: () => undefined,
      trustBoundary: makeBoundary(),
      collect,
      execute,
      enabled: true,
      intervalMs: 60_000,
      cooldownMs: AUTO_HEAL_DEFAULT_COOLDOWN_MS,
    });

    healer.start();
    expect(healer.isRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(collect).toHaveBeenCalledTimes(1); // immediate first pass

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(collect).toHaveBeenCalledTimes(3); // initial + 2 interval ticks

    healer.stop();
    expect(healer.isRunning()).toBe(false);
    const calls = collect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(collect.mock.calls.length).toBe(calls);
  });

  it('emits onStatus events for UI visibility on success', async () => {
    const events: Array<{ phase: string; serviceId: string | null; message: string }> = [];
    const collect = vi.fn(async () => report([service('kanban', 'error')]));
    const execute = vi.fn(async () => okResult('kanban'));
    const healer = createAutoHealer({
      projectRoot: () => '/project',
      indexDir: () => undefined,
      trustBoundary: makeBoundary(),
      collect,
      execute,
      enabled: true,
      onStatus: (event) =>
        events.push({ phase: event.phase, serviceId: event.serviceId, message: event.message }),
    });

    await healer.tick();
    expect(events.map((e) => e.phase)).toEqual(['restarting', 'restarted']);
    expect(events[0]).toMatchObject({
      serviceId: 'kanban',
      message: expect.stringContaining('Auto-restarting'),
    });
  });

  it('emits refused when policy denies, and failed + escalated on repeated failures', async () => {
    const events: Array<{ phase: string; serviceId: string | null }> = [];
    const denied = createAutoHealer({
      projectRoot: () => '/project',
      indexDir: () => undefined,
      trustBoundary: makeBoundary('deny'),
      collect: vi.fn(async () => report([service('kanban', 'error')])),
      execute: vi.fn(async () => okResult('kanban')),
      enabled: true,
      onStatus: (event) => events.push({ phase: event.phase, serviceId: event.serviceId }),
    });
    await denied.tick();
    expect(events.map((e) => e.phase)).toEqual(['refused']);

    const failing = vi.fn(
      async (): Promise<ServiceActionResult> => ({
        serviceId: 'kanban',
        action: 'restart',
        success: false,
        message: 'verify failed',
      }),
    );
    const healer = createAutoHealer({
      projectRoot: () => '/project',
      indexDir: () => undefined,
      trustBoundary: makeBoundary(),
      collect: vi.fn(async () => report([service('kanban', 'error')])),
      execute: failing,
      enabled: true,
      cooldownMs: 0,
      maxAttempts: 2,
      onStatus: (event) => events.push({ phase: event.phase, serviceId: event.serviceId }),
    });
    await healer.tick();
    await healer.tick();
    expect(events.map((e) => e.phase)).toEqual([
      'refused',
      'restarting',
      'failed',
      'restarting',
      'failed',
      'escalated',
    ]);
  });

  it('never starts a restart when disposal begins mid-authorization', async () => {
    // Authorization parks on a promise we control, so disposal can begin
    // while the authorizeWebUIAction await is still pending.
    let resolveAuth: (decision: { kind: 'allow'; reason: string }) => void = () => {};
    const gate = new Promise<{ kind: 'allow'; reason: string }>((resolve) => {
      resolveAuth = resolve;
    });
    const boundary = { evaluate: vi.fn(() => gate) } as unknown as TrustBoundary;
    const collect = vi.fn(async () => report([service('kanban', 'error')]));
    const execute = vi.fn(async () => okResult('kanban'));
    const events: string[] = [];
    const healer = createAutoHealer({
      projectRoot: () => '/project',
      indexDir: () => undefined,
      trustBoundary: boundary,
      collect,
      execute,
      enabled: true,
      onStatus: (event) => events.push(event.phase),
    });

    const ticking = healer.tick();
    // Flush microtasks until the tick is parked on the authorization gate.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // The tick really reached the authorization stage — the test cannot pass
    // vacuously if the loop never got there.
    expect(boundary.evaluate).toHaveBeenCalledOnce();

    // Disposal begins while authorization is still pending...
    await healer.dispose();
    // ...then the authorization resolves as allowed.
    resolveAuth({ kind: 'allow', reason: 'allowed' });
    await ticking;

    expect(execute).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(healer.getSnapshot().services['kanban']?.lastAttemptAt).toBeNull();
  });

  it('onStatus throwing never breaks the heal loop', async () => {
    const collect = vi.fn(async () => report([service('kanban', 'error')]));
    const execute = vi.fn(async () => okResult('kanban'));
    const healer = createAutoHealer({
      projectRoot: () => '/project',
      indexDir: () => undefined,
      trustBoundary: makeBoundary(),
      collect,
      execute,
      enabled: true,
      logger: makeLogger(),
      onStatus: () => {
        throw new Error('broadcast failed');
      },
    });

    await expect(healer.tick()).resolves.toBeDefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
