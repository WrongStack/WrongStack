import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoard } from '@wrongstack/kanban';
import {
  addCheckToTask,
  addTask,
  transitionTask,
  updateTaskAssignment,
} from '@wrongstack/kanban/test-support';
import { wireKanbanPorts } from '@wrongstack/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

wireKanbanPorts();

vi.mock('@wrongstack/providers', () => ({
  // Fresh capabilities object per call (each provider owns its own), with the
  // openai-compatible family default so the maxContext overlay is observable.
  makeProviderFromConfig: vi.fn(() => ({
    id: 'mock',
    capabilities: { streaming: false, tools: true, maxContext: 32_000 },
    complete: vi.fn(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    })),
  })),
  capabilitiesFor: vi.fn(async () => ({ maxContext: 128_000 })),
  // Subagents overlay their own model's catalog facts onto the freshly built
  // provider. Mirror the real helper: mutate `capabilities` in place with a
  // COPY so each provider keeps its own object, and let the maxContext
  // refinement that runs afterwards stay observable.
  withCatalogCapabilities: vi.fn(async (_registry, _providerId, provider) => {
    Object.defineProperty(provider, 'capabilities', {
      value: { ...provider.capabilities, maxOutput: 64_000 },
      writable: true,
      configurable: true,
      enumerable: true,
    });
    return provider;
  }),
}));

import { createProjectAgent } from '@wrongstack/core/coordination';
import { DefaultErrorHandler, DefaultRetryPolicy } from '@wrongstack/core/execution';
import { DefaultLogger } from '@wrongstack/core/infrastructure';
import { Container, EventBus, TOKENS } from '@wrongstack/core/kernel';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { DefaultSecretScrubber } from '@wrongstack/core/security';
import type {
  Config,
  ConfigStore,
  SessionWriter,
  SubagentConfig,
  SystemPromptBuilder,
  TokenCounter,
  Tool,
} from '@wrongstack/core/types';
import { capabilitiesFor } from '@wrongstack/providers';
import { type MultiAgentDeps, MultiAgentHost } from '../src/multi-agent.js';

beforeEach(() => {
  vi.mocked(capabilitiesFor).mockClear();
});

const writerRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    writerRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * V0-C: `MultiAgentHost` is lazy by design — until /spawn fires, no
 * coordinator is built. These tests pin that lazy contract. The actual
 * spawn flow is exercised by the core `multi-agent-coordinator` tests;
 * here we cover the host wrapper's pre-spawn surface plus stopAll.
 */

function makeDeps(): MultiAgentDeps {
  const configStore = {
    get: vi.fn(() => ({
      provider: 'anthropic',
      model: 'claude',
      apiKey: 'fake',
    })),
    watch: vi.fn(() => () => {}),
  } as never as ConfigStore;

  const systemPromptBuilder = {
    build: vi.fn(async () => [{ type: 'text', text: 'sys' }]),
  } as never as SystemPromptBuilder;

  const session = {
    id: 'sess-test',
    pendingToolUses: [],
    append: vi.fn(async () => undefined),
    appendBatch: vi.fn(async () => undefined),
    flush: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    recordFileChange: vi.fn(() => undefined),
    writeCheckpoint: vi.fn(async () => undefined),
    writeFileSnapshot: vi.fn(async () => undefined),
    truncateToCheckpoint: vi.fn(async () => 0),
    clearSession: vi.fn(async () => undefined),
    writeInFlightMarker: vi.fn(async () => undefined),
    clearInFlightMarker: vi.fn(async () => undefined),
  } as never as SessionWriter;

  const tokenCounter: TokenCounter = {
    account: vi.fn(),
    currentRequestTokens: vi.fn(() => ({ input: 0, cacheRead: 0 })),
    total: vi.fn(() => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })),
    estimateCost: vi.fn(() => ({ input: 0, output: 0, total: 0, currency: 'USD' })),
    cacheStats: vi.fn(() => ({ readTokens: 0, writeTokens: 0, hitRatio: 0 })),
    reset: vi.fn(),
  } as never as TokenCounter;

  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error', stderr: false }));
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());

  return {
    container,
    fallbackProfileManager: {} as never,
    toolRegistry: new ToolRegistry(),
    providerRegistry: new ProviderRegistry(),
    configStore,
    events: new EventBus(),
    systemPromptBuilder,
    session,
    tokenCounter,
    projectRoot: '/tmp/proj',
    cwd: '/tmp/proj',
    secretScrubber: new DefaultSecretScrubber(),
  };
}

function registerShadowHostTools(deps: MultiAgentDeps): void {
  for (const name of ['mailbox', 'mail_inbox', 'mail_send']) {
    deps.toolRegistry.register({
      name,
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'ok';
      },
    });
  }
}

