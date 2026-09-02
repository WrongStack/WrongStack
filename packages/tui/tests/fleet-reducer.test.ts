/**
 * Tests for src/reducers/fleet.ts — reduceFleetState.
 * Covers every fleet/leader action case to reach 100% line and branch.
 * Pure function: (state, action) => State | null.
 */

import { describe, expect, it } from 'vitest';
import type { FleetEntry, State } from '../src/app-state.js';
import { reduceFleetState } from '../src/reducers/fleet.js';
import { createTestState } from './helpers/create-test-state.js';

function stubState(over: Partial<State> | Record<string, unknown> = {}): State {
  return createTestState(over);
}
function makeEntry(id = 'a1', over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: 'w1',
    provider: 'o',
    model: 'm',
    status: 'idle',
    streamingText: '',
    iterations: 0,
    toolCalls: 0,
    recentTools: [],
    recentMessages: [],
    cost: 0,
    startedAt: 0,
    lastEventAt: 0,
    transcriptPath: undefined,
    ...over,
  };
}

describe('reduceFleetState', () => {
  it('returns null for non-fleet/leader actions', () => {
    const state = stubState();
    expect(reduceFleetState(state, { type: 'unknown' } as never)).toBeNull();
  });

  it('fleetSeed: populates fleet entries with defaults', () => {
    const state = stubState();
    const legacyEntry = {
      id: 'a1',
      name: 'agent1',
      provider: 'anthropic',
      model: 'claude',
      status: 'idle',
      streamingText: '',
      iterations: 0,
      toolCalls: 0,
      cost: 0,
      startedAt: 0,
      lastEventAt: 0,
    } satisfies Omit<FleetEntry, 'recentTools' | 'recentMessages'>;
    const result = reduceFleetState(state, {
      type: 'fleetSeed',
      // Persisted entries can predate these arrays; the reducer owns their migration defaults.
      entries: [legacyEntry as FleetEntry],
      cost: 0,
    });
    const seeded = result?.fleet['a1'];
    expect(seeded).toBeDefined();
    expect(seeded?.recentTools).toEqual([]);
    expect(seeded?.recentMessages).toEqual([]);
  });

  // ── fleetSpawn ─────────────────────────────────────────────────────────
  it('fleetSpawn: creates a new entry with placeholder name from id', () => {
    const state = stubState();
    const result = reduceFleetState(state, {
      type: 'fleetSpawn',
      id: 'test1234',
      name: undefined,
      provider: 'openai',
      model: 'gpt4',
      transcriptPath: undefined,
    });
    expect(result).not.toBeNull();
    expect(result!.fleet['test1234']).toBeDefined();
    expect(result!.fleet['test1234']!.name).toBe('test1234');
  });

  it('fleetSpawn: uses provided name when given', () => {
    const state = stubState();
    const result = reduceFleetState(state, {
      type: 'fleetSpawn',
      id: 'a1',
      name: 'worker-1',
      provider: 'openai',
      model: 'gpt4',
      transcriptPath: '/tmp/x',
    });
    expect(result!.fleet['a1']!.name).toBe('worker-1');
    expect(result!.fleet['a1']!.transcriptPath).toBe('/tmp/x');
  });

  it('fleetSpawn: does NOT update existing entry with placeholder name (same name)', () => {
    const state = stubState({
      fleet: {
        a1: makeEntry('a1', { name: 'worker-1', provider: 'openai', model: 'gpt4' }) as never,
      },
    });
    const result = reduceFleetState(state, {
      type: 'fleetSpawn',
      id: 'a1',
      name: 'worker-1',
      provider: 'openai',
      model: 'gpt4',
      transcriptPath: undefined,
    });
    // Name didn't change, no update needed → returns state unchanged.
    expect(result).toBe(state);
  });

  it('fleetSpawn: upgrades placeholder name to real name', () => {
    const state = stubState({
      fleet: {
        a1: makeEntry('a1', { name: 'slot-0', provider: 'openai', model: 'gpt4' }) as never,
      },
    });
    const result = reduceFleetState(state, {
      type: 'fleetSpawn',
      id: 'a1',
      name: 'worker-42',
      provider: 'openai',
      model: 'gpt4',
      transcriptPath: undefined,
    });
    expect(result).not.toBeNull();
    expect(result!.fleet['a1']!.name).toBe('worker-42');
  });

  // ── fleetToolStart / fleetToolEnd ──────────────────────────────────────
  it('fleetToolStart: sets currentTool on existing entry', () => {
    const state = stubState({ fleet: { a1: makeEntry('a1', { status: 'idle' }) as never } });
    const result = reduceFleetState(state, { type: 'fleetToolStart', id: 'a1', name: 'read_file' });
    expect(result!.fleet['a1']!.currentTool?.name).toBe('read_file');
  });

  it('fleetToolStart: returns state unchanged for unknown id', () => {
    const state = stubState();
    expect(reduceFleetState(state, { type: 'fleetToolStart', id: 'unknown', name: 'read' })).toBe(
      state,
    );
  });

  it('fleetToolEnd: clears currentTool', () => {
    const state = stubState({
      fleet: {
        a1: makeEntry('a1', {
          status: 'running',
          currentTool: { name: 'read', startedAt: 100 },
        }) as never,
      },
    });
    const result = reduceFleetState(state, { type: 'fleetToolEnd', id: 'a1' });
    expect(result!.fleet['a1']!.currentTool).toBeUndefined();
  });

  // ── fleetStart ─────────────────────────────────────────────────────────
  it('fleetStart: transitions to running status', () => {
    const state = stubState({ fleet: { a1: makeEntry('a1', { streamingText: 'old' }) as never } });
    const result = reduceFleetState(state, { type: 'fleetStart', id: 'a1' });
    expect(result!.fleet['a1']!.status).toBe('running');
    expect(result!.fleet['a1']!.streamingText).toBe('');
  });

  it('fleetStart: returns state unchanged for unknown id', () => {
    const state = stubState();
    expect(reduceFleetState(state, { type: 'fleetStart', id: 'unknown' })).toBe(state);
  });

  // ── fleetDelta ─────────────────────────────────────────────────────────
  it('fleetDelta: appends streaming text (capped at 500 chars)', () => {
    const state = stubState({
      fleet: {
        a1: makeEntry('a1', { status: 'running', streamingText: 'x'.repeat(498) }) as never,
      },
    });
    const result = reduceFleetState(state, { type: 'fleetDelta', id: 'a1', text: 'yz' });
    expect(result!.fleet['a1']!.streamingText.length).toBeLessThanOrEqual(500);
  });

  // ── fleetMessage ──────────────────────────────────────────────────────
  it('fleetMessage: drops empty text', () => {
    const state = stubState({
      fleet: {
        a1: makeEntry('a1', {
          status: 'running',
          currentTool: { name: 'read', startedAt: 100 },
        }) as never,
      },
    });
    expect(reduceFleetState(state, { type: 'fleetMessage', id: 'a1', text: '' })).toBe(state);
  });

  // ── fleetTool (action.name undefined) ─────────────────────────────────
  it('fleetTool: handles undefined name (skips push to recentTools)', () => {
    const state = stubState({
      fleet: {
        a1: makeEntry('a1', {
          status: 'running',
          recentTools: [
            { name: 'prev', ok: true, durationMs: 10, outputBytes: 0, outputLines: 0, at: 0 },
          ],
        }) as never,
      },
    });
    const result = reduceFleetState(state, {
      type: 'fleetTool',
      id: 'a1',
      name: undefined as never,
      ok: true,
      durationMs: 5,
      outputBytes: 0,
      outputLines: 0,
    });
    expect(result!.fleet['a1']!.toolCalls).toBe(1);
    // When name is undefined, slice(-2) of existing recentTools.
    expect(result!.fleet['a1']!.recentTools).toHaveLength(1); // no new one added
  });

  // ── fleetUsage ────────────────────────────────────────────────────────
  it('fleetUsage: updates lastEventAt for known agent', () => {
    const state = stubState({ fleet: { a1: makeEntry('a1', { status: 'idle' }) as never } });
    const result = reduceFleetState(state, {
      type: 'fleetUsage',
      id: 'a1',
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(result!.fleet['a1']!.lastEventAt).toBeGreaterThan(0);
  });

  it('fleetUsage: returns state unchanged for unknown id', () => {
    const state = stubState();
    expect(
      reduceFleetState(state, {
        type: 'fleetUsage',
        id: 'unknown',
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ).toBe(state);
  });

  // ── fleetDone ─────────────────────────────────────────────────────────
  it('fleetDone: sets final status and clears streaming text', () => {
    const state = stubState({
      fleet: {
        a1: {
          id: 'a1',
          name: 'w1',
          provider: 'o',
          model: 'm',
          status: 'running',
          streamingText: 'abc',
          iterations: 0,
          toolCalls: 0,
          currentTool: { name: 'x', startedAt: 0 },
          budgetWarning: { kind: 'time', used: 100, limit: 200, at: 0 },
          recentTools: [],
          recentMessages: [],
          cost: 0,
          startedAt: 0,
          lastEventAt: 0,
          transcriptPath: undefined,
        },
      },
    });
    const result = reduceFleetState(state, {
      type: 'fleetDone',
      id: 'a1',
      status: 'success',
      iterations: 5,
      toolCalls: 3,
    });
    expect(result!.fleet['a1']!.status).toBe('success');
    expect(result!.fleet['a1']!.streamingText).toBe('');
    expect(result!.fleet['a1']!.currentTool).toBeUndefined();
    expect(result!.fleet['a1']!.budgetWarning).toBeUndefined();
  });

  it('fleetDone: preserves failureReason', () => {
    const state = stubState({
      fleet: {
        a1: makeEntry('a1', {
          status: 'running',
          currentTool: { name: 'read', startedAt: 100 },
        }) as never,
      },
    });
    const result = reduceFleetState(state, {
      type: 'fleetDone',
      id: 'a1',
      status: 'failed',
      iterations: 2,
      toolCalls: 1,
      failureReason: 'timeout',
    });
    expect(result!.fleet['a1']!.failureReason).toBe('timeout');
  });

  // ── fleetRemove ───────────────────────────────────────────────────────
  it('fleetRemove: removes the entry', () => {
    const state = stubState({ fleet: { a1: makeEntry('a1', { status: 'idle' }) as never } });
    const result = reduceFleetState(state, { type: 'fleetRemove', id: 'a1' });
    expect(result!.fleet['a1']).toBeUndefined();
  });

  it('fleetRemove: returns state unchanged for missing id', () => {
    const state = stubState();
    expect(reduceFleetState(state, { type: 'fleetRemove', id: 'nonexistent' })).toBe(state);
  });

  // ── fleetBudgetWarning ────────────────────────────────────────────────
  it('fleetBudgetWarning: sets budget warning', () => {
    const state = stubState({
      fleet: {
        a1: makeEntry('a1', {
          status: 'running',
          currentTool: { name: 'read', startedAt: 100 },
        }) as never,
      },
    });
    const result = reduceFleetState(state, {
      type: 'fleetBudgetWarning',
      id: 'a1',
      kind: 'time',
      used: 80,
      limit: 100,
    });
    expect(result!.fleet['a1']!.budgetWarning?.kind).toBe('time');
  });

  // ── fleetBudgetExtended ───────────────────────────────────────────────
  it('fleetBudgetExtended: sets extensions count', () => {
    const state = stubState({
      fleet: {
        a1: makeEntry('a1', {
          status: 'running',
          currentTool: { name: 'read', startedAt: 100 },
        }) as never,
      },
    });
    const result = reduceFleetState(state, {
      type: 'fleetBudgetExtended',
      id: 'a1',
      totalExtensions: 3,
    });
    expect(result!.fleet['a1']!.extensions).toBe(3);
  });

  // ── fleetCtxPct ──────────────────────────────────────────────────────
  it('fleetCtxPct: clamps and sets context load', () => {
    const state = stubState({
      fleet: {
        a1: makeEntry('a1', {
          status: 'running',
          currentTool: { name: 'read', startedAt: 100 },
        }) as never,
      },
    });
    const result = reduceFleetState(state, {
      type: 'fleetCtxPct',
      id: 'a1',
      load: -0.5,
      tokens: 100,
      maxContext: 200,
      ctxCost: 0.5,
    });
    expect(result!.fleet['a1']!.ctxPct).toBe(0);
  });

  // ── fleetCost ─────────────────────────────────────────────────────────
  it('fleetCost: updates fleet cost and tokens for specific agent', () => {
    const state = stubState({
      fleet: { a1: makeEntry('a1', { status: 'idle' }) as never },
      fleetCost: 0,
      fleetTokens: { input: 0, output: 0 },
    });
    const result = reduceFleetState(state, {
      type: 'fleetCost',
      id: 'a1',
      cost: 50,
      input: 100,
      output: 200,
    } as never);
    expect(result!.fleet['a1']!.cost).toBe(50);
    expect(result!.fleetCost).toBe(50);
    expect(result!.fleetTokens.input).toBe(100);
    expect(result!.fleetTokens.output).toBe(200);
  });

  it('fleetCost: updates perAgent costs', () => {
    const state = stubState({
      fleet: {
        a1: makeEntry('a1', { status: 'idle' }) as never,
        a2: makeEntry('a2', { status: 'idle' }) as never,
      },
    });
    const result = reduceFleetState(state, {
      type: 'fleetCost',
      cost: 100,
      perAgent: { a1: { cost: 40 }, a2: { cost: 60 } },
    });
    expect(result!.fleet['a1']!.cost).toBe(40);
    expect(result!.fleet['a2']!.cost).toBe(60);
  });

  it('fleetCost: preserves state identity when all reported values are unchanged', () => {
    const state = stubState({
      fleet: {
        a1: makeEntry('a1', { cost: 40, lastEventAt: 123 }) as never,
        a2: makeEntry('a2', { cost: 60, lastEventAt: 456 }) as never,
      },
      fleetCost: 100,
      fleetTokens: { input: 10, output: 20 },
    });
    const result = reduceFleetState(state, {
      type: 'fleetCost',
      cost: 100,
      input: 10,
      output: 20,
      perAgent: { a1: { cost: 40 }, a2: { cost: 60 } },
    });
    expect(result).toBe(state);
    expect(result?.fleet['a1']?.lastEventAt).toBe(123);
    expect(result?.fleet['a2']?.lastEventAt).toBe(456);
  });

  // ── fleetConcurrency ─────────────────────────────────────
  it('fleetConcurrency: sets concurrency', () => {
    const state = stubState();
    const result = reduceFleetState(state, { type: 'fleetConcurrency', n: 8 });
    expect(result).not.toBeNull();
    expect(result!.fleetConcurrency).toBe(8);
  });

  // ── fleetBatch ────────────────────────────────────────────
  it('fleetBatch: no-op returns state unchanged', () => {
    const state = stubState();
    expect(reduceFleetState(state, { type: 'fleetBatch', actions: [] })).toBe(state);
  });

  // ── Leader actions ─────────────────────────────────────────────────────
  it('leaderIterStart: increments iterations sets iterating', () => {
    const state = stubState();
    const result = reduceFleetState(state, { type: 'leaderIterStart' });
    expect(result!.leader.iterations).toBe(1);
    expect(result!.leader.iterating).toBe(true);
  });

  it('leaderIterEnd: clears iterating', () => {
    const state = stubState({
      leader: {
        iterations: 5,
        toolCalls: 3,
        recentTools: [],
        currentTool: undefined,
        startedAt: 0,
        lastEventAt: 0,
        iterating: true,
      },
    });
    const result = reduceFleetState(state, { type: 'leaderIterEnd' });
    expect(result!.leader.iterating).toBe(false);
  });

  it('leaderToolStart: sets currentTool on leader', () => {
    const state = stubState();
    const result = reduceFleetState(state, { type: 'leaderToolStart', name: 'inspect' });
    expect(result!.leader.currentTool?.name).toBe('inspect');
  });

  it('leaderToolEnd: pushes to recentTools (capped at 8)', () => {
    const state = stubState({
      leader: {
        iterations: 0,
        toolCalls: 0,
        recentTools: Array(8).fill({ name: 'prev', ok: true, durationMs: 1, at: 0 }),
        currentTool: { name: 'test', startedAt: 100 },
        startedAt: 0,
        lastEventAt: 0,
        iterating: true,
      },
    });
    const result = reduceFleetState(state, {
      type: 'leaderToolEnd',
      name: 'read',
      durationMs: 50,
      ok: true,
      outputBytes: 10,
      outputLines: 1,
      outputTokens: 0,
    } as never);
    expect(result!.leader.recentTools).toHaveLength(8);
    expect(result!.leader.toolCalls).toBe(1);
    expect(result!.leader.currentTool).toBeUndefined();
  });

  it('leaderCtxPct: clamps and sets context percentage', () => {
    const state = stubState();
    const result = reduceFleetState(state, {
      type: 'leaderCtxPct',
      load: 1.5,
      tokens: 1000,
      maxContext: 2000,
    });
    expect(result!.leader.ctxPct).toBe(1);
    expect(result!.leader.ctxTokens).toBe(1000);
  });

  it('setFleetChat: sets the fleet-chat verbosity mode', () => {
    const state = stubState();
    for (const mode of ['off', 'full'] as const) {
      const result = reduceFleetState(state, { type: 'setFleetChat', mode });
      expect(result!.fleetChat).toBe(mode);
    }
  });
});
