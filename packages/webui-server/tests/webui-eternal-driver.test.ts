import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { RunResult } from '@wrongstack/core/agent';
import { emptyGoal, goalFilePath, saveGoal } from '@wrongstack/goal';
import { HOST_CAPABILITY_ETERNAL_AUTONOMY } from '@wrongstack/webui-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmbeddedConversationRoutes } from '../src/server/embedded-host-adapters.js';
import {
  createWebuiEternalDriver,
  type EternalEngineInput,
  type RuntimeTurnRunner,
} from '../src/server/webui-eternal-driver.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function projectWithGoal(state?: 'completed'): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), 'eternal-driver-'));
  roots.push(root);
  const goal = emptyGoal('ship the feature');
  await saveGoal(goalFilePath(root), state ? { ...goal, goalState: state } : goal);
  return root;
}

const done = (finalText = 'ok'): RunResult => ({ status: 'done', iterations: 1, finalText });

/**
 * An engine stand-in that behaves like the real one where the driver cares:
 * `run()` loops, sends one directive per pass through `agent.run`, and ends
 * on `stop()` or after `passes` directives.
 */
function scriptedEngine(passes: number) {
  const seen: { input?: EternalEngineInput; runOptions: unknown[]; results: RunResult[] } = {
    runOptions: [],
    results: [],
  };
  let stopped = false;
  let ctrl: AbortController | undefined;
  const createEngine = (input: EternalEngineInput) => {
    seen.input = input;
    return {
      async run() {
        for (let i = 0; i < passes && !stopped; i++) {
          ctrl = new AbortController();
          const options = {
            signal: ctrl.signal,
            autonomousContinue: true,
            maxIterations: 12,
          };
          seen.runOptions.push(options);
          const result = await input.agent.run([{ type: 'text', text: `directive ${i}` }], options);
          seen.results.push(result);
          input.onIteration({ iteration: i + 1, task: `task ${i}` } as never);
        }
      },
      stop() {
        stopped = true;
        ctrl?.abort();
      },
    };
  };
  return { seen, createEngine, isStopped: () => stopped };
}

function harness(root: string, runner: RuntimeTurnRunner, passes = 1) {
  const engine = scriptedEngine(passes);
  const meta: Record<string, unknown> = { autonomy: 'eternal' };
  const broadcasts: Array<{ type: string; payload: unknown }> = [];
  const persisted: string[] = [];
  const open = new Set(['tab-1', 'tab-2']);
  const agent = {
    ctx: { meta, marker: 'real-ctx' },
    run: vi.fn(async () => {
      throw new Error('the engine must not call the agent directly');
    }),
  };
  const driver = createWebuiEternalDriver({
    getProjectRoot: () => root,
    getAgent: () => agent as never,
    isSessionOpen: (sessionId) => open.has(sessionId),
    broadcast: (message) => broadcasts.push(message),
    persistAutonomy: (mode) => {
      persisted.push(mode);
    },
    createEngine: engine.createEngine,
    busyRetryMs: 5,
  });
  driver.bindTurnRunner(runner);
  return { driver, engine, meta, broadcasts, persisted, open, agent };
}

const settled = (broadcasts: Array<{ type: string; payload: unknown }>) =>
  broadcasts.filter((m) => m.type === 'prefs.updated').map((m) => m.payload);

