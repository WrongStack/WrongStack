import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirectorTaskRegistry } from '../../src/coordination/director/director-task-registry.js';
import { Director } from '../../src/coordination/director.js';
import { FleetManager } from '../../src/coordination/fleet-manager.js';
import type { WorktreeTaskStateUpdate } from '../../src/coordination/worktree-task-runner.js';
import { EventBus } from '../../src/kernel/events.js';
import type {
  SubagentConfig,
  SubagentRunContext,
  SubagentRunOutcome,
  TaskSpec,
} from '../../src/types/multi-agent.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

type DirectorOpts = ConstructorParameters<typeof Director>[0];
type Runner = (task: TaskSpec, ctx: SubagentRunContext) => Promise<SubagentRunOutcome>;
const tick = () => new Promise((r) => setImmediate(r));

let tmpDirs: string[] = [];
async function mkTmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

function makeDirector(
  extra: Partial<DirectorOpts> = {},
  customRunner?: Runner,
): {
  d: Director;
  buses: Map<string, EventBus>;
  runner: ReturnType<typeof vi.fn>;
} {
  const buses = new Map<string, EventBus>();
  const runner = vi.fn(
    customRunner ??
      (async (task: TaskSpec, ctx: SubagentRunContext): Promise<SubagentRunOutcome> => {
        const bus = buses.get(ctx.subagentId);
        bus?.emit('provider.response', {
          ctx: null as never,
          model: 'test-model',
          usage: { input: 100, output: 20 },
          stopReason: 'end_turn',
        });
        return { result: `done:${task.description}`, iterations: 1, toolCalls: 1 };
      }),
  );
  const d = new Director({
    sessionId: TEST_SESSION_ID,
    config: {
      coordinatorId: 'd-extra',
      doneCondition: { type: 'all_tasks_done' },
      maxConcurrent: 4,
    },
    runner,
    ...extra,
  } as DirectorOpts);
  return { d, buses, runner };
}

/** Emit a budget.threshold_reached event and capture extend/deny. */
function emitBudget(
  d: Director,
  kind: string,
  over: Record<string, unknown> = {},
): { extended: Record<string, unknown> | null; denied: boolean } {
  const captured = { extended: null as Record<string, unknown> | null, denied: false };
  d.fleet.emit({
    subagentId: 'agent-1',
    taskId: 'task-1',
    ts: Date.now(),
    type: 'budget.threshold_reached',
    payload: {
      kind,
      used: 11,
      limit: 10,
      timeoutMs: 60_000,
      extend: (extra: Record<string, unknown>) => {
        captured.extended = extra;
      },
      deny: () => {
        captured.denied = true;
      },
      ...over,
    },
  } as never);
  return captured;
}

/** Spawn + attach a per-subagent bus so the runner can emit on it. */
async function spawnWithBus(
  d: Director,
  buses: Map<string, EventBus>,
  config: SubagentConfig,
): Promise<string> {
  const id = await d.spawn(config);
  const bus = new EventBus();
  buses.set(id, bus);
  d.fleet.attach(id, bus);
  return id;
}

describe('Director accessors', () => {
  it('exposes coordinatorId, leader context pressure, and extension counts', () => {
    const { d } = makeDirector();
    expect(d.coordinatorId).toBe('d-extra');
    expect(d.getLeaderContextPressure()).toBe(0);
    d.setLeaderContextPressure(1234);
    expect(d.getLeaderContextPressure()).toBe(1234);
    expect(d.extensionsFor('unknown-sub')).toBe(0);
  });

  it('workComplete flips the flag and is idempotent', () => {
    const { d } = makeDirector();
    expect(d.isWorkComplete()).toBe(false);
    d.workComplete();
    d.workComplete();
    expect(d.isWorkComplete()).toBe(true);
  });

  it('stashes, peeks, and drains leader /btw notes (ignoring blanks)', () => {
    const { d } = makeDirector();
    expect(d.setLeaderBtwNote('   ')).toBe(0); // blank ignored
    expect(d.setLeaderBtwNote('first')).toBe(1);
    d.setLeaderBtwNote('second');
    expect(d.peekLeaderBtwNotes()).toEqual(['first', 'second']);
    expect(d.drainLeaderBtwNotes()).toEqual(['first', 'second']);
    expect(d.peekLeaderBtwNotes()).toEqual([]); // drained
    expect(d.getLeaderBtwNotes()).toEqual([]); // empty after drain
  });

  it('tracks active collab sessions and notifies collab alert subscribers', () => {
    const { d } = makeDirector();
    expect(d.activeCollabSessions()).toEqual([]);
    // Unknown session id is a silent no-op.
    expect(() => d.cancelCollabSession('nope')).not.toThrow();
    const seen: unknown[] = [];
    const unsub = d.onCollabAlert((a) => seen.push(a));
    d.fleet.emit({
      subagentId: 's',
      ts: Date.now(),
      type: 'collab.warning',
      payload: { level: 'warning', message: 'careful' } as never,
    });
    expect(seen).toHaveLength(1);
    unsub();
  });
});

