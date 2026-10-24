/**
 * Regression tests for the R2 bug-hunt round: `executeListSessions` (and its
 * sibling `executeListFilteredSessions`) used to forward a caller-controlled
 * `limit` raw into `Array.slice`. A WebUI WS payload limit of -1 silently
 * dropped the newest session, NaN returned an empty page, Infinity returned
 * everything, and string values coerced through slice(). The fix clamps at
 * the module boundary via `clampListLimit`: non-number/non-finite -> fallback
 * (20/100), negative -> 0 (empty page, matching the catalog RPC's bounded
 * limit), otherwise floor.
 */

import type { SessionSummary } from '@wrongstack/contracts/types/session';
import { describe, expect, it } from 'vitest';
import {
  executeListSessions,
  type ListSessionsHost,
} from '../../src/storage/session-store/list-sessions.js';

const TOTAL = 25;
const POOL_PAGE = 20;

function mkSummary(i: number): SessionSummary {
  return {
    id: `s-${String(i).padStart(2, '0')}`,
    title: `session ${i}`,
    startedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
    model: 'test-model',
    provider: 'test-provider',
    tokenTotal: 0,
  };
}

function makeHost(): ListSessionsHost {
  const pool: SessionSummary[] = Array.from({ length: TOTAL }, (_, i) => mkSummary(i));
  return {
    readIndex: async () => pool,
    listFromDirectoryScan: async () => pool,
    scrubSummaries: (rows) => [...rows],
    getIndexDeletedIds: () => new Set<string>(),
  };
}

describe('executeListSessions untrusted limit handling', () => {
  it('honors a valid limit', async () => {
    expect(await executeListSessions(makeHost(), 3)).toHaveLength(3);
  });

  it('limit 0 yields an empty page', async () => {
    expect(await executeListSessions(makeHost(), 0)).toHaveLength(0);
  });

  it('negative limit -> empty page (catalog parity), NOT drop-the-newest', async () => {
    expect(await executeListSessions(makeHost(), -1)).toHaveLength(0);
  });

  it('Infinity -> default page (20), NOT everything', async () => {
    expect(await executeListSessions(makeHost(), Infinity)).toHaveLength(POOL_PAGE);
  });

  it('NaN -> default page (20), NOT empty', async () => {
    expect(await executeListSessions(makeHost(), NaN)).toHaveLength(POOL_PAGE);
  });

  it('string limit from a WS payload -> default (20), NOT slice coercion', async () => {
    expect(await executeListSessions(makeHost(), '7' as unknown as number)).toHaveLength(POOL_PAGE);
  });

  it('omitted limit still defaults to 20', async () => {
    expect(await executeListSessions(makeHost())).toHaveLength(POOL_PAGE);
  });
});
