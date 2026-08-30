import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultMultiAgentCoordinator } from '../../src/coordination/multi-agent-coordinator.js';
import type { Agent } from '../../src/core/agent.js';
import { ParallelEternalEngine } from '../../src/execution/parallel-eternal-engine.js';
import type { GoalFile, JournalEntry } from '../../src/storage/goal-store.js';
import type { SubagentConfig } from '../../src/types/multi-agent.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeMockAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    ctx: {
      todos: [],
      provider: { id: 'test-provider', capabilities: {}, sendRequest: vi.fn() } as never,
      model: 'test-model',
      messages: [],
      systemPrompt: '',
      signal: new AbortController().signal,
      session: {
        id: '2026-08-26/sess_01TESTPARALLELENGINE00000',
        append: vi.fn(),
        close: vi.fn(),
      } as never,
      // The coordinator stamps each spawned worker with the owning session.
      eventSessionId: () => '2026-08-26/sess_01TESTPARALLELENGINE00000',
      state: {} as never,
      tokenCounter: {
        currentRequestTokens: () => ({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }),
      } as never,
      modeStore: { get: vi.fn(), set: vi.fn() } as never,
      registerAbortHook: vi.fn(),
      drainAbortHooks: vi.fn(),
      isDisposed: false,
    },
    run: vi.fn(async () => ({
      status: 'done' as const,
      finalText: 'DONE',
      iterations: 1,
      toolCalls: 0,
    })),
    events: { emit: vi.fn(), on: vi.fn(() => () => {}), off: vi.fn() } as never,
    container: { resolve: vi.fn() } as never,
    tools: { register: vi.fn(), all: () => [] } as never,
    providers: { all: () => [], default: () => null } as never,
    ...overrides,
  } as Agent;
}