describe('Director.spawn budget rejections', () => {
  it('refuses spawning after workComplete()', async () => {
    const { d } = makeDirector();
    d.workComplete();
    await expect(d.spawn({ name: 'x', provider: 'anthropic', model: 'm' })).rejects.toThrow(
      /max_spawns|workComplete/,
    );
  });

  it('refuses spawning beyond the max spawn depth', async () => {
    const { d } = makeDirector({ spawnDepth: 2, maxSpawnDepth: 2 });
    await expect(d.spawn({ name: 'x', provider: 'anthropic', model: 'm' })).rejects.toThrow();
  });

  it('refuses spawning beyond maxSpawns', async () => {
    const { d } = makeDirector({ maxSpawns: 0 });
    await expect(d.spawn({ name: 'x', provider: 'anthropic', model: 'm' })).rejects.toThrow();
  });

  it('refuses spawning when the fleet cost cap is already met', async () => {
    const { d } = makeDirector({ directorBudget: { maxCostUsd: 0 } } as Partial<DirectorOpts>);
    await expect(d.spawn({ name: 'x', provider: 'anthropic', model: 'm' })).rejects.toThrow();
  });

  it('refuses spawning when leader context pressure exceeds the load threshold', async () => {
    const { d } = makeDirector({
      maxLeaderContextLoad: 0.5,
      maxContext: 1000,
    } as Partial<DirectorOpts>);
    d.setLeaderContextPressure(900); // 900 >= 0.5 * 1000
    await expect(d.spawn({ name: 'x', provider: 'anthropic', model: 'm' })).rejects.toThrow();
  });
});

describe('Director task lifecycle + delegating methods', () => {
  it('runs a task and exposes completedResults, status, snapshot, on()', async () => {
    const { d, buses } = makeDirector();
    const completedEvents: unknown[] = [];
    const unsub = d.on('task.completed', (p) => completedEvents.push(p));
    const id = await spawnWithBus(d, buses, { name: 'Coder', provider: 'anthropic', model: 'm' });

    const taskId = await d.assign({ id: 't-1', description: 'do work', subagentId: id });
    const [res] = await d.awaitTasks([taskId]);
    expect(res?.status).toBe('success');
    expect(res?.result).toBe('done:do work');

    expect(d.completedResults().length).toBeGreaterThan(0);
    expect(completedEvents).toHaveLength(1);

    const st = d.status();
    expect(st.subagents.find((s) => s.id === id)).toBeDefined();
    expect(d.snapshot().total).toBeDefined();

    await d.terminate(id);
    await d.remove(id);
    unsub();
  });

  it('terminateAll stops the whole fleet', async () => {
    const { d, buses } = makeDirector();
    await spawnWithBus(d, buses, { name: 'A', provider: 'anthropic', model: 'm' });
    await spawnWithBus(d, buses, { name: 'B', provider: 'anthropic', model: 'm' });
    await expect(d.terminateAll()).resolves.toBeUndefined();
  });
});

describe('Director.readSession', () => {
  it('parses the subagent JSONL transcript and supports tailing', async () => {
    const root = await mkTmp('dir-sess-');
    const runId = 'run-1';
    const { d } = makeDirector({
      sessionsRoot: root,
      directorRunId: runId,
    } as Partial<DirectorOpts>);
    await fs.mkdir(path.join(root, runId), { recursive: true });
    const lines = [
      JSON.stringify({ type: 'assistant', text: 'hello' }),
      JSON.stringify({ type: 'tool_use' }),
      JSON.stringify({ type: 'stop', stopReason: 'end_turn' }),
      'not-json-line',
      '',
    ].join('\n');
    await fs.writeFile(path.join(root, runId, 'sub-1.jsonl'), `${lines}\n`);

    const r = await d.readSession('sub-1');
    expect(r?.lastAssistantText).toBe('hello');
    expect(r?.lastStopReason).toBe('end_turn');
    expect(r?.toolUsesObserved).toBe(1);

    const tailed = await d.readSession('sub-1', 1);
    expect(tailed?.events).toBe(1);

    expect(await d.readSession('absent')).toBeNull();
  });

  it('returns null when no sessionsRoot is configured', async () => {
    const { d } = makeDirector();
    expect(await d.readSession('any')).toBeNull();
  });
});

