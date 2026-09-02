import type { Context } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Control the index host's reported state so each status-gate branch of the
// three codebase tools runs without a real SQLite index / worker.
type Circuit = { state: string; cooldownRemainingMs: number; lastFailure?: string };
const state: {
  ready: boolean;
  indexing: boolean;
  currentFile: number;
  totalFiles: number;
  lastError?: string;
  circuit: Circuit;
} = {
  ready: true,
  indexing: false,
  currentFile: 0,
  totalFiles: 0,
  circuit: { state: 'closed', cooldownRemainingMs: 0 },
};

let isIndexingValue = false;
let statsError: Error | undefined;
let statsCalls = 0;
const statsValue = {
  totalSymbols: 5,
  totalFiles: 2,
  byLang: { ts: 5 },
  byKind: { function: 5 },
  lastIndexed: 1 as number | null,
  sizeBytes: 100,
  indexPath: '/x',
  version: 1,
};
let circuitSnapshot: Circuit = { state: 'closed', cooldownRemainingMs: 0 };

/** Configurable search answer so stale-serve / refusal paths can be simulated. */
let searchError: Error | undefined;
let searchValue: { results: never[]; total: number; stale?: boolean } = {
  results: [],
  total: 0,
};

/** Same configurability for the call-graph services. */
let incomingError: Error | undefined;
let incomingValue: {
  calls: never[];
  symbolFound: boolean;
  ambiguous: boolean;
  totalMatches: number;
  stale?: boolean;
} = {
  calls: [],
  symbolFound: true,
  ambiguous: false,
  totalMatches: 0,
};
let outgoingError: Error | undefined;
let outgoingValue: {
  calls: never[];
  symbolFound: boolean;
  unresolvedCount: number;
  totalMatches: number;
  stale?: boolean;
} = {
  calls: [],
  symbolFound: true,
  unresolvedCount: 0,
  totalMatches: 0,
};

vi.mock('../src/codebase-index/background-indexer.js', () => ({
  getIndexState: () => state,
  isIndexing: () => isIndexingValue,
  codebaseIndexStats: async () => {
    statsCalls += 1;
    if (statsError) throw statsError;
    return statsValue;
  },
  searchCodebaseIndex: async () => {
    if (searchError) throw searchError;
    return searchValue;
  },
  incomingCallsService: async () => {
    if (incomingError) throw incomingError;
    return incomingValue;
  },
  outgoingCallsService: async () => {
    if (outgoingError) throw outgoingError;
    return outgoingValue;
  },
  runStartupIndex: async () => ({
    filesIndexed: 1,
    symbolsIndexed: 1,
    langStats: {},
    durationMs: 1,
    errors: [],
  }),
}));

vi.mock('../src/codebase-index/circuit-breaker.js', () => ({
  IndexTimeoutError: class IndexTimeoutError extends Error {
    override name = 'IndexTimeoutError';
  },
  indexCircuitBreaker: { snapshot: () => circuitSnapshot },
}));

import { codebaseIncomingCallsTool } from '../src/codebase-index/codebase-incoming-calls-tool.js';
import { codebaseIndexTool } from '../src/codebase-index/codebase-index-tool.js';
import { codebaseOutgoingCallsTool } from '../src/codebase-index/codebase-outgoing-calls-tool.js';
import { codebaseSearchTool } from '../src/codebase-index/codebase-search-tool.js';
import { codebaseStatsTool } from '../src/codebase-index/codebase-stats-tool.js';

const ctx = () => ({ cwd: '/p', projectRoot: '/p', tools: [], meta: {} }) as never as Context;
const opts = () => ({ signal: new AbortController().signal });