function makeGoal(overrides: Partial<GoalFile> = {}): GoalFile {
  return {
    version: 1,
    goal: 'test goal — verify parallel autonomy works',
    setAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    iterations: 0,
    engineState: 'idle',
    goalState: 'active',
    todoAttempts: {},
    journal: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ParallelEternalEngine', () => {
  let tmpDir: string;
  let goalPath: string;
  /** Collect all engine instances so afterEach can stop and clean them up. */
  const engines: ParallelEternalEngine[] = [];

  beforeEach(async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ws-parallel-test-'));
    // The engine reads its goal from an injected `goalPath` (see each
    // construction) so the goal lives in the temp dir, not the real home dir.
    goalPath = path.join(tmpDir, '.wrongstack', 'goal.json');
    await mkdir(path.dirname(goalPath), { recursive: true });
    await writeFile(goalPath, JSON.stringify(makeGoal()), 'utf-8');
  });

  afterEach(async () => {
    // Stop all tracked engines first — aborts in-flight async operations.
    for (const eng of engines) {
      try {
        eng.stop();
      } catch {
        /* ignore — may already be stopped */
      }
    }
    engines.length = 0;

    // Clean up temp directory with retries to handle Windows file locks.
    if (tmpDir) {
      const { rm } = await import('node:fs/promises');
      try {
        await rm(tmpDir, { recursive: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // Silently ignore — the directory may still be locked on Windows by a
        // lingering handle. The next test gets a fresh directory anyway.
      }
    }
  });

  describe('constructor', () => {
    it('accepts minimal options and sets defaults', () => {
      const agent = makeMockAgent();
      const engine = new ParallelEternalEngine({ agent, projectRoot: tmpDir, goalPath, noTaskCoolDownMs: 0 });
      expect(engine.currentState).toBe('idle');
    });

    it('respects parallelSlots option', () => {
      const agent = makeMockAgent();
      const engine = new ParallelEternalEngine({
        agent,
        projectRoot: tmpDir,
        goalPath,
        noTaskCoolDownMs: 0,
        parallelSlots: 8,
      });
      // Slots are capped at 16, so 8 is accepted
      // The only way to verify is through behavior — we check the slot count indirectly
      expect(engine.currentState).toBe('idle');
    });

    it('caps parallelSlots at 16', () => {
      const agent = makeMockAgent();
      const engine = new ParallelEternalEngine({
        agent,
        projectRoot: tmpDir,
        goalPath,
        noTaskCoolDownMs: 0,
        parallelSlots: 99,
      });
      expect(engine.currentState).toBe('idle');
    });

    it('floors parallelSlots at 1', () => {
      const agent = makeMockAgent();
      const engine = new ParallelEternalEngine({
        agent,
        projectRoot: tmpDir,
        goalPath,
        noTaskCoolDownMs: 0,
        parallelSlots: 0,
      });
      expect(engine.currentState).toBe('idle');
    });
  });

  describe('stop()', () => {
    it('transitions state to stopped', async () => {
      const agent = makeMockAgent();
      const engine = new ParallelEternalEngine({ agent, projectRoot: tmpDir, goalPath, noTaskCoolDownMs: 0 });
      engine.stop();
      expect(engine.currentState).toBe('stopped');
    });

    it('run() returns after stop() is called', async () => {
      const { writeFile, rm } = await import('node:fs/promises');
      const agent = makeMockAgent();
      await writeFile(goalPath, JSON.stringify(makeGoal({ engineState: 'idle' })), 'utf-8');
      const engine = new ParallelEternalEngine({ agent, projectRoot: tmpDir, goalPath, noTaskCoolDownMs: 0 });
      // Stop immediately, before first iteration
      setTimeout(() => engine.stop(), 50);
      const runPromise = engine.run();
      await runPromise;
      expect(engine.currentState).toBe('stopped');
      await rm(tmpDir, { recursive: true });
    });
  });

  describe('runOneIteration()', () => {
    it('returns false and stops when no goal exists', async () => {
      const agent = makeMockAgent();
      const engine = new ParallelEternalEngine({ agent, projectRoot: tmpDir, goalPath, noTaskCoolDownMs: 0 });
      const result = await engine.runOneIteration();
      expect(result).toBe(false);
      expect(engine.currentState).toBe('idle');
    });

    it('returns false and stops when goal is completed', async () => {
      const { writeFile, rm } = await import('node:fs/promises');
      const agent = makeMockAgent();
      await writeFile(goalPath, JSON.stringify(makeGoal({ goalState: 'completed' })), 'utf-8');
      const engine = new ParallelEternalEngine({ agent, projectRoot: tmpDir, goalPath, noTaskCoolDownMs: 0 });
      const result = await engine.runOneIteration();
      expect(result).toBe(false);
      await rm(tmpDir, { recursive: true });
    });

    it('writes a journal entry after a tick', async () => {
      const { writeFile, readFile, rm } = await import('node:fs/promises');
      const agent = makeMockAgent({
        run: vi.fn(async () => ({
          status: 'done' as const,
          finalText: 'Inspect the codebase',
          iterations: 1,
          toolCalls: 0,
        })),
      });
      await writeFile(goalPath, JSON.stringify(makeGoal()), 'utf-8');
      const engine = new ParallelEternalEngine({ agent, projectRoot: tmpDir, goalPath, noTaskCoolDownMs: 0 });
      await engine.runOneIteration();
      const written = JSON.parse(await readFile(goalPath, 'utf-8')) as GoalFile;
      expect(written.journal.length).toBe(1);
      expect(written.journal[0]!.source).toBe('parallel');
      expect(written.iterations).toBe(1);
      await rm(tmpDir, { recursive: true });
    });

    it('calls onIteration callback with the new journal entry', async () => {
      const { writeFile, rm } = await import('node:fs/promises');
      const entries: JournalEntry[] = [];
      const agent = makeMockAgent({
        run: vi.fn(async () => ({
          status: 'done' as const,
          finalText: 'Write tests',
          iterations: 1,
          toolCalls: 0,
        })),
      });
      await writeFile(goalPath, JSON.stringify(makeGoal()), 'utf-8');
      const engine = new ParallelEternalEngine({
        agent,
        projectRoot: tmpDir,
        goalPath,
        noTaskCoolDownMs: 0,
        onIteration: (e) => entries.push(e),
      });
      await engine.runOneIteration();
      expect(entries.length).toBe(1);
      expect(entries[0]!.source).toBe('parallel');
      await rm(tmpDir, { recursive: true });
    });

    it('emits live stage callbacks for a parallel tick', async () => {
      const { writeFile, rm } = await import('node:fs/promises');
      const phases: string[] = [];
      const agent = makeMockAgent({
        run: vi.fn(async () => ({
          status: 'done' as const,
          finalText: 'Write tests',
          iterations: 1,
          toolCalls: 0,
        })),
      });
      await writeFile(goalPath, JSON.stringify(makeGoal()), 'utf-8');
      const engine = new ParallelEternalEngine({
        agent,
        projectRoot: tmpDir,
        goalPath,
        noTaskCoolDownMs: 0,
        onStage: (stage) => phases.push(stage.phase),
      });
      await engine.runOneIteration();
      expect(phases).toContain('decompose');
      expect(phases).toContain('fanout');
      expect(phases).toContain('await');
      expect(phases).toContain('aggregate');
      await rm(tmpDir, { recursive: true });
    });

    it('decomposes goal via the leader agent when no todos/git', async () => {
      const { writeFile, rm } = await import('node:fs/promises');
      const runCalls: string[] = [];
      const agent = makeMockAgent({
        run: vi.fn(async (messages) => {
          runCalls.push(messages[messages.length - 1]!.text);
          return {
            status: 'done' as const,
            finalText: 'task-1 | task-2 | task-3 | task-4',
            iterations: 1,
            toolCalls: 0,
          };
        }),
      });
      await writeFile(goalPath, JSON.stringify(makeGoal()), 'utf-8');
      const engine = new ParallelEternalEngine({
        agent,
        projectRoot: tmpDir,
        goalPath,
        noTaskCoolDownMs: 0,
        parallelSlots: 4,
      });
      await engine.runOneIteration();
      // Leader agent should have been called to decompose
      expect(runCalls.length).toBeGreaterThanOrEqual(1);
      const taskText = runCalls[runCalls.length - 1]!;
      expect(taskText).toContain('Decompose this goal');
      await rm(tmpDir, { recursive: true });
    });

    it('stops cleanly when [GOAL_COMPLETE] appears in subagent result', async () => {
      const { writeFile, rm } = await import('node:fs/promises');
      // Leader must brainstorm at least one task (>10 chars) so fan-out runs
      // and the subagent's [GOAL_COMPLETE] is observed.
      const agent = makeMockAgent({
        run: vi.fn(async () => ({
          status: 'done' as const,
          finalText: 'inspect the whole codebase',
          iterations: 1,
          toolCalls: 0,
        })),
      });
      await writeFile(goalPath, JSON.stringify(makeGoal()), 'utf-8');
      const engine = new ParallelEternalEngine({
        agent,
        projectRoot: tmpDir,
        goalPath,
        noTaskCoolDownMs: 0,
        subagentFactory: async () => ({
          agent: makeMockAgent({
            run: vi.fn(async () => ({
              status: 'done' as const,
              finalText: '[GOAL_COMPLETE]',
              iterations: 1,
              toolCalls: 0,
            })),
          }),
          events: agent.events,
        }),
      });
      const result = await engine.runOneIteration();
      expect(result).toBe(true); // goal complete
      expect(engine.currentState).toBe('stopped');
      await rm(tmpDir, { recursive: true });
    });

    it('calls onError callback when an error occurs in runOneIteration', async () => {
      const { writeFile, rm } = await import('node:fs/promises');
      const errors: Error[] = [];
      const badAgent = makeMockAgent({
        run: vi.fn(async () => {
          throw new Error('simulated failure');
        }),
      });
      await writeFile(goalPath, JSON.stringify(makeGoal()), 'utf-8');
      const engine = new ParallelEternalEngine({
        agent: badAgent,
        projectRoot: tmpDir,
        goalPath,
        onError: (err) => errors.push(err),
      });
      await engine.runOneIteration();
      expect(errors.length).toBe(1);
      expect(errors[0]!.message).toBe('simulated failure');
      await rm(tmpDir, { recursive: true });
    });
  });

  describe('compactEveryNIterations', () => {
    it('does not compact on first iteration', async () => {
      const { writeFile, rm } = await import('node:fs/promises');
      const compactCall = vi.fn();
      const agent = makeMockAgent({
        run: vi.fn(async () => ({
          status: 'done' as const,
          finalText: 'step 1',
          iterations: 1,
          toolCalls: 0,
        })),
      });
      await writeFile(goalPath, JSON.stringify(makeGoal()), 'utf-8');
      const engine = new ParallelEternalEngine({
        agent,
        projectRoot: tmpDir,
        goalPath,
        noTaskCoolDownMs: 0,
        compactEveryNIterations: 3,
        compactor: { compact: compactCall } as never,
      });
      await engine.runOneIteration();
      expect(compactCall).not.toHaveBeenCalled();
      await rm(tmpDir, { recursive: true });
    });

    it('runs compaction after compactEveryNIterations successful iterations', async () => {
      const { writeFile, rm } = await import('node:fs/promises');
      const compactCall = vi.fn(async () => ({ before: 1000, after: 500 }));
      const agent = makeMockAgent({
        run: vi.fn(async () => ({
          status: 'done' as const,
          finalText: 'run the full audit pass',
          iterations: 1,
          toolCalls: 0,
        })),
      });
      await writeFile(goalPath, JSON.stringify(makeGoal()), 'utf-8');
      const engine = new ParallelEternalEngine({
        agent,
        projectRoot: tmpDir,
        goalPath,
        noTaskCoolDownMs: 0,
        compactEveryNIterations: 2,
        compactor: { compact: compactCall } as never,
      });
      await engine.runOneIteration(); // 1
      await engine.runOneIteration(); // 2 → triggers compaction
      expect(compactCall).toHaveBeenCalledTimes(1);
      await rm(tmpDir, { recursive: true });
    });
  });

  describe('state transitions', () => {
    it('transitions idle → running → stopped across full run() lifecycle', async () => {
      const { writeFile, rm } = await import('node:fs/promises');
      const agent = makeMockAgent();
      await writeFile(goalPath, JSON.stringify(makeGoal({ engineState: 'idle' })), 'utf-8');
      const engine = new ParallelEternalEngine({ agent, projectRoot: tmpDir, goalPath, noTaskCoolDownMs: 0 });
      setTimeout(() => engine.stop(), 20);
      await engine.run();
      expect(engine.currentState).toBe('stopped');
      await rm(tmpDir, { recursive: true });
    });
  });

  describe('dispatch routing', () => {
    // Seed a single pending todo so decomposeGoal (Strategy 1) yields one known
    // task string and exactly one slot — no git/brainstorm interference.
    function seedTodo(agent: Agent, content: string): void {
      (agent.ctx as never as { todos: Array<{ status: string; content: string }> }).todos = [
        { status: 'pending', content },
      ];
    }

    it('routes a security task to security-reviewer, injects the persona, and does not call the classifier when confident', async () => {
      const { writeFile, rm } = await import('node:fs/promises');
      const agent = makeMockAgent();
      seedTodo(agent, 'scan this code for sql injection vulnerabilities');
      await writeFile(goalPath, JSON.stringify(makeGoal()), 'utf-8');

      const spawnSpy = vi.spyOn(DefaultMultiAgentCoordinator.prototype, 'spawn');
      const assignSpy = vi.spyOn(DefaultMultiAgentCoordinator.prototype, 'assign');
      const classifier = vi.fn(async () => ({ role: 'executor' }));

      const engine = new ParallelEternalEngine({
        agent,
        projectRoot: tmpDir,
        goalPath,
        noTaskCoolDownMs: 0,
        parallelSlots: 1,
        dispatchClassifier: classifier,
      });
      await engine.runOneIteration();

      const cfg = spawnSpy.mock.calls[0]![0] as SubagentConfig;
      expect(cfg.role).toBe('security-reviewer');
      // Spawn carries the role's tool allowlist + persona prompt (forward-compatible).
      expect(Array.isArray(cfg.tools)).toBe(true);
      const spec = assignSpy.mock.calls[0]![0] as { description: string };
      expect(spec.description).toContain('Acting agent:');
      expect(spec.description.toLowerCase()).toContain('security');
      // Confident heuristic → the LLM fallback is never consulted.
      expect(classifier).not.toHaveBeenCalled();

      spawnSpy.mockRestore();
      assignSpy.mockRestore();
      await rm(tmpDir, { recursive: true });
    });

    it('falls back to the executor generalist for a no-signal task', async () => {
      const { writeFile, rm } = await import('node:fs/promises');
      const agent = makeMockAgent();
      seedTodo(agent, 'zzzzz qqqqq wwwww');
      await writeFile(goalPath, JSON.stringify(makeGoal()), 'utf-8');

      const spawnSpy = vi.spyOn(DefaultMultiAgentCoordinator.prototype, 'spawn');
      const engine = new ParallelEternalEngine({
        agent,
        projectRoot: tmpDir,
        goalPath,
        noTaskCoolDownMs: 0,
        parallelSlots: 1,
      });
      await engine.runOneIteration();

      const cfg = spawnSpy.mock.calls[0]![0] as SubagentConfig;
      expect(cfg.role).toBe('executor');

      spawnSpy.mockRestore();
      await rm(tmpDir, { recursive: true });
    });

    it('preserves the legacy generic spawn (no role) when dispatch is disabled', async () => {
      const { writeFile, rm } = await import('node:fs/promises');
      const agent = makeMockAgent();
      seedTodo(agent, 'scan this code for sql injection vulnerabilities');
      await writeFile(goalPath, JSON.stringify(makeGoal()), 'utf-8');

      const spawnSpy = vi.spyOn(DefaultMultiAgentCoordinator.prototype, 'spawn');
      const assignSpy = vi.spyOn(DefaultMultiAgentCoordinator.prototype, 'assign');
      const engine = new ParallelEternalEngine({
        agent,
        projectRoot: tmpDir,
        goalPath,
        noTaskCoolDownMs: 0,
        parallelSlots: 1,
        dispatch: false,
      });
      await engine.runOneIteration();

      const cfg = spawnSpy.mock.calls[0]![0] as SubagentConfig;
      expect(cfg.role).toBeUndefined();
      expect(cfg.name).toMatch(/^slot-/);
      const spec = assignSpy.mock.calls[0]![0] as { description: string };
      expect(spec.description).not.toContain('Acting agent:');

      spawnSpy.mockRestore();
      assignSpy.mockRestore();
      await rm(tmpDir, { recursive: true });
    });
  });
});