describe('Director manifest scheduling', () => {
  it('writes the manifest synchronously when debounce is 0', async () => {
    const root = await mkTmp('dir-manifest-');
    const manifestPath = path.join(root, 'manifest.json');
    const { d, buses } = makeDirector({
      manifestPath,
      manifestDebounceMs: 0,
    } as Partial<DirectorOpts>);
    await spawnWithBus(d, buses, { name: 'Worker', provider: 'anthropic', model: 'm' });
    // synchronous flush path → file exists shortly after
    await vi.waitFor(async () => {
      const txt = await fs.readFile(manifestPath, 'utf8');
      expect(txt).toContain('Worker');
    });
  });

  it('disables manifest writes when debounce is negative', async () => {
    const root = await mkTmp('dir-manifest-neg-');
    const manifestPath = path.join(root, 'manifest.json');
    const { d, buses } = makeDirector({
      manifestPath,
      manifestDebounceMs: -1,
    } as Partial<DirectorOpts>);
    await spawnWithBus(d, buses, { name: 'NoWrite', provider: 'anthropic', model: 'm' });
    await expect(fs.readFile(manifestPath, 'utf8')).rejects.toThrow(); // never written
  });

  it('writeManifest returns null when no path is configured', async () => {
    const { d } = makeDirector();
    expect(await d.writeManifest()).toBeNull();
  });
});

describe('Director budget-threshold extension policy (no brain)', () => {
  it('auto-extends each budget kind with the right field', async () => {
    const { d } = makeDirector();
    for (const [kind, field] of [
      ['iterations', 'maxIterations'],
      ['tool_calls', 'maxToolCalls'],
      ['tokens', 'maxTokens'],
      ['cost', 'maxCostUsd'],
    ] as const) {
      const cap = emitBudget(d, kind);
      await tick();
      await tick();
      expect(cap.denied).toBe(false);
      expect(cap.extended?.[field]).toBeGreaterThan(0);
    }
  });

  it('denies once the per-kind extension cap is reached', async () => {
    const { d } = makeDirector({ maxBudgetExtensions: 0 } as Partial<DirectorOpts>);
    const cap = emitBudget(d, 'iterations');
    await tick();
    expect(cap.denied).toBe(true);
  });

  it('denies a cost extension when the fleet cost cap is exceeded', async () => {
    const { d } = makeDirector({ directorBudget: { maxCostUsd: 0 } } as Partial<DirectorOpts>);
    const cap = emitBudget(d, 'cost');
    await tick();
    expect(cap.denied).toBe(true);
  });

  it('auto-extends collab-named roles used outside an active collab session', async () => {
    // Plain delegate({ role: 'critic' }) mints critic-<uuid> ids. Those must
    // still receive director auto-extend — only agents owned by a live
    // CollabSession are skipped.
    const { d } = makeDirector();
    let denied = false;
    let extended: Record<string, unknown> | null = null;
    d.fleet.emit({
      subagentId: 'critic-abcdef12',
      taskId: 't',
      ts: Date.now(),
      type: 'budget.threshold_reached',
      payload: {
        kind: 'iterations',
        used: 11,
        limit: 10,
        extend: (extra: Record<string, unknown>) => {
          extended = extra;
        },
        deny: () => {
          denied = true;
        },
      },
    } as never);
    await tick();
    await tick();
    expect(denied).toBe(false);
    expect(extended).not.toBeNull();
    expect((extended as { maxIterations?: number } | null)?.maxIterations).toBeGreaterThan(10);
  });

  it('skips budget thresholds for agents owned by an active collab session', () => {
    const { d } = makeDirector();
    // Simulate an active collab owning bug-hunter-1 via the collab controller's
    // ownership probe (no full CollabSession required for this unit check).
    const collab = (d as unknown as { collab: { ownsSubagent: (id: string) => boolean } }).collab;
    const original = collab.ownsSubagent.bind(collab);
    collab.ownsSubagent = (id: string) => id === 'bug-hunter-1' || original(id);

    let denied = false;
    let extended = false;
    d.fleet.emit({
      subagentId: 'bug-hunter-1',
      taskId: 't',
      ts: Date.now(),
      type: 'budget.threshold_reached',
      payload: {
        kind: 'iterations',
        used: 11,
        limit: 10,
        extend: () => {
          extended = true;
        },
        deny: () => {
          denied = true;
        },
      },
    } as never);
    expect(denied).toBe(false);
    expect(extended).toBe(false); // director skips — the CollabSession handles it
  });
});