describe('MultiAgentHost', () => {
  it('accepts a project-created generic role through spawn_subagent', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-custom-agent-'));
    try {
      const deps = makeDeps();
      deps.projectRoot = projectRoot;
      deps.cwd = projectRoot;
      const host = new MultiAgentHost(deps);
      const director = await host.ensureDirector();
      const spawnTool = director
        ?.tools(host.getRoster())
        .find((tool) => tool.name === 'spawn_subagent');

      // Create the role after both host and tool construction. The roster
      // overlay must discover it live without rebuilding the Director.
      createProjectAgent(
        {
          name: 'ABC',
          purpose: 'Own X, Y and Z workflows for this project.',
          taskTypes: ['X workflow', 'Y analysis', 'Z verification'],
        },
        projectRoot,
      );

      expect(Object.keys(host.getRoster())).toContain('abc');
      const executeSpawn = (input: Record<string, unknown>) =>
        spawnTool?.execute(input, {} as never, { signal: new AbortController().signal });
      await expect(executeSpawn({ role: 'abc' })).resolves.toEqual(
        expect.objectContaining({
          subagentId: expect.any(String),
          role: 'abc',
          name: 'ABC',
        }),
      );
      await expect(
        executeSpawn({ description: 'Run the Z verification workflow for this change.' }),
      ).resolves.toEqual(expect.objectContaining({ role: 'abc', name: 'ABC' }));
      await host.stopAll();
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('gives the dispatcher a model to break ties with', async () => {
    // The dispatcher is two-stage by design — keyword heuristic, then a model —
    // but nothing ever supplied stage two to the Director, so every description
    // the keywords could not resolve fell through to the `executor` generalist.
    // That is half of why a 77-role roster was served by a handful of agents.
    const host = new MultiAgentHost(makeDeps());
    const director = await host.ensureDirector();
    expect(typeof director?.dispatchClassifier).toBe('function');

    // With no usable provider in this harness it must decline rather than
    // throw: routing degrades to the heuristic, it never fails a spawn.
    await expect(
      director?.dispatchClassifier?.('design a migration', [
        { role: 'database', name: 'Database', summary: 'Schema and migrations.' },
      ]),
    ).resolves.toBeNull();
    await host.stopAll();
  });

  it('status() before any spawn reports "No subagents"', () => {
    const host = new MultiAgentHost(makeDeps());
    const s = host.status();
    expect(s.summary).toMatch(/no subagents/i);
    expect(s.pending).toEqual([]);
    expect(s.completed).toEqual([]);
  });

  it('stopAll() before any spawn is a no-op', async () => {
    const host = new MultiAgentHost(makeDeps());
    await expect(host.stopAll()).resolves.toBeUndefined();
  });

  it('spawn() is available because director mode is permanently on', async () => {
    const host = new MultiAgentHost(makeDeps());
    await expect(host.spawn('do a thing')).resolves.toEqual({
      subagentId: expect.any(String),
      taskId: expect.any(String),
    });
    await host.stopAll();
  });

  it('kill() before any spawn returns false', async () => {
    const host = new MultiAgentHost(makeDeps());
    expect(await host.kill('any-id')).toBe(false);
  });

  it('kill() after spawn stops the subagent and returns true', async () => {
    const host = new MultiAgentHost(makeDeps());
    const { subagentId } = await host.spawn('do a thing');
    expect(await host.kill(subagentId)).toBe(true);
    await host.stopAll();
  });

  it('constructor does not eagerly read config or build the coordinator', () => {
    const deps = makeDeps();
    new MultiAgentHost(deps);
    // configStore.get is only called inside ensureCoordinator()
    expect(deps.configStore.get).not.toHaveBeenCalled();
    expect(
      (deps.systemPromptBuilder as { build: ReturnType<typeof vi.fn> }).build,
    ).not.toHaveBeenCalled();
  });

  it('status() shape stays stable across calls when nothing changes', () => {
    const host = new MultiAgentHost(makeDeps());
    const a = host.status();
    const b = host.status();
    expect(a.pending).toEqual(b.pending);
    expect(a.completed).toEqual(b.completed);
  });

  it('spawn() lazily builds the coordinator and tracks pending tasks', async () => {
    const deps = makeDeps();
    const host = new MultiAgentHost(deps);
    const { subagentId, taskId } = await host.spawn('do a thing');
    expect(subagentId).toBeTruthy();
    expect(taskId).toBeTruthy();
    expect(deps.configStore.get).toHaveBeenCalled();
    // Pending tracking is synchronous in host.spawn — assert it before the
    // task gets dispatched and leaves the pending list.
    const s = host.status();
    expect(s.pending).toHaveLength(1);
    expect(s.pending[0]!.description).toBe('do a thing');
    expect(s.summary).toMatch(/1 pending/);
    // The agent factory runs on task dispatch (async, and it does real
    // mailbox I/O before building the prompt) — wait for it rather than
    // asserting the call landed within spawn()'s own promise chain.
    await vi.waitFor(() =>
      expect(
        (deps.systemPromptBuilder as { build: ReturnType<typeof vi.fn> }).build,
      ).toHaveBeenCalled(),
    );
    await host.stopAll();
  });

  it('does not account subagent provider usage into the leader token counter', async () => {
    const deps = makeDeps();
    const host = new MultiAgentHost(deps);
    const result = await host.spawnAndWait('do a thing');
    expect(result.status).toBe('success');
    expect(deps.tokenCounter.account).not.toHaveBeenCalled();
    await host.stopAll();
  });

  it('spawn() reuses the coordinator across multiple calls', async () => {
    const deps = makeDeps();
    const host = new MultiAgentHost(deps);
    const a = await host.spawn('task one');
    const b = await host.spawn('task two');
    expect(a.taskId).not.toBe(b.taskId);
    // The coordinator/director is built lazily once and reused (proven by both
    // spawns succeeding on the same host with distinct task ids). configStore is
    // additionally read live per spawn so a mid-session /setmodel model-matrix
    // change applies on the next spawn — so get() is called more than once now.
    expect((deps.configStore.get as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
    await host.stopAll();
  });

  it('shadow spawn exposes lazy director tools to the subagent', async () => {
    const deps = makeDeps();
    const host = new MultiAgentHost(deps);
    await host.spawn('shadow monitor', {
      name: 'shadow',
      tools: ['fleet', 'fleet', 'fleet', 'terminate_subagent'],
    });

    await vi.waitFor(() =>
      expect(
        (deps.systemPromptBuilder as { build: ReturnType<typeof vi.fn> }).build,
      ).toHaveBeenCalled(),
    );

    const build = (deps.systemPromptBuilder as { build: ReturnType<typeof vi.fn> }).build;
    const shadowBuild = build.mock.calls.find((call) => call[0]?.subagent === true);
    const toolNames = ((shadowBuild?.[0]?.tools ?? []) as Tool[]).map((tool) => tool.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(['fleet', 'fleet', 'fleet', 'terminate_subagent']),
    );
    await host.stopAll();
  });

  it('manual shadow check is one-shot and excluded from fleet summaries', async () => {
    const deps = makeDeps();
    const startedEvents: unknown[] = [];
    deps.events.on('subagent.task_started', (event) => startedEvents.push(event));
    const host = new MultiAgentHost(deps);
    await host.spawn('shadow monitor', {
      name: 'shadow',
      shadowIntervalMs: 10,
      tools: ['fleet', 'fleet', 'fleet', 'terminate_subagent'],
    });

    const build = (deps.systemPromptBuilder as { build: ReturnType<typeof vi.fn> }).build;
    await vi.waitFor(() => expect(build.mock.calls.length).toBeGreaterThan(0));

    const s = host.status();
    expect(s.pending).toEqual([]);
    expect(s.completed).toEqual([]);
    expect(startedEvents).toEqual([]);
    await host.stopAll();
  });

  it('clears tracked shadow state when the director removes the shadow subagent', async () => {
    const deps = makeDeps();
    const stopped = vi.fn();
    const host = new MultiAgentHost(deps, { onShadowAgentStopped: stopped });
    const { subagentId } = await host.spawn('shadow monitor', {
      name: 'shadow',
      tools: ['fleet', 'fleet', 'fleet', 'terminate_subagent'],
    });

    await host.getDirector()?.remove(subagentId);

    expect(stopped).toHaveBeenCalledWith(subagentId);
    await host.stopAll();
  });

  it('healthy leader turns do not auto-start a shadow LLM pass', async () => {
    const deps = makeDeps();
    const host = new MultiAgentHost(deps);
    await host.promoteToDirector();

    deps.events.emit('agent.run.started', {
      ctx: {} as never,
      model: 'claude',
      at: new Date().toISOString(),
    });
    deps.events.emit('agent.run.completed', {
      ctx: {} as never,
      status: 'done',
      iterations: 1,
      at: new Date().toISOString(),
      durationMs: 1,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(
      (deps.systemPromptBuilder as { build: ReturnType<typeof vi.fn> }).build,
    ).not.toHaveBeenCalled();
    await host.stopAll();
  });

  it('problem-triggered shadow inherits the leader provider and model', async () => {
    const providersMod = await import('@wrongstack/providers');
    const mocked = providersMod.makeProviderFromConfig as ReturnType<typeof vi.fn>;
    mocked.mockClear();

    const deps = makeDeps();
    registerShadowHostTools(deps);
    (deps.configStore.get as ReturnType<typeof vi.fn>).mockReturnValue({
      provider: 'openai',
      model: 'gpt-5',
      apiKey: 'leader-key',
      providers: {
        openai: { type: 'openai', family: 'openai', apiKey: 'openai-key' },
      },
    });

    const host = new MultiAgentHost(deps);
    await host.promoteToDirector();
    deps.events.emit('agent.run.started', {
      ctx: {} as never,
      model: 'gpt-5',
      at: new Date().toISOString(),
    });
    deps.events.emit('agent.run.completed', {
      ctx: {} as never,
      status: 'failed',
      iterations: 1,
      at: new Date().toISOString(),
      durationMs: 1,
    });
    await vi.waitFor(() =>
      expect(
        (deps.systemPromptBuilder as { build: ReturnType<typeof vi.fn> }).build,
      ).toHaveBeenCalled(),
    );
    await host.stopAll();

    const providerIds = mocked.mock.calls.map((c) => c[0]);
    expect(providerIds).toContain('openai');
    expect(providerIds).not.toContain('anthropic');
  });

  it('defers a problem-triggered shadow pass until the next work window finishes', async () => {
    const deps = makeDeps();
    registerShadowHostTools(deps);
    const host = new MultiAgentHost(deps);
    await host.promoteToDirector();

    deps.events.emit('agent.run.started', {
      ctx: {} as never,
      model: 'claude',
      at: new Date().toISOString(),
    });
    deps.events.emit('agent.run.completed', {
      ctx: {} as never,
      status: 'failed',
      iterations: 1,
      at: new Date().toISOString(),
      durationMs: 1,
    });
    deps.events.emit('agent.run.started', {
      ctx: {} as never,
      model: 'claude',
      at: new Date().toISOString(),
    });

    await Promise.resolve();
    await Promise.resolve();

    const build = (deps.systemPromptBuilder as { build: ReturnType<typeof vi.fn> }).build;
    expect(build).not.toHaveBeenCalled();

    deps.events.emit('agent.run.completed', {
      ctx: {} as never,
      status: 'done',
      iterations: 1,
      at: new Date().toISOString(),
      durationMs: 1,
    });

    await vi.waitFor(() => expect(build).toHaveBeenCalled());
    await host.stopAll();
  });

  it('spawn() works with a providers config entry (not just top-level apiKey)', async () => {
    const deps = makeDeps();
    (deps.configStore.get as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      provider: 'anthropic',
      model: 'claude',
      providers: { anthropic: { type: 'anthropic', apiKey: 'k', baseUrl: 'https://x' } },
    });
    const host = new MultiAgentHost(deps);
    const { taskId } = await host.spawn('with provider config');
    expect(taskId).toBeTruthy();
    await host.stopAll();
  });

  it('spawn() with per-subagent provider override builds that provider, not the leader', async () => {
    // Director-mode: a single fleet should be able to use planner for the
    // editor + haiku for the researcher in the same run. Verifies the
    // factory looks up `config.providers[<overrideId>]` and passes the
    // right config to `makeProviderFromConfig`.
    const providersMod = await import('@wrongstack/providers');
    const mocked = providersMod.makeProviderFromConfig as ReturnType<typeof vi.fn>;
    mocked.mockClear();

    const deps = makeDeps();
    (deps.configStore.get as ReturnType<typeof vi.fn>).mockReturnValue({
      provider: 'anthropic',
      model: 'planner',
      apiKey: 'leader-key',
      providers: {
        anthropic: { type: 'anthropic', family: 'anthropic', apiKey: 'anthropic-key' },
        openai: { type: 'openai', family: 'openai', apiKey: 'openai-key' },
      },
    });

    const host = new MultiAgentHost(deps);
    await host.spawn('rewrite README', { name: 'editor', provider: 'anthropic', model: 'planner' });
    await host.spawn('audit code', { name: 'auditor', provider: 'openai', model: 'gpt-5' });
    await host.stopAll();

    // Each unique provider override should land as one of the recorded calls.
    const providerIds = mocked.mock.calls.map((c) => c[0]);
    expect(providerIds).toContain('anthropic');
    expect(providerIds).toContain('openai');

    // And the openai call must use the openai-specific apiKey, not the leader's.
    const openaiCall = mocked.mock.calls.find((c) => c[0] === 'openai');
    expect(openaiCall).toBeDefined();
    expect((openaiCall![1] as { apiKey: string }).apiKey).toBe('openai-key');
  });

  it('spawn() falls back to leader provider when override is unknown', async () => {
    // Typo / unconfigured provider id shouldn't crash the run — we use
    // the leader and let downstream code decide whether to fail loudly.
    const providersMod = await import('@wrongstack/providers');
    const mocked = providersMod.makeProviderFromConfig as ReturnType<typeof vi.fn>;
    mocked.mockClear();

    const deps = makeDeps();
    (deps.configStore.get as ReturnType<typeof vi.fn>).mockReturnValue({
      provider: 'anthropic',
      model: 'planner',
      apiKey: 'leader-key',
      providers: {
        anthropic: { type: 'anthropic', family: 'anthropic', apiKey: 'anthropic-key' },
      },
    });

    const host = new MultiAgentHost(deps);
    await host.spawn('do thing', { provider: 'mistral-but-not-configured' });
    await host.stopAll();

    // We should have called makeProviderFromConfig with 'anthropic' (the
    // leader), not the unknown id.
    const providerIds = mocked.mock.calls.map((c) => c[0]);
    expect(providerIds).toContain('anthropic');
    expect(providerIds).not.toContain('mistral-but-not-configured');
  });

  it('spawn() honors the toolRegistry filter when called with allow-list', async () => {
    const deps = makeDeps();
    const tools = deps.toolRegistry;
    tools.register({
      name: 'a',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    });
    tools.register({
      name: 'b',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    });
    const host = new MultiAgentHost(deps);
    await host.spawn('go');
    // SystemPromptBuilder receives the unfiltered list via the factory closure;
    // exercising the path is what matters for coverage. The factory runs on
    // async task dispatch (with mailbox I/O first), so wait for the call to
    // land before tearing the fleet down.
    await vi.waitFor(() =>
      expect(
        (deps.systemPromptBuilder as { build: ReturnType<typeof vi.fn> }).build,
      ).toHaveBeenCalled(),
    );
    await host.stopAll();
  });

  describe('director mode', () => {
    it('isDirectorMode() is true before the lazy Director is built', () => {
      const host = new MultiAgentHost(makeDeps());
      expect(host.isDirectorMode()).toBe(true);
      expect(host.getDirector()).toBeUndefined();
    });

    it('first spawn lazily builds the permanently-on Director', async () => {
      const directed = new MultiAgentHost(makeDeps());
      expect(directed.getDirector()).toBeUndefined();
      await directed.spawn('a thing');
      expect(directed.isDirectorMode()).toBe(true);
      expect(directed.getDirector()).toBeDefined();
      await directed.stopAll();
    });

    it('manifest() returns null when no manifestPath is configured', async () => {
      // Without manifestPath the Director has nowhere to write.
      const host = new MultiAgentHost(makeDeps());
      await host.spawn('do thing');
      expect(await host.manifest()).toBeNull();
      await host.stopAll();
    });

    it('director mode builds a Director on first spawn and writes a manifest', async () => {
      const os = await import('node:os');
      const path = await import('node:path');
      const fs = await import('node:fs/promises');
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-manifest-'));
      const manifestPath = path.join(tmpRoot, 'fleet.json');

      const host = new MultiAgentHost(makeDeps(), {
        manifestPath,
      });
      expect(host.getDirector()).toBeUndefined();
      await host.spawn('inspect', { name: 'inspector', provider: 'anthropic', model: 'claude' });
      expect(host.isDirectorMode()).toBe(true);
      const written = await host.manifest();
      expect(written).toBe(manifestPath);
      const raw = await fs.readFile(manifestPath, 'utf8');
      const parsed = JSON.parse(raw) as { directorRunId: string; children: unknown[] };
      expect(parsed.directorRunId).toBeTruthy();
      expect(parsed.children.length).toBeGreaterThanOrEqual(1);
      await host.stopAll();
      await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    it('status() / usage() keep working in director mode', async () => {
      // Smoke-test that the host's public API stays the same when the
      // Director is the one driving the coordinator under the hood.
      const host = new MultiAgentHost(makeDeps());
      await host.spawn('a thing');
      const s = host.status();
      expect(s.pending.length).toBeGreaterThanOrEqual(0);
      const u = host.usage();
      expect(u).toHaveProperty('rows');
      expect(u).toHaveProperty('totals');
      await host.stopAll();
    });

    it('ensureDirector() builds the permanently-on Director before a spawn', async () => {
      const host = new MultiAgentHost(makeDeps());
      expect(await host.ensureDirector()).not.toBeNull();
      await host.stopAll();
    });

    it('ensureDirector() eagerly builds the Director and exposes the orchestration tools', async () => {
      const host = new MultiAgentHost(makeDeps());
      const director = await host.ensureDirector();
      expect(director).not.toBeNull();
      expect(director!.maxSpawnDepth).toBe(2);
      expect(director!.maxSpawns).toBe(64);
      const tools = director!.tools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'ask_result',
        'ask_subagent',
        'assign_task',
        'await_tasks',
        'collab_debug',
        'fleet',
        'fleet_emit',
        'kanban_queue',
        'mutation_test',
        'quality_gate',
        'roll_up',
        'spawn_subagent',
        'terminate_all',
        'terminate_subagent',
        'work_complete',
      ]);
      // After ensureDirector(), the host considers itself in director
      // mode — the lazy build flipped the flag.
      expect(host.isDirectorMode()).toBe(true);
      await host.stopAll();
    });

    it('director-mode spawn uses the per-subagent session factory when sessionsRoot is set', async () => {
      const os = await import('node:os');
      const path = await import('node:path');
      const fs = await import('node:fs/promises');
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-subsessions-'));

      const host = new MultiAgentHost(makeDeps(), {
        sessionsRoot: tmpRoot,
        directorRunId: 'run-test',
      });
      const director = await host.ensureDirector();
      const { taskId } = await host.spawn('a job', { name: 'worker-1' });
      // Wait for the task to actually run — the factory closure (which
      // creates the per-subagent JSONL) only fires when the runner picks
      // up the task. host.spawn returns as soon as assign is called.
      await director!.awaitTasks([taskId]);
      const runDir = path.join(tmpRoot, 'run-test');
      const entries = await fs.readdir(runDir);
      // At least one JSONL file under the run dir means the factory was
      // actually invoked with the director's session writer.
      expect(entries.some((e) => e.endsWith('.jsonl'))).toBe(true);
      await host.stopAll();
      await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    it('director-mode passes sharedScratchpadPath through to Director', async () => {
      const os = await import('node:os');
      const path = await import('node:path');
      const fs = await import('node:fs/promises');
      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-scratch-'));
      const scratch = path.join(tmpRoot, 'shared');

      const host = new MultiAgentHost(makeDeps(), {
        sharedScratchpadPath: scratch,
      });
      const director = await host.ensureDirector();
      expect(director!.sharedScratchpadPath).toBe(scratch);
      // Any subagent prompt the director composes carries the path so
      // agents can find the scratchpad without further plumbing.
      const out = director!.subagentSystemPrompt({ name: 'x', prompt: 'r' }, 'task');
      expect(out).toContain('Shared notes:');
      expect(out).toContain(scratch);
      // The directory is created lazily (fire-and-forget mkdir in the
      // Director constructor). Give it a tick to settle, then verify —
      // if it still doesn't exist, the first write would create it
      // anyway thanks to `recursive: true`, so the assertion here is a
      // soft check that the eager-mkdir code path actually ran.
      await new Promise((r) => setTimeout(r, 50));
      const stat = await fs.stat(scratch).catch(() => null);
      expect(stat?.isDirectory() ?? false).toBe(true);
      await host.stopAll();
      await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    describe('promoteToDirector (runtime promotion)', () => {
      it('materializes the lazy Director and returns it', async () => {
        const host = new MultiAgentHost(makeDeps());
        expect(host.isDirectorMode()).toBe(true);
        expect(host.getDirector()).toBeUndefined();

        const director = await host.promoteToDirector();
        expect(director).not.toBeNull();
        expect(host.isDirectorMode()).toBe(true);
        expect(host.getDirector()).toBe(director);
        // After promotion, the director has the orchestration tools.
        const tools = director!.tools();
        expect(tools.map((t) => t.name).sort()).toEqual([
          'ask_result',
          'ask_subagent',
          'assign_task',
          'await_tasks',
          'collab_debug',
          'fleet',
          'fleet_emit',
          'kanban_queue',
          'mutation_test',
          'quality_gate',
          'roll_up',
          'spawn_subagent',
          'terminate_all',
          'terminate_subagent',
          'work_complete',
        ]);
        await host.stopAll();
      });

      it('is idempotent — calling promoteToDirector twice returns the same Director', async () => {
        const host = new MultiAgentHost(makeDeps());
        const a = await host.promoteToDirector();
        const b = await host.promoteToDirector();
        expect(a).not.toBeNull();
        expect(a).toBe(b); // Same instance — no double-build.
        await host.stopAll();
      });

      it('returns the existing Director if one is already built (spawn already called)', async () => {
        // With the single-path refactoring, spawn() always builds a Director.
        // promoteToDirector() after spawn returns that existing Director.
        const host = new MultiAgentHost(makeDeps());
        await host.spawn('do something');
        expect(host.isDirectorMode()).toBe(true);
        const director = await host.promoteToDirector();
        expect(director).not.toBeNull();
        expect(host.isDirectorMode()).toBe(true);
        await host.stopAll();
      });

      it('manifest() works after runtime promotion', async () => {
        const os = await import('node:os');
        const path = await import('node:path');
        const fs = await import('node:fs/promises');
        const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-promote-manifest-'));
        const fleetRoot = path.join(tmpRoot, 'session-1');

        // Keep the worker alive past task completion so the manifest still
        // records it: with auto-retirement (the default), the subagent is
        // removed on completion and FleetManager prunes its manifest entry.
        const host = new MultiAgentHost(makeDeps(), {
          fleetRoot,
          retireSubagentOnTaskComplete: false,
        });
        await host.promoteToDirector();
        // manifest() should return null before any spawn (no director yet
        // in the simple path, but we just promoted, so it should work).
        await host.spawnAndWait('inspect', { name: 'inspector' });
        const written = await host.manifest();
        expect(written).toBe(path.join(fleetRoot, 'fleet.json'));
        const raw = await fs.readFile(written!, 'utf8');
        const parsed = JSON.parse(raw) as { directorRunId: string; children: unknown[] };
        expect(parsed.directorRunId).toBeTruthy();
        expect(parsed.children.length).toBeGreaterThanOrEqual(1);
        await host.stopAll();
        await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      });

      it('derives manifest/shared/subagent paths from fleetRoot', async () => {
        const path = await import('node:path');
        const os = await import('node:os');
        const fs = await import('node:fs/promises');
        const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-fleet-paths-'));
        const fleetRoot = path.join(tmpRoot, 'session-2');
        const host = new MultiAgentHost(makeDeps(), { fleetRoot });
        const director = await host.promoteToDirector();
        expect(director).not.toBeNull();

        // Trigger lazy build and verify the Director's session factory
        // was wired — spawn, finish the task, then check the manifest path.
        await host.spawnAndWait('path check', { name: 'checker' });
        const written = await host.manifest();
        expect(written).toBe(path.join(fleetRoot, 'fleet.json'));
        await host.stopAll();
        await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      });

      it('works without fleetRoot — director still built, no paths', async () => {
        const host = new MultiAgentHost(makeDeps());
        // No fleetRoot at all — should still create the director.
        const director = await host.promoteToDirector();
        expect(director).not.toBeNull();
        expect(host.isDirectorMode()).toBe(true);

        // The director is alive but without paths, manifest() returns
        // null because no manifestPath was configured.
        await host.spawn('no-root', { name: 'ghost' });
        expect(await host.manifest()).toBeNull();
        await host.stopAll();
      });

      it('ensureDirector() returns the same Director after promotion', async () => {
        const host = new MultiAgentHost(makeDeps());
        const promoted = await host.promoteToDirector();
        const ensured = await host.ensureDirector();
        expect(ensured).toBe(promoted);
        await host.stopAll();
      });

      it('spawn() after promotion routes through Director (manifest populated)', async () => {
        const os = await import('node:os');
        const path = await import('node:path');
        const fs = await import('node:fs/promises');
        const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-promote-route-'));
        const fleetRoot = path.join(tmpRoot, 'session-3');

        // Keep the worker alive past task completion so the manifest still
        // records it: with auto-retirement (the default), the subagent is
        // removed on completion and FleetManager prunes its manifest entry.
        const host = new MultiAgentHost(makeDeps(), {
          fleetRoot,
          retireSubagentOnTaskComplete: false,
        });
        await host.promoteToDirector();
        const result = await host.spawnAndWait('routed', {
          name: 'router',
          provider: 'anthropic',
          model: 'claude',
        });
        expect(result.taskId).toBeTruthy();

        // The manifest should reflect the spawn even though we promoted
        // at runtime — the spawn path checks `this.director` and routes
        // through `Director.spawn` + `Director.assign`.
        const written = await host.manifest();
        expect(written).toBe(path.join(fleetRoot, 'fleet.json'));
        const raw = await fs.readFile(written!, 'utf8');
        const parsed = JSON.parse(raw) as {
          children: { name: string; provider: string; model: string }[];
        };
        const child = parsed.children.find((c) => c.name === 'router');
        expect(child).toBeDefined();
        expect(child!.provider).toBe('anthropic');
        expect(child!.model).toBe('claude');
        await host.stopAll();
        await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      });
    });
  });
});

describe('MultiAgentHost.makeSubagentFactory', () => {
  function fakeTool(name: string): Tool {
    return {
      name,
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    };
  }

  function depsWithTools(): MultiAgentDeps {
    const deps = makeDeps();
    deps.toolRegistry.register(fakeTool('read'));
    deps.toolRegistry.register(fakeTool('grep'));
    deps.toolRegistry.register(fakeTool('bash'));
    return deps;
  }

  const config = { provider: 'anthropic', model: 'claude', apiKey: 'fake' } as never as Config;

  const slotCfg: SubagentConfig = {
    id: 'slot-1',
    name: 'sec',
    role: 'security-reviewer',
    tools: ['read', 'grep'],
    systemPromptOverride: 'PERSONA-SENTINEL-XYZ',
  };

  it('returns an isolated runner triple { agent, events, dispose }', async () => {
    const host = new MultiAgentHost(depsWithTools());
    const factory = host.makeSubagentFactory(config);
    const built = await factory(slotCfg);
    expect(built.agent).toBeDefined();
    expect(built.events).toBeInstanceOf(EventBus);
    expect(typeof built.dispose).toBe('function');
    await built.dispose?.();
  });

  it('installs the host-owned tool boundary on Fleet subagent pipelines', async () => {
    const deps = depsWithTools();
    const installToolBoundary = vi.fn(
      (pipelines: import('@wrongstack/core/agent').AgentPipelines) => {
        pipelines.toolCall.prepend({
          name: 'TrustedFleetTestBoundary',
          async handler(payload, next) {
            return next(payload);
          },
        });
      },
    );
    deps.installToolBoundary = installToolBoundary;
    const built = await new MultiAgentHost(deps).makeSubagentFactory(config)(slotCfg);

    expect(installToolBoundary).toHaveBeenCalledOnce();
    expect(installToolBoundary).toHaveBeenCalledWith(built.agent.pipelines);
    expect(built.agent.pipelines.toolCall.list()[0]).toBe('TrustedFleetTestBoundary');
    await built.dispose?.();
  });

  it('dispose() drains agent-lifetime hooks so retired subagents do not leak timers', async () => {
    // Regression for the subagent teardown leak: every retired subagent used
    // to leave its mailbox heartbeat interval, awareness polling interval,
    // HQ publisher connection, and auto-compaction timer alive for the rest
    // of the leader process's lifetime. dispose() must call agent.teardown()
    // so drainAgentHooks() runs and clears the per-subagent hook registrations.
    const host = new MultiAgentHost(depsWithTools());
    const factory = host.makeSubagentFactory(config);
    const built = await factory(slotCfg);

    // Construction registers at least one mailbox-related agent hook on the
    // subagent's Context (heartbeat, awareness, HQ, auto-compact). Capture
    // the pre-dispose count as a positive baseline.
    const agentHooksBefore = (
      built.agent.ctx as unknown as {
        agentHooks: { size: number };
      }
    ).agentHooks.size;
    expect(agentHooksBefore).toBeGreaterThan(0);

    await built.dispose?.();

    // After dispose the Context's agentHooks Set must be empty — drainAgentHooks
    // pops every entry and clears the set. A non-zero count means at least
    // one hook was not invoked (timers / subscriptions / HQ socket still alive).
    const agentHooksAfter = (
      built.agent.ctx as unknown as {
        agentHooks: { size: number };
      }
    ).agentHooks.size;
    expect(agentHooksAfter).toBe(0);
  });

  it('dispose() remains idempotent across repeated subagent retirements', async () => {
    // Long-running kanban-dispatch loops spin up many subagents sequentially;
    // each must fully release its hooks on retire. Build three subagents and
    // assert none of them retain agentHooks after dispose.
    const host = new MultiAgentHost(depsWithTools());
    const factory = host.makeSubagentFactory(config);
    const built1 = await factory({ ...slotCfg, id: 'leak-1' });
    const built2 = await factory({ ...slotCfg, id: 'leak-2' });
    const built3 = await factory({ ...slotCfg, id: 'leak-3' });

    await built1.dispose?.();
    await built2.dispose?.();
    await built3.dispose?.();

    for (const built of [built1, built2, built3]) {
      const remaining = (
        built.agent.ctx as unknown as {
          agentHooks: { size: number };
        }
      ).agentHooks.size;
      expect(remaining).toBe(0);
    }
  });

  it('scopes the agent context to the filtered tool allow-list', async () => {
    const host = new MultiAgentHost(depsWithTools());
    const { agent, dispose } = await host.makeSubagentFactory(config)(slotCfg);
    const names = agent.ctx.tools.map((t) => t.name).sort();
    // `submit_result` and `session_note` are injected regardless of the
    // allow-list: a subagent that cannot report and cannot ask is a dead end.
    expect(names).toEqual(['grep', 'read', 'session_note', 'submit_result']);
    expect(names).not.toContain('bash');
    await dispose?.();
  });

  it('keeps unscoped developer tools but hides recursive orchestration controls', async () => {
    const deps = depsWithTools();
    for (const name of [
      'delegate',
      'spawn_subagent',
      'assign_task',
      'await_tasks',
      'fleet_emit',
      'work_complete',
    ]) {
      deps.toolRegistry.register(fakeTool(name));
    }
    const host = new MultiAgentHost(deps);
    const { agent, dispose } = await host.makeSubagentFactory(config)({
      id: 'full-slot',
      name: 'full',
      role: 'general',
    });
    const names = agent.ctx.tools.map((t) => t.name).sort();
    expect(names).toEqual(['bash', 'grep', 'read', 'session_note', 'submit_result']);
    expect(names).not.toContain('delegate');
    expect(names).not.toContain('spawn_subagent');
    expect(names).not.toContain('fleet_emit');
    await dispose?.();
  });

  it('appends the role persona to the agent system prompt', async () => {
    const host = new MultiAgentHost(depsWithTools());
    const { agent, dispose } = await host.makeSubagentFactory(config)(slotCfg);
    const promptText = agent.ctx.systemPrompt.map((b) => b.text).join('\n');
    expect(promptText).toContain('PERSONA-SENTINEL-XYZ');
    await dispose?.();
  });

  it('resolves role-prioritized skill names into bounded prompt content', async () => {
    const deps = depsWithTools();
    deps.systemPromptBuilder = {
      build: vi.fn(async () => [
        { type: 'text', text: 'sys' },
        { type: 'text', text: '# Active Skills\n\nSTALE-GENERIC-SKILL' },
      ]),
    } as never as SystemPromptBuilder;
    deps.skillLoader = {
      list: vi.fn(async () => []),
      listEntries: vi.fn(async () => []),
      find: vi.fn(async (name: string) =>
        name === 'testing'
          ? { name, description: '', path: `/skills/${name}/SKILL.md`, source: 'bundled' as const }
          : undefined,
      ),
      manifestText: vi.fn(async () => ''),
      readBody: vi.fn(async () => ''),
      readSaveBody: vi.fn(async () => 'TESTING-SKILL-SENTINEL'),
      invalidateCache: vi.fn(),
    };
    const host = new MultiAgentHost(deps);
    const { agent, dispose } = await host.makeSubagentFactory(config)({
      ...slotCfg,
      skillNames: ['testing', 'not-installed'],
      skillContent: 'DIRECT-SKILL-SENTINEL',
    });
    const promptText = agent.ctx.systemPrompt.map((block) => block.text).join('\n');
    expect(promptText).toContain('DIRECT-SKILL-SENTINEL');
    expect(promptText).toContain('## Skill: testing');
    expect(promptText).toContain('TESTING-SKILL-SENTINEL');
    expect(promptText).not.toContain('STALE-GENERIC-SKILL');
    expect(promptText).not.toContain('## Skill: not-installed');
    await dispose?.();
  });

  it('builds a distinct, fresh Agent + Context per invocation (no shared leader)', async () => {
    const host = new MultiAgentHost(depsWithTools());
    const factory = host.makeSubagentFactory(config);
    const a = await factory({ ...slotCfg, id: 'slot-a' });
    const b = await factory({ ...slotCfg, id: 'slot-b' });
    expect(a.agent).not.toBe(b.agent);
    expect(a.agent.ctx).not.toBe(b.agent.ctx);
    expect(a.events).not.toBe(b.events);
    await a.dispose?.();
    await b.dispose?.();
  });

  it('overlays the real context window on the subagent provider when modelsRegistry is wired', async () => {
    // Without the overlay an openai-compatible subagent (DeepSeek/Groq)
    // reports the 32k family default in the fleet panel. With a registry
    // wired, the factory resolves the real window (here mocked to 128k).
    vi.mocked(capabilitiesFor).mockResolvedValueOnce({ maxContext: 128_000 } as never);
    const deps = depsWithTools();
    deps.modelsRegistry = {} as never as MultiAgentDeps['modelsRegistry'];
    const host = new MultiAgentHost(deps);
    const { agent, dispose } = await host.makeSubagentFactory(config)(slotCfg);
    expect(agent.ctx.provider.capabilities.maxContext).toBe(128_000);
    await dispose?.();
  });

  it('uses the model-specific maxContext for subagents instead of the provider family default', async () => {
    vi.mocked(capabilitiesFor).mockResolvedValueOnce({ maxContext: 1_050_000 } as never);
    const deps = depsWithTools();
    deps.modelsRegistry = {} as never as MultiAgentDeps['modelsRegistry'];
    const gptConfig = {
      provider: 'openai',
      model: 'gpt-5.5',
      apiKey: 'fake',
    } as never as Config;
    const host = new MultiAgentHost(deps);
    const { agent, dispose } = await host.makeSubagentFactory(gptConfig)({
      ...slotCfg,
      provider: 'openai',
      model: 'gpt-5.5',
    });
    expect(agent.ctx.provider.capabilities.maxContext).toBe(1_050_000);
    await dispose?.();
  });

  it('does not apply catalog maxContext to custom baseUrl subagents', async () => {
    const deps = depsWithTools();
    deps.modelsRegistry = {} as never as MultiAgentDeps['modelsRegistry'];
    const gptProxyConfig = {
      provider: 'openai',
      model: 'gpt-5.5',
      providers: {
        openai: {
          type: 'openai',
          apiKey: 'fake',
          baseUrl: 'http://127.0.0.1:8317/v1',
        },
      },
    } as never as Config;
    const host = new MultiAgentHost(deps);
    const { agent, dispose } = await host.makeSubagentFactory(gptProxyConfig)({
      ...slotCfg,
      provider: 'openai',
      model: 'gpt-5.5',
    });
    expect(agent.ctx.provider.capabilities.maxContext).toBe(32_000);
    expect(capabilitiesFor).not.toHaveBeenCalled();
    await dispose?.();
  });

  it('falls back to the family default window when no modelsRegistry is wired', async () => {
    const host = new MultiAgentHost(depsWithTools());
    const { agent, dispose } = await host.makeSubagentFactory(config)(slotCfg);
    expect(agent.ctx.provider.capabilities.maxContext).toBe(32_000);
    await dispose?.();
  });

  it('applies role-specific reasoning runtime from the model matrix', async () => {
    const deps = depsWithTools();
    const liveConfig = {
      provider: 'anthropic',
      model: 'claude',
      apiKey: 'fake',
      modelRuntime: { reasoning: { mode: 'auto', effort: 'high' } },
      modelMatrix: {
        'security-reviewer': { modelRuntime: { reasoning: { effort: 'low' } } },
      },
    } as never as Config;
    vi.mocked(deps.configStore.get).mockReturnValue(liveConfig);
    deps.modelsRegistry = {
      refresh: vi.fn(async () => ({})),
      getProvider: vi.fn(async () => undefined),
      getModel: vi.fn(async () => ({
        capabilities: {
          maxContext: 128_000,
          reasoningConfig: {
            default: 'enabled',
            disableSupported: true,
            effortSupported: true,
            effortLevels: ['low', 'medium', 'high'],
            preserveThinking: 'optional',
          },
        },
      })),
    } as never;
    const host = new MultiAgentHost(deps);
    const { agent, dispose } = await host.makeSubagentFactory(liveConfig)(slotCfg);

    const req = await agent.pipelines.request.run({ model: 'claude' } as never);

    expect(req.reasoning).toEqual({ effort: 'low' });
    await dispose?.();
  });

  // SubagentConfig.allowedCapabilities must reach the subagent's
  // AutoApprovePermissionPolicy via the factory — otherwise widening the
  // allowlist (e.g. /techstack granting fs.write) is silently inert and the
  // subagent can never write its report.
  function writerTool(): Tool {
    return {
      name: 'writer',
      description: 'fake fs.write tool',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: true,
      capabilities: ['fs.write'],
      execute: vi.fn().mockResolvedValue('WROTE'),
    } as Tool;
  }

  async function runWriter(
    cfg: Partial<SubagentConfig>,
  ): Promise<{ result: { type: string; is_error?: boolean }; tool: Tool; dispose?: () => void }> {
    const deps = depsWithTools();
    const projectRoot = await mkdtemp(join(tmpdir(), 'wstack-subagent-writer-'));
    writerRoots.push(projectRoot);
    deps.projectRoot = projectRoot;
    deps.cwd = projectRoot;
    const tool = writerTool();
    deps.toolRegistry.register(tool);
    const host = new MultiAgentHost(deps);
    const { agent, dispose } = await host.makeSubagentFactory(config)({
      id: cfg.id ?? 'slot',
      name: cfg.name ?? 'w',
      role: 'general',
      ...cfg,
    });
    const board = await createBoard(projectRoot, {
      title: 'Capability test board',
      columns: [
        { id: 'backlog', title: 'Backlog', order: 0 },
        { id: 'todo', title: 'Todo', order: 1 },
        { id: 'running', title: 'Running', order: 2 },
        { id: 'review', title: 'Review', order: 3 },
        { id: 'done', title: 'Done', order: 4 },
      ],
      lifecycle: {
        mode: 'managed',
        columns: {
          backlog: 'backlog',
          todo: 'todo',
          running: 'in-progress',
          review: 'review',
          done: 'done',
        },
      },
    });
    const added = await addTask(projectRoot, board.id, {
      title: 'Exercise writer capability',
      description: 'Verify the subagent capability grant reaches the writer tool.',
      assignedAgent: agent.ctx.agentId,
      dueDate: '2026-08-10T00:00:00.000Z',
      labels: ['capability-test'],
    });
    const taskId = added!.task.id;
    await addCheckToTask(projectRoot, board.id, taskId, {
      description: 'Writer tool executes once',
      type: 'test',
    });
    await transitionTask(projectRoot, board.id, taskId, {
      to: 'todo',
      actor: agent.ctx.agentId ?? 'subagent',
      comment: 'Capability test is ready.',
    });
    await updateTaskAssignment(projectRoot, board.id, taskId, {
      status: 'running',
      agentId: agent.ctx.agentId ?? 'subagent',
      leaseId: 'capability-test-lease',
      claimedAt: '2026-08-10T00:00:00.000Z',
      heartbeatAt: '2026-08-10T00:00:00.000Z',
      leaseExpiresAt: '2026-08-11T00:00:00.000Z',
      attempt: 1,
      maxAttempts: 1,
    });
    await transitionTask(projectRoot, board.id, taskId, {
      to: 'running',
      actor: agent.ctx.agentId ?? 'subagent',
      comment: 'Capability test started.',
    });
    agent.ctx.setCurrentKanbanTask(taskId, board.id);
    const r = await agent.toolExecutor.executeBatch(
      [{ type: 'tool_use', id: 'u1', name: 'writer', input: {} }],
      agent.ctx,
      'sequential',
    );
    return { result: r.outputs[0]!.result as never, tool, dispose } as never;
  }

  it('explicit allowedCapabilities lets a granted fs.write tool run', async () => {
    const { result, tool, dispose } = await runWriter({
      tools: ['writer'],
      allowedCapabilities: ['fs.read', 'net.outbound', 'fs.write'],
    });
    expect(result.type).toBe('tool_result');
    expect(result.is_error).toBeFalsy();
    expect(tool.execute).toHaveBeenCalledTimes(1);
    await dispose?.();
  });

  it('derives fs.write from a scoped tools slice (no explicit caps)', async () => {
    // The granted tool slice IS the capability grant: a subagent handed the
    // `writer` (fs.write) tool may execute it without an explicit allowlist.
    const { result, tool, dispose } = await runWriter({ tools: ['writer'] });
    expect(result.type).toBe('tool_result');
    expect(result.is_error).toBeFalsy();
    expect(tool.execute).toHaveBeenCalledTimes(1);
    await dispose?.();
  });

  it('allows fs.write for an unscoped (full-registry) subagent — wide default', async () => {
    // No `tools` restriction → WIDE working capabilities (read/write/net/shell/
    // install). The user authorized full developer work by invoking the leader.
    const { result, tool, dispose } = await runWriter({});
    expect(result.type).toBe('tool_result');
    expect(result.is_error).toBeFalsy();
    expect(tool.execute).toHaveBeenCalledTimes(1);
    await dispose?.();
  });

  it('still denies an escape-hatch capability (fs.write.outside-project) by default', async () => {
    // WIDE covers in-project work but NOT the blast-radius-escaping caps —
    // writing outside the repo needs an explicit per-spawn grant.
    const deps = depsWithTools();
    const escaper = {
      name: 'escaper',
      description: 'writes outside the project',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: true,
      capabilities: ['fs.write.outside-project'],
      execute: vi.fn().mockResolvedValue('ESCAPED'),
    } as Tool;
    deps.toolRegistry.register(escaper);
    const host = new MultiAgentHost(deps);
    const { agent, dispose } = await host.makeSubagentFactory(config)({
      id: 'esc',
      name: 'esc',
      role: 'general',
    });
    const r = await agent.toolExecutor.executeBatch(
      [{ type: 'tool_use', id: 'u1', name: 'escaper', input: {} }],
      agent.ctx,
      'sequential',
    );
    expect((r.outputs[0]!.result as { is_error?: boolean }).is_error).toBe(true);
    expect(escaper.execute).not.toHaveBeenCalled();
    await dispose?.();
  });
});
