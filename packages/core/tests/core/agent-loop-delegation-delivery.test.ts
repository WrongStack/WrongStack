/**
 * Leader delivery of background `delegate` results through the agent loop.
 *
 * The loop drains `leaderDeliveryHub` at each iteration boundary — only for
 * the leader of the owning session — folds one `[DELEGATION RESULT]` block per
 * item, records completed-work evidence, and journals `delegation_delivered`.
 * The final test is the no-wake end-to-end: a leader delegates, keeps
 * iterating, and the result lands exactly once.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Container } from '@wrongstack/contracts/kernel/container';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import type {
  SubagentRunContext,
  SubagentRunOutcome,
  TaskSpec,
} from '@wrongstack/contracts/types/multi-agent';
import type { Request } from '@wrongstack/contracts/types/provider';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAgentCoordination } from '../../src/agent-coordination-default.js';
import { createDelegateTool } from '../../src/coordination/delegate-tool.js';
import { DelegationTracker } from '../../src/coordination/delegation/delegation-tracker.js';
import {
  AUTO_WAKE_MARKER,
  LeaderAutoWakeController,
} from '../../src/coordination/delegation/leader-auto-wake.js';
import {
  DELEGATION_RESULT_MARKER,
  delegationDeliveryId,
  type LeaderDelivery,
  leaderDeliveryHub,
} from '../../src/coordination/delegation/leader-delivery-hub.js';
import { Director } from '../../src/coordination/director.js';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { AGENT_COORDINATION } from '../../src/core/agent-coordination.js';
import { Context } from '../../src/core/context.js';
import { DefaultErrorHandler } from '../../src/execution/error-handler.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import { MockProvider } from '../helpers/mock-provider.js';

import { removeProjectFixtureDirectory } from '../helpers/project-server-harness.js';

const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  leaderDeliveryHub.reset();
  for (const d of dirs.splice(0)) {
    await removeProjectFixtureDirectory(d, { maxRetries: 10, retryDelay: 50 });
  }
});

async function buildAgent(
  provider: MockProvider,
  tools: Tool[],
  identity: { agentId: string; owningSessionId?: string },
) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-delivery-'));
  dirs.push(tmp);
  const container = new Container();
  // Host wiring (createDefaultContainer) binds the production coordination.
  container.bind(AGENT_COORDINATION, () => defaultAgentCoordination);
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error', stderr: false }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
  container.bind(
    TOKENS.PermissionPolicy,
    () => new DefaultPermissionPolicy({ trustFile: path.join(tmp, 'trust.json'), yolo: true }),
  );
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  const events = new EventBus();
  const sessionStore = new DefaultSessionStore({ dir: path.join(tmp, 'sessions') });
  const session = await sessionStore.create({ id: '', model: 'm', provider: 'mock' });
  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'test leader' }],
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter: container.resolve(TOKENS.TokenCounter),
    cwd: tmp,
    projectRoot: tmp,
    model: 'm',
    agentId: identity.agentId,
  });
  if (identity.owningSessionId) ctx.meta['sessionId'] = identity.owningSessionId;
  const toolExecutor = new ToolExecutor(registry, {
    permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
    secretScrubber: container.resolve(TOKENS.SecretScrubber),
    events,
    confirmAwaiter: undefined,
    iterationTimeoutMs: 300_000,
    perIterationOutputCapBytes: 100_000,
    tracer: undefined,
  });
  const agent = new Agent({
    container,
    tools: registry,
    providers: new ProviderRegistry(),
    events,
    pipelines: createDefaultPipelines(),
    context: ctx,
    maxIterations: 10,
    toolExecutor,
  });
  return { agent, ctx, events, session, sessionStore };
}

function tool(name: string, execute: () => Promise<unknown>): Tool {
  return {
    name,
    description: '',
    inputSchema: { type: 'object' },
    permission: 'auto',
    mutating: false,
    execute,
  };
}

function delivery(sessionId: string, id: string): LeaderDelivery {
  return {
    deliveryId: delegationDeliveryId(id),
    sessionId,
    kind: 'delegation_result',
    createdAt: Date.now(),
    wake: true,
    payload: {
      delegationId: id,
      taskId: `task-${id}`,
      target: 'bug-hunter',
      task: 'audit',
      ok: true,
      status: 'success',
      stopReason: 'end_turn',
      handoffs: 0,
      summary: `[bug-hunter] done ${id}`,
      excerpt: `REPORT ${id}`,
    },
  };
}

function requestText(req: Request | undefined): string {
  if (!req) return '';
  return req.messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content
            .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
            .join('\n'),
    )
    .join('\n');
}

function countMarker(text: string): number {
  return text.split(DELEGATION_RESULT_MARKER).length - 1;
}

async function journalEvents(store: DefaultSessionStore, id: string) {
  const data = await store.load(id);
  return data.events ?? [];
}

describe('agent loop — leader delivery of background delegation results', () => {
  it('folds a result that settles while a tool call is in flight into the next request', async () => {
    let sessionId = '';
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'work', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'handled' }], stopReason: 'end_turn' },
    ]);
    const work = tool('work', async () => {
      leaderDeliveryHub.enqueue(delivery(sessionId, 'd1'));
      return 'ok';
    });
    const { agent, ctx, session, sessionStore } = await buildAgent(provider, [work], {
      agentId: 'leader',
    });
    sessionId = session.id;

    const result = await agent.run('go');
    expect(result.status).toBe('done');
    expect(countMarker(requestText(provider.receivedRequests[0]))).toBe(0);
    expect(countMarker(requestText(provider.receivedRequests[1]))).toBe(1);
    expect(requestText(provider.receivedRequests[1])).toContain('REPORT d1');
    expect(leaderDeliveryHub.pending(sessionId)).toBe(0);
    expect(ctx.contextEvidence?.completedWork.map((w) => w.key)).toContain('delegation:d1');
    const events = await journalEvents(sessionStore, sessionId);
    expect(events.filter((e) => e.type === 'delegation_delivered')).toEqual([
      expect.objectContaining({ delegationId: 'd1', via: 'loop' }),
    ]);
  });

  it('a worker of the same session never drains the leader results', async () => {
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'worker done' }], stopReason: 'end_turn' },
    ]);
    const { agent, session } = await buildAgent(provider, [], {
      agentId: 'bug-hunter-1234',
      owningSessionId: 'tab-leader-session',
    });
    leaderDeliveryHub.enqueue(delivery('tab-leader-session', 'd2'));
    leaderDeliveryHub.enqueue(delivery(session.id, 'd3'));
    await agent.run('work');
    expect(countMarker(requestText(provider.receivedRequests[0]))).toBe(0);
    expect(leaderDeliveryHub.pending('tab-leader-session')).toBe(1);
    expect(leaderDeliveryHub.pending(session.id)).toBe(1);
  });

  it('an undelivered result survives compaction (it lives outside ctx.messages) and the ledger keeps it after', async () => {
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'first' }], stopReason: 'end_turn' },
      { content: [{ type: 'text', text: 'second' }], stopReason: 'end_turn' },
    ]);
    const { agent, ctx, session } = await buildAgent(provider, [], { agentId: 'leader' });
    await agent.run('turn one');
    leaderDeliveryHub.enqueue(delivery(session.id, 'd4'));
    // Simulate a compaction that rewrote the whole conversation.
    ctx.state.replaceMessages([]);
    await agent.run('turn two');
    expect(countMarker(requestText(provider.receivedRequests[1]))).toBe(1);
    // The delivered block is itself compactable; the ledger entry is not.
    ctx.state.replaceMessages([]);
    expect(ctx.contextEvidence?.completedWork.map((w) => w.key)).toContain('delegation:d4');
  });

  it('delegateSummaries only collects subagent.done for this run session', async () => {
    let sessionId = '';
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'noise', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const holder: { events?: EventBus } = {};
    const noise = tool('noise', async () => {
      holder.events!.emit('subagent.done', {
        sessionId: 'another-tab',
        summary: 'theirs',
        ok: true,
      });
      holder.events!.emit('subagent.done', { sessionId, summary: 'mine', ok: true });
      return 'ok';
    });
    const built = await buildAgent(provider, [noise], { agentId: 'leader' });
    holder.events = built.events;
    sessionId = built.session.id;
    const result = await built.agent.run('go');
    expect(result.delegateSummaries).toEqual([{ summary: 'mine', ok: true }]);
  });

  it('end-to-end (no wake): leader delegates, keeps iterating, and gets exactly one [DELEGATION RESULT]', async () => {
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((r) => {
      releaseWorker = r;
    });
    const runner = vi.fn(
      async (task: TaskSpec, _ctx: SubagentRunContext): Promise<SubagentRunOutcome> => {
        await workerGate;
        return { result: `worker finished: ${task.id}`, iterations: 1, toolCalls: 1 };
      },
    );
    const notifier = vi.fn();
    let sessionId = '';
    const director = new Director({
      sessionId: () => sessionId,
      config: {
        coordinatorId: 'e2e-bg',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 2,
      },
      runner,
      taskResultNotifier: notifier,
    });
    cleanups.push(() => director.shutdown());
    const hostEvents = new EventBus();
    const tracker = new DelegationTracker({ events: hostEvents });
    cleanups.push(() => tracker.dispose());
    const delegate = createDelegateTool({
      host: {
        isDirectorMode: () => true,
        ensureDirector: async () => director,
        promoteToDirector: async () => director,
      },
      events: hostEvents,
      tracker,
    });
    const started: Array<Record<string, unknown>> = [];
    const completed: Array<Record<string, unknown>> = [];
    hostEvents.on('delegate.started', (e) => started.push(e as never));
    hostEvents.on('delegate.completed', (e) => completed.push(e as never));

    const release = tool('release_worker', async () => {
      releaseWorker();
      await expect.poll(() => leaderDeliveryHub.pending(sessionId)).toBe(1);
      return 'released';
    });
    const provider = new MockProvider([
      {
        content: [
          {
            type: 'tool_use',
            id: 'd1',
            name: 'delegate',
            input: {
              name: 'helper',
              task: 'inspect the parser',
              scope: 'packages/parser only',
              outOfScope: ['Do not edit files'],
            },
          },
        ],
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'tool_use', id: 'r1', name: 'release_worker', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'integrated the result' }], stopReason: 'end_turn' },
    ]);
    const { agent, session, sessionStore } = await buildAgent(
      provider,
      [{ ...delegate, permission: 'auto' }, release],
      { agentId: 'leader' },
    );
    sessionId = session.id;

    const result = await agent.run('please delegate');
    expect(result.status).toBe('done');
    expect(provider.calls).toBe(3);
    // Iteration 2 ran while the worker was still blocked: the call did not wait.
    expect(runner).toHaveBeenCalledTimes(1);
    const second = requestText(provider.receivedRequests[1]);
    // The launch result rides a tool_result block, not a text block.
    expect(JSON.stringify(provider.receivedRequests[1]?.messages)).toMatch(/running/);
    expect(countMarker(second)).toBe(0);
    const third = requestText(provider.receivedRequests[2]);
    expect(countMarker(third)).toBe(1);
    expect(third).toContain('worker finished');
    expect(notifier).not.toHaveBeenCalled();

    expect(started).toEqual([expect.objectContaining({ mode: 'background', sessionId })]);
    const delegationId = started[0]!['delegationId'];
    expect(completed).toEqual([
      expect.objectContaining({ delegationId, mode: 'background', ok: true }),
    ]);
    const events = await journalEvents(sessionStore, sessionId);
    expect(events.filter((e) => e.type === 'delegation_delivered')).toEqual([
      expect.objectContaining({ delegationId }),
    ]);
    expect(tracker.get(delegationId as string)?.state).toBe('delivered');
  });

  it('end-to-end (auto-wake): leader ends its turn, worker finishes → exactly one woken turn with exactly one [DELEGATION RESULT]', async () => {
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((r) => {
      releaseWorker = r;
    });
    const runner = vi.fn(
      async (task: TaskSpec, _ctx: SubagentRunContext): Promise<SubagentRunOutcome> => {
        await workerGate;
        return { result: `worker finished: ${task.id}`, iterations: 1, toolCalls: 1 };
      },
    );
    const notifier = vi.fn();
    let sessionId = '';
    const director = new Director({
      sessionId: () => sessionId,
      config: {
        coordinatorId: 'e2e-wake',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 2,
      },
      runner,
      taskResultNotifier: notifier,
    });
    cleanups.push(() => director.shutdown());
    const hostEvents = new EventBus();
    const tracker = new DelegationTracker({ events: hostEvents });
    cleanups.push(() => tracker.dispose());
    const delegate = createDelegateTool({
      host: {
        isDirectorMode: () => true,
        ensureDirector: async () => director,
        promoteToDirector: async () => director,
      },
      events: hostEvents,
      tracker,
    });
    const provider = new MockProvider([
      {
        content: [
          {
            type: 'tool_use',
            id: 'd1',
            name: 'delegate',
            input: {
              name: 'helper',
              task: 'inspect the parser',
              scope: 'packages/parser only',
              outOfScope: ['Do not edit files'],
            },
          },
        ],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'delegated; ending my turn' }], stopReason: 'end_turn' },
      { content: [{ type: 'text', text: 'integrated the result' }], stopReason: 'end_turn' },
    ]);
    const { agent, session, sessionStore } = await buildAgent(
      provider,
      [{ ...delegate, permission: 'auto' }],
      { agentId: 'leader' },
    );
    sessionId = session.id;

    const controller = new LeaderAutoWakeController({
      events: hostEvents,
      config: () => ({ autoWakeDebounceMs: 5 }),
    });
    cleanups.push(() => controller.dispose());
    let running = false;
    const wakeRuns: Array<Promise<unknown>> = [];
    const prompts: string[] = [];
    controller.attachPort({
      isIdle: () => !running,
      hasPendingUserInput: () => false,
      isConfirmPending: () => false,
      isOpen: (id) => id === sessionId,
      isDisplayed: (id) => id === sessionId,
      startWakeTurn: async (_id, prompt) => {
        prompts.push(prompt);
        running = true;
        const run = agent.run(prompt).finally(() => {
          running = false;
          controller.onRunFinished(sessionId);
        });
        wakeRuns.push(run);
        await run;
      },
    });
    const wakeStarted: unknown[] = [];
    hostEvents.on('leader.auto_wake_started', (e) => wakeStarted.push(e));

    running = true;
    const first = await agent.run('please delegate');
    running = false;
    controller.onRunFinished(sessionId);
    expect(first.status).toBe('done');
    expect(provider.calls).toBe(2);
    expect(leaderDeliveryHub.pending(sessionId)).toBe(0);

    releaseWorker();
    await expect.poll(() => wakeRuns.length, { timeout: 5_000 }).toBe(1);
    const woken = await wakeRuns[0];
    expect((woken as { status: string }).status).toBe('done');
    // Give any stray second wake a chance to fire.
    await new Promise((r) => setTimeout(r, 50));

    expect(wakeRuns).toHaveLength(1);
    expect(provider.calls).toBe(3);
    const third = requestText(provider.receivedRequests[2]);
    expect(countMarker(third)).toBe(1);
    expect(third).toContain('worker finished');
    expect(third).toContain(AUTO_WAKE_MARKER);
    const tracked = tracker.list(sessionId);
    expect(tracked).toHaveLength(1);
    expect(prompts).toEqual([expect.stringContaining(tracked[0]!.delegationId)]);
    expect(wakeStarted).toHaveLength(1);
    // No mailbox result mail: the delegate owns the task.
    expect(notifier).not.toHaveBeenCalled();
    expect(leaderDeliveryHub.pending(sessionId)).toBe(0);
    const events = await journalEvents(sessionStore, sessionId);
    expect(events.filter((e) => e.type === 'delegation_delivered')).toHaveLength(1);
  });
});
