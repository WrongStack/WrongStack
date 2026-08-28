import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonlFindingStore, JsonlReportStore } from '@wrongstack/core/plugin';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  createChimeraRouteHandlers,
  handleChimeraRoute,
  isPendingChimeraReport,
  listChimeraReportsForSession,
  queryAllChimeraReports,
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

describe('listChimeraReportsForSession and queryAllChimeraReports', () => {
  let projectDir = '';

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), 'chimera-routes-'));
    const store = new JsonlReportStore(projectDir);
    const base = {
      agentId: 'chimera-review',
      reviewerModel: 'test-model',
      source: 'chimera' as const,
      reviewStatus: 'success' as const,
      files: [{ path: 'src/index.ts', status: 'modified' as const }],
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

  it('queries all reports across sessions', async () => {
    const all = await queryAllChimeraReports(projectDir);
    expect(all).toHaveLength(3);
  });

  it('queries reports filtered by session', async () => {
    const sess1 = await queryAllChimeraReports(projectDir, { sessionId: 'sess-1' });
    expect(sess1).toHaveLength(2);
  });
});

describe('handleChimeraRoute', () => {
  it('routes chimera requests and rejects other types', async () => {
    const handlers: ChimeraRouteHandlers = {
      listReports: vi.fn().mockResolvedValue(undefined),
      getReport: vi.fn().mockResolvedValue(undefined),
      transitionReport: vi.fn().mockResolvedValue(undefined),
      addReportNote: vi.fn().mockResolvedValue(undefined),
      transitionFinding: vi.fn().mockResolvedValue(undefined),
    };
    const ws = {} as never;
    expect(await handleChimeraRoute(ws, { type: 'chimera.reports.list', payload: {} }, handlers)).toBe(true);
    expect(await handleChimeraRoute(ws, { type: 'chimera.report.get', payload: {} }, handlers)).toBe(true);
    expect(await handleChimeraRoute(ws, { type: 'chimera.report.transition', payload: {} }, handlers)).toBe(true);
    expect(await handleChimeraRoute(ws, { type: 'chimera.report.add_note', payload: {} }, handlers)).toBe(true);
    expect(await handleChimeraRoute(ws, { type: 'chimera.finding.transition', payload: {} }, handlers)).toBe(true);
    expect(await handleChimeraRoute(ws, { type: 'git.changes', payload: {} }, handlers)).toBe(false);
  });
});

describe('createChimeraRouteHandlers operations', () => {
  let projectDir = '';

  beforeAll(async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), 'chimera-routes-ops-'));
    const reportStore = new JsonlReportStore(projectDir);
    const findingStore = new JsonlFindingStore(projectDir);

    await reportStore.persist({
      id: 'r9',
      sessionId: 'sess-9',
      totalFindings: 1,
      agentId: 'chimera-review',
      reviewerModel: 'test-model',
      source: 'chimera',
      reviewStatus: 'success',
      files: [{ path: 'src/app.ts', status: 'modified' }],
      counts: { critical: 1, high: 0, medium: 0, low: 0 },
      unparseableCount: 0,
      rawText: '## 🦂 Chimera Review\n### Critical (1)\n1. Bug',
    });

    await findingStore.upsert(
      [
        {
          id: 'f-1',
          fingerprint: 'fp-1',
          severity: 'critical',
          source: 'chimera',
          location: { file: 'src/app.ts', line: 10 },
          title: 'Null dereference',
          description: 'Null check missing',
          suggestedFix: 'Add guard',
          createdAt: new Date().toISOString(),
          status: 'active',
          originReport: {
            reportId: 'r9',
            sessionId: 'sess-9',
            agentId: 'chimera-review',
            reviewerModel: 'test-model',
          },
        },
      ],
      { sessionId: 'sess-9', reportId: 'r9', agentId: 'chimera-review', model: 'test-model' },
    );
  });

  afterAll(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  function makeHarness() {
    const send = vi.fn();
    const log = vi.fn();
    const handlers = createChimeraRouteHandlers({
      projectDir: () => projectDir,
      send: send as (ws: WebSocket, msg: { type: string; payload: unknown }) => void,
      log,
    });
    const ws = {} as WebSocket;
    return { send, log, handlers, ws };
  }

  it('queries all reports when all: true is provided', async () => {
    const { send, handlers, ws } = makeHarness();
    await handlers.listReports(ws, { type: 'chimera.reports.list', payload: { all: true } });
    expect(send).toHaveBeenCalledOnce();
    const frame = send.mock.calls[0]?.[1] as { type: string; payload: { reports: unknown[] } };
    expect(frame.type).toBe('chimera.reports');
    expect(frame.payload.reports.length).toBeGreaterThanOrEqual(1);
  });

  it('gets full report details including findings and journal events', async () => {
    const { send, handlers, ws } = makeHarness();
    await handlers.getReport?.(ws, { type: 'chimera.report.get', payload: { reportId: 'r9' } });
    expect(send).toHaveBeenCalledOnce();
    const frame = send.mock.calls[0]?.[1] as {
      type: string;
      payload: { report: { id: string }; findings: Array<{ finding: { id: string } }>; events: unknown[] };
    };
    expect(frame.type).toBe('chimera.report.detail');
    expect(frame.payload.report?.id).toBe('r9');
    expect(frame.payload.findings).toHaveLength(1);
    expect(frame.payload.findings[0]?.finding.id).toBe('f-1');
    expect(frame.payload.events.length).toBeGreaterThanOrEqual(1);
  });

  it('adds a note to a report', async () => {
    const { send, handlers, ws } = makeHarness();
    await handlers.addReportNote?.(ws, {
      type: 'chimera.report.add_note',
      payload: { reportId: 'r9', note: 'Checked by QA team' },
    });
    expect(send).toHaveBeenCalledOnce();
    const frame = send.mock.calls[0]?.[1] as { type: string; payload: { success: boolean } };
    expect(frame.type).toBe('chimera.report.note_added');
    expect(frame.payload.success).toBe(true);

    const store = new JsonlReportStore(projectDir);
    const events = await store.getEvents('r9');
    expect(events.some((e) => e.eventType === 'note_added' && e.reason === 'Checked by QA team')).toBe(true);
  });

  it('transitions a report lifecycle', async () => {
    const { send, handlers, ws } = makeHarness();
    await handlers.transitionReport?.(ws, {
      type: 'chimera.report.transition',
      payload: { reportId: 'r9', to: 'actioned', reason: 'Assigned to dev' },
    });
    expect(send).toHaveBeenCalledOnce();
    const frame = send.mock.calls[0]?.[1] as { type: string; payload: { success: boolean; lifecycle: string } };
    expect(frame.type).toBe('chimera.report.updated');
    expect(frame.payload.lifecycle).toBe('actioned');
  });

  it('transitions a finding and auto-syncs the parent report', async () => {
    const { send, handlers, ws } = makeHarness();
    await handlers.transitionFinding?.(ws, {
      type: 'chimera.finding.transition',
      payload: { findingId: 'f-1', to: 'resolved', outcome: 'fixed', reason: 'Patched guard' },
    });
    expect(send).toHaveBeenCalledOnce();
    const frame = send.mock.calls[0]?.[1] as { type: string; payload: { success: boolean; status: string } };
    expect(frame.type).toBe('chimera.finding.updated');
    expect(frame.payload.status).toBe('resolved');

    const reportStore = new JsonlReportStore(projectDir);
    const updatedReport = await reportStore.get('r9');
    expect(updatedReport?.lifecycle).toBe('completed');
  });
});
