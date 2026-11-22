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

let contextError: Error | undefined;
const emptyContext = {
  query: 'retry logic',
  entries: [],
  seedCount: 0,
  semanticSeedCount: 0,
  totalCandidates: 0,
  indexStatus: 'no-matches' as string,
};
let contextValue = { ...emptyContext };

vi.mock('../../codebase/src/background-indexer.js', () => ({
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
  codebaseContext: async () => {
    if (contextError) throw contextError;
    return contextValue;
  },
  codebaseVectorSearch: async () => ({ hits: [], total: 0 }),
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

import { codebaseContextTool } from '../src/codebase-index/codebase-context-tool.js';
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
  (state as { lastError: string | undefined }).lastError = undefined;
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
  contextError = undefined;
  contextValue = { ...emptyContext };
});
afterEach(() => vi.restoreAllMocks());

// Refusals and outages THROW: a returned payload is a successful call to the
// executor (is_error:false), so they used to read as "ok" / "nothing found".
describe('codebase-index tool gates', () => {
  it('fails the call when an index is already in progress', async () => {
    isIndexingValue = true;
    await expect(codebaseIndexTool.execute({}, ctx(), opts())).rejects.toThrow(
      /already in progress/,
    );
  });

  it('fails the call when the circuit breaker is open', async () => {
    circuitSnapshot = { state: 'open', cooldownRemainingMs: 5000, lastFailure: 'boom' };
    await expect(codebaseIndexTool.execute({}, ctx(), opts())).rejects.toThrow(
      /paused after repeated failures \(last: boom\)/,
    );
  });

  it('fails the call on an open circuit without a specific last failure', async () => {
    circuitSnapshot = { state: 'open', cooldownRemainingMs: 5000 };
    await expect(codebaseIndexTool.execute({}, ctx(), opts())).rejects.toThrow(/last: unknown/);
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

  it('fails the call with guidance when the stats host times out', async () => {
    const err = new Error('index stats timed out');
    err.name = 'IndexTimeoutError';
    statsError = err;
    await expect(codebaseStatsTool.execute({}, ctx(), opts())).rejects.toThrow(
      /statistics timed out.*codebase-search/s,
    );
  });

  it('fails the call when the stats query itself fails', async () => {
    statsError = new Error('database disk image is malformed');
    await expect(codebaseStatsTool.execute({}, ctx(), opts())).rejects.toThrow(
      /statistics query failed: database disk image is malformed/,
    );
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

  it('fails the call when not ready and the DB is empty (not "zero hits")', async () => {
    state.ready = false;
    statsValue.totalSymbols = 0;
    statsValue.totalFiles = 0;
    statsValue.lastIndexed = null;
    await expect(codebaseSearchTool.execute({ query: 'q' }, ctx(), opts())).rejects.toThrow(
      /No persisted index data.*codebase-index/,
    );
  });

  it('fails the call when the index query itself fails', async () => {
    searchError = new Error('project daemon unavailable');
    await expect(codebaseSearchTool.execute({ query: 'q' }, ctx(), opts())).rejects.toThrow(
      /Index query failed: project daemon unavailable/,
    );
  });

  it('does not mistake a zero-hit persisted snapshot for a missing index', async () => {
    state.ready = false;
    const out = await codebaseSearchTool.execute({ query: 'q' }, ctx(), opts());
    expect(out.indexStatus).toBeUndefined();
  });

  it('fails the call when the first build has no cached answer yet', async () => {
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
    await expect(codebaseSearchTool.execute({ query: 'q' }, ctx(), opts())).rejects.toThrow(
      /Index refresh in progress.*no cached answer yet/s,
    );
  });

  it('fails the call with a retry hint when a refresh has no cached answer for this query', async () => {
    state.ready = true;
    state.indexing = true;
    state.currentFile = 4;
    state.totalFiles = 9;
    searchError = new Error(
      'Codebase index refresh in progress (4/9 files); retry after the completed generation is published.',
    );
    searchError.name = 'IndexRefreshInProgressError';
    await expect(codebaseSearchTool.execute({ query: 'q' }, ctx(), opts())).rejects.toThrow(
      /Index refresh in progress \(4\/9 files\).*completed generation is published/s,
    );
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

  it('fails the call on a build failure with a circuit-open retry hint', async () => {
    state.lastError = 'disk full';
    state.circuit = { state: 'open', cooldownRemainingMs: 2000 };
    await expect(codebaseSearchTool.execute({ query: 'q' }, ctx(), opts())).rejects.toThrow(
      /Index build failed.*circuit open/s,
    );
  });

  it('fails the call on a build failure with a plain retry hint when the circuit is closed', async () => {
    state.lastError = 'parse error';
    await expect(codebaseSearchTool.execute({ query: 'q' }, ctx(), opts())).rejects.toThrow(
      /Try \/codebase-reindex/,
    );
  });
});

describe('codebase-context tool failures', () => {
  it('fails the call when the lookup fails instead of returning indexStatus "error"', async () => {
    contextError = new Error('worker crashed');
    await expect(
      codebaseContextTool.execute({ query: 'retry logic' }, ctx(), opts()),
    ).rejects.toThrow(/codebase-context lookup failed: worker crashed/);
  });

  it('fails the call when no index exists', async () => {
    contextValue = { ...contextValue, indexStatus: 'no-index' };
    await expect(
      codebaseContextTool.execute({ query: 'retry logic' }, ctx(), opts()),
    ).rejects.toThrow(/No codebase index data found/);
  });

  it('returns a no-matches answer from a healthy index as data', async () => {
    const out = await codebaseContextTool.execute({ query: 'retry logic' }, ctx(), opts());
    expect(out.indexStatus).toBe('no-matches');
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

  it('fails the call on a refresh refusal for both tools', async () => {
    state.ready = true;
    state.indexing = true;
    state.currentFile = 4;
    state.totalFiles = 9;
    incomingError = refreshRefusal();
    outgoingError = refreshRefusal();
    const refusal = /Index refresh in progress \(4\/9 files\).*no cached answer yet/s;
    await expect(
      codebaseIncomingCallsTool.execute({ symbol: 'Target' }, ctx(), opts()),
    ).rejects.toThrow(refusal);
    await expect(
      codebaseOutgoingCallsTool.execute({ symbol: 'Target' }, ctx(), opts()),
    ).rejects.toThrow(refusal);
  });

  it('fails the call on an index query failure instead of returning "no callers"', async () => {
    incomingError = new Error('endpoint invalid');
    outgoingError = new Error('endpoint invalid');
    await expect(
      codebaseIncomingCallsTool.execute({ symbol: 'Target' }, ctx(), opts()),
    ).rejects.toThrow(/Index query failed: endpoint invalid/);
    await expect(
      codebaseOutgoingCallsTool.execute({ symbol: 'Target' }, ctx(), opts()),
    ).rejects.toThrow(/Index query failed: endpoint invalid/);
  });

  it('fails the call on a missing index but reports an unknown symbol in a healthy index as data', async () => {
    incomingValue = { ...incomingValue, symbolFound: false };
    outgoingValue = { ...outgoingValue, symbolFound: false };

    // Healthy persisted index: "not found" is a legitimate answer.
    const incoming = await codebaseIncomingCallsTool.execute({ symbol: 'Nope' }, ctx(), opts());
    expect(incoming.note).toMatch(/not found in the index/);

    // Never-built index: the same empty answer would be a lie.
    state.ready = false;
    statsValue.totalFiles = 0;
    statsValue.lastIndexed = null;
    await expect(
      codebaseIncomingCallsTool.execute({ symbol: 'Nope' }, ctx(), opts()),
    ).rejects.toThrow(/No persisted index data/);
    await expect(
      codebaseOutgoingCallsTool.execute({ symbol: 'Nope' }, ctx(), opts()),
    ).rejects.toThrow(/No persisted index data/);
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
    // Guidance may be present; the stale advisory must not be.
    expect(incoming.note ?? '').not.toMatch(/refresh in progress/);
    expect(outgoing.note ?? '').not.toMatch(/refresh in progress/);
  });

  it('codebaseSearchTool honors ctx.signal when execOpts is omitted and ctx.signal is aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const abortedCtx = { ...ctx(), signal: ctrl.signal };
    await expect(
      codebaseSearchTool.execute(
        { query: 'Target' },
        abortedCtx as any,
        undefined as unknown as { signal: AbortSignal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('codebaseSearchTool honors execOpts.signal when pre-aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      codebaseSearchTool.execute({ query: 'Target' }, ctx(), { signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