beforeEach(() => {
  state.ready = true;
  state.indexing = false;
  state.currentFile = 0;
  state.totalFiles = 0;
  state.lastError = undefined;
  state.circuit = { state: 'closed', cooldownRemainingMs: 0 };
  isIndexingValue = false;
  statsError = undefined;
  statsCalls = 0;
  circuitSnapshot = { state: 'closed', cooldownRemainingMs: 0 };
  statsValue.totalSymbols = 5;
  statsValue.totalFiles = 2;
  statsValue.lastIndexed = 1;
  searchError = undefined;
  searchValue = { results: [], total: 0 };
  incomingError = undefined;
  incomingValue = { calls: [], symbolFound: true, ambiguous: false, totalMatches: 0 };
  outgoingError = undefined;
  outgoingValue = { calls: [], symbolFound: true, unresolvedCount: 0, totalMatches: 0 };
});
afterEach(() => vi.restoreAllMocks());

describe('codebase-index tool gates', () => {
  it('reports when an index is already in progress', async () => {
    isIndexingValue = true;
    const out = await codebaseIndexTool.execute({}, ctx(), opts());
    expect(out.note).toMatch(/already in progress/);
  });

  it('reports when the circuit breaker is open', async () => {
    circuitSnapshot = { state: 'open', cooldownRemainingMs: 5000, lastFailure: 'boom' };
    const out = await codebaseIndexTool.execute({}, ctx(), opts());
    expect(out.note).toMatch(/paused after repeated failures/);
  });

  it('reports open circuit without a specific last failure', async () => {
    circuitSnapshot = { state: 'open', cooldownRemainingMs: 5000 };
    const out = await codebaseIndexTool.execute({}, ctx(), opts());
    expect(out.note).toContain('last: unknown');
  });

  it('runs the indexer when not gated', async () => {
    const out = await codebaseIndexTool.execute({}, ctx(), opts());
    expect(out.filesIndexed).toBe(1);
  });
});

describe('codebase-stats tool gates', () => {
  it('keeps the outer tool timeout above the index host read watchdog', () => {
    expect(codebaseStatsTool.timeoutMs).toBeGreaterThan(30_000);
  });

  it('reports "not yet built" when the persisted index has no data', async () => {
    state.ready = false;
    statsValue.totalSymbols = 0;
    statsValue.totalFiles = 0;
    statsValue.lastIndexed = null;
    const out = await codebaseStatsTool.execute({}, ctx(), opts());
    expect(out.indexStatus).toMatch(/No persisted index data.*codebase-index/);
    expect(out.totalSymbols).toBe(0);
  });

  it('reports indexing-in-progress when persisting data is in flight', async () => {
    state.ready = false;
    state.indexing = true;
    state.currentFile = 3;
    state.totalFiles = 10;
    const out = await codebaseStatsTool.execute({}, ctx(), opts());
    expect(out.indexStatus).toMatch(/Startup indexing in progress/);
    expect(out.statsAvailable).toBe(false);
    expect(out.indexing).toEqual({ currentFile: 3, totalFiles: 10 });
    expect(statsCalls).toBe(0);
  });

  it('reports refresh-in-progress when ready and indexing', async () => {
    state.indexing = true;
    const out = await codebaseStatsTool.execute({}, ctx(), opts());
    expect(out.indexStatus).toMatch(/refresh in progress/);
    expect(out.statsAvailable).toBe(false);
    expect(statsCalls).toBe(0);
  });

  it('returns structured guidance instead of throwing when the stats host times out', async () => {
    const err = new Error('index stats timed out');
    err.name = 'IndexTimeoutError';
    statsError = err;
    const out = await codebaseStatsTool.execute({}, ctx(), opts());
    expect(out.indexStatus).toMatch(/statistics timed out.*codebase-search/s);
    expect(out.statsAvailable).toBe(false);
  });

  it('appends a paused note when the circuit is open', async () => {
    state.circuit = { state: 'open', cooldownRemainingMs: 3000, lastFailure: 'x' };
    const out = await codebaseStatsTool.execute({}, ctx(), opts());
    expect(out.indexStatus).toMatch(/paused after repeated failures/);
    expect(out.totalSymbols).toBe(statsValue.totalSymbols);
  });

  it('handles open circuit without a lastFailure value', async () => {
    state.circuit = { state: 'open', cooldownRemainingMs: 3000 };
    const out = await codebaseStatsTool.execute({}, ctx(), opts());
    expect(out.indexStatus).toContain('unknown');
    expect(out.totalSymbols).toBe(statsValue.totalSymbols);
  });

  it('returns plain stats when ready and healthy', async () => {
    const out = await codebaseStatsTool.execute({}, ctx(), opts());
    expect(out.totalSymbols).toBe(statsValue.totalSymbols);
    expect(out.indexStatus).toBeUndefined();
  });
});

