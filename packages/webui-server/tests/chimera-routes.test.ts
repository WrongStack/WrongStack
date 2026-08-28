import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonlReportStore } from '@wrongstack/core/plugins/review-report-store';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createChimeraRouteHandlers,
  handleChimeraRoute,
  isPendingChimeraReport,
  listChimeraReportsForSession,
  type ChimeraRouteHandlers,
} from '../src/server/chimera-routes.js';

describe('isPendingChimeraReport', () => {
  it('treats findings on a non-terminal lifecycle as pending', () => {
    expect(isPendingChimeraReport({ lifecycle: 'open', totalFindings: 2 })).toBe(true);
    expect(isPendingChimeraReport({ lifecycle: 'actioned', totalFindings: 1 })).toBe(true);
  });

  it('treats terminal lifecycles and zero-finding reports as not pending', () => {
    expect(isPendingChimeraReport({ lifecycle: 'completed', totalFindings: 4 })).toBe(false);
    expect(isPendingChimeraReport({ lifecycle: 'skipped', totalFindings: 1 })).toBe(false);
    expect(isPendingChimeraReport({ lifecycle: 'open', totalFindings: 0 })).toBe(false);
  });
});

describe('listChimeraReportsForSession', () => {
  let projectDir = '';

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), 'chimera-routes-'));
    const store = new JsonlReportStore(projectDir);
    const base = {
      agentId: 'chimera-review',
      reviewerModel: 'test-model',
      source: 'chimera' as const,
      reviewStatus: 'success' as const,
      files: [],
      counts: { critical: 0, high: 2, medium: 0, low: 0 },
      unparseableCount: 0,
      rawText: '## 🦂 Chimera Review',
    };
    await store.persist({ ...base, id: 'r1', sessionId: 'sess-1', totalFindings: 2 });
    await store.persist({ ...base, id: 'r2', sessionId: 'sess-1', totalFindings: 0 });
    await store.persist({ ...base, id: 'r3', sessionId: 'sess-2', totalFindings: 5 });
  });

  afterAll(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('lists only the named session and only pending reports', async () => {
    const sess1 = await listChimeraReportsForSession(projectDir, 'sess-1');
    expect(sess1).toHaveLength(1);
    expect(sess1[0]).toMatchObject({ reportId: 'r1', totalFindings: 2, lifecycleStatus: 'open' });

    const sess2 = await listChimeraReportsForSession(projectDir, 'sess-2');
    expect(sess2.map((r) => r.reportId)).toEqual(['r3']);
  });

  it('answers an unknown session with an empty list', async () => {
    expect(await listChimeraReportsForSession(projectDir, 'nope')).toEqual([]);
  });
});

describe('handleChimeraRoute', () => {
  it('routes the list request and rejects other types', async () => {
    const handlers: ChimeraRouteHandlers = { listReports: vi.fn().mockResolvedValue(undefined) };
    const ws = {} as never;
    expect(await handleChimeraRoute(ws, { type: 'chimera.reports.list', payload: {} }, handlers)).toBe(true);
    expect(handlers.listReports).toHaveBeenCalledOnce();
    expect(await handleChimeraRoute(ws, { type: 'git.changes', payload: {} }, handlers)).toBe(false);
  });
});

describe('createChimeraRouteHandlers.listReports', () => {
  let projectDir = '';
  let stored = 0;

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), 'chimera-routes-handlers-'));
    const store = new JsonlReportStore(projectDir);
    await store.persist({
      id: 'r9',
      sessionId: 'sess-9',
      totalFindings: 3,
      agentId: 'chimera-review',
      reviewerModel: 'test-model',
      source: 'chimera',
      reviewStatus: 'success',
      files: [],
      counts: { critical: 1, high: 0, medium: 0, low: 0 },
      unparseableCount: 0,
      rawText: 'x',
    });
    stored += 1;
  });

  afterAll(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  function makeHarness() {
    const send = vi.fn();
    const log = vi.fn();
    const handlers = createChimeraRouteHandlers({
      projectDir: () => projectDir,
      send: send as (ws: never, msg: { type: string; payload: unknown }) => void,
      log,
    });
    const ws = {} as never;
    return { send, log, handlers, ws };
  }

  it('answers with the pending report list for the named session', async () => {
    const { send, handlers, ws } = makeHarness();
    await handlers.listReports(ws, { type: 'chimera.reports.list', payload: { sessionId: 'sess-9' } });
    expect(send).toHaveBeenCalledOnce();
    const frame = send.mock.calls[0]?.[1] as { type: string; payload: { sessionId: string; reports: unknown[] } };
    expect(frame.type).toBe('chimera.reports');
    expect(frame.payload.sessionId).toBe('sess-9');
    expect(frame.payload.reports).toHaveLength(stored);
  });

  it('stays silent when the request names no session', async () => {
    const { send, handlers, ws } = makeHarness();
    await handlers.listReports(ws, { type: 'chimera.reports.list', payload: {} });
    expect(send).not.toHaveBeenCalled();
  });

  it('answers with an empty list instead of erroring when the store is unreadable', async () => {
    const send = vi.fn();
    const log = vi.fn();
    const handlers = createChimeraRouteHandlers({
      projectDir: () => {
        throw new Error('store gone');
      },
      send: send as (ws: never, msg: { type: string; payload: unknown }) => void,
      log,
    });
    const ws = {} as never;
    await handlers.listReports(ws, { type: 'chimera.reports.list', payload: { sessionId: 'sess-9' } });
    const frame = send.mock.calls[0]?.[1] as { payload: { reports: unknown[] } };
    expect(frame.payload.reports).toEqual([]);
    expect(log).toHaveBeenCalledOnce();
  });
});
