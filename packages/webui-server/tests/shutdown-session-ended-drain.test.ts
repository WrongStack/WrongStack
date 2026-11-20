import { describe, expect, it, vi } from 'vitest';

/**
 * F15: the standalone engine's shutdown never emitted `session.ended` on the
 * boot bus, so the dep-watcher's in-flight tech-stack audits never registered
 * their teardown wait and were reaped at exit with their reports lost. The
 * kernel contract (contracts/kernel/events/session-events.ts) says cleanup
 * joins every waitUntil producer; the CLI honors it in execution-cleanup.ts,
 * and now the engine does too — emitted after closeChimera (its boot-bus
 * listener is detached) and BEFORE stopHostServices unsubscribes the
 * dep-watcher, with a bounded outer deadline on the exit path.
 *
 * These tests run the REAL runtime consumer (runtime/dep-watcher consumers.ts)
 * against a REAL EventBus and the REAL setupWebuiShutdown. Only environment
 * plumbing is mocked: the coordination mailbox/poll loop (the same seam the
 * cli tech-stack-audit tests use), the fleet host (structural interface), the
 * shutdown registration (captures onPreShutdown — no signal/exit needed), and
 * the instance registry / salvage hooks.
 */

const seam = vi.hoisted(() => ({
  registered: null as null | { onPreShutdown: () => Promise<void> },
  consumerOpts: null as null | { onSpawn: (task: string, name: string) => Promise<unknown> },
}));

vi.mock('../src/server/server-runtime.js', () => ({
  registerShutdown: (options: { onPreShutdown: () => Promise<void> }) => {
    seam.registered = options;
    return () => {};
  },
}));
vi.mock('../src/server/instance-registry.js', () => ({
  unregisterInstance: async () => {},
}));
vi.mock('@wrongstack/core/utils', () => ({
  toErrorMessage: String,
  addFatalSalvageHook: () => () => {},
}));
vi.mock('@wrongstack/coordination', () => ({
  getSharedProjectMailbox: () => ({ send: async () => {} }),
  startTechStackConsumer: (opts: { onSpawn: (task: string, name: string) => Promise<unknown> }) => {
    seam.consumerOpts = opts;
    return () => {};
  },
  startPackageOutdatedWatcher: () => () => {},
}));

import { EventBus } from '@wrongstack/contracts/kernel';
import { setupDepWatcherConsumers } from '../../runtime/src/dep-watcher/consumers.js';
import { setupWebuiShutdown } from '../src/server/start-webui-shutdown.js';