describe('WebUI eternal driver', () => {
  it('advertises the eternal-loop capability', () => {
    const driver = createWebuiEternalDriver({
      getProjectRoot: () => '.',
      getAgent: () => ({}) as never,
      isSessionOpen: () => true,
      broadcast: () => {},
    });
    expect(driver.capability).toBe(HOST_CAPABILITY_ETERNAL_AUTONOMY);
  });

  it('runs every directive through the conversation path with the engine options, then settles the tab on auto', async () => {
    const root = await projectWithGoal();
    const runner = vi.fn<RuntimeTurnRunner>(async () => ({ started: true, result: done() }));
    const h = harness(root, runner, 2);

    expect(await h.driver.check('tab-1', 'eternal')).toBeUndefined();
    h.driver.setMode('tab-1', 'eternal');
    expect(h.driver.activeSessionId()).toBe('tab-1');
    await vi.waitFor(() => expect(h.driver.activeSessionId()).toBeUndefined());

    expect(h.agent.run).not.toHaveBeenCalled();
    expect(runner).toHaveBeenCalledTimes(2);
    const [sessionId, prompt, options] = runner.mock.calls[0] ?? [];
    expect(sessionId).toBe('tab-1');
    expect(prompt).toBe('directive 0');
    expect(options).toMatchObject({
      autonomousContinue: true,
      maxIterations: 12,
      resultOrigin: 'eternal',
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    // The rest of the agent is the conversation's own.
    const routedCtx = h.engine.seen.input?.agent.ctx as unknown as { marker: string } | undefined;
    expect(routedCtx?.marker).toBe('real-ctx');
    expect(h.broadcasts.filter((m) => m.type === 'eternal.iteration')).toEqual([
      { type: 'eternal.iteration', payload: { entry: expect.anything(), sessionId: 'tab-1' } },
      { type: 'eternal.iteration', payload: { entry: expect.anything(), sessionId: 'tab-1' } },
    ]);
    // The engine ended on its own: the tab leaves the eternal mode.
    expect(h.meta['autonomy']).toBe('auto');
    expect(settled(h.broadcasts)).toEqual([{ autonomy: 'auto', sessionId: 'tab-1' }]);
    expect(h.persisted).toEqual(['auto']);
  });

  it('waits while another turn holds the conversation instead of failing the iteration', async () => {
    const root = await projectWithGoal();
    let busy = 2;
    const runner = vi.fn<RuntimeTurnRunner>(async () =>
      busy-- > 0 ? { started: false } : { started: true, result: done() },
    );
    const h = harness(root, runner);
    h.driver.setMode('tab-1', 'eternal');
    await vi.waitFor(() => expect(h.driver.activeSessionId()).toBeUndefined());
    expect(runner).toHaveBeenCalledTimes(3);
    expect(h.engine.seen.results).toEqual([done()]);
  });

  it('ends the loop and settles the tab on off when the user stops an eternal turn', async () => {
    const root = await projectWithGoal();
    const runner = vi.fn<RuntimeTurnRunner>(async () => ({
      started: true,
      result: { status: 'aborted', iterations: 1 },
    }));
    const h = harness(root, runner, 5);
    h.driver.setMode('tab-1', 'eternal');
    await vi.waitFor(() => expect(h.driver.activeSessionId()).toBeUndefined());
    expect(runner).toHaveBeenCalledTimes(1);
    expect(h.engine.isStopped()).toBe(true);
    expect(h.meta['autonomy']).toBe('off');
    expect(settled(h.broadcasts)).toEqual([{ autonomy: 'off', sessionId: 'tab-1' }]);
  });

  it('stops the running iteration when the tab leaves the eternal modes, without settling again', async () => {
    const root = await projectWithGoal();
    let signal: AbortSignal | undefined;
    const runner = vi.fn<RuntimeTurnRunner>(
      (_id, _prompt, options) =>
        new Promise((resolve) => {
          signal = options?.signal;
          options?.signal?.addEventListener('abort', () =>
            resolve({ started: true, result: { status: 'aborted', iterations: 0 } }),
          );
        }),
    );
    const h = harness(root, runner, 5);
    h.driver.setMode('tab-1', 'eternal');
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    h.driver.setMode('tab-1', 'auto');
    expect(signal?.aborted).toBe(true);
    expect(h.driver.activeSessionId()).toBeUndefined();
    await vi.waitFor(() => expect(h.engine.seen.results).toHaveLength(1));
    // The user chose the new mode; the driver does not overwrite it.
    expect(settled(h.broadcasts)).toEqual([]);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('refuses eternal without a goal, with a completed goal, and while another tab runs it', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'eternal-driver-'));
    roots.push(empty);
    const never = vi.fn<RuntimeTurnRunner>(() => new Promise(() => {}));
    expect(await harness(empty, never).driver.check('tab-1', 'eternal')).toMatch(/needs a goal/);
    const completed = await projectWithGoal('completed');
    expect(await harness(completed, never).driver.check('tab-1', 'eternal')).toMatch(
      /already completed/,
    );

    const root = await projectWithGoal();
    const h = harness(root, never);
    h.driver.setMode('tab-1', 'eternal');
    expect(await h.driver.check('tab-2', 'eternal-parallel')).toMatch(/Another conversation/);
    expect(await h.driver.check('tab-2', 'auto')).toBeUndefined();
    // A switch that bypassed the check is turned back, and tab-1 keeps running.
    h.driver.setMode('tab-2', 'eternal');
    expect(h.driver.activeSessionId()).toBe('tab-1');
    expect(settled(h.broadcasts)).toEqual([{ autonomy: 'off', sessionId: 'tab-2' }]);
    h.driver.dispose();
  });

  it('refuses when no conversation path is bound', async () => {
    const root = await projectWithGoal();
    const driver = createWebuiEternalDriver({
      getProjectRoot: () => root,
      getAgent: () => ({}) as never,
      isSessionOpen: () => true,
      broadcast: () => {},
    });
    expect(await driver.check('tab-1', 'eternal')).toMatch(/no conversation path/);
  });

  it('stops quietly when the conversation is no longer open', async () => {
    const root = await projectWithGoal();
    const runner = vi.fn<RuntimeTurnRunner>(async () => ({ started: true, result: done() }));
    const h = harness(root, runner, 5);
    h.open.delete('tab-1');
    h.driver.setMode('tab-1', 'eternal');
    await vi.waitFor(() => expect(h.driver.activeSessionId()).toBeUndefined());
    expect(runner).not.toHaveBeenCalled();
    expect(settled(h.broadcasts)).toEqual([]);
  });

  it('settles nothing when the host shuts down during an eternal turn', async () => {
    const root = await projectWithGoal();
    const runner = vi.fn<RuntimeTurnRunner>(
      (_id, _prompt, options) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener('abort', () =>
            resolve({ started: true, result: { status: 'aborted', iterations: 0 } }),
          );
        }),
    );
    const h = harness(root, runner, 5);
    h.driver.setMode('tab-1', 'eternal');
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    h.driver.dispose();
    await vi.waitFor(() => expect(h.engine.seen.results).toHaveLength(1));
    expect(settled(h.broadcasts)).toEqual([]);
    expect(h.persisted).toEqual([]);
    expect(h.meta['autonomy']).toBe('eternal');
  });

  it('stops the loop and settles off when the host switches projects', async () => {
    const root = await projectWithGoal();
    const never = vi.fn<RuntimeTurnRunner>(() => new Promise(() => {}));
    const h = harness(root, never, 5);
    h.driver.setMode('tab-1', 'eternal');
    h.driver.projectChanged();
    expect(h.driver.activeSessionId()).toBeUndefined();
    expect(h.engine.isStopped()).toBe(true);
    expect(settled(h.broadcasts)).toEqual([{ autonomy: 'off', sessionId: 'tab-1' }]);
  });

  it('runs directives through the CLI-hosted conversation path: its run lock, the engine options, runtime origin', async () => {
    const root = await projectWithGoal();
    const abortControllers = new Map<string, AbortController>();
    const lockHeld: boolean[] = [];
    const run = vi.fn(async () => {
      lockHeld.push(abortControllers.has('tab-1'));
      return done('iteration ok');
    });
    const agent = {
      run,
      ctx: {
        provider: { id: 'provider', capabilities: { vision: true } },
        model: 'model',
        messages: [],
        meta: { autonomy: 'eternal' },
        session: { id: 'tab-1', append: vi.fn() },
      },
      tools: { list: () => [] },
    };
    const broadcasts: Array<{ type: string; payload: unknown }> = [];
    const engine = scriptedEngine(1);
    const driver = createWebuiEternalDriver({
      getProjectRoot: () => root,
      getAgent: () => agent as never,
      isSessionOpen: () => true,
      broadcast: (message) => broadcasts.push(message),
      createEngine: engine.createEngine,
    });
    createEmbeddedConversationRoutes({
      agent: agent as never,
      events: { emit: vi.fn(), on: vi.fn(() => () => {}) } as never,
      getAgent: () => agent as never,
      peekAgent: (id?: string) => (id === 'tab-1' ? (agent as never) : undefined),
      abortControllers,
      pendingConfirms: new Map(),
      eternal: driver,
      send: vi.fn(),
      broadcast: (message) => broadcasts.push(message as never),
      log: () => undefined,
    });

    expect(await driver.check('tab-1', 'eternal')).toBeUndefined();
    driver.setMode('tab-1', 'eternal');
    await vi.waitFor(() => expect(driver.activeSessionId()).toBeUndefined());

    expect(run).toHaveBeenCalledWith(
      'directive 0',
      expect.objectContaining({
        inputOrigin: 'runtime',
        autonomousContinue: true,
        maxIterations: 12,
      }),
    );
    expect(lockHeld).toEqual([true]);
    expect(abortControllers.size).toBe(0);
    expect(engine.seen.results).toEqual([done('iteration ok')]);
    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        type: 'run.result',
        payload: expect.objectContaining({ sessionId: 'tab-1', origin: 'eternal' }),
      }),
    );
  });
});
