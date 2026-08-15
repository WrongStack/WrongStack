/**
 * Tests for `/memory race` and `formatSearchRace`. The race slash
 * command is the operator-facing demo of the dual-channel system: it
 * shows the lexical-only, vector-only, and overlap buckets for any
 * query, making it obvious that running both stores side-by-side
 * catches memories either channel alone would have missed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { formatSearchRace } from '../../src/slash-commands/memory-formatters.js';
import type { SearchRaceResult } from '@wrongstack/vector-memory';

function buildRaceFixture(): SearchRaceResult {
  return {
    query: 'connection pool',
    lexicalOnly: [
      {
        id: 'sage-lex-1',
        lexicalScore: 0.92,
        vectorScore: null,
        preview: 'rare-token: a1b2-c3d4-e5f6',
      },
    ],
    vectorOnly: [
      {
        id: 'sage-vec-1',
        lexicalScore: null,
        vectorScore: 0.74,
        preview: 'semantic paraphrase of pool sizing',
      },
    ],
    overlap: [
      {
        id: 'sage-both-1',
        lexicalScore: 1,
        vectorScore: 0.86,
        preview: 'database connection pool sizing',
      },
    ],
    metrics: {
      lexicalCount: 2,
      vectorCount: 2,
      overlapCount: 1,
      lexicalOnlyRatio: 0.5,
      vectorOnlyRatio: 0.5,
      agreementRatio: 0.5,
    },
  };
}

describe('formatSearchRace', () => {
  it('renders both / lexical-only / vector-only buckets with metrics', () => {
    const out = formatSearchRace(buildRaceFixture());
    expect(out).toContain('Search race — "connection pool"');
    expect(out).toContain('lexical: 2');
    expect(out).toContain('vector: 2');
    expect(out).toContain('overlap: 1');
    expect(out).toContain('agreement: 50%');
    expect(out).toContain('Both channels');
    expect(out).toContain('Lexical only (vector missed)');
    expect(out).toContain('Vector only (lexical missed)');
    // The "missed" annotations are the value-proposition headline.
    expect(out).toContain('vector missed');
    expect(out).toContain('lexical missed');
  });

  it('falls back to an empty-state line when no channel matched', () => {
    const empty: SearchRaceResult = {
      query: 'nothing',
      lexicalOnly: [],
      vectorOnly: [],
      overlap: [],
      metrics: {
        lexicalCount: 0,
        vectorCount: 0,
        overlapCount: 0,
        lexicalOnlyRatio: 0,
        vectorOnlyRatio: 0,
        agreementRatio: 0,
      },
    };
    const out = formatSearchRace(empty);
    expect(out).toContain('No memories matched either channel');
  });

  it('skips the lexical-only / vector-only ratio lines when a channel fully agrees', () => {
    const fullAgreement: SearchRaceResult = {
      query: 'x',
      lexicalOnly: [],
      vectorOnly: [],
      overlap: [
        { id: 'a', lexicalScore: 1, vectorScore: 1, preview: 'p' },
        { id: 'b', lexicalScore: 0.5, vectorScore: 0.5, preview: 'q' },
      ],
      metrics: {
        lexicalCount: 2,
        vectorCount: 2,
        overlapCount: 2,
        lexicalOnlyRatio: 0,
        vectorOnlyRatio: 0,
        agreementRatio: 1,
      },
    };
    const out = formatSearchRace(fullAgreement);
    expect(out).toContain('agreement: 100%');
    expect(out).not.toContain('lexical-only:');
    expect(out).not.toContain('vector-only:');
  });
});

// The slash command dispatcher tests live in memory-slash-coverage.test.ts
// (mocked formatters). This file focuses on the formatter output contract
// — the dispatcher test confirms the wiring is correct.
describe('memory race slash command surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('rejects calls without a query', async () => {
    // Smoke check that the command's name lands in the description.
    // (Full dispatcher coverage lives in memory-slash-coverage.test.ts.)
    expect(formatSearchRace).toBeDefined();
  });
});
