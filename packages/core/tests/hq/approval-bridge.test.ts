import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetConfirmObserversForTest } from '../../src/core/confirm-observers.js';
import {
  type ApprovalRegistry,
  createApprovalRegistry,
  startApprovalTelemetryBridge,
} from '../../src/hq/approval-bridge.js';
import type {
  HqApprovalRequestedPayload,
  HqApprovalResolvedPayload,
  HqRedactionPolicy,
} from '../../src/hq/protocol.js';
import type { HqPublisher } from '../../src/hq/publisher.js';
import { EventBus } from '../../src/kernel/events.js';

function fakePublisher(
  spy: ReturnType<typeof vi.fn>,
  redactionPolicy?: Partial<HqRedactionPolicy>,
): HqPublisher {
  return {
    redactionPolicy,
    publishEvent: (o: { type: string; payload: unknown }) => {
      spy(o);
      return {} as never;
    },
  } as unknown as HqPublisher;
}

interface EmitOverrides {
  toolUseId?: string;
  sessionId?: string;
  input?: unknown;
  riskTier?: 'safe' | 'standard' | 'destructive';
  decisionSource?: string;
  deadlineAt?: number;
}

function emitConfirmNeeded(
  events: EventBus,
  resolve: (d: 'yes' | 'no' | 'always' | 'deny') => void,
  overrides: EmitOverrides = {},
): void {
  events.emit('tool.confirm_needed', {
    sessionId: overrides.sessionId ?? 'sess-1',
    tool: { name: 'bash' },
    input: overrides.input ?? { command: 'rm -rf build', token: 'sk-secret-value' },
    toolUseId: overrides.toolUseId ?? 'toolu_1',
    suggestedPattern: 'bash:rm',
    decisionSource: overrides.decisionSource ?? 'default',
    riskTier: overrides.riskTier ?? 'destructive',
    writeTargets: ['/proj/build'],
    deadlineAt: overrides.deadlineAt ?? Date.now() + 120_000,
    resolve,
  } as never);
}

describe('createApprovalRegistry', () => {
  const registries: ApprovalRegistry[] = [];
  afterEach(() => {
    for (const registry of registries.splice(0)) registry.dispose();
    resetConfirmObserversForTest();
  });

  function make(events: EventBus): ApprovalRegistry {
    const registry = createApprovalRegistry(events);
    registries.push(registry);
    return registry;
  }

  it('holds a prompt and answers it with the resolver the event carried', () => {
    const events = new EventBus();
    const registry = make(events);
    const resolve = vi.fn();
    emitConfirmNeeded(events, resolve);

    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.toolName).toBe('bash');
    expect(registry.list()[0]?.destructive).toBe(true);

    expect(registry.resolve('toolu_1', 'always')).toBe(true);
    expect(resolve).toHaveBeenCalledWith('always');
    expect(registry.list()).toHaveLength(0);
  });

  it('reports false when the prompt was already answered elsewhere', () => {
    const events = new EventBus();
    const registry = make(events);
    emitConfirmNeeded(events, vi.fn());

    // What a local surface answering produces: the run emits confirm_resolved.
    events.emit('tool.confirm_resolved', {
      sessionId: 'sess-1',
      toolUseId: 'toolu_1',
      toolName: 'bash',
      decision: 'yes',
      source: 'user',
    } as never);

    // Losing the race must be REPORTABLE, not silently swallowed — the
    // operator has to learn their answer did not apply.
    expect(registry.resolve('toolu_1', 'no')).toBe(false);
  });

  it('refuses an answer aimed at a different session', () => {
    const events = new EventBus();
    const registry = make(events);
    const resolve = vi.fn();
    emitConfirmNeeded(events, resolve, { sessionId: 'tab-3' });

    expect(registry.resolve('toolu_1', 'yes', 'tab-1')).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(registry.resolve('toolu_1', 'yes', 'tab-3')).toBe(true);
  });

  it('registers a prompt that raised no event, and retires it on demand', () => {
    // The plain REPL asks through the permission policy, not the executor, so
    // its prompt never produces `tool.confirm_needed`.
    const events = new EventBus();
    const registry = make(events);
    const resolve = vi.fn();
    const finish = registry.register({
      toolUseId: 'repl:1',
      toolName: 'bash',
      sessionId: 'sess-1',
      deadlineAt: Date.now() + 60_000,
      input: { command: 'rm -rf dist' },
      suggestedPattern: 'bash:rm',
      destructive: true,
      resolve,
    });

    expect(registry.list().map((a) => a.toolUseId)).toEqual(['repl:1']);
    expect(registry.resolve('repl:1', 'yes')).toBe(true);
    expect(resolve).toHaveBeenCalledWith('yes');

    // The disposer runs unconditionally in a finally block, so it must be a
    // no-op once HQ has answered — otherwise it would report the prompt
    // refused immediately after it was allowed.
    finish('no');
    expect(registry.list()).toHaveLength(0);
  });

  it('renews a registered deadline so a terminal prompt can outlive one window', () => {
    const events = new EventBus();
    const registry = make(events);
    const deadlineAt = Date.now() + 50;
    registry.register({
      toolUseId: 'repl:1',
      toolName: 'bash',
      deadlineAt,
      input: {},
      suggestedPattern: 'bash:rm',
      destructive: false,
      resolve: vi.fn(),
    });

    expect(registry.renew('repl:1', Date.now() + 60_000)).toBe(true);
    expect(registry.list()[0]?.deadlineAt).toBeGreaterThan(deadlineAt);
    // Nothing to renew once it is gone — the caller's heartbeat learns to stop.
    registry.resolve('repl:1', 'no');
    expect(registry.renew('repl:1', Date.now() + 60_000)).toBe(false);
  });

  it('drops a prompt whose deadline has passed instead of offering it', () => {
    const events = new EventBus();
    const registry = make(events);
    emitConfirmNeeded(events, vi.fn(), { deadlineAt: Date.now() - 1 });

    // Past the deadline the Brain arbiter already owns the decision.
    expect(registry.list()).toHaveLength(0);
    expect(registry.resolve('toolu_1', 'yes')).toBe(false);
  });
});