describe('codebase-search tool gates', () => {
  it('keeps the outer tool timeout above the index host read watchdog', () => {
    expect(codebaseSearchTool.timeoutMs).toBeGreaterThan(30_000);
  });

  it('reports no persisted data when not ready and DB is empty', async () => {
    state.ready = false;
    statsValue.totalSymbols = 0;
    statsValue.totalFiles = 0;
    statsValue.lastIndexed = null;
    const out = await codebaseSearchTool.execute({ query: 'q' }, ctx(), opts());
    expect(out.indexStatus).toMatch(/No persisted index data/);
  });

  it('does not mistake a zero-hit persisted snapshot for a missing index', async () => {
    state.ready = false;
    const out = await codebaseSearchTool.execute({ query: 'q' }, ctx(), opts());
    expect(out.indexStatus).toBeUndefined();
  });

  it('reports refresh-in-progress when the first build has no cached answer yet', async () => {
    // First build: nothing was ever indexed, so the server has no cached
    // answer to serve stale and refuses with IndexRefreshInProgressError.
    state.ready = false;
    state.indexing = true;
    state.currentFile = 0;
    state.totalFiles = 0;
    searchError = new Error(
      'Codebase index refresh in progress (0/0 files); retry after the completed generation is published.',
    );
    searchError.name = 'IndexRefreshInProgressError';
    const out = await codebaseSearchTool.execute({ query: 'q' }, ctx(), opts());
    expect(out.indexStatus).toMatch(/Index refresh in progress/);
    expect(out.indexStatus).toMatch(/no cached answer yet/);
    expect(out.results).toEqual([]);
  });

  it('refuses gracefully when a refresh has no cached answer for this query', async () => {
    state.ready = true;
    state.indexing = true;
    state.currentFile = 4;
    state.totalFiles = 9;
    searchError = new Error(
      'Codebase index refresh in progress (4/9 files); retry after the completed generation is published.',
    );
    searchError.name = 'IndexRefreshInProgressError';
    const out = await codebaseSearchTool.execute({ query: 'q' }, ctx(), opts());
    expect(out.indexStatus).toMatch(/Index refresh in progress \(4\/9 files\)/);
    expect(out.indexStatus).toMatch(/completed generation is published/);
  });

  it('serves a stale previous-generation answer during a refresh instead of refusing', async () => {
    state.ready = true;
    state.indexing = true;
    state.currentFile = 4;
    state.totalFiles = 9;
    searchValue = { results: [], total: 3, stale: true };
    const out = await codebaseSearchTool.execute({ query: 'q' }, ctx(), opts());
    expect(out.stale).toBe(true);
    expect(out.total).toBe(3);
    expect(out.indexStatus).toMatch(/previous generation/);
    expect(out.indexStatus).toMatch(/\(4\/9 files\)/);
  });

  it('does not flag staleness on a fresh answer', async () => {
    state.ready = true;
    state.indexing = true;
    searchValue = { results: [], total: 1 };
    const out = await codebaseSearchTool.execute({ query: 'q' }, ctx(), opts());
    expect(out.stale).toBeUndefined();
    expect(out.indexStatus).toBeUndefined();
  });

  it('reports a build failure with a circuit-open retry hint', async () => {
    state.lastError = 'disk full';
    state.circuit = { state: 'open', cooldownRemainingMs: 2000 };
    const out = await codebaseSearchTool.execute({ query: 'q' }, ctx(), opts());
    expect(out.indexStatus).toMatch(/Index build failed.*circuit open/s);
  });

  it('reports a build failure with a plain retry hint when the circuit is closed', async () => {
    state.lastError = 'parse error';
    const out = await codebaseSearchTool.execute({ query: 'q' }, ctx(), opts());
    expect(out.indexStatus).toMatch(/Try \/codebase-reindex/);
  });
});