describe('Director defensive teardown paths', () => {
  it('swallows a failing session-writer append', async () => {
    const sessionWriter = { append: vi.fn().mockRejectedValue(new Error('writer closed')) };
    const { d, buses } = makeDirector({ sessionWriter } as never as Partial<DirectorOpts>);
    const id = await spawnWithBus(d, buses, { name: 'W', provider: 'p', model: 'm' });
    // assign() calls appendSessionEvent('task_created') → append rejects → swallowed
    await expect(d.assign({ id: 't-w', description: 'x', subagentId: id })).resolves.toBeDefined();
  });

  it('swallows a failing debounced manifest write (sync and timer)', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const root = await mkTmp('dir-bad-manifest-');
    // A FILE where the manifest's parent directory should be → mkdir/atomicWrite fail.
    await fs.writeFile(path.join(root, 'blocker'), 'x');
    const manifestPath = path.join(root, 'blocker', 'm.json');

    const sync = makeDirector({ manifestPath, manifestDebounceMs: 0 } as Partial<DirectorOpts>);
    await spawnWithBus(sync.d, sync.buses, { name: 'S', provider: 'p', model: 'm' });

    const timer = makeDirector({ manifestPath, manifestDebounceMs: 5 } as Partial<DirectorOpts>);
    await spawnWithBus(timer.d, timer.buses, { name: 'T', provider: 'p', model: 'm' });
    await new Promise((r) => setTimeout(r, 30)); // let the debounce timer fire + reject

    expect(warn).toHaveBeenCalled();
  });
});

describe('Director budget-threshold extension policy (brain)', () => {
  const brainDir = (
    decide: DirectorOpts['brain'] extends infer B
      ? B extends { decide: infer D }
        ? D
        : never
      : never,
  ) => makeDirector({ brain: { decide } as DirectorOpts['brain'] });

  it.each([
    ['iterations', 'maxIterations'],
    ['tool_calls', 'maxToolCalls'],
    ['tokens', 'maxTokens'],
  ] as const)(
    'auto-extends routine %s limits without consulting the brain',
    async (kind, field) => {
      const decide = vi.fn(async () => ({ type: 'deny' }) as never);
      const { d } = brainDir(decide as never);
      const cap = emitBudget(d, kind);
      await tick();
      await tick();
      expect(decide).not.toHaveBeenCalled();
      expect(cap.denied).toBe(false);
      expect(cap.extended?.[field]).toBeGreaterThan(0);
    },
  );

  it('denies a cost extension on a deny decision', async () => {
    const { d } = brainDir(async () => ({ type: 'deny' }) as never);
    const cap = emitBudget(d, 'cost');
    await tick();
    await tick();
    expect(cap.denied).toBe(true);
  });

  it('denies a cost extension on an ask_human decision', async () => {
    const { d } = brainDir(async () => ({ type: 'ask_human' }) as never);
    const cap = emitBudget(d, 'cost');
    await tick();
    await tick();
    expect(cap.denied).toBe(true);
  });

  it('denies a cost extension when the brain decision rejects', async () => {
    const { d } = brainDir(async () => {
      throw new Error('brain down');
    });
    const cap = emitBudget(d, 'cost');
    await tick();
    await tick();
    expect(cap.denied).toBe(true);
  });

  it('extends cost on an answer that is not "stop"', async () => {
    const { d } = brainDir(
      async () => ({ type: 'answer', optionId: 'extend', text: 'extend' }) as never,
    );
    const cap = emitBudget(d, 'cost');
    await tick();
    await tick();
    expect(cap.extended?.maxCostUsd).toBeGreaterThan(0);
  });
});

