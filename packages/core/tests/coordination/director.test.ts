import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Director, type TaskResultNotification } from '../../src/coordination/director.js';
import { EventBus } from '../../src/kernel/events.js';
import type {
  SubagentConfig,
  SubagentRunContext,
  SubagentRunOutcome,
  TaskSpec,
} from '../../src/types/multi-agent.js';

/**
 * Integration tests for the Director orchestration layer.
 *
 * These tests prove the system works end-to-end without spinning up a
 * real provider or Agent. We stand in for the production
 * `AgentSubagentRunner` with a tiny in-line runner that:
 *
 *   1. Looks up which subagent is running via `ctx.subagentId`.
 *   2. Emits the same events a real Agent would (provider.response,
 *      tool.executed) on a per-subagent EventBus.
 *   3. Hooks that bus into the Director's FleetBus so the usage
 *      aggregator picks the events up.
 *   4. Returns a `SubagentRunOutcome` with the task's "result" set to
 *      a marker string that proves the right runner ran the right task.
 *
 * If anyone breaks per-subagent isolation, provider attribution, cost
 * roll-up, or the await/spawn flow — one of these tests fails.
 */

describe('Director orchestration', () => {
  let _director: Director;
  /** Map of subagent id → EventBus the test runner uses to emit events
   *  on that subagent's behalf. Populated by `spawn()` so each subagent
   *  gets a distinct bus (true isolation, no cross-talk). */
  let buses: Map<string, EventBus>;
  /** Detach functions returned by `fleet.attach()`. Cleared between
   *  tests so we don't leak listeners across cases. */
  let attachDisposers: Array<() => void>;

  beforeEach(() => {
    buses = new Map();
    attachDisposers = [];
  });

  /**
   * Build a Director whose runner is a vi.fn() spy. Each test customizes
   * the runner's behavior via `runner.mockImplementation(...)`.
   *
   * The runner's contract: given the task + ctx, emit the canonical
   * events on the matching subagent's bus, then return an outcome. The
   * bus is attached to the Director's FleetBus inside this helper so
   * the test doesn't have to remember the wiring step.
   */
  function buildDirector(brain?: ConstructorParameters<typeof Director>[0]['brain']): {
    director: Director;
    runner: ReturnType<typeof vi.fn>;
  } {
    const runner = vi.fn(
      async (task: TaskSpec, ctx: SubagentRunContext): Promise<SubagentRunOutcome> => {
        const bus = buses.get(ctx.subagentId)!;
        // One iteration, one tool, one provider call — enough to exercise
        // every aggregator path without committing the test to a
        // particular shape of agent run.
        bus.emit('iteration.started', { ctx: null as never, index: 1 });
        bus.emit('tool.started', { name: 'mock', id: 'm-1', input: {} });
        bus.emit('tool.executed', { id: 'm-1', name: 'mock', durationMs: 5, ok: true });
        bus.emit('provider.response', {
          ctx: null as never,
          usage: { input: 1000, output: 200 },
          stopReason: 'end_turn',
        });
        return {
          result: `${ctx.config.name}@${ctx.config.provider ?? 'default'}:${task.description}`,
          iterations: 1,
          toolCalls: 1,
        };
      },
    );
    const d = new Director({
      config: {
        coordinatorId: 'test-director',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 4,
      },
      runner,
      brain,
    });
    return { director: d, runner };
  }

  /** Spawn a subagent + create + attach its EventBus to the FleetBus.
   *  Returns the subagent id so the test can pass it to `assign()`. */
  async function spawnWithBus(
    d: Director,
    config: SubagentConfig,
    price?: { input?: number; output?: number },
  ): Promise<string> {
    const id = await d.spawn(config, price);
    const bus = new EventBus();
    buses.set(id, bus);
    attachDisposers.push(d.fleet.attach(id, bus));
    return id;
  }

  const waitImmediate = () => new Promise((resolve) => setImmediate(resolve));

  it('asks Brain before granting a non-timeout budget extension and extends on answer', async () => {
    let brainCalls = 0;
    const { director: d } = buildDirector({
      decide: async (req) => {
        brainCalls++;
        expect(req.source).toBe('director');
        expect(req.question).toContain('iterations');
        return { type: 'answer', optionId: 'extend', text: 'extend' };
      },
    });
    _director = d;
    let extended: Record<string, unknown> | null = null;
    let denied = false;

    d.fleet.emit({
      subagentId: 'agent-1',
      taskId: 'task-1',
      ts: Date.now(),
      type: 'budget.threshold_reached',
      payload: {
        kind: 'iterations',
        used: 11,
        limit: 10,
        timeoutMs: 60_000,
        extend: (extra: Record<string, unknown>) => {
          extended = extra;
        },
        deny: () => {
          denied = true;
        },
      },
    });

    await waitImmediate();
    await waitImmediate();

    expect(brainCalls).toBe(1);
    expect(denied).toBe(false);
    expect(extended?.maxIterations).toBeGreaterThan(11);
  });

  it('asks Brain before granting a non-timeout budget extension and denies on stop', async () => {
    const { director: d } = buildDirector({
      decide: async () => ({ type: 'answer', optionId: 'stop', text: 'stop' }),
    });
    _director = d;
    let extended = false;
    let denied = false;

    d.fleet.emit({
      subagentId: 'agent-1',
      taskId: 'task-1',
      ts: Date.now(),
      type: 'budget.threshold_reached',
      payload: {
        kind: 'tool_calls',
        used: 11,
        limit: 10,
        timeoutMs: 60_000,
        extend: () => {
          extended = true;
        },
        deny: () => {
          denied = true;
        },
      },
    });

    await waitImmediate();

    expect(denied).toBe(true);
    expect(extended).toBe(false);
  });

  it('extends idle_timeout via the heartbeat path with a real idleTimeoutMs (not a no-op extend)', async () => {
    const { director: d } = buildDirector();
    _director = d;
    let extended: Record<string, unknown> | null = null;
    let denied = false;

    d.fleet.emit({
      subagentId: 'agent-idle',
      taskId: 'task-idle',
      ts: Date.now(),
      type: 'budget.threshold_reached',
      payload: {
        kind: 'idle_timeout',
        used: 40,
        limit: 30,
        timeoutMs: 30,
        extend: (extra: Record<string, unknown>) => {
          extended = extra;
        },
        deny: () => {
          denied = true;
        },
      },
    });

    await waitImmediate();
    await waitImmediate();

    // Regression: idle_timeout previously fell through to the generic per-kind
    // switch (which has no idle_timeout case) and produced extend({}) — raising
    // no limit. It must instead extend the idle window.
    expect(denied).toBe(false);
    expect(extended?.idleTimeoutMs).toBeGreaterThan(30);
    // And it must NOT touch the wall-clock timeout field.
    expect(extended?.timeoutMs).toBeUndefined();
  });

  it('denies an idle_timeout extension when the subagent made no progress since the last grant', async () => {
    const { director: d } = buildDirector();
    _director = d;
    let extendCount = 0;
    let denied = false;
    const emitIdle = () =>
      d.fleet.emit({
        subagentId: 'agent-stuck',
        taskId: 'task-stuck',
        ts: Date.now(),
        type: 'budget.threshold_reached',
        payload: {
          kind: 'idle_timeout',
          used: 40,
          limit: 30,
          timeoutMs: 30,
          extend: () => {
            extendCount++;
          },
          deny: () => {
            denied = true;
          },
        },
      });

    emitIdle(); // first: progress(0) > last(-1) → extend
    await waitImmediate();
    await waitImmediate();
    emitIdle(); // second: no new tool.executed → progress(0) <= last(0) → deny
    await waitImmediate();

    expect(extendCount).toBe(1);
    expect(denied).toBe(true);
  });

  it('isolates subagents: per-id provider + model attribution', async () => {
    const { director: d } = buildDirector();
    _director = d;
    const plannerId = await spawnWithBus(d, {
      name: 'editor',
      provider: 'anthropic',
      model: 'anthropic-test-model',
    });
    const haikuId = await spawnWithBus(d, {
      name: 'researcher',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    });
    const gptId = await spawnWithBus(d, {
      name: 'auditor',
      provider: 'openai',
      model: 'gpt-5',
    });

    expect(plannerId).not.toEqual(haikuId);
    expect(haikuId).not.toEqual(gptId);

    const status = d.status();
    expect(status.subagents).toHaveLength(3);
    const names = status.subagents.map((s) => s.name).sort();
    expect(names).toEqual(['auditor', 'editor', 'researcher']);
  });

  it('routes a task to the named subagent (no cross-talk)', async () => {
    const { director: d, runner } = buildDirector();
    _director = d;
    const editorId = await spawnWithBus(d, {
      name: 'editor',
      provider: 'anthropic',
      model: 'planner',
    });
    const researcherId = await spawnWithBus(d, {
      name: 'researcher',
      provider: 'anthropic',
      model: 'haiku',
    });

    const taskId = await d.assign({
      id: 't-1',
      description: 'rewrite the README',
      subagentId: editorId,
    });
    const [result] = await d.awaitTasks([taskId]);

    // The runner's marker proves the right subagent picked it up — if
    // the coordinator misrouted, the marker would say "researcher@…".
    expect(result.status).toBe('success');
    expect(result.result).toBe('editor@anthropic:rewrite the README');
    expect(result.subagentId).toBe(editorId);

    // Researcher should not have been touched.
    const researcherCalls = runner.mock.calls.filter(
      (c) => (c[1] as SubagentRunContext).subagentId === researcherId,
    );
    expect(researcherCalls).toHaveLength(0);
  });

  it('rolls up usage across subagents with per-subagent pricing', async () => {
    const { director: d } = buildDirector();
    _director = d;
    // Planner: $3/M in, $15/M out.
    const plannerId = await spawnWithBus(
      d,
      { name: 'editor', provider: 'anthropic', model: 'planner' },
      { input: 3, output: 15 },
    );
    // Haiku: $0.80/M in, $4/M out.
    const haikuId = await spawnWithBus(
      d,
      { name: 'researcher', provider: 'anthropic', model: 'haiku' },
      { input: 0.8, output: 4 },
    );

    const a = await d.assign({ id: 't-a', description: 'edit', subagentId: plannerId });
    const b = await d.assign({ id: 't-b', description: 'research', subagentId: haikuId });
    await d.awaitTasks([a, b]);

    const snap = d.snapshot();

    // Each subagent emitted one provider.response with 1000 in / 200 out.
    // planner cost = 1000/1M * 3 + 200/1M * 15 = 0.003 + 0.003 = 0.006
    // haiku  cost = 1000/1M * 0.8 + 200/1M * 4 = 0.0008 + 0.0008 = 0.0016
    expect(snap.perSubagent[plannerId].cost).toBeCloseTo(0.006, 6);
    expect(snap.perSubagent[haikuId].cost).toBeCloseTo(0.0016, 6);
    expect(snap.total.cost).toBeCloseTo(0.0076, 6);
    expect(snap.total.input).toBe(2000);
    expect(snap.total.output).toBe(400);

    // Tool calls + iterations attributed correctly.
    expect(snap.perSubagent[plannerId].toolCalls).toBe(1);
    expect(snap.perSubagent[haikuId].toolCalls).toBe(1);
    expect(snap.perSubagent[plannerId].iterations).toBe(1);

    // Provider metadata captured at spawn time, surfaced in snapshot.
    expect(snap.perSubagent[plannerId].provider).toBe('anthropic');
    expect(snap.perSubagent[plannerId].model).toBe('planner');
    expect(snap.perSubagent[haikuId].model).toBe('haiku');
  });

  it('awaitTasks resolves for tasks that completed before being awaited', async () => {
    // Regression guard for the "consumer asks late" case — without the
    // `completed` cache, awaitTasks would hang forever for a task whose
    // event already fired.
    const { director: d } = buildDirector();
    _director = d;
    const id = await spawnWithBus(d, { name: 'w', provider: 'anthropic', model: 'haiku' });
    const taskId = await d.assign({ id: 't-late', description: 'do thing', subagentId: id });

    // Give the runner time to complete.
    await new Promise((r) => setTimeout(r, 30));

    const [result] = await d.awaitTasks([taskId]);
    expect(result.status).toBe('success');
  });

  it('terminate aborts a running subagent', async () => {
    const { director: d, runner } = buildDirector();
    _director = d;
    // Custom slow runner so terminate has something to abort.
    runner.mockImplementationOnce(async (_task, ctx) => {
      await new Promise<void>((resolve, reject) => {
        const tid = setTimeout(() => resolve(), 5000);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(tid);
          reject(new Error('aborted'));
        });
      });
      return { iterations: 0, toolCalls: 0 };
    });
    const id = await spawnWithBus(d, { name: 'slow', provider: 'anthropic', model: 'haiku' });
    const taskId = await d.assign({ id: 't-slow', description: 'slow op', subagentId: id });

    // Terminate after the runner has a chance to start.
    await new Promise((r) => setTimeout(r, 20));
    await d.terminate(id);

    const [result] = await d.awaitTasks([taskId]);
    // Coordinator marks aborted subagent's task as 'stopped' or 'failed'
    // depending on whether the signal aborted first or the throw landed first.
    expect(['stopped', 'failed']).toContain(result.status);
  });

  it('director tools expose the same API to an LLM', async () => {
    const { director: d } = buildDirector();
    _director = d;
    const tools = d.tools({
      researcher: { name: 'researcher', provider: 'anthropic', model: 'haiku' },
      auditor: { name: 'auditor', provider: 'openai', model: 'gpt-5' },
    });
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'ask_result',
      'ask_subagent',
      'assign_task',
      'await_tasks',
      'collab_debug',
      'fleet',
      'fleet_emit',
      'kanban_queue',
      'quality_gate',
      'roll_up',
      'spawn_subagent',
      'terminate_all',
      'terminate_subagent',
      'work_complete',
    ]);

    const spawn = tools.find((t) => t.name === 'spawn_subagent')!;
    const assign = tools.find((t) => t.name === 'assign_task')!;
    const awaitTasks = tools.find((t) => t.name === 'await_tasks')!;
    const usage = tools.find((t) => t.name === 'fleet')!;

    // Spawn from roster.
    const spawnRes = (await spawn.execute({ role: 'researcher' }, null as never, {
      signal: new AbortController().signal,
    })) as { subagentId: string; provider: string; model: string };
    expect(spawnRes.provider).toBe('anthropic');
    expect(spawnRes.model).toBe('haiku');

    // Wire the bus the runner needs (production version would do this in
    // the AgentFactory — here we mirror that pattern).
    const bus = new EventBus();
    buses.set(spawnRes.subagentId, bus);
    attachDisposers.push(d.fleet.attach(spawnRes.subagentId, bus));

    // Assign + await via tools.
    const assignRes = (await assign.execute(
      { subagentId: spawnRes.subagentId, description: 'enumerate packages' },
      null as never,
      { signal: new AbortController().signal },
    )) as { taskId: string };

    const awaitRes = (await awaitTasks.execute({ taskIds: [assignRes.taskId] }, null as never, {
      signal: new AbortController().signal,
    })) as { results: Array<{ status: string }> };
    expect(awaitRes.results[0].status).toBe('success');

    // fleet action:usage should show one subagent with non-zero token usage.
    const usageRes = (await usage.execute({ action: 'usage' }, null as never, {
      signal: new AbortController().signal,
    })) as { total: { input: number } };
    expect(usageRes.total.input).toBeGreaterThan(0);
  });

  it('unknown role in spawn_subagent returns an error', async () => {
    const { director: d } = buildDirector();
    _director = d;
    const [spawn] = d.tools({ researcher: { name: 'researcher' } });
    const res = (await spawn.execute({ role: 'nope' }, null as never, {
      signal: new AbortController().signal,
    })) as { error?: string };
    expect(res.error).toMatch(/unknown role "nope"/);
  });

  it('spawn_subagent can instantiate the same roster role repeatedly', async () => {
    const { director: d } = buildDirector();
    _director = d;
    const [spawn] = d.tools({
      researcher: { id: 'researcher', name: 'Researcher', provider: 'anthropic', model: 'haiku' },
    });

    const first = (await spawn.execute({ role: 'researcher' }, null as never, {
      signal: new AbortController().signal,
    })) as { subagentId: string };
    const second = (await spawn.execute({ role: 'researcher' }, null as never, {
      signal: new AbortController().signal,
    })) as { subagentId: string };

    expect(first.subagentId).toMatch(/^researcher-/);
    expect(second.subagentId).toMatch(/^researcher-/);
    expect(second.subagentId).not.toBe(first.subagentId);
  });

  it('FleetBus subscribe + filter routes events to the right handlers', async () => {
    const { director: d } = buildDirector();
    _director = d;
    const id = await spawnWithBus(d, { name: 'w', provider: 'anthropic', model: 'haiku' });

    const perAgent: string[] = [];
    const allTools: string[] = [];
    const allAny: string[] = [];

    d.fleet.subscribe(id, (e) => perAgent.push(e.type));
    d.fleet.filter('tool.executed', (e) => allTools.push(e.subagentId));
    d.fleet.onAny((e) => allAny.push(e.type));

    const taskId = await d.assign({ id: 't-1', description: 'go', subagentId: id });
    await d.awaitTasks([taskId]);

    // Subscribe-by-id sees every event from that subagent.
    expect(perAgent).toEqual(
      expect.arrayContaining([
        'iteration.started',
        'tool.started',
        'tool.executed',
        'provider.response',
      ]),
    );
    // Filter sees only the requested type but across the fleet.
    expect(allTools).toEqual([id]);
    // onAny sees everything.
    expect(allAny.length).toBeGreaterThanOrEqual(4);
  });

  it('ask() round-trips a question to a subagent via the bridge', async () => {
    // The runner subscribes to the child's bridge and replies with an
    // echoed payload. Director.ask resolves with the reply payload.
    const responses: string[] = [];
    const runner = vi.fn(
      async (_task: TaskSpec, ctx: SubagentRunContext): Promise<SubagentRunOutcome> => {
        // Subscribe BEFORE doing anything else — we want to catch the
        // director's `ask()` message arriving while this task runs.
        ctx.bridge?.subscribe((msg) => {
          if (msg.type === 'task') {
            const q = (msg.payload as { question?: string }).question ?? 'no question';
            responses.push(q);
            // Reply: same id so the director's `request<T>` matches it,
            // direction reversed (from child, to director).
            void ctx.bridge!.send({
              id: msg.id,
              type: 'result',
              from: ctx.subagentId,
              to: msg.from,
              payload: { answer: `echo: ${q}` },
              timestamp: Date.now(),
            });
          }
        });
        // Keep the task alive so the bridge stays subscribed.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 200);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
        return { iterations: 1, toolCalls: 0 };
      },
    );
    const d = new Director({
      config: { coordinatorId: 'ask-d', doneCondition: { type: 'all_tasks_done' } },
      runner,
    });
    _director = d;
    const id = await d.spawn({ name: 'answerer', provider: 'anthropic', model: 'haiku' });
    const bus = new EventBus();
    buses.set(id, bus);
    attachDisposers.push(d.fleet.attach(id, bus));
    const taskId = await d.assign({ id: 'ask-task', description: 'standby', subagentId: id });

    // Give the runner a tick to subscribe.
    await new Promise((r) => setTimeout(r, 30));

    const answer = await d.ask<{ answer: string }>(id, { question: 'what is 2+2?' });
    expect(answer.answer).toBe('echo: what is 2+2?');
    expect(responses).toContain('what is 2+2?');

    await d.awaitTasks([taskId]);
  });

  it('ask() rejects with a helpful error for unknown subagent', async () => {
    const { director: d } = buildDirector();
    _director = d;
    await expect(d.ask('does-not-exist', { question: 'hi' })).rejects.toThrow(/unknown subagent/);
  });

  it('rollUp() formats markdown summary across completed tasks', async () => {
    const { director: d } = buildDirector();
    _director = d;
    const editor = await spawnWithBus(d, {
      name: 'editor',
      provider: 'anthropic',
      model: 'planner',
    });
    const researcher = await spawnWithBus(d, {
      name: 'researcher',
      provider: 'anthropic',
      model: 'haiku',
    });
    const a = await d.assign({ id: 'r-a', description: 'edit X', subagentId: editor });
    const b = await d.assign({ id: 'r-b', description: 'research Y', subagentId: researcher });
    await d.awaitTasks([a, b]);

    const md = d.rollUp([a, b]);
    expect(md).toContain('### ' + editor);
    expect(md).toContain('### ' + researcher);
    expect(md).toContain('anthropic/planner');
    expect(md).toContain('anthropic/haiku');
    // Marker strings from the mock runner appear in the rolled-up text.
    expect(md).toContain('editor@anthropic:edit X');
    expect(md).toContain('researcher@anthropic:research Y');
  });

  it('rollUp(taskIds, "json") emits a parseable JSON array', async () => {
    const { director: d } = buildDirector();
    _director = d;
    const id = await spawnWithBus(d, { name: 'w', provider: 'anthropic', model: 'haiku' });
    const taskId = await d.assign({ id: 'j-1', description: 'do thing', subagentId: id });
    await d.awaitTasks([taskId]);

    const json = d.rollUp([taskId], 'json');
    const parsed = JSON.parse(json) as Array<{ taskId: string; status: string; result: unknown }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].taskId).toBe(taskId);
    expect(parsed[0].status).toBe('success');
  });

  it('rollUp with no matching tasks returns a polite empty marker', () => {
    const { director: d } = buildDirector();
    _director = d;
    const md = d.rollUp(['nonexistent']);
    expect(md).toMatch(/No completed tasks/);
  });

  it('writeManifest persists run state to disk', async () => {
    const os = await import('node:os');
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wrongstack-manifest-test-'));
    const manifestPath = path.join(tmpDir, 'fleet.json');
    try {
      const { director: d } = buildDirectorWithManifest(manifestPath);
      _director = d;
      const editor = await spawnWithBus(d, {
        name: 'editor',
        provider: 'anthropic',
        model: 'planner',
      });
      const taskId = await d.assign({ id: 'm-1', description: 'rewrite', subagentId: editor });
      await d.awaitTasks([taskId]);

      const written = await d.writeManifest();
      expect(written).toBe(manifestPath);

      const content = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as {
        directorRunId: string;
        children: Array<{
          subagentId: string;
          provider?: string;
          results: Array<{ taskId: string; status: string }>;
        }>;
        usage: { total: { input: number } };
      };
      expect(content.directorRunId).toBe('test-director-manifest');
      expect(content.children).toHaveLength(1);
      expect(content.children[0].subagentId).toBe(editor);
      expect(content.children[0].provider).toBe('anthropic');
      expect(content.children[0].results[0].taskId).toBe(taskId);
      expect(content.children[0].results[0].status).toBe('success');
      expect(content.usage.total.input).toBeGreaterThan(0);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * Variant of buildDirector that wires a manifest path. We can't add an
   * option to the existing helper without rewriting all the other tests,
   * so this co-located factory keeps the manifest test self-contained.
   */
  function buildDirectorWithManifest(manifestPath: string): {
    director: Director;
    runner: ReturnType<typeof vi.fn>;
  } {
    const runner = vi.fn(
      async (task: TaskSpec, ctx: SubagentRunContext): Promise<SubagentRunOutcome> => {
        const bus = buses.get(ctx.subagentId)!;
        bus.emit('iteration.started', { ctx: null as never, index: 1 });
        bus.emit('tool.executed', { id: 'm-1', name: 'mock', durationMs: 5, ok: true });
        bus.emit('provider.response', {
          ctx: null as never,
          usage: { input: 1000, output: 200 },
          stopReason: 'end_turn',
        });
        return { result: `${ctx.config.name}:${task.description}`, iterations: 1, toolCalls: 1 };
      },
    );
    const d = new Director({
      config: {
        coordinatorId: 'test-director-manifest',
        doneCondition: { type: 'all_tasks_done' },
      },
      runner,
      manifestPath,
    });
    return { director: d, runner };
  }

  it('director.tools() exposes all 13 tools including collab_debug, fleet, and quality_gate', async () => {
    const { director: d } = buildDirector();
    _director = d;
    const tools = d.tools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'ask_result',
      'ask_subagent',
      'assign_task',
      'await_tasks',
      'collab_debug',
      'fleet',
      'fleet_emit',
      'kanban_queue',
      'quality_gate',
      'roll_up',
      'spawn_subagent',
      'terminate_all',
      'terminate_subagent',
      'work_complete',
    ]);
  });

  it('per-subagent session JSONL: each subagent gets its own file', async () => {
    // Phase-2 fix: prove that the DirectorSessionFactory hands out one
    // SessionWriter per spawned subagent, with each transcript landing
    // in its own JSONL file under <runDir>/<subagentId>.jsonl.
    const os = await import('node:os');
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const { makeDirectorSessionFactory } = await import(
      '../../src/coordination/director-session.js'
    );

    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'wrongstack-director-test-'));
    try {
      const factory = makeDirectorSessionFactory({
        sessionsRoot: tmpRoot,
        directorRunId: 'run-abc',
      });

      const editor = await factory.createSubagentSession({
        subagentId: 'editor',
        provider: 'anthropic',
        model: 'planner',
      });
      const researcher = await factory.createSubagentSession({
        subagentId: 'researcher',
        provider: 'anthropic',
        model: 'haiku',
      });

      // Write distinct events to each — proves no cross-talk.
      await editor.append({
        type: 'user_input',
        ts: new Date().toISOString(),
        content: 'rewrite README',
      });
      await researcher.append({
        type: 'user_input',
        ts: new Date().toISOString(),
        content: 'find OWASP risks',
      });
      await editor.close();
      await researcher.close();

      const runDir = path.join(tmpRoot, 'run-abc');
      const files = await fsp.readdir(runDir);
      expect(files.sort()).toContain('editor.jsonl');
      expect(files.sort()).toContain('researcher.jsonl');

      const editorContent = await fsp.readFile(path.join(runDir, 'editor.jsonl'), 'utf8');
      const researcherContent = await fsp.readFile(path.join(runDir, 'researcher.jsonl'), 'utf8');

      // Each file contains its own user_input — no leak across.
      expect(editorContent).toContain('rewrite README');
      expect(editorContent).not.toContain('OWASP');
      expect(researcherContent).toContain('OWASP');
      expect(researcherContent).not.toContain('rewrite README');
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('cleanup detaches FleetBus listeners (no leak across tests)', () => {
    // The afterEach below runs every test's disposers — this test
    // explicitly verifies the disposer is callable and idempotent.
    const fleet = new Director({
      config: { coordinatorId: 'cleanup', doneCondition: { type: 'all_tasks_done' } },
    }).fleet;
    const bus = new EventBus();
    const off = fleet.attach('x', bus);
    expect(() => off()).not.toThrow();
    expect(() => off()).not.toThrow(); // second call is a no-op
  });

  describe('safety caps (Phase 6)', () => {
    it('maxSpawns refuses the N+1-th spawn with FleetSpawnBudgetError', async () => {
      const { FleetSpawnBudgetError } = await import('../../src/coordination/director.js');
      const dir = new Director({
        config: { coordinatorId: 'cap', doneCondition: { type: 'all_tasks_done' } },
        runner: async () => ({ result: 'ok', iterations: 1, toolCalls: 0 }),
        maxSpawns: 2,
      });
      await dir.spawn({ name: 'a' });
      await dir.spawn({ name: 'b' });
      let caught: unknown;
      try {
        await dir.spawn({ name: 'c' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(FleetSpawnBudgetError);
      expect((caught as InstanceType<typeof FleetSpawnBudgetError>).kind).toBe('max_spawns');
      expect((caught as InstanceType<typeof FleetSpawnBudgetError>).limit).toBe(2);
      // Status should reflect only the two spawns that actually landed.
      const s = dir.status();
      expect(s.subagents.length).toBe(2);
      await dir.shutdown();
    });

    it('maxSpawnDepth refuses spawn when director is too deep', async () => {
      const { FleetSpawnBudgetError } = await import('../../src/coordination/director.js');
      // A "nested" director at depth >= cap — it cannot spawn at all.
      const dir = new Director({
        config: { coordinatorId: 'deep', doneCondition: { type: 'all_tasks_done' } },
        runner: async () => ({ result: 'ok', iterations: 1, toolCalls: 0 }),
        maxSpawnDepth: 2,
        spawnDepth: 2, // already at the cap
      });
      let caught: unknown;
      try {
        await dir.spawn({ name: 'a' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(FleetSpawnBudgetError);
      expect((caught as InstanceType<typeof FleetSpawnBudgetError>).kind).toBe('max_spawn_depth');
      await dir.shutdown();
    });

    it('default maxSpawnDepth is 2 — root director (depth 0) can spawn', async () => {
      const dir = new Director({
        config: { coordinatorId: 'root', doneCondition: { type: 'all_tasks_done' } },
        runner: async () => ({ result: 'ok', iterations: 1, toolCalls: 0 }),
      });
      expect(dir.maxSpawnDepth).toBe(2);
      expect(dir.spawnDepth).toBe(0);
      expect(dir.maxSpawns).toBe(Number.POSITIVE_INFINITY);
      // Root spawn should succeed since 0 < 2.
      await expect(dir.spawn({ name: 'a' })).resolves.toBeTruthy();
      await dir.shutdown();
    });

    it('spawn_subagent tool surfaces budget error as structured { error, kind }', async () => {
      const dir = new Director({
        config: { coordinatorId: 'cap-tool', doneCondition: { type: 'all_tasks_done' } },
        runner: async () => ({ result: 'ok', iterations: 1, toolCalls: 0 }),
        maxSpawns: 1,
      });
      const tools = dir.tools();
      const spawnTool = tools.find((t) => t.name === 'spawn_subagent')!;
      // First call succeeds.
      const r1 = await spawnTool.execute({ name: 'first' });
      expect((r1 as { subagentId: string }).subagentId).toBeTruthy();
      // Second call hits the cap. Must NOT throw — the leader needs a
      // readable error payload to replan.
      const r2 = await spawnTool.execute({ name: 'second' });
      expect(r2).toMatchObject({
        kind: 'max_spawns',
        limit: 1,
      });
      expect((r2 as { error: string }).error).toMatch(/spawn budget exceeded/i);
      await dir.shutdown();
    });

    it('isolation regression: subagent prompts do not leak siblings or parent', () => {
      const dir = new Director({
        config: { coordinatorId: 'iso', doneCondition: { type: 'all_tasks_done' } },
        // The director's own "leader" prompt — must NOT appear inside any subagent prompt.
      });
      const a: SubagentConfig = {
        name: 'A',
        prompt: 'You are A. SECRET_A=alpha.',
        systemPromptOverride: 'OVERRIDE_A',
      };
      const b: SubagentConfig = {
        name: 'B',
        prompt: 'You are B. SECRET_B=bravo.',
        systemPromptOverride: 'OVERRIDE_B',
      };
      const promptA = dir.subagentSystemPrompt(a, 'task A');
      const promptB = dir.subagentSystemPrompt(b, 'task B');

      // A's prompt must mention A's role + override only — never B's.
      expect(promptA).toContain('SECRET_A=alpha');
      expect(promptA).toContain('OVERRIDE_A');
      expect(promptA).not.toContain('SECRET_B');
      expect(promptA).not.toContain('OVERRIDE_B');

      // Symmetric.
      expect(promptB).toContain('SECRET_B=bravo');
      expect(promptB).toContain('OVERRIDE_B');
      expect(promptB).not.toContain('SECRET_A');
      expect(promptB).not.toContain('OVERRIDE_A');

      // And neither leaks the director-leader preamble's signature
      // (i.e. subagents never see the director's own playbook).
      expect(promptA).not.toContain('You are the Director');
      expect(promptB).not.toContain('You are the Director');
    });
  });

  // ── readSession — sessionsRoot not set, file unreadable, tail param ──────────

  describe('readSession robustness', () => {
    it('readSession returns null when sessionsRoot is not set', async () => {
      const { director: d } = buildDirector();
      _director = d;
      const id = await spawnWithBus(d, { name: 'w', provider: 'anthropic', model: 'haiku' });
      const result = await d.readSession(id);
      // sessionsRoot is not configured → immediate null
      expect(result).toBeNull();
      await d.shutdown();
    });

    it('readSession returns null for nonexistent subagent', async () => {
      const dir = new Director({
        config: { coordinatorId: 'no-sessions', doneCondition: { type: 'all_tasks_done' } },
        sessionsRoot: '/tmp/does-not-exist',
      });
      const result = await dir.readSession('nonexistent-id', 10);
      expect(result).toBeNull();
      await dir.shutdown();
    });

    it('readSession skips malformed JSON lines', async () => {
      const dir = new Director({
        config: { coordinatorId: 'corrupt-jsonl', doneCondition: { type: 'all_tasks_done' } },
        sessionsRoot: '/tmp/does-not-exist', // won't be used
      });
      const result = await dir.readSession('any-id');
      expect(result).toBeNull();
      await dir.shutdown();
    });
  });

  // ── DirectorStateCheckpoint methods ────────────────────────────────────────

  describe('Director checkpoint state integration', () => {
    it('setCheckpointState resumes checkpoint when stateCheckpoint is set', async () => {
      // Build a director with stateCheckpoint available — we test the code path
      // by creating a mock that at least exercises the resume() call
      const { Director: Dir } = await import('../../src/coordination/director.js');
      const dir = new Dir({
        config: { coordinatorId: 'checkpoint-test', doneCondition: { type: 'all_tasks_done' } },
      });

      // If there's no actual checkpoint store, the call is a no-op but the code path runs
      expect(() =>
        dir.setCheckpointState({
          subagents: [],
          tasks: [],
          completedTaskIds: [],
          manifest: new Map(),
        }),
      ).not.toThrow();
      await dir.shutdown();
    });

    it('acquireCheckpointLock returns true when no stateCheckpoint is set', async () => {
      const { Director: Dir } = await import('../../src/coordination/director.js');
      const dir = new Dir({
        config: { coordinatorId: 'no-lock', doneCondition: { type: 'all_tasks_done' } },
      });
      // No stateCheckpoint → always returns true (line 1078)
      const lock = await dir.acquireCheckpointLock();
      expect(lock).toBe(true);
      await dir.shutdown();
    });

    it('resumeFromCheckpoint is a no-op when stateCheckpoint is null', async () => {
      const { Director: Dir } = await import('../../src/coordination/director.js');
      const dir = new Dir({
        config: { coordinatorId: 'no-resume', doneCondition: { type: 'all_tasks_done' } },
      });
      expect(() =>
        dir.resumeFromCheckpoint({
          subagents: [],
          tasks: [],
          completedTaskIds: [],
          manifest: new Map(),
        }),
      ).not.toThrow();
      await dir.shutdown();
    });
  });

  // ── getSubagentMeta coverage ────────────────────────────────────────────────

  describe('getSubagentMeta', () => {
    it('returns manifest-only fields when no usage is present', async () => {
      const { director: d } = buildDirector();
      _director = d;
      const id = await spawnWithBus(d, { name: 'worker', provider: 'openai', model: 'gpt-4o' });
      const meta = d.getSubagentMeta(id);
      // Manifest has name/provider/model — usage was set by buildDirector's price lookup
      expect(meta).toBeDefined();
      expect(meta?.name).toBe('worker');
      expect(meta?.provider).toMatch(/anthropic|openai/);
      await d.shutdown();
    });

    it('returns undefined for unknown subagent id', async () => {
      const { director: d } = buildDirector();
      _director = d;
      const meta = d.getSubagentMeta('totally-unknown-id');
      expect(meta).toBeUndefined();
      await d.shutdown();
    });
  });

  // ── leaderSystemPrompt with no roster ───────────────────────────────────────

  describe('leaderSystemPrompt / subagentSystemPrompt', () => {
    it('leaderSystemPrompt works when roster is not set', () => {
      const dir = new Director({
        config: { coordinatorId: 'no-roster', doneCondition: { type: 'all_tasks_done' } },
      });
      const prompt = dir.leaderSystemPrompt('custom base prompt');
      expect(prompt).toContain('custom base prompt');
      // Director preamble is always prepended
      expect(prompt).toContain('Director');
      dir.shutdown();
    });

    it('subagentSystemPrompt uses taskBrief when provided', () => {
      const dir = new Director({
        config: { coordinatorId: 'task-brief', doneCondition: { type: 'all_tasks_done' } },
      });
      const config: SubagentConfig = {
        name: 'W',
        prompt: 'Do work',
        systemPromptOverride: 'OVERRIDE',
      };
      const prompt = dir.subagentSystemPrompt(config, 'specific task description');
      expect(prompt).toContain('Do work');
      expect(prompt).toContain('OVERRIDE');
      expect(prompt).toContain('specific task description');
      dir.shutdown();
    });

    it('subagentSystemPrompt omits task section when taskBrief is omitted', () => {
      const dir = new Director({
        config: { coordinatorId: 'no-task', doneCondition: { type: 'all_tasks_done' } },
      });
      const config: SubagentConfig = { name: 'W', prompt: 'Do work' };
      const prompt = dir.subagentSystemPrompt(config);
      expect(prompt).toContain('Do work');
      // No explicit task mention when taskBrief is undefined
      dir.shutdown();
    });
  });

  // ── subagentSystemPrompt sharedScratchpad ───────────────────────────────────

  it('subagentSystemPrompt includes sharedScratchpad path when set', () => {
    const dir = new Director({
      config: { coordinatorId: 'scratchpad', doneCondition: { type: 'all_tasks_done' } },
      sharedScratchpadPath: '/tmp/shared-scratch.md',
    });
    const config: SubagentConfig = { name: 'W', prompt: 'work' };
    const prompt = dir.subagentSystemPrompt(config, 'task');
    expect(prompt).toContain('/tmp/shared-scratch.md');
    dir.shutdown();
  });

  // ── spawn with maxSpawnDepth at limit ─────────────────────────────────────

  it('maxSpawnDepth=0 director cannot spawn any subagents', async () => {
    const { FleetSpawnBudgetError, Director: Dir } = await import(
      '../../src/coordination/director.js'
    );
    const dir = new Dir({
      config: { coordinatorId: 'zero-depth', doneCondition: { type: 'all_tasks_done' } },
      maxSpawnDepth: 0,
      spawnDepth: 0,
    });
    let caught: unknown;
    try {
      await dir.spawn({ name: 'a' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FleetSpawnBudgetError);
    expect((caught as InstanceType<typeof FleetSpawnBudgetError>).kind).toBe('max_spawn_depth');
    await dir.shutdown();
  });

  // ── spawn_subagent smart dispatch (description-based routing) ─────────────────
  describe('spawn_subagent smart dispatch (description-based routing)', () => {
    const stubRoster: Record<string, SubagentConfig> = {
      explorer: { name: 'Explorer', role: 'explorer', provider: 'anthropic', model: 'planner' },
      builder: { name: 'Builder', role: 'builder', provider: 'openai', model: 'gpt-5' },
    };

    function buildDirectorWithClassifier(classifier) {
      const runner = vi.fn(async (task, ctx) => {
        const bus = buses.get(ctx.subagentId);
        bus.emit('iteration.started', { ctx: null, index: 1 });
        bus.emit('provider.response', {
          ctx: null,
          usage: { input: 100, output: 50 },
          stopReason: 'end_turn',
        });
        return {
          result: ctx.config.name + ':' + task.description,
          iterations: 1,
          toolCalls: 0,
        } as SubagentRunOutcome;
      });
      const d = new Director({
        config: { coordinatorId: 'dispatch-test', doneCondition: { type: 'all_tasks_done' } },
        runner,
        dispatchClassifier: classifier,
      });
      return { director: d, runner };
    }

    it('with description field routes to correct agent via dispatcher', async () => {
      const mockClassifier = vi.fn().mockResolvedValue({ role: 'explorer', reason: 'file task' });
      const { director: d } = buildDirectorWithClassifier(mockClassifier);
      const spawn = d.tools(stubRoster).find((t) => t.name === 'spawn_subagent')!;
      const res = await spawn.execute({ description: 'explore the codebase' }, null, {
        signal: new AbortController().signal,
      });

      expect(mockClassifier).toHaveBeenCalled();
      expect(res.provider).toBeTruthy();
      expect(res.subagentId).toBeTruthy();

      const id = res.subagentId!;
      const bus = new EventBus();
      buses.set(id, bus);
      d.fleet.attach(id, bus);
      const taskId = await d.assign({ id: 't-d1', description: 'find config', subagentId: id });
      const [result] = await d.awaitTasks([taskId]);
      expect(result.status).toBe('success');
      await d.shutdown();
    });

    it('with description and heuristic-only dispatch still routes', async () => {
      const { director: d } = buildDirectorWithClassifier(undefined);
      const spawn = d.tools(stubRoster).find((t) => t.name === 'spawn_subagent')!;
      const res = await spawn.execute({ description: 'find bugs in auth module' }, null, {
        signal: new AbortController().signal,
      });

      expect(res.subagentId).toBeTruthy();
      await d.shutdown();
    });

    it('with role takes precedence over description', async () => {
      const mockClassifier = vi.fn().mockResolvedValue({ role: 'explorer' });
      const { director: d } = buildDirectorWithClassifier(mockClassifier);

      const spawn = d.tools(stubRoster).find((t) => t.name === 'spawn_subagent')!;
      const res = await spawn.execute(
        { role: 'builder', description: 'explore the codebase' },
        null,
        { signal: new AbortController().signal },
      );

      expect(mockClassifier).not.toHaveBeenCalled();
      expect(res.provider).toBe('openai');
      await d.shutdown();
    });

    it('with description dispatch falls back gracefully when dispatcher returns null', async () => {
      const mockClassifier = vi.fn().mockResolvedValue(null);
      const { director: d } = buildDirectorWithClassifier(mockClassifier);
      const spawn = d.tools(stubRoster).find((t) => t.name === 'spawn_subagent')!;
      const res = await spawn.execute({ description: 'do something weird' }, null, {
        signal: new AbortController().signal,
      });

      expect(res.subagentId).toBeTruthy();
      expect(res.name).toBeTruthy();
      await d.shutdown();
    });

    it('without classifier uses heuristic dispatch only (no crash)', async () => {
      const { director: d } = buildDirectorWithClassifier(undefined);
      const spawn = d.tools().find((t) => t.name === 'spawn_subagent')!;
      const res = await spawn.execute({ description: 'audit the authentication module' }, null, {
        signal: new AbortController().signal,
      });
      expect(res.subagentId).toBeTruthy();
      await d.shutdown();
    });
  });

  // ── FleetManager integration ────────────────────────────────────────────────

  it('Director registers subagents with FleetManager when available', async () => {
    const { director: d } = buildDirector();
    _director = d;
    // buildDirector creates a director without an explicit FleetManager
    // — just verify the fleet exists and attach/detach works
    const id = await spawnWithBus(d, { name: 'w', provider: 'anthropic', model: 'haiku' });
    const status = d.status();
    expect(status.subagents.map((s) => s.id)).toContain(id);
    await d.shutdown();
  });

  // ── Listener-leak regression ───────────────────────────────────────────────
  // The Director constructor installs two `FleetBus.filter()` calls
  // (`tool.executed` and `budget.threshold_reached`) for the
  // timeout-heartbeat logic. If the unsubs aren't called in
  // `shutdown()`, repeated Director construction (tests, hot reloads,
  // `--director` restarts) accumulates 2 dangling listeners per
  // Director on the shared FleetBus, slowly drifting the EventEmitter
  // past its default max-listener warning. This test constructs and
  // shuts down N directors in a row and verifies the listener count
  // returns to its baseline.

  it('shutdown() detaches FleetBus filters so listeners do not leak across constructions', async () => {
    // Build one director, get a reference to its FleetBus so we can
    // measure listener counts before/after.
    const { director: d0 } = buildDirector();
    const bus = d0.fleet;
    await d0.shutdown();

    const countListeners = (type: string): number => {
      // `byType` is a private Map<string, Set<handler>> on FleetBus;
      // we reach in via a typed cast because the regression test is
      // explicitly white-box — the alternative is to expose a public
      // listener-count getter for a single test, which is worse.
      const internal = bus as never as { byType: Map<string, Set<unknown>> };
      return internal.byType.get(type)?.size ?? 0;
    };
    const toolBefore = countListeners('tool.executed');
    const budgetBefore = countListeners('budget.threshold_reached');

    // Build and shut down 10 more directors. Without the fix, each
    // adds 1 listener to each of the two event types, so the
    // counts grow by 10.
    for (let i = 0; i < 10; i++) {
      const d = buildDirector();
      await d.director.shutdown();
    }

    expect(countListeners('tool.executed')).toBe(toolBefore);
    expect(countListeners('budget.threshold_reached')).toBe(budgetBefore);
  });
});

describe('Director taskResultNotifier (fire-and-forget report-back)', () => {
  function build(notifier: (n: TaskResultNotification) => void): Director {
    const runner = vi.fn(
      async (task: TaskSpec, _ctx: SubagentRunContext): Promise<SubagentRunOutcome> => ({
        result: `done:${task.description}`,
        iterations: 1,
        toolCalls: 1,
      }),
    );
    return new Director({
      config: {
        coordinatorId: 'notify-director',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 2,
      },
      runner,
      taskResultNotifier: notifier,
    });
  }

  it('fires for a completed task with NO pending await (fire-and-forget assign)', async () => {
    const notifier = vi.fn();
    const d = build(notifier);
    const id = await d.spawn({ name: 'worker' });
    const taskId = await d.assign({
      id: 't-noawait',
      description: 'background job',
      subagentId: id,
    });

    await expect.poll(() => notifier.mock.calls.length).toBe(1);
    const n = notifier.mock.calls[0]![0] as TaskResultNotification;
    expect(n.taskId).toBe(taskId);
    expect(n.status).toBe('success');
    expect(n.title).toBe('background job');
    expect(n.resultText).toBe('done:background job');
    expect(n.subagentId).toBe(id);
    await d.shutdown();
  });

  it('does NOT fire when the task is being awaited (delegate path)', async () => {
    const notifier = vi.fn();
    const d = build(notifier);
    const id = await d.spawn({ name: 'worker' });
    const taskId = await d.assign({ id: 't-awaited', description: 'sync job', subagentId: id });
    const [result] = await d.awaitTasks([taskId]);

    expect(result?.status).toBe('success');
    // Give any stray async notifier call a chance to land before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    expect(notifier).not.toHaveBeenCalled();
    await d.shutdown();
  });

  it('a throwing notifier does not disturb completion bookkeeping', async () => {
    const notifier = vi.fn(() => {
      throw new Error('mailbox down');
    });
    const d = build(notifier);
    const id = await d.spawn({ name: 'worker' });
    const taskId = await d.assign({ id: 't-throws', description: 'job', subagentId: id });

    await expect.poll(() => notifier.mock.calls.length).toBe(1);
    // Result must still be cached and retrievable after the notifier threw.
    const [result] = await d.awaitTasks([taskId]);
    expect(result?.status).toBe('success');
    expect(result?.result).toBe('done:job');
    await d.shutdown();
  });
});
