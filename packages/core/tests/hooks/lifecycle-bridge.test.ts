import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { HookEvent, HookInput } from '@wrongstack/contracts/types/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventUserInputAwaiter } from '../../src/core/user-input-awaiter.js';
import { createStrategyCompactor } from '../../src/execution/strategy-compactor.js';
import { bridgeLifecycleHooks } from '../../src/hooks/lifecycle-bridge.js';
import { HookRegistry } from '../../src/hooks/registry.js';
import { HookRunner } from '../../src/hooks/runner.js';

let seq = 0;

/** A conversation big enough that hybrid compaction has work to do. */
function conversation() {
  seq += 1;
  const messages = Array.from({ length: 60 }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `conv-${seq} turn ${i} ${'x'.repeat(400)}`,
  }));
  return {
    cwd: '/work/project',
    meta: {},
    model: 'test-model',
    messages,
    state: {
      revision: 1,
      messages,
      replaceMessages: vi.fn(),
      setMeta: vi.fn(),
      getMeta: vi.fn(),
    },
    session: {
      id: 'sess-1',
      append: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
    },
  } as never;
}

function setup(opts: { allowNonPolicy?: boolean } = {}) {
  const registry = new HookRegistry();
  const runner = new HookRunner({ registry, allowNonPolicy: opts.allowNonPolicy ?? true });
  const events = new EventBus();
  const compactor = createStrategyCompactor({ strategy: 'hybrid' });
  const warn = vi.fn();
  const dispose = bridgeLifecycleHooks({
    hookRunner: runner,
    events,
    cwd: '/work/project',
    compactor,
    logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
  });
  const seen: HookInput[] = [];
  const record = (event: HookEvent, matcher?: string) =>
    registry.registerInProcess(event, matcher, (input) => {
      seen.push(input);
    });
  return { registry, runner, events, compactor, dispose, seen, record, warn };
}

const flush = () => new Promise((r) => setImmediate(r));

let active: Array<() => void> = [];
afterEach(() => {
  for (const d of active) d();
  active = [];
});

describe('bridgeLifecycleHooks — compaction', () => {
  it('fires PreCompact before and PostCompact after every pass, with the report', async () => {
    const h = setup();
    active.push(h.dispose);
    const order: string[] = [];
    h.registry.registerInProcess('PreCompact', undefined, (input) => {
      order.push('pre');
      h.seen.push(input);
    });
    h.registry.registerInProcess('PostCompact', undefined, (input) => {
      order.push('post');
      h.seen.push(input);
    });

    const report = await h.compactor.compact(conversation());

    expect(order).toEqual(['pre', 'post']);
    const [pre, post] = h.seen;
    expect(pre).toMatchObject({
      event: 'PreCompact',
      cwd: '/work/project',
      sessionId: 'sess-1',
      compaction: { trigger: 'auto', aggressive: false },
    });
    expect(post?.compaction).toEqual({
      trigger: 'auto',
      aggressive: false,
      tokensBefore: report.before,
      tokensAfter: report.after,
    });
  });

  it('matches the registration against the compaction trigger', async () => {
    const h = setup();
    active.push(h.dispose);
    h.record('PreCompact', 'manual|overflow');

    await h.compactor.compact(conversation());
    expect(h.seen).toHaveLength(0);

    await h.compactor.compact(conversation(), { trigger: 'manual', aggressive: true });
    expect(h.seen.map((s) => s.compaction)).toEqual([{ trigger: 'manual', aggressive: true }]);
  });

  it('never lets a failing hook fail or skip the compaction', async () => {
    const h = setup();
    active.push(h.dispose);
    h.registry.registerInProcess(
      'PreCompact',
      undefined,
      () => {
        throw new Error('backup script crashed');
      },
      undefined,
      { failurePolicy: 'closed' },
    );
    const ctx = conversation();

    await expect(h.compactor.compact(ctx)).resolves.toMatchObject({ before: expect.any(Number) });
  });

  it('stops observing the compactor once disposed', async () => {
    const h = setup();
    h.record('PostCompact');
    h.dispose();

    await h.compactor.compact(conversation());

    expect(h.seen).toHaveLength(0);
  });
});