const logger = { info: () => {}, warn: () => {}, debug: () => {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fixture(events: EventBus | undefined, extra: Record<string, unknown> = {}) {
  const noop = () => {};
  const done = async () => {};
  return {
    getSession: () => ({ id: 'boot', append: done, close: done, flushSync: noop }),
    tokenCounter: { total: () => ({ input: 3, output: 7 }) },
    clients: new Map(),
    httpServer: { close: noop },
    companionServer: null,
    wssPrimary: { close: noop },
    stopEmptySessionCleanup: { dispose: done },
    getKanbanSupervisorDispose: () => null,
    todosCheckpoint: { detach: done },
    stopHeapWatchdog: done,
    getCredentialWatcherClose: () => undefined,
    getProxyInstantApplyDispose: () => noop,
    disposeRealtimeHandlers: noop,
    logger,
    brainMonitor: { stop: noop },
    agentServices: {
      closeChimera: done,
      closeAcpLeader: done,
      closePlugins: done,
      runSageSessionHygiene: done,
    },
    mcpRegistry: { stopAll: done },
    sessionIdentity: { stop: done },
    eventArming: { getDispose: () => undefined },
    getEternalSubscription: () => null,
    clearEternalSubscription: noop,
    codebaseIndexing: { dispose: noop },
    memoryStore: { dispose: done },
    vectorMemoryStore: undefined,
    globalConfigPath: 'D:/fake/config.json',
    ...(events ? { events } : {}),
    ...extra,
  };
}

function wireConsumer(events: EventBus, awaitTasks: () => Promise<unknown>) {
  const teardownHandlers: Array<() => void> = [];
  setupDepWatcherConsumers({
    dwCfg: { enabled: true },
    globalRoot: 'D:/fake/global',
    projectSlug: 'probe',
    events,
    multiAgentHost: {
      spawn: async () => ({ subagentId: 's1', taskId: 't1' }),
      getDirector: () => ({ awaitTasks }),
    },
    sessionId: 'boot',
    logger,
    teardownHandlers,
    projectRoot: 'D:/fake/repo',
  } as never);
  return teardownHandlers;
}

describe('engine shutdown joins in-flight dep-watcher audits (F15)', () => {
  it('control: the consumer registers its audit when session.ended is emitted', async () => {
    const events = new EventBus();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    wireConsumer(events, () => gate);
    await seam.consumerOpts!.onSpawn('audit the manifest', 'tech-stack-package.json');
    const registered: Promise<void>[] = [];
    events.emit('session.ended', {
      id: 'boot',
      sessionId: 'boot',
      usage: { input: 0, output: 0 },
      waitUntil: (w: Promise<void>) => registered.push(w),
    } as never);
    expect(registered.length).toBe(1);
    release();
    await Promise.allSettled(registered);
  });

  it('drains the in-flight audit before stopping host services', async () => {
    const events = new EventBus();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const teardownHandlers = wireConsumer(events, () => gate);
    await seam.consumerOpts!.onSpawn('audit the manifest', 'tech-stack-package.json');

    const emitted: Array<{
      id?: string | undefined;
      sessionId?: string | undefined;
      usage?: unknown;
      waitUntil?: unknown;
    }> = [];
    events.on('session.ended', (e) => {
      emitted.push(e);
    });
    const order: string[] = [];

    let auditSettled = false;
    void gate.then(() => {
      auditSettled = true;
    });
    let stoppedWhileAuditPending = false;
    setupWebuiShutdown(
      fixture(events, {
        agentServices: {
          closeChimera: async () => {
            order.push('closeChimera');
          },
          closeAcpLeader: async () => {},
          closePlugins: async () => {},
          runSageSessionHygiene: async () => {},
        },
        stopHostServices: () => {
          order.push('stopHostServices');
          stoppedWhileAuditPending = !auditSettled;
          for (const h of teardownHandlers.splice(0)) h();
        },
      }) as never,
    );
    events.on('session.ended', () => order.push('session.ended'));

    let preDone = false;
    const pre = seam.registered!.onPreShutdown().then(() => {
      preDone = true;
    });
    await sleep(60);
    expect(preDone, 'shutdown waits for the in-flight audit').toBe(false);
    release();
    await pre;
    expect(preDone).toBe(true);
    expect(stoppedWhileAuditPending, 'host services stop only after the audit settled').toBe(false);
    expect(emitted.length).toBe(1);
    expect(emitted[0]!.id).toBe('boot');
    expect(emitted[0]!.sessionId).toBe('boot');
    expect(emitted[0]!.usage).toEqual({ input: 3, output: 7 });
    expect(typeof emitted[0]!.waitUntil).toBe('function');
    expect(order.indexOf('closeChimera')).toBeLessThan(order.indexOf('session.ended'));
    expect(order.indexOf('session.ended')).toBeLessThan(order.indexOf('stopHostServices'));
  });

  it('a rejected audit still lets shutdown complete (allSettled, not all)', async () => {
    const events = new EventBus();
    const teardownHandlers = wireConsumer(events, () => Promise.reject(new Error('audit died')));
    await seam.consumerOpts!.onSpawn('audit the manifest', 'tech-stack-package.json');
    let hostStopped = false;
    setupWebuiShutdown(
      fixture(events, {
        stopHostServices: () => {
          hostStopped = true;
          for (const h of teardownHandlers.splice(0)) h();
        },
      }) as never,
    );
    await seam.registered!.onPreShutdown();
    expect(hostStopped).toBe(true);
  });

  it('a hanging audit keeps the drain pending (bounded wait registered, not skipped)', async () => {
    const events = new EventBus();
    const teardownHandlers = wireConsumer(events, () => new Promise<void>(() => {}));
    await seam.consumerOpts!.onSpawn('audit the manifest', 'tech-stack-package.json');
    let hostStopped = false;
    setupWebuiShutdown(
      fixture(events, {
        stopHostServices: () => {
          hostStopped = true;
          for (const h of teardownHandlers.splice(0)) h();
        },
      }) as never,
    );
    let preDone = false;
    void seam.registered!.onPreShutdown().then(() => {
      preDone = true;
    });
    await sleep(60);
    expect(preDone, 'hanging audit is joined (outer 50s deadline bounds it)').toBe(false);
    expect(hostStopped).toBe(false);
  });

  it('idle shutdown completes promptly', async () => {
    const events = new EventBus();
    const teardownHandlers = wireConsumer(events, () => Promise.resolve([]));
    let hostStopped = false;
    setupWebuiShutdown(
      fixture(events, {
        stopHostServices: () => {
          hostStopped = true;
          for (const h of teardownHandlers.splice(0)) h();
        },
      }) as never,
    );
    await seam.registered!.onPreShutdown();
    expect(hostStopped).toBe(true);
  });

  it('legacy callers without the events option still shut down (backward compat)', async () => {
    let hostStopped = false;
    setupWebuiShutdown(
      fixture(undefined, {
        stopHostServices: () => {
          hostStopped = true;
        },
      }) as never,
    );
    await seam.registered!.onPreShutdown();
    expect(hostStopped).toBe(true);
  });
});