describe('Director.assign after workComplete + rollUp formatting', () => {
  it('synthesizes a stopped result for tasks assigned after workComplete', async () => {
    const { d } = makeDirector();
    d.workComplete();
    const taskId = await d.assign({
      id: 't-late',
      description: 'too late',
      subagentId: 'unassigned',
    });
    const [res] = await d.awaitTasks([taskId]);
    expect(res?.status).toBe('stopped');
    expect(res?.error?.kind).toBe('aborted_by_parent');
  });

  it('formats error, string, object, and empty results in a roll-up', async () => {
    const runner: Runner = async (task) => {
      if (task.description === 'err') throw new Error('kaboom');
      if (task.description === 'obj')
        return { result: { hello: 'world' }, iterations: 1, toolCalls: 0 };
      if (task.description === 'undef') return { result: undefined, iterations: 1, toolCalls: 0 };
      return { result: 'plain text', iterations: 1, toolCalls: 0 };
    };
    const { d, buses } = makeDirector({}, runner);
    const id = await spawnWithBus(d, buses, { name: 'W', provider: 'anthropic', model: 'm' });
    const ids: string[] = [];
    for (const desc of ['err', 'obj', 'undef', 'text']) {
      ids.push(await d.assign({ id: `t-${desc}`, description: desc, subagentId: id }));
    }
    await d.awaitTasks(ids);
    const md = d.rollUp(ids);
    expect(md).toContain('Error:');
    expect(md).toContain('hello');
    expect(md).toContain('plain text');
    expect(md).toContain('(no output)');
  });

  it('rollUp reports when no requested ids have completed', () => {
    const { d } = makeDirector();
    expect(d.rollUp(['never-seen'])).toContain('No completed tasks');
  });
});

