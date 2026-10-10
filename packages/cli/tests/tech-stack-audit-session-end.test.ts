import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression: an in-flight TechStack audit must be REGISTERED as a session-end
 * producer so teardown actually waits for it.
 *
 * Why this is the real fix (and the flag alone was not):
 *   - `finalizeExecutionCleanup` only blocks on work that registered through the
 *     `session.ended` `waitUntil` hook — joined to a fixed point at
 *     execution-cleanup.ts:216-218 — or through `chimeraWork.drainAndClose()`.
 *   - `coordinator.requestFinish()` is notify-only and grants no grace window
 *     (multi-agent-coordinator.ts:508-511), so `gracefulFinish` alone buys the
 *     audit nothing when teardown is already sweeping.
 *   - Live evidence before this change: `routed_to_pkg-outdated-watcher=0`,
 *     `aborted_records=3`, `VERDICT=STILL_ABORTED`.
 *
 * These tests use a real EventBus, so they exercise the actual listener
 * registration and payload shape rather than a hand-rolled stub.
 */

const mocks = vi.hoisted(() => ({
  getSharedProjectMailbox: vi.fn(),
  startTechStackConsumer: vi.fn(),
  startPackageOutdatedWatcher: vi.fn(),
}));

vi.mock('@wrongstack/core/coordination', () => ({
  getSharedProjectMailbox: mocks.getSharedProjectMailbox,
  startTechStackConsumer: mocks.startTechStackConsumer,
  startPackageOutdatedWatcher: mocks.startPackageOutdatedWatcher,
}));

import { EventBus } from '@wrongstack/core/kernel';
import { setupDepWatcherConsumers } from '../src/wiring/dep-watcher.js';

interface HarnessOptions {
  /** Resolves the director's awaitTasks for a spawned task id. */
  awaitTasks?: (taskIds: string[]) => Promise<unknown>;
  /** Omit getDirector entirely (audit is untracked). */
  withDirector?: boolean;
}