describe('startApprovalTelemetryBridge', () => {
  const registries: ApprovalRegistry[] = [];
  afterEach(() => {
    for (const registry of registries.splice(0)) registry.dispose();
    resetConfirmObserversForTest();
  });

  function make(events: EventBus): ApprovalRegistry {
    const registry = createApprovalRegistry(events);
    registries.push(registry);
    return registry;
  }

  it('publishes a requested envelope carrying the deadline and risk', () => {
    const events = new EventBus();
    const registry = make(events);
    const spy = vi.fn();
    const stop = startApprovalTelemetryBridge({
      registry,
      publisher: fakePublisher(spy),
      projectRoot: '/proj',
      sessionId: 'sess-1',
    });

    const deadlineAt = Date.now() + 90_000;
    emitConfirmNeeded(events, vi.fn(), { deadlineAt });

    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]![0];
    expect(call.type).toBe('approval.requested');
    const payload: HqApprovalRequestedPayload = call.payload;
    expect(payload.toolUseId).toBe('toolu_1');
    expect(payload.deadlineAt).toBe(deadlineAt);
    expect(payload.destructive).toBe(true);
    expect(payload.writeTargets).toEqual(['/proj/build']);
    stop();
  });

  it('redacts the argument summary under the publisher policy', () => {
    const events = new EventBus();
    const registry = make(events);
    const spy = vi.fn();
    const stop = startApprovalTelemetryBridge({
      registry,
      publisher: fakePublisher(spy, { toolArgs: 'none' }),
      projectRoot: '/proj',
      sessionId: 'sess-1',
    });

    emitConfirmNeeded(events, vi.fn());

    // The approval payload is the one event whose whole purpose is to show
    // arguments, which makes it the one most likely to leak them.
    const payload: HqApprovalRequestedPayload = spy.mock.calls[0]![0].payload;
    expect(JSON.stringify(payload)).not.toContain('sk-secret-value');
    stop();
  });

  it('replays outstanding prompts on start so a reconnect is not blind', () => {
    const events = new EventBus();
    const registry = make(events);
    // Prompt raised while HQ was disconnected.
    emitConfirmNeeded(events, vi.fn());

    const spy = vi.fn();
    const stop = startApprovalTelemetryBridge({
      registry,
      publisher: fakePublisher(spy),
      sessionId: 'sess-1',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].type).toBe('approval.requested');
    stop();
  });

  it('publishes a resolved envelope whatever settled the prompt', () => {
    const events = new EventBus();
    const registry = make(events);
    const spy = vi.fn();
    const stop = startApprovalTelemetryBridge({
      registry,
      publisher: fakePublisher(spy),
      sessionId: 'sess-1',
    });

    emitConfirmNeeded(events, vi.fn());
    events.emit('tool.confirm_resolved', {
      sessionId: 'sess-1',
      toolUseId: 'toolu_1',
      toolName: 'bash',
      decision: 'no',
      source: 'user',
    } as never);

    const resolved = spy.mock.calls.find((c) => c[0].type === 'approval.resolved');
    expect(resolved).toBeDefined();
    const payload: HqApprovalResolvedPayload = resolved![0].payload;
    expect(payload.decision).toBe('no');
    expect(payload.source).toBe('user');
    stop();
  });

  it('stops publishing after the bridge is disposed but keeps the registry live', () => {
    const events = new EventBus();
    const registry = make(events);
    const spy = vi.fn();
    const stop = startApprovalTelemetryBridge({
      registry,
      publisher: fakePublisher(spy),
      sessionId: 'sess-1',
    });
    stop();

    const resolve = vi.fn();
    emitConfirmNeeded(events, resolve);

    expect(spy).not.toHaveBeenCalled();
    // The resolver must survive an HQ disconnect — the prompt is still on
    // screen at the machine, and dropping it would strand the run.
    expect(registry.resolve('toolu_1', 'yes')).toBe(true);
    expect(resolve).toHaveBeenCalledWith('yes');
  });
});
