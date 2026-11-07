import { EventBus } from '@wrongstack/contracts/kernel/events';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { resetConfirmObserversForTest } from '../../core/src/core/confirm-observers.js';
import {
  type ApprovalRegistry,
  createApprovalRegistry,
  startApprovalTelemetryBridge,
} from '../src/approval-bridge.js';
import {
  type HqApprovalRequestedPayload,
  type HqApprovalResolvedPayload,
  type HqRedactionPolicy,
  parseHqEventPayload,
} from '../src/protocol.js';
import type { HqPublisher } from '../src/publisher.js';

/**
 * `ReturnType<typeof vi.fn>` widens to `Mock<Constructable | Procedure>`,
 * which the type system refuses to CALL (it might be a constructor). Naming
 * the signature keeps the spy callable here and still accepts a bare
 * `vi.fn()` at every call site.
 */
type PublishSpy = Mock<(o: { type: string; payload: unknown }) => void>;

function fakePublisher(spy: PublishSpy, redactionPolicy?: Partial<HqRedactionPolicy>): HqPublisher {
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

  it('refuses to renew an expired prompt and still announces registered resolutions after a reused toolUseId', () => {
    const events = new EventBus();
    const registry = make(events);
    const resolved: string[] = [];
    registry.onChange((change) => {
      if (change.kind === 'resolved') resolved.push(`${change.toolUseId}:${change.decision}`);
    });

    events.emit('tool.confirm_resolved', {
      sessionId: 'sess-1',
      toolUseId: 'repl:1',
      toolName: 'bash',
      decision: 'no',
      source: 'user',
    } as never);
    resolved.length = 0;

    registry.register({
      toolUseId: 'repl:1',
      toolName: 'bash',
      sessionId: 'sess-1',
      deadlineAt: Date.now() + 60_000,
      input: {},
      suggestedPattern: 'bash:rm',
      destructive: true,
      resolve: vi.fn(),
    });
    expect(registry.resolve('repl:1', 'yes')).toBe(true);
    expect(resolved).toEqual(['repl:1:yes']);

    registry.register({
      toolUseId: 'repl:expired',
      toolName: 'bash',
      sessionId: 'sess-1',
      deadlineAt: Date.now() - 1,
      input: {},
      suggestedPattern: 'bash:rm',
      destructive: true,
      resolve: vi.fn(),
    });
    expect(registry.renew('repl:expired', Date.now() + 60_000)).toBe(false);
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

  it('publishes only the sessions it speaks for, replay and resolution included', () => {
    // Two registries on one bus (the WebUI host): the root conversation's
    // prompts were announced by both publishers.
    const events = new EventBus();
    const registry = make(events);
    emitConfirmNeeded(events, vi.fn(), { toolUseId: 'toolu_root_early', sessionId: 'root' });
    const spy = vi.fn();
    const stop = startApprovalTelemetryBridge({
      registry,
      publisher: fakePublisher(spy),
      sessionId: 'tab-1',
      acceptSession: (sessionId) => sessionId !== 'root',
    });
    emitConfirmNeeded(events, vi.fn(), { toolUseId: 'toolu_root', sessionId: 'root' });
    emitConfirmNeeded(events, vi.fn(), { toolUseId: 'toolu_tab', sessionId: 'tab-1' });
    registry.resolve('toolu_root', 'yes');

    const published = spy.mock.calls.map(
      (call) => `${call[0].type}:${(call[0].payload as { toolUseId: string }).toolUseId}`,
    );
    expect(published).toEqual(['approval.requested:toolu_tab']);
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

  it('publishes approval.resolved when a prompt registered via registry.register is resolved from HQ (F150)', () => {
    const events = new EventBus();
    const registry = make(events);
    const spy = vi.fn();
    const stop = startApprovalTelemetryBridge({
      registry,
      publisher: fakePublisher(spy),
      sessionId: 'sess-1',
    });

    const finish = registry.register({
      toolUseId: 'repl:1',
      toolName: 'bash',
      sessionId: 'sess-1',
      deadlineAt: Date.now() + 60_000,
      input: { command: 'rm -rf dist' },
      suggestedPattern: 'bash:rm',
      destructive: true,
      resolve: vi.fn(),
    });

    expect(registry.resolve('repl:1', 'yes')).toBe(true);
    finish('no');

    const resolved = spy.mock.calls.filter((c) => c[0].type === 'approval.resolved');
    expect(resolved).toHaveLength(1);
    const payload = resolved[0]![0].payload as HqApprovalResolvedPayload;
    expect(payload.toolUseId).toBe('repl:1');
    expect(payload.decision).toBe('yes');
    stop();
  });

  it('forwards grantedUntil onto approval.resolved when an always approval is answered from HQ (F624)', () => {
    const events = new EventBus();
    const registry = make(events);
    const spy = vi.fn();
    const stop = startApprovalTelemetryBridge({
      registry,
      publisher: fakePublisher(spy),
      sessionId: 'sess-1',
    });

    const before = Date.now();
    registry.register({
      toolUseId: 'repl:always',
      toolName: 'bash',
      sessionId: 'sess-1',
      deadlineAt: before + 60_000,
      input: { command: 'git status' },
      suggestedPattern: 'bash:git status',
      destructive: false,
      resolve: vi.fn(),
    });

    expect(registry.resolve('repl:always', 'always', 'sess-1', 120_000)).toBe(true);

    const resolved = spy.mock.calls.filter((c) => c[0].type === 'approval.resolved');
    expect(resolved).toHaveLength(1);
    const payload = resolved[0]![0].payload as HqApprovalResolvedPayload;
    expect(payload.toolUseId).toBe('repl:always');
    expect(payload.decision).toBe('always');
    expect(typeof payload.grantedUntil).toBe('number');
    expect(payload.grantedUntil).toBeGreaterThanOrEqual(before + 120_000);
    expect(parseHqEventPayload('approval.resolved', payload)).toEqual({
      ok: true,
      payload,
    });
    stop();
  });

  it('ignores stale register() disposers after toolUseId reuse and preserves sessionId / user_input.resolved notifications (F62)', () => {
    const events = new EventBus();
    const registry = make(events);
    const spy = vi.fn();
    const stop = startApprovalTelemetryBridge({
      registry,
      publisher: fakePublisher(spy),
      sessionId: 'sess-1',
      acceptSession: (sid) => sid === 'sess-1',
    });

    const finishFirst = registry.register({
      toolUseId: 'repl:reuse',
      toolName: 'bash',
      sessionId: 'sess-1',
      deadlineAt: Date.now() + 60_000,
      input: { step: 1 },
      suggestedPattern: 'bash:first',
      destructive: false,
      resolve: vi.fn(),
    });
    expect(registry.resolve('repl:reuse', 'yes', 'sess-1')).toBe(true);

    const resolveSecond = vi.fn();
    const finishSecond = registry.register({
      toolUseId: 'repl:reuse',
      toolName: 'bash',
      sessionId: 'sess-1',
      deadlineAt: Date.now() + 60_000,
      input: { step: 2 },
      suggestedPattern: 'bash:second',
      destructive: true,
      resolve: resolveSecond,
    });

    // Stale finally-block disposer from the first prompt must not delete or refuse the second prompt.
    finishFirst('no');
    expect(registry.list()).toHaveLength(1);
    expect(registry.resolve('repl:reuse', 'always', 'sess-1')).toBe(true);
    expect(resolveSecond).toHaveBeenCalledWith('always');
    finishSecond('no');

    // Direct user-input resolver (which does not emit user.input_resolved on the bus) still publishes user_input.resolved.
    events.emit('user.input_requested', {
      sessionId: 'sess-1',
      request: {
        id: 'req-direct-1',
        title: 'Continue?',
        tabs: [
          {
            id: 'main',
            label: 'Question',
            questions: [{ id: 'q1', prompt: 'Continue?', kind: 'text' }],
          },
        ],
      },
      resolve: vi.fn(),
    } as never);
    expect(
      registry.resolveUserInput?.(
        'req-direct-1',
        {
          requestId: 'req-direct-1',
          status: 'submitted',
          answers: [
            { questionId: 'q1', selectedOptionIds: [], text: 'yes', usedRecommendation: false },
          ],
        },
        'sess-1',
      ),
    ).toBe(true);
    const inputResolved = spy.mock.calls.filter((c) => c[0].type === 'user_input.resolved');
    expect(inputResolved).toHaveLength(1);

    // Confirm resolver emitting tool.confirm_resolved without sessionId still inherits held.sessionId ('sess-1').
    events.emit('tool.confirm_needed', {
      sessionId: 'sess-1',
      tool: { name: 'bash' },
      input: {},
      toolUseId: 'toolu_no_sid',
      suggestedPattern: 'bash:ls',
      deadlineAt: Date.now() + 60_000,
      resolve: (decision: 'yes' | 'no' | 'always' | 'deny') => {
        events.emit('tool.confirm_resolved', {
          toolUseId: 'toolu_no_sid',
          toolName: 'bash',
          decision,
          source: 'user',
        } as never);
      },
    } as never);
    expect(registry.resolve('toolu_no_sid', 'yes', 'sess-1')).toBe(true);
    const heldResolved = spy.mock.calls.filter(
      (c) =>
        c[0].type === 'approval.resolved' &&
        (c[0].payload as { toolUseId?: string }).toolUseId === 'toolu_no_sid',
    );
    expect(heldResolved).toHaveLength(1);
    stop();
  });
});