describe('Director with an injected FleetManager', () => {
  it('delegates spawn/assign/remove through the FleetManager', async () => {
    const fleetManager = new FleetManager({ maxSpawns: 5 });
    const { d, buses } = makeDirector({ fleetManager } as Partial<DirectorOpts>);
    const id = await spawnWithBus(d, buses, { name: 'FM', provider: 'anthropic', model: 'm' });
    const taskId = await d.assign({ id: 't-fm', description: 'fm task', subagentId: id });
    const [res] = await d.awaitTasks([taskId]);
    expect(res?.status).toBe('success');
    await d.remove(id);
  });

  it('reclaims taskWorktrees + registry descriptions/owners on the FleetManager path', async () => {
    // Regression (RAM-leak audit 2026-08-01): Director.remove() cleaned
    // taskWorktrees and the task registry ONLY inside a block gated on
    // manifestEntries, which fleet-spawn.ts populates solely when
    // !host.fleetManager. With a FleetManager injected (the default production
    // path) manifestEntries stays empty, so both maps grew one entry per task
    // for the Director's lifetime. The fix prunes them unconditionally.
    const fleetManager = new FleetManager({ maxSpawns: 5 });
    const { d, buses } = makeDirector({
      fleetManager,
      retireSubagentOnTaskComplete: false,
    } as Partial<DirectorOpts>);

    const s1 = await spawnWithBus(d, buses, { name: 'W1', provider: 'anthropic', model: 'm' });
    const s2 = await spawnWithBus(d, buses, { name: 'W2', provider: 'openai', model: 'g' });

    // On the fleet path assign() routes through fleetManager.addTaskToSubagent,
    // NOT Director.manifestEntries — so manifestEntries stays empty here.
    await d.assign({ id: 't-1', description: 'brief-1', subagentId: s1 });
    await d.assign({ id: 't-2', description: 'brief-2', subagentId: s1 });
    await d.assign({ id: 't-3', description: 'brief-3', subagentId: s2 });

    // Seed worktree state as recordWorktreeTaskUpdate would (public readonly map).
    const wt = (taskId: string, subagentId: string): WorktreeTaskStateUpdate => ({
      taskId,
      subagentId,
      handleId: `h-${taskId}`,
      dir: `/tmp/${taskId}`,
      branch: `b-${taskId}`,
      baseBranch: 'main',
      status: 'allocated',
    });
    d.taskWorktrees.set('t-1', wt('t-1', s1));
    d.taskWorktrees.set('t-2', wt('t-2', s1));
    d.taskWorktrees.set('t-3', wt('t-3', s2));
    expect(d.taskWorktrees.size).toBe(3);

    const tasks = (d as unknown as { tasks: DirectorTaskRegistry }).tasks;
    expect(tasks.ownerFor('t-1')).toBe(s1);
    expect(tasks.descriptionFor('t-1', 'X')).toBe('brief-1');

    await d.remove(s1);

    // s1's worktree entries reclaimed; s2's retained.
    expect(d.taskWorktrees.has('t-1')).toBe(false);
    expect(d.taskWorktrees.has('t-2')).toBe(false);
    expect(d.taskWorktrees.has('t-3')).toBe(true);
    expect(d.taskWorktrees.size).toBe(1);
    // s1's registry descriptions/owners back to baseline; s2's retained.
    expect(tasks.ownerFor('t-1')).toBeUndefined();
    expect(tasks.ownerFor('t-2')).toBeUndefined();
    expect(tasks.descriptionFor('t-1', 'X')).toBe('X');
    expect(tasks.descriptionFor('t-2', 'X')).toBe('X');
    expect(tasks.ownerFor('t-3')).toBe(s2);
    expect(tasks.descriptionFor('t-3', 'X')).toBe('brief-3');
  });

  it('keeps the FleetManager manifest authoritative after assign', async () => {
    const root = await mkTmp('director-fleet-manager-manifest-');
    const manifestPath = path.join(root, 'fleet.json');
    const fleetManager = new FleetManager({
      manifestPath,
      manifestDebounceMs: 0,
      directorRunId: 'fleet-manager-run',
    });
    const { d, buses } = makeDirector({
      fleetManager,
      manifestPath,
      manifestDebounceMs: 5,
      retireSubagentOnTaskComplete: false,
    } as Partial<DirectorOpts>);
    const id = await spawnWithBus(d, buses, {
      name: 'Visible Worker',
      provider: 'anthropic',
      model: 'm',
    });
    const taskId = await d.assign({
      id: 'visible-task',
      description: 'stay visible',
      subagentId: id,
    });
    await d.awaitTasks([taskId]);

    // The legacy Director writer used to fire after FleetManager's canonical
    // write and replace this file with { children: [] }.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await vi.waitFor(async () => {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
        version?: number;
        directorRunId?: string;
        children?: Array<{ id: string; taskIds: string[] }>;
      };
      expect(manifest.version).toBe(1);
      expect(manifest.directorRunId).toBe('fleet-manager-run');
      expect(manifest.children).toEqual([
        expect.objectContaining({ id, taskIds: ['visible-task'] }),
      ]);
    });
  });

  it('surfaces a FleetManager spawn rejection as a budget error', async () => {
    const fleetManager = new FleetManager({ maxSpawns: 0 });
    const { d } = makeDirector({ fleetManager } as Partial<DirectorOpts>);
    await expect(d.spawn({ name: 'over', provider: 'anthropic', model: 'm' })).rejects.toThrow();
  });

  it('maps every FleetManager spawn-rejection kind to its error', async () => {
    const fleetManager = new FleetManager();
    const { d } = makeDirector({ fleetManager } as Partial<DirectorOpts>);
    const spy = vi.spyOn(fleetManager, 'canSpawn');
    for (const kind of [
      'max_spawn_depth',
      'max_cost_usd',
      'max_tokens',
      'max_context_load',
    ] as const) {
      spy.mockReturnValueOnce({ kind, limit: 1, observed: 2 } as never);
      await expect(d.spawn({ name: kind, provider: 'p', model: 'm' })).rejects.toThrow();
    }
  });

  it('assigns a nickname via the FleetManager for synthetic names', async () => {
    const fleetManager = new FleetManager();
    const { d } = makeDirector({ fleetManager } as Partial<DirectorOpts>);
    const id = await d.spawn({ name: 'adhoc', role: 'coder', provider: 'p', model: 'm' } as never);
    expect(id).toBeDefined();
  });
});