describe('codebase call-graph tool gates', () => {
  function refreshRefusal(): Error {
    const error = new Error(
      'Codebase index refresh in progress (4/9 files); retry after the completed generation is published.',
    );
    error.name = 'IndexRefreshInProgressError';
    return error;
  }

  it('degrades a refresh refusal to a friendly status for both tools', async () => {
    state.ready = true;
    state.indexing = true;
    state.currentFile = 4;
    state.totalFiles = 9;
    incomingError = refreshRefusal();
    outgoingError = refreshRefusal();
    const incoming = await codebaseIncomingCallsTool.execute({ symbol: 'Target' }, ctx(), opts());
    const outgoing = await codebaseOutgoingCallsTool.execute({ symbol: 'Target' }, ctx(), opts());
    expect(incoming.indexStatus).toMatch(/Index refresh in progress \(4\/9 files\)/);
    expect(incoming.indexStatus).toMatch(/no cached answer yet/);
    expect(outgoing.indexStatus).toMatch(/Index refresh in progress \(4\/9 files\)/);
    expect(outgoing.indexStatus).toMatch(/no cached answer yet/);
    expect(incoming.calls).toEqual([]);
    expect(outgoing.calls).toEqual([]);
  });

  it('serves stale previous-generation callers/callees during a refresh instead of refusing', async () => {
    state.ready = true;
    state.indexing = true;
    state.currentFile = 4;
    state.totalFiles = 9;
    incomingValue = {
      calls: [],
      symbolFound: true,
      ambiguous: false,
      totalMatches: 5,
      stale: true,
    };
    outgoingValue = {
      calls: [],
      symbolFound: true,
      unresolvedCount: 0,
      totalMatches: 3,
      stale: true,
    };
    const incoming = await codebaseIncomingCallsTool.execute({ symbol: 'Target' }, ctx(), opts());
    const outgoing = await codebaseOutgoingCallsTool.execute({ symbol: 'Target' }, ctx(), opts());
    expect(incoming.stale).toBe(true);
    expect(incoming.note).toMatch(/previous generation/);
    expect(outgoing.stale).toBe(true);
    expect(outgoing.note).toMatch(/previous generation/);
  });

  it('appends the stale note after cap/ambiguity notes rather than clobbering them', async () => {
    state.ready = true;
    state.indexing = true;
    incomingValue = {
      calls: [],
      symbolFound: true,
      ambiguous: true,
      totalMatches: 500, // > default limit 50 → cap note
      stale: true,
    };
    const out = await codebaseIncomingCallsTool.execute({ symbol: 'Target' }, ctx(), opts());
    expect(out.note).toMatch(/Results capped at 50 of 500/);
    expect(out.note).toMatch(/exists in multiple files/);
    expect(out.note).toMatch(/previous generation/);
  });

  it('does not flag staleness on fresh call-graph answers', async () => {
    state.ready = true;
    state.indexing = true;
    const incoming = await codebaseIncomingCallsTool.execute({ symbol: 'Target' }, ctx(), opts());
    const outgoing = await codebaseOutgoingCallsTool.execute({ symbol: 'Target' }, ctx(), opts());
    expect(incoming.stale).toBeUndefined();
    expect(outgoing.stale).toBeUndefined();
    expect(incoming.note).toBeUndefined();
    expect(outgoing.note).toBeUndefined();
  });

  it('codebaseSearchTool honors ctx.signal when execOpts is omitted and ctx.signal is aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const abortedCtx = { ...ctx(), signal: ctrl.signal };
    await expect(codebaseSearchTool.execute({ query: 'Target' }, abortedCtx)).rejects.toMatchObject(
      { name: 'AbortError' },
    );
  });

  it('codebaseSearchTool honors execOpts.signal when pre-aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      codebaseSearchTool.execute({ query: 'Target' }, ctx(), { signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
