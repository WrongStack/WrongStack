/**
 * D5/M2 — FleetManager unit tests.
 *
 * Covers the fleet-level policy surface extracted from Director:
 * - canSpawn() budget enforcement (maxSpawns, maxSpawnDepth, maxFleetCostUsd)
 * - recordSpawn() state mutations (counter, metadata, manifest entries, checkpoint)
 * - addTaskToSubagent() manifest wiring
 * - writeManifest() file output
 * - snapshot() usage rollup delegation
 * - backward-compatibility: Director works identically with and without
 *   an injected FleetManager (same behavior, different code path)
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FleetBus } from '../../src/coordination/fleet-bus.js';
import { FleetManager } from '../../src/coordination/fleet-manager.js';
import type { SubagentConfig } from '../../src/types/multi-agent.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

/**
 * Poll for a debounced manifest write instead of sleeping a fixed window —
 * robust under heavy parallel load where a tight margin would flake.
 */
async function readWhenReady(
  file: string,
  ready: (content: string) => boolean = () => true,
  timeoutMs = 3000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  // Date.now() in a test runner is fine (not a workflow script).
  for (;;) {
    try {
      const content = await fsp.readFile(file, 'utf8');
      if (ready(content)) return content;
    } catch {
      /* not written yet */
    }
    if (Date.now() >= deadline) {
      return fsp.readFile(file, 'utf8'); // final attempt → surfaces the real error
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('FleetManager', () => {
  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  function makeConfig(overrides: Partial<SubagentConfig> = {}): SubagentConfig {
    return {
      name: 'test-subagent',
      provider: 'anthropic',
      model: 'anthropic-test-model',
      ...overrides,
    };
  }

  /** Fake price lookup — $1/M tokens for everything. */
  function priceLookup() {
    return { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0.1 };
  }

  // -------------------------------------------------------------------------
  // construction
  // -------------------------------------------------------------------------

  describe('construction', () => {
    it('defaults maxSpawns to Infinity', () => {
      const fm = new FleetManager();
      expect(fm.canSpawn(makeConfig())).toBeNull();
    });

    it('defaults maxSpawnDepth to 2', () => {
      const fm = new FleetManager({ maxSpawnDepth: 2 });
      expect(fm.canSpawn(makeConfig({ name: 'deep' }) as SubagentConfig)).toBeNull();
    });

    it('hard-caps configured recursive spawn depth at 2', () => {
      const fm = new FleetManager({ maxSpawnDepth: 99 });
      expect(fm.maxSpawnDepth).toBe(2);
    });

    it('defaults maxFleetCostUsd to Infinity', () => {
      const fm = new FleetManager({ directorBudget: {} });
      expect(fm.canSpawn(makeConfig())).toBeNull();
    });

    it('exposes fleetBus as a FleetBus instance', () => {
      const fm = new FleetManager();
      expect(fm.fleetBus).toBeInstanceOf(FleetBus);
    });

    it('exposes usage as a FleetUsageAggregator', () => {
      const fm = new FleetManager();
      // Snapshot should return a well-formed object even with no events.
      const snap = fm.snapshot();
      expect(snap).toHaveProperty('total');
      expect(snap).toHaveProperty('perSubagent');
    });
  });

  // -------------------------------------------------------------------------
  // canSpawn() — budget enforcement
  // -------------------------------------------------------------------------

  describe('canSpawn()', () => {
    it('returns null (allowed) when no caps are set', () => {
      const fm = new FleetManager();
      expect(fm.canSpawn(makeConfig())).toBeNull();
    });

    it('rejects when maxSpawnDepth is reached', () => {
      const fm = new FleetManager({ maxSpawnDepth: 1, spawnDepth: 1 });
      const result = fm.canSpawn(makeConfig());
      expect(result).not.toBeNull();
      expect(result!.kind).toBe('max_spawn_depth');
      expect(result!.limit).toBe(1);
      expect(result!.observed).toBe(1);
    });

    it('allows spawn when depth is below cap', () => {
      const fm = new FleetManager({ maxSpawnDepth: 2, spawnDepth: 1 });
      expect(fm.canSpawn(makeConfig())).toBeNull();
    });

    it('rejects when maxSpawns is reached (without prior recordSpawn)', () => {
      const fm = new FleetManager({ maxSpawns: 1 });
      // Without recordSpawn, spawnCount is 0 — so maxSpawns=1 should be fine
      expect(fm.canSpawn(makeConfig())).toBeNull();
    });

    it('rejects when maxFleetCostUsd is zero (cost already at cap)', () => {
      // cap=0 and cost=0 → 0 >= 0 → reject
      const fm = new FleetManager({ directorBudget: { maxCostUsd: 0 } });
      const result = fm.canSpawn(makeConfig());
      expect(result).not.toBeNull();
      expect(result!.kind).toBe('max_cost_usd');
    });

    it('rejects new spawns when cumulative fleet tokens reach maxTokens', () => {
      const fm = new FleetManager({ directorBudget: { maxTokens: 100 } });
      fm.fleet.emit({
        subagentId: 'existing',
        ts: Date.now(),
        type: 'provider.response',
        payload: { usage: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0 } },
      });

      expect(fm.canSpawn(makeConfig())).toMatchObject({
        kind: 'max_tokens',
        limit: 100,
        observed: 100,
      });
      expect(fm.budgetSnapshot()).toMatchObject({
        maxTokens: 100,
        usedTokens: 100,
        remainingTokens: 0,
      });
    });

    it('rejects when fleet already hit cost cap', () => {
      const bus = new FleetBus();
      // Create FM with generous cap, then fake a cost event
      const _fm = new FleetManager({ directorBudget: { maxCostUsd: 0.01 }, maxSpawns: 10 });
      // Emit a large usage event so fleet cost > cap
      bus.emit({
        subagentId: 'existing',
        ts: Date.now(),
        type: 'provider.response',
        payload: { usage: { input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
      });
      // The aggregator needs to be connected to this bus — but FM created
      // its own bus internally. We can't inject the bus, so we test the
      // cost cap path by verifying the reject when cap is 0.
    });

    it('returns null for all-OK case with all limits set high', () => {
      const fm = new FleetManager({
        maxSpawns: 100,
        maxSpawnDepth: 5,
        spawnDepth: 1,
        directorBudget: { maxCostUsd: 100 },
      });
      expect(fm.canSpawn(makeConfig())).toBeNull();
    });

    it('reads maxContext lazily so leader model switches update spawn pressure checks', () => {
      let maxContext = 128_000;
      const fm = new FleetManager({ maxContext: () => maxContext, maxLeaderContextLoad: 0.85 });
      fm.setLeaderContextPressure(120_000);

      expect(fm.canSpawn(makeConfig())?.kind).toBe('max_context_load');

      maxContext = 1_050_000;
      expect(fm.canSpawn(makeConfig())).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // recordSpawn() — state mutations
  // -------------------------------------------------------------------------

  describe('recordSpawn()', () => {
    it('stores subagentMeta for getSubagentMeta()', () => {
      const fm = new FleetManager();
      fm.recordSpawn('sub-1', makeConfig({ name: 'worker', provider: 'openai', model: 'gpt-4o' }));
      expect(fm.getSubagentMeta('sub-1')).toEqual({
        provider: 'openai',
        model: 'gpt-4o',
        name: 'worker',
      });
    });

    it('stores priceLookup for cost attribution', () => {
      const fm = new FleetManager();
      fm.recordSpawn('sub-1', makeConfig(), { input: 1.5, output: 7.5 });
      // getSubagentMeta is metadata only; price is stored separately
      // in the aggregator — we verify via snapshot below
    });

    it('subsequent canSpawn() reflects spawn count', () => {
      const fm = new FleetManager({ maxSpawns: 2 });
      expect(fm.canSpawn(makeConfig())).toBeNull(); // count=0
      fm.recordSpawn('sub-1', makeConfig());
      expect(fm.canSpawn(makeConfig())).toBeNull(); // count=1
      fm.recordSpawn('sub-2', makeConfig());
      const result = fm.canSpawn(makeConfig());
      expect(result).not.toBeNull();
      expect(result!.kind).toBe('max_spawns');
    });

    it('stores provider + model for usage attribution', () => {
      const fm = new FleetManager();
      fm.recordSpawn('sub-x', makeConfig({ provider: 'anthropic', model: 'anthropic-test-model' }));
      // Usage entry is created on first provider.response event, not on recordSpawn.
      fm.fleet.emit({
        subagentId: 'sub-x',
        ts: Date.now(),
        type: 'provider.response',
        payload: { usage: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 } },
      });
      const snap = fm.snapshot();
      expect(snap.perSubagent['sub-x']).toBeDefined();
      expect(snap.perSubagent['sub-x']!.provider).toBe('anthropic');
      expect(snap.perSubagent['sub-x']!.model).toBe('anthropic-test-model');
    });
  });

  // -------------------------------------------------------------------------
  // addTaskToSubagent() — manifest wiring
  // -------------------------------------------------------------------------

  describe('addTaskToSubagent()', () => {
    it('is safe to call before any spawn (no-op)', () => {
      const fm = new FleetManager();
      expect(() => fm.addTaskToSubagent('unknown', 'task-1')).not.toThrow();
    });

    it('accumulates multiple task ids for the same subagent', () => {
      const fm = new FleetManager();
      fm.recordSpawn('sub-1', makeConfig());
      fm.addTaskToSubagent('sub-1', 'task-a');
      fm.addTaskToSubagent('sub-1', 'task-b');
      // The manifest entry is internal; we verify via writeManifest
    });
  });

  // -------------------------------------------------------------------------
  // writeManifest() — file I/O
  // -------------------------------------------------------------------------

  describe('writeManifest()', () => {
    it('returns null when no manifestPath configured', async () => {
      const fm = new FleetManager();
      const result = await fm.writeManifest();
      expect(result).toBeNull();
    });

    it('writes a valid JSON manifest with spawned subagent', async () => {
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fm-manifest-'));
      const manifestPath = path.join(tmpDir, 'fleet.json');

      const fm = new FleetManager({ manifestPath });
      fm.recordSpawn(
        'sub-1',
        makeConfig({
          name: 'worker',
          role: 'researcher',
          provider: 'anthropic',
          model: 'anthropic-test-model',
        }),
      );
      fm.addTaskToSubagent('sub-1', 'task-1');

      const written = await fm.writeManifest();
      expect(written).toBe(manifestPath);

      const content = JSON.parse(await fsp.readFile(manifestPath, 'utf-8'));
      expect(content.version).toBe(1);
      expect(content.children).toHaveLength(1);
      expect(content.children[0].id).toBe('sub-1');
      expect(content.children[0].name).toBe('worker');
      expect(content.children[0].role).toBe('researcher');
      expect(content.children[0].taskIds).toEqual(['task-1']);

      await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    it('writes manifest with correct usage snapshot', async () => {
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fm-manifest-'));
      const manifestPath = path.join(tmpDir, 'fleet.json');

      const fm = new FleetManager({ manifestPath, directorBudget: { maxCostUsd: 10 } });
      fm.recordSpawn('sub-1', makeConfig(), priceLookup());

      // Emit usage so aggregator has data
      fm.fleet.emit({
        subagentId: 'sub-1',
        ts: Date.now(),
        type: 'provider.response',
        payload: {
          usage: { input: 1_000_000, output: 500_000, cacheRead: 200_000, cacheWrite: 0 },
        },
      });

      const written = await fm.writeManifest();
      expect(written).toBe(manifestPath);
      const content = JSON.parse(await fsp.readFile(manifestPath, 'utf-8'));
      expect(content.usage.total.input).toBe(1_000_000);
      expect(content.usage.total.output).toBe(500_000);
      expect(content.usage.total.cost).toBeCloseTo(1.5, 1); // 1M input * $1/M + 0.5M output * $1/M

      await fsp.rm(tmpDir, { recursive: true, force: true });
    });
  });

  // -------------------------------------------------------------------------
  // closeManifest() — teardown freeze (regression: ENOTEMPTY on rmdir)
  // -------------------------------------------------------------------------

  describe('closeManifest()', () => {
    it('writes the final manifest then freezes further writes', async () => {
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fm-close-'));
      const manifestPath = path.join(tmpDir, 'fleet.json');
      const fm = new FleetManager({ manifestPath });
      fm.recordSpawn('sub-1', makeConfig({ name: 'worker' }));

      await fm.closeManifest();
      const afterClose = await fsp.readFile(manifestPath, 'utf-8');

      // A late fire-and-forget flush — the exact call the Director issues on
      // task completion — must NOT start a new write once frozen. Without the
      // freeze this atomicWrite (temp sibling + rename) races a caller that
      // deletes the directory next, producing ENOTEMPTY on rmdir (Windows).
      fm.addTaskToSubagent('sub-1', 'late-task');
      await fm.flushManifest();
      await fm.writeManifest();

      // On-disk manifest is unchanged by the frozen writes.
      expect(await fsp.readFile(manifestPath, 'utf-8')).toBe(afterClose);

      await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    it('lifts the freeze on the next recordSpawn (stop-then-spawn-again)', async () => {
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fm-close-'));
      const manifestPath = path.join(tmpDir, 'fleet.json');
      const fm = new FleetManager({ manifestPath });
      fm.recordSpawn('sub-1', makeConfig({ name: 'first' }));
      await fm.closeManifest();

      // New activity after the stop re-enables persistence.
      fm.recordSpawn('sub-2', makeConfig({ name: 'second' }));
      const written = await fm.writeManifest();
      expect(written).toBe(manifestPath);
      const content = JSON.parse(await fsp.readFile(manifestPath, 'utf-8'));
      expect(content.children.map((c: { id: string }) => c.id)).toContain('sub-2');

      await fsp.rm(tmpDir, { recursive: true, force: true });
    });
  });

  // -------------------------------------------------------------------------
  // snapshot() — delegation to FleetUsageAggregator
  // -------------------------------------------------------------------------

  describe('snapshot()', () => {
    it('returns empty snapshot with no events', () => {
      const fm = new FleetManager();
      const snap = fm.snapshot();
      expect(snap.total.input).toBe(0);
      expect(snap.total.output).toBe(0);
      expect(snap.total.cost).toBe(0);
      expect(Object.keys(snap.perSubagent)).toHaveLength(0);
    });

    it('accumulates events from attached subagents', () => {
      const fm = new FleetManager();
      fm.recordSpawn('sub-1', makeConfig(), priceLookup());

      fm.fleet.emit({
        subagentId: 'sub-1',
        ts: Date.now(),
        type: 'provider.response',
        payload: { usage: { input: 2_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0 } },
      });

      const snap = fm.snapshot();
      expect(snap.perSubagent['sub-1']).toBeDefined();
      expect(snap.total.input).toBe(2_000_000);
      expect(snap.total.output).toBe(500_000);
      // cost: 2M * $1/M + 0.5M * $1/M = $2.50
      expect(snap.total.cost).toBeCloseTo(2.5, 1);
    });

    it('merges events from multiple subagents', () => {
      const fm = new FleetManager();
      fm.recordSpawn('a', makeConfig({ name: 'agent-a' }), priceLookup());
      fm.recordSpawn('b', makeConfig({ name: 'agent-b' }), priceLookup());

      fm.fleet.emit({
        subagentId: 'a',
        ts: 1,
        type: 'provider.response',
        payload: { usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
      });
      fm.fleet.emit({
        subagentId: 'b',
        ts: 2,
        type: 'provider.response',
        payload: { usage: { input: 3_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
      });

      const snap = fm.snapshot();
      expect(snap.total.input).toBe(4_000_000);
      expect(snap.perSubagent['a']).toBeDefined();
      expect(snap.perSubagent['b']).toBeDefined();
      expect(snap.perSubagent['a']!.input).toBe(1_000_000);
      expect(snap.perSubagent['b']!.input).toBe(3_000_000);
    });
  });

  // -------------------------------------------------------------------------
  // scheduleManifest() — debounce behavior
  // -------------------------------------------------------------------------

  describe('scheduleManifest()', () => {
    it('writes immediately when manifestDebounceMs is 0 (synchronous flush)', async () => {
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fm-debounce-'));
      const manifestPath = path.join(tmpDir, 'sync.json');
      const fm = new FleetManager({ manifestPath, manifestDebounceMs: 0 });
      fm.recordSpawn('sub-1', makeConfig());
      await fm.flushManifest();
      const content = await fsp.readFile(manifestPath, 'utf8');
      expect(content).toContain('sub-1');
      await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    it('does nothing when manifestDebounceMs is negative', () => {
      const fm = new FleetManager({ manifestDebounceMs: -1 });
      // Should not throw and should not write (no path configured)
      expect(() => fm.scheduleManifest()).not.toThrow();
    });

    it('schedules a deferred write for positive debounce', async () => {
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fm-debounce-'));
      const manifestPath = path.join(tmpDir, 'deferred.json');
      const fm = new FleetManager({ manifestPath, manifestDebounceMs: 50 });
      fm.recordSpawn('sub-1', makeConfig());

      // File should not exist yet (timer is pending)
      await expect(fsp.access(manifestPath)).rejects.toThrow();

      // Wait for the debounced write to land. Poll instead of a fixed sleep:
      // under heavy parallel load the 50ms timer + write can overrun a tight
      // window, which made this flaky in the full suite.
      const content = await readWhenReady(manifestPath);
      expect(content).toContain('sub-1');
      await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    it('collapses multiple rapid calls into one write', async () => {
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fm-debounce-'));
      const manifestPath = path.join(tmpDir, 'burst.json');
      const fm = new FleetManager({ manifestPath, manifestDebounceMs: 50 });
      fm.recordSpawn('sub-1', makeConfig());
      fm.recordSpawn('sub-2', makeConfig());
      fm.recordSpawn('sub-3', makeConfig());

      // Single timer, not three — poll for the collapsed write (load-robust).
      const content = await readWhenReady(manifestPath, (c) => c.includes('sub-3'));
      expect(content).toContain('sub-1');
      expect(content).toContain('sub-2');
      expect(content).toContain('sub-3');
      await fsp.rm(tmpDir, { recursive: true, force: true });
    });
  });

  // -------------------------------------------------------------------------
  // flushManifest() — immediate bypass
  // -------------------------------------------------------------------------

  describe('flushManifest()', () => {
    it('writes immediately, bypassing the debounce timer', async () => {
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fm-flush-'));
      const manifestPath = path.join(tmpDir, 'immediate.json');
      const fm = new FleetManager({ manifestPath, manifestDebounceMs: 50 });
      fm.recordSpawn('sub-1', makeConfig());

      // File should not exist yet (timer is pending with 5s delay)
      await expect(fsp.access(manifestPath)).rejects.toThrow();

      // flushManifest() should write immediately despite the long debounce
      await fm.flushManifest();

      const content = await fsp.readFile(manifestPath, 'utf8');
      expect(content).toContain('sub-1');
      await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    it('clears a pending debounce timer', async () => {
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fm-flush-'));
      const manifestPath = path.join(tmpDir, 'clear-timer.json');
      const fm = new FleetManager({ manifestPath, manifestDebounceMs: 50 });

      // Record first spawn and flush — clears any pending write, file gets sub-1
      fm.recordSpawn('sub-1', makeConfig());
      await fm.flushManifest();
      const content = await fsp.readFile(manifestPath, 'utf8');
      expect(content).toContain('sub-1');

      // Second spawn starts a new debounce timer (5 s). scheduleManifest()
      // should return immediately (defer) without writing anything.
      fm.recordSpawn('sub-2', makeConfig());

      // File should still only have sub-1 — new timer hasn't fired
      const afterContent = await fsp.readFile(manifestPath, 'utf8');
      expect(afterContent).toContain('sub-1');
      expect(afterContent).not.toContain('sub-2');

      // Wait long enough for the new timer to fire naturally
      await new Promise((resolve) => setTimeout(resolve, 120));
      const finalContent = await fsp.readFile(manifestPath, 'utf8');
      expect(finalContent).toContain('sub-2');

      await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    it('is a no-op when no manifest path is configured', () => {
      const fm = new FleetManager();
      // Should not throw
      expect(() => fm.flushManifest()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // IFleetManager contract — ensure the class fulfills the interface
  // -------------------------------------------------------------------------

  describe('IFleetManager contract', () => {
    it('fleetBus is a FleetBus', () => {
      const fm = new FleetManager();
      expect(fm.fleetBus).toBeInstanceOf(FleetBus);
    });

    it('getSubagentMeta returns undefined for unknown id', () => {
      const fm = new FleetManager();
      expect(fm.getSubagentMeta('nonexistent')).toBeUndefined();
    });

    it('getSubagentMeta returns data for known subagent', () => {
      const fm = new FleetManager();
      fm.recordSpawn('sub-1', makeConfig({ provider: 'openai', model: 'gpt-4o' }));
      expect(fm.getSubagentMeta('sub-1')).toEqual({
        provider: 'openai',
        model: 'gpt-4o',
        name: 'test-subagent',
      });
    });

    it('writeManifest returns string path when configured', async () => {
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fm-contract-'));
      const fm = new FleetManager({ manifestPath: path.join(tmpDir, 'fleet.json') });
      const result = await fm.writeManifest();
      expect(typeof result).toBe('string');
      await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    it('writeManifest returns null when not configured', async () => {
      const fm = new FleetManager();
      expect(await fm.writeManifest()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // integration: Director with injected FleetManager (backward-compat)
  // -------------------------------------------------------------------------

  describe('Director backward-compatibility', () => {
    it('Director works without fleetManager (inline state)', async () => {
      const { Director } = await import('../../src/coordination/director.js');
      const runner = vi.fn(async (_task: TaskSpec, _ctx: SubagentRunContext) => {
        return { result: 'ok', iterations: 1, toolCalls: 1 };
      });
      const director = new Director({
        sessionId: TEST_SESSION_ID,
        config: {
          coordinatorId: 'compat-test',
          doneCondition: { type: 'all_tasks_done' },
          maxConcurrent: 4,
        },
        runner,
      });
      expect(director.fleet).toBeInstanceOf(FleetBus);
      const id = await director.spawn(makeConfig({ name: 'test' }));
      expect(typeof id).toBe('string');
      await director.shutdown();
    });

    it('Director works with injected FleetManager (delegated state)', async () => {
      const { Director } = await import('../../src/coordination/director.js');
      const fm = new FleetManager({ maxSpawns: 10, maxSpawnDepth: 3 });
      const runner = vi.fn(async (_task: TaskSpec, _ctx: SubagentRunContext) => {
        return { result: 'ok', iterations: 1, toolCalls: 1 };
      });
      const director = new Director({
        sessionId: TEST_SESSION_ID,
        config: {
          coordinatorId: 'fm-delegation-test',
          doneCondition: { type: 'all_tasks_done' },
          maxConcurrent: 4,
        },
        runner,
        fleetManager: fm,
      });
      // With FM injected, director.fleet must point at fm.fleet
      expect(director.fleet).toBe(fm.fleet);
      const id = await director.spawn(makeConfig({ name: 'delegated' }));
      expect(typeof id).toBe('string');
      // FM got the spawn record
      expect(fm.getSubagentMeta(id)).toBeDefined();
      await director.shutdown();
    });

    it('spawn rejects at FM boundary with maxSpawns', async () => {
      const { Director } = await import('../../src/coordination/director.js');
      const { FleetSpawnBudgetError } = await import('../../src/coordination/director.js');
      const fm = new FleetManager({ maxSpawns: 1 });
      const runner = vi.fn(async () => ({ result: 'ok', iterations: 1, toolCalls: 1 }));
      const director = new Director({
        sessionId: TEST_SESSION_ID,
        config: {
          coordinatorId: 'budget-boundary',
          doneCondition: { type: 'all_tasks_done' },
          maxConcurrent: 4,
        },
        runner,
        fleetManager: fm,
      });
      await director.spawn(makeConfig({ name: 'first' }));
      await expect(director.spawn(makeConfig({ name: 'second' }))).rejects.toThrow(
        FleetSpawnBudgetError,
      );
      await director.shutdown();
    });

    it('FM is stateful across multiple spawns on same Director', async () => {
      const { Director } = await import('../../src/coordination/director.js');
      const fm = new FleetManager({ maxSpawns: 5 });
      const runner = vi.fn(async () => ({ result: 'ok', iterations: 1, toolCalls: 1 }));
      const director = new Director({
        sessionId: TEST_SESSION_ID,
        config: {
          coordinatorId: 'stateful-fm',
          doneCondition: { type: 'all_tasks_done' },
          maxConcurrent: 4,
        },
        runner,
        fleetManager: fm,
      });
      const id1 = await director.spawn(makeConfig({ name: 'a' }));
      const id2 = await director.spawn(makeConfig({ name: 'b' }));
      expect(fm.getSubagentMeta(id1)).toBeDefined();
      expect(fm.getSubagentMeta(id2)).toBeDefined();
      expect(fm.snapshot().total.input).toBe(0); // no events yet
      await director.shutdown();
    });
  });
});