describe('bridgeLifecycleHooks — bus events', () => {
  it('maps delegate lifecycle to SubagentStart / SubagentStop, matched on the target', async () => {
    const h = setup();
    active.push(h.dispose);
    h.record('SubagentStart', 'reviewer');
    h.record('SubagentStop');

    h.events.emit('delegate.started', {
      sessionId: 'sess-1',
      target: 'coder',
      task: 'write it',
      mode: 'background',
    });
    h.events.emit('delegate.started', {
      sessionId: 'sess-1',
      target: 'reviewer',
      task: 'review it',
      subagentId: 'reviewer@1',
      delegationId: 'd-1',
      mode: 'wait',
    });
    h.events.emit('delegate.completed', {
      sessionId: 'sess-1',
      target: 'reviewer',
      task: 'review it',
      ok: true,
      status: 'success',
      summary: 'LGTM',
      durationMs: 1200,
      iterations: 3,
      toolCalls: 4,
      subagentId: 'reviewer@1',
      delegationId: 'd-1',
      mode: 'wait',
    });
    await flush();

    expect(h.seen).toEqual([
      {
        event: 'SubagentStart',
        cwd: '/work/project',
        sessionId: 'sess-1',
        subagent: {
          target: 'reviewer',
          task: 'review it',
          subagentId: 'reviewer@1',
          delegationId: 'd-1',
          mode: 'wait',
        },
      },
      {
        event: 'SubagentStop',
        cwd: '/work/project',
        sessionId: 'sess-1',
        subagent: {
          target: 'reviewer',
          task: 'review it',
          subagentId: 'reviewer@1',
          delegationId: 'd-1',
          mode: 'wait',
          ok: true,
          status: 'success',
          summary: 'LGTM',
          durationMs: 1200,
        },
      },
    ]);
  });

  it('raises Notification for permission prompts and structured questions', async () => {
    const h = setup();
    active.push(h.dispose);
    h.record('Notification');

    h.events.emit('tool.confirm_needed', {
      sessionId: 'sess-1',
      tool: { name: 'bash' } as never,
      input: { command: 'rm -rf build' },
      toolUseId: 'tu-1',
      suggestedPattern: 'bash:rm*',
      deadlineAt: Date.now() + 1000,
      resolve: () => undefined,
    });
    h.events.emit('user.input_requested', {
      sessionId: 'sess-1',
      request: { id: 'q-1', title: 'Pick a database', tabs: [] },
      resolve: () => undefined,
    });
    await flush();

    expect(h.seen.map((s) => s.notification)).toEqual([
      { kind: 'permission', message: 'Permission needed to run bash', toolName: 'bash' },
      { kind: 'input', message: 'Pick a database' },
    ]);
    // The permission prompt itself carries no command text into the hook.
    expect(JSON.stringify(h.seen)).not.toContain('rm -rf');
  });

  it('matches Notification registrations on the kind', async () => {
    const h = setup();
    active.push(h.dispose);
    h.record('Notification', 'input');

    h.events.emit('tool.confirm_needed', {
      tool: { name: 'bash' } as never,
      input: {},
      toolUseId: 'tu-1',
      suggestedPattern: 'bash',
      deadlineAt: Date.now() + 1000,
      resolve: () => undefined,
    });
    await flush();

    expect(h.seen).toHaveLength(0);
  });

  it('joins SessionEnd to the session-close barrier via waitUntil', async () => {
    const h = setup();
    active.push(h.dispose);
    let finished = false;
    h.registry.registerInProcess('SessionEnd', undefined, async (input) => {
      await new Promise((r) => setTimeout(r, 20));
      finished = true;
      h.seen.push(input);
    });
    const joined: Promise<void>[] = [];

    h.events.emit('session.ended', {
      id: 'sess-1',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as never,
      waitUntil: (work) => joined.push(work),
    });
    expect(finished).toBe(false);
    await Promise.all(joined);

    expect(finished).toBe(true);
    expect(h.seen[0]).toEqual({ event: 'SessionEnd', cwd: '/work/project', sessionId: 'sess-1' });
  });

  it('skips ordinary observational hooks under --no-hooks but keeps policy hooks', async () => {
    const h = setup({ allowNonPolicy: false });
    active.push(h.dispose);
    h.record('SubagentStop');
    h.registry.registerInProcess(
      'SubagentStop',
      undefined,
      (input) => {
        h.seen.push({ ...input, prompt: 'policy' });
      },
      undefined,
      { policy: true },
    );

    h.events.emit('delegate.completed', {
      target: 'coder',
      task: 't',
      ok: false,
      summary: 's',
      durationMs: 1,
      iterations: 1,
      toolCalls: 0,
    });
    await flush();

    expect(h.seen.map((s) => s.prompt)).toEqual(['policy']);
  });

  it('removes every bus subscription on dispose', async () => {
    const h = setup();
    h.record('SubagentStart');
    h.record('Notification');
    h.dispose();

    h.events.emit('delegate.started', { target: 'coder', task: 't' });
    h.events.emit('user.input_requested', {
      request: { id: 'q', title: 't', tabs: [] },
      resolve: () => undefined,
    });
    await flush();

    expect(h.seen).toHaveLength(0);
  });

  it('does not pose as a surface that can answer a structured question', async () => {
    const h = setup();
    active.push(h.dispose);
    const ask = createEventUserInputAwaiter(h.events);
    const request = { id: 'q', title: 't', tabs: [] };

    // Only the bridge is listening: nobody can answer, so the ask returns at once.
    await expect(ask(request, { signal: new AbortController().signal })).resolves.toBeUndefined();

    // A real surface makes the same ask wait for its answer.
    h.events.on('user.input_requested', (e) =>
      e.resolve({ requestId: e.request.id, status: 'submitted', answers: [] }),
    );
    await expect(ask(request, { signal: new AbortController().signal })).resolves.toMatchObject({
      status: 'submitted',
    });
  });
});