function harness(opts: HarnessOptions = {}) {
  const { awaitTasks, withDirector = true } = opts;
  const mailbox = { send: vi.fn().mockResolvedValue(undefined) };
  mocks.getSharedProjectMailbox.mockReturnValue(mailbox);

  const events = new EventBus();
  const spawned: Array<{ subagentId: string; taskId: string }> = [];
  let spawnCounter = 0;

  const director = {
    awaitTasks: vi.fn(async (taskIds: string[]) =>
      awaitTasks ? awaitTasks(taskIds) : Promise.resolve([]),
    ),
  };

  const multiAgentHost: Record<string, unknown> = {
    spawn: vi.fn(async () => {
      spawnCounter += 1;
      const rec = { subagentId: `sub-${spawnCounter}`, taskId: `task-${spawnCounter}` };
      spawned.push(rec);
      return rec;
    }),
  };
  if (withDirector) multiAgentHost['getDirector'] = vi.fn(() => director);

  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

  setupDepWatcherConsumers({
    dwCfg: { enabled: true },
    globalRoot: 'C:/global',
    projectSlug: 'project',
    events,
    multiAgentHost,
    sessionId: 'session-1',
    logger,
    teardownHandlers: [],
    projectRoot: 'C:/repo',
  } as never);

  const consumerOptions = mocks.startTechStackConsumer.mock.calls[0]?.[0] as
    | { onSpawn: (task: string, name: string) => Promise<unknown> }
    | undefined;
  if (!consumerOptions) throw new Error('startTechStackConsumer was not called');

  return {
    consumerOptions,
    director,
    events,
    spawned,
    multiAgentHost,
    logger,
    teardownHandlers: [] as Array<() => void>,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('in-flight audits are registered as session-end producers', () => {
  it('awaits a spawned audit when session.ended fires', async () => {
    let releaseAudit: (() => void) | undefined;
    const auditFinished = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });

    const { consumerOptions, director, events } = harness({
      awaitTasks: () => auditFinished,
    });

    await consumerOptions.onSpawn('audit the manifest', 'tech-stack-package.json');
    expect(director.awaitTasks).toHaveBeenCalledWith(['task-1']);

    // Teardown emits session.ended and captures what we register.
    const registered: Promise<void>[] = [];
    events.emit('session.ended', {
      id: 's1',
      sessionId: 's1',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      waitUntil: (work: Promise<void>) => {
        registered.push(work);
      },
    } as never);

    // The audit is still running, so the drain must NOT be satisfied yet.
    expect(registered).toHaveLength(1);
    let drained = false;
    void Promise.allSettled([registered[0]!]).then(() => {
      drained = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(drained).toBe(false);

    // Once the audit delivers, the wait resolves and teardown may proceed.
    releaseAudit!();
    await Promise.allSettled([registered[0]!]);
    expect(drained).toBe(true);
  });

  it('does not register an already-finished audit', async () => {
    const { consumerOptions, events } = harness({
      awaitTasks: () => Promise.resolve([]),
    });

    await consumerOptions.onSpawn('audit the manifest', 'tech-stack-package.json');
    // Let the completion promise settle so the set drains itself.
    await new Promise((r) => setTimeout(r, 10));

    const registered: Promise<void>[] = [];
    events.emit('session.ended', {
      id: 's1',
      sessionId: 's1',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      waitUntil: (work: Promise<void>) => {
        registered.push(work);
      },
    } as never);

    expect(registered).toHaveLength(0);
  });

  it('registers nothing when there is no director to await through', async () => {
    const { consumerOptions, events } = harness({ withDirector: false });

    await consumerOptions.onSpawn('audit the manifest', 'tech-stack-package.json');

    const registered: Promise<void>[] = [];
    events.emit('session.ended', {
      id: 's1',
      sessionId: 's1',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      waitUntil: (work: Promise<void>) => {
        registered.push(work);
      },
    } as never);

    expect(registered).toHaveLength(0);
  });

  // ── The ordering gate ──────────────────────────────────────────────────
  // The confirmed live defect: `session.ended` fires at 18:09:37, the consumer's
  // poll loop posts an assign at 18:09:39, and the audit spawned at 18:10:20
  // into a session that was already tearing down — reaped mid-research with no
  // report. Neither gracefulFinish nor the waitUntil drain can help an audit
  // that did not exist when session.ended fired, so the spawn itself must be
  // refused.

  it('refuses to spawn an audit once session.ended has fired', async () => {
    const { consumerOptions, multiAgentHost, events, logger } = harness();

    // Session ends. Nothing is in flight yet — this is the exact ordering.
    events.emit('session.ended', {
      id: 's1',
      sessionId: 's1',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      waitUntil: (work: Promise<void>) => {
        void work;
      },
    } as never);

    expect(multiAgentHost.spawn).not.toHaveBeenCalled();

    // The consumer's poll loop finds an assign moments later.
    const result = await consumerOptions.onSpawn('audit the manifest', 'tech-stack-package.json');

    // THE ASSERTION: no subagent was burned on a dying session.
    expect(multiAgentHost.spawn).not.toHaveBeenCalled();
    // Refusal is a sentinel, never a fabricated id.
    expect(result).toEqual({ subagentId: '', taskId: '' });
    // And it is NOT a silent drop — a lost audit must be visible.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('refusing to spawn audit'));
  });

  it('still spawns normally while the session is alive', async () => {
    const { consumerOptions, multiAgentHost } = harness();

    await consumerOptions.onSpawn('audit the manifest', 'tech-stack-package.json');
    await consumerOptions.onSpawn('audit again', 'tech-stack-go.mod');

    // The gate must not leak into the healthy path.
    expect(multiAgentHost.spawn).toHaveBeenCalledTimes(2);
    expect(multiAgentHost.spawn).toHaveBeenCalledWith(
      'audit the manifest',
      expect.objectContaining({ gracefulFinish: true }),
    );
  });

  it('never blocks teardown forever — the wait is bounded', async () => {
    // A hung audit (stalled registry fetch / wedged provider) must not hold the
    // CLI open. The bound is 45s of real time; this asserts the wiring exists
    // and that registration happens, without waiting that long.
    const never = new Promise<void>(() => {});
    const { consumerOptions, events } = harness({ awaitTasks: () => never });

    await consumerOptions.onSpawn('audit the manifest', 'tech-stack-package.json');

    const registered: Promise<void>[] = [];
    events.emit('session.ended', {
      id: 's1',
      sessionId: 's1',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      waitUntil: (work: Promise<void>) => {
        registered.push(work);
      },
    } as never);

    // Registered (so teardown waits), but the promise is a bounded race rather
    // than the raw `never` promise — verified by it not being identity-equal and
    // by still being pending.
    expect(registered).toHaveLength(1);
    expect(registered[0]).not.toBe(never as unknown as Promise<void>);
    let settled = false;
    void registered[0]!.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
  });
});