describe('Director misc coverage', () => {
  it('reuses a pending awaitTasks promise and resolves it via a post-workComplete assign', async () => {
    const { d } = makeDirector();
    const p1 = d.awaitTasks(['dup-id']);
    const p2 = d.awaitTasks(['dup-id']); // shares the existing waiter
    d.workComplete();
    await d.assign({ id: 'dup-id', description: 'late', subagentId: 's' }); // resolves the waiter
    const [r1] = await p1;
    const [r2] = await p2;
    expect(r1?.status).toBe('stopped');
    expect(r2?.status).toBe('stopped');
  });

  it('rolls up usage for a subagent with no provider/model', async () => {
    const { d, buses } = makeDirector();
    const id = await d.spawn({ name: 'Anon' } as never); // no provider/model
    const bus = new EventBus();
    buses.set(id, bus);
    d.fleet.attach(id, bus);
    const t = await d.assign({ id: 't-anon', description: 'go', subagentId: id });
    await d.awaitTasks([t]);
    expect(d.snapshot().total).toBeDefined();
  });

  it('frees the nickname slot on remove (no FleetManager)', async () => {
    const { d, buses } = makeDirector();
    const id = await spawnWithBus(d, buses, {
      name: 'adhoc',
      role: 'coder',
      provider: 'p',
      model: 'm',
    });
    await expect(d.remove(id)).resolves.toBeUndefined();
  });

  it('writes the manifest when the debounce timer fires', async () => {
    const root = await mkTmp('dir-manifest-timer-');
    const manifestPath = path.join(root, 'm.json');
    const { d, buses } = makeDirector({
      manifestPath,
      manifestDebounceMs: 5,
    } as Partial<DirectorOpts>);
    await spawnWithBus(d, buses, { name: 'T', provider: 'p', model: 'm' });
    await vi.waitFor(async () => {
      expect(await fs.readFile(manifestPath, 'utf8')).toContain('directorRunId');
    });
  });
});

describe('Director.shutdown', () => {
  it('clears the manifest timer, writes the manifest, and flushes the checkpoint', async () => {
    const root = await mkTmp('dir-shutdown-');
    const manifestPath = path.join(root, 'manifest.json');
    const stateCheckpointPath = path.join(root, 'checkpoint.json');
    const { d, buses } = makeDirector({
      manifestPath,
      stateCheckpointPath,
      manifestDebounceMs: 5000,
    } as Partial<DirectorOpts>);
    await spawnWithBus(d, buses, { name: 'S', provider: 'anthropic', model: 'm' }); // schedules a debounced timer
    await d.shutdown();
    expect(await fs.readFile(manifestPath, 'utf8')).toContain('directorRunId');
  });

  it('logShutdownError emits a process warning without throwing', () => {
    const { d } = makeDirector();
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    (d as never as { logShutdownError: (p: string, e: unknown) => void }).logShutdownError(
      'test_phase',
      new Error('boom'),
    );
    expect(warn).toHaveBeenCalled();
  });
});

describe('Director.spawnCollab', () => {
  const snapshot = () => ({
    id: 'snap',
    createdAt: new Date().toISOString(),
    files: [{ path: 'a.ts', content: 'export const x = 1;' }],
  });

  const taskResult = () => [
    {
      taskId: 't',
      subagentId: 's',
      status: 'success',
      result: '{}',
      iterations: 1,
      toolCalls: 0,
      durationMs: 1,
    },
  ];

  it('runs a collab session and clears it from the active set on completion', async () => {
    const { d } = makeDirector();
    // The real CollabSession awaits on subagent ids; drive completion via awaitTasks.
    vi.spyOn(d, 'awaitTasks').mockResolvedValue(taskResult() as never);
    const report = await d.spawnCollab({
      targetPaths: ['a.ts'],
      prebuiltSnapshot: snapshot() as never,
      timeoutMs: 5000,
    });
    expect(report.sessionId).toBeDefined();
    expect(d.activeCollabSessions()).toEqual([]);
  });

  it('cancels an active collab session', async () => {
    const { d } = makeDirector();
    // awaitTasks hangs so the session stays active; cancelCollabSession() runs
    // its teardown synchronously, so we don't await the (intentionally stuck) run.
    vi.spyOn(d, 'awaitTasks').mockReturnValue(new Promise<never>(() => {}));
    const p = d.spawnCollab({
      targetPaths: ['a.ts'],
      prebuiltSnapshot: snapshot() as never,
      timeoutMs: 10_000,
    });
    void p.catch(() => {}); // never settles (real director can't resolve subagent-id awaits); swallow
    await tick();
    const ids = d.activeCollabSessions();
    expect(ids.length).toBe(1);
    expect(() => d.cancelCollabSession(ids[0]!)).not.toThrow();
  });

  it('clears the session from the active set when it errors', async () => {
    const { d } = makeDirector();
    vi.spyOn(d, 'awaitTasks').mockRejectedValue(new Error('collab failure'));
    await expect(
      d.spawnCollab({
        targetPaths: ['a.ts'],
        prebuiltSnapshot: snapshot() as never,
        timeoutMs: 5000,
      }),
    ).rejects.toThrow();
    expect(d.activeCollabSessions()).toEqual([]);
  });
});
