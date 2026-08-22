import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionSummaryTracker } from '../../src/storage/session-summary-tracker.js';
import type { SessionEvent, SessionMetadata } from '../../src/types/session.js';

const ts = '2026-01-01T00:00:00.000Z';
const baseMeta: SessionMetadata = {
  id: 's1', startedAt: ts, model: 'gpt-4', provider: 'openai',
};

const ev = (partial: { type: SessionEvent['type'] } & Record<string, unknown>): SessionEvent =>
  ({ ts, ...partial }) as SessionEvent;

describe('SessionSummaryTracker — coverage', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-stracker-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('exposes currentSummary', () => {
    const tracker = new SessionSummaryTracker({ id: 's1', startedAt: ts, meta: baseMeta });
    expect(tracker.currentSummary.id).toBe('s1');
    expect(tracker.currentSummary.tokenTotal).toBe(0);
  });

  it('tracks compactionCount and surfaces it in snapshot/finalize', () => {
    const tracker = new SessionSummaryTracker({ id: 's2', startedAt: ts, meta: baseMeta });
    tracker.observe(ev({ type: 'compaction', reason: 'context_budget', count: 3 }));
    expect(tracker.snapshot().compactionCount).toBe(1);
    tracker.finalize();
  });

  it('updates tokenTotal from session_end with positive usage', async () => {
    const tracker = new SessionSummaryTracker({ id: 's3', startedAt: ts, meta: baseMeta });
    tracker.observe(ev({ type: 'user_input', content: 'hello' }) as never);
    tracker.observe(ev({ type: 'llm_response', content: [], usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 } }) as never);
    tracker.observe(ev({ type: 'session_end', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }));
    const summary = await tracker.finalize();
    expect(summary.tokenTotal).toBe(15);
  });

  it('does not change tokenTotal from session_end with zero usage', async () => {
    const tracker = new SessionSummaryTracker({ id: 's4', startedAt: ts, meta: baseMeta });
    tracker.observe(ev({ type: 'session_end', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
    const summary = await tracker.finalize();
    expect(summary.tokenTotal).toBe(0);
  });

  it('records error outcome from error and provider_error events', async () => {
    const tracker = new SessionSummaryTracker({ id: 's5', startedAt: ts, meta: baseMeta });
    tracker.observe(ev({ type: 'error', error: { type: 'test', message: 'boom' } }) as never);
    expect((await tracker.finalize()).outcome).toBe('error');

    const tracker2 = new SessionSummaryTracker({ id: 's5b', startedAt: ts, meta: baseMeta });
    tracker2.observe(ev({ type: 'provider_error' }) as never);
    expect((await tracker2.finalize()).outcome).toBe('error');
  });

  it('counts tool_call_start and tracks breakdown', async () => {
    const tracker = new SessionSummaryTracker({ id: 's6', startedAt: ts, meta: baseMeta });
    tracker.observe(ev({ type: 'tool_call_start', id: 'tc1', name: 'bash', input: {} }) as never);
    tracker.observe(ev({ type: 'tool_call_start', id: 'tc2', name: 'bash', input: {} }) as never);
    tracker.observe(ev({ type: 'tool_call_start', id: 'tc3', name: 'read', input: {} }) as never);
    const summary = tracker.snapshot();
    expect(summary.toolCallCount).toBe(3);
    expect(summary.toolBreakdown).toEqual({ bash: 2, read: 1 });
  });

  it('counts tool errors from tool_result with isError', async () => {
    const tracker = new SessionSummaryTracker({ id: 's7', startedAt: ts, meta: baseMeta });
    tracker.observe(ev({ type: 'tool_use', id: 't1', name: 'bash' }) as never);
    tracker.observe(ev({ type: 'tool_result', id: 't1', content: 'broken', isError: true }) as never);
    const summary = tracker.snapshot();
    expect(summary.toolErrorCount).toBe(1);
    expect(summary.outcome).toBe('error');
  });

  it('counts tool_call_start and tracks breakdown in finalize', async () => {
    const tracker = new SessionSummaryTracker({ id: 's6b', startedAt: ts, meta: baseMeta });
    tracker.observe(ev({ type: 'tool_call_start', id: 'tc1', name: 'bash', input: {} }) as never);
    tracker.observe(ev({ type: 'tool_call_start', id: 'tc2', name: 'read', input: {} }) as never);
    const summary = await tracker.finalize();
    expect(summary.toolCallCount).toBe(2);
    expect(summary.toolBreakdown).toEqual({ bash: 1, read: 1 });
  });

  it('tracks file_snapshot file changes', async () => {
    const tracker = new SessionSummaryTracker({ id: 's8', startedAt: ts, meta: baseMeta });
    tracker.observe(ev({ type: 'file_snapshot', files: ['a.ts', 'b.ts', 'c.ts'] }) as never);
    const summary = tracker.snapshot();
    expect(summary.fileChangeCount).toBe(3);
  });

  it('counts messages from user_input and llm_response', async () => {
    const tracker = new SessionSummaryTracker({ id: 's9', startedAt: ts, meta: baseMeta });
    tracker.observe(ev({ type: 'user_input', content: 'hello' }) as never);
    tracker.observe(ev({ type: 'user_input', content: 'world' }) as never);
    tracker.observe(ev({ type: 'llm_response', content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) as never);
    const summary = tracker.snapshot();
    expect(summary.messageCount).toBe(3);
  });

  it('updates tokenIn/tokenOut from llm_response', async () => {
    const tracker = new SessionSummaryTracker({ id: 's10', startedAt: ts, meta: baseMeta });
    tracker.observe(ev({ type: 'llm_response', content: [], usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } }) as never);
    const summary = await tracker.finalize();
    expect(summary.tokenTotal).toBe(150);
  });

  it('tracks open and closed tool_use via llm_response tool_use blocks', () => {
    const tracker = new SessionSummaryTracker({ id: 's11', startedAt: ts, meta: baseMeta });
    tracker.observe(ev({ type: 'llm_response', content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'x' } }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) as never);
    expect(tracker.pendingToolUses).toEqual(['tu1']);
    tracker.observe(ev({ type: 'tool_use', id: 'tu2', name: 'write_file' }) as never);
    expect(tracker.pendingToolUses).toHaveLength(2);
    tracker.observe(ev({ type: 'tool_result', id: 'tu1', content: 'ok', isError: false }) as never);
    expect(tracker.pendingToolUses).toEqual(['tu2']);
  });

  it('finalizes with a resolved name from resolveNameCb', async () => {
    const tracker = new SessionSummaryTracker({
      id: 's12', startedAt: ts, meta: baseMeta,
      resolveName: async () => ({ name: 'MySession' }),
    });
    const summary = await tracker.finalize();
    expect(summary.name).toBe('MySession');
  });

  it('finalizes with a null resolved name (catch path)', async () => {
    const tracker = new SessionSummaryTracker({
      id: 's12b', startedAt: ts, meta: baseMeta,
      resolveName: async () => { throw new Error('network'); },
    });
    const summary = await tracker.finalize();
    expect(summary.endedAt).toBeDefined();
    expect(summary.name).toBeUndefined();
  });

  it('finalizes with outcome "completed" when no error occurred', async () => {
    const tracker = new SessionSummaryTracker({ id: 's13', startedAt: ts, meta: baseMeta });
    const summary = await tracker.finalize();
    expect(summary.outcome).toBe('completed');
    expect(summary.endedAt).toBeDefined();
  });

  it('recomputeFromDisk returns early for empty path', async () => {
    const tracker = new SessionSummaryTracker({ id: 's14', startedAt: ts, meta: baseMeta });
    await tracker.recomputeFromDisk('');
  });

  it('recomputeFromDisk returns early when the file is not accessible', async () => {
    const tracker = new SessionSummaryTracker({ id: 's15', startedAt: ts, meta: baseMeta });
    const nonexistent = path.join(dir, 'does_not_exist.jsonl');
    await tracker.recomputeFromDisk(nonexistent);
    const summary = tracker.snapshot();
    expect(summary.messageCount).toBe(0);
  });

  it('recomputeFromDisk replays events from disk', async () => {
    const filePath = path.join(dir, 'replay.jsonl');
    await fsp.appendFile(filePath, JSON.stringify(ev({ type: 'user_input', content: 'hi' })) + '\n', 'utf8');
    await fsp.appendFile(filePath, JSON.stringify(ev({ type: 'llm_response', content: [], usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 } })) + '\n', 'utf8');

    const tracker = new SessionSummaryTracker({ id: 's16', startedAt: ts, meta: baseMeta });
    await tracker.recomputeFromDisk(filePath);
    const summary = tracker.snapshot();
    expect(summary.messageCount).toBe(2);
    expect(summary.tokenTotal).toBe(10);
  });

  it('recomputeFromDisk skips malformed lines', async () => {
    const filePath = path.join(dir, 'malformed.jsonl');
    await fsp.appendFile(filePath, JSON.stringify(ev({ type: 'user_input', content: 'hi' })) + '\n', 'utf8');
    await fsp.appendFile(filePath, '{not json\n', 'utf8');
    await fsp.appendFile(filePath, JSON.stringify(ev({ type: 'llm_response', content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } })) + '\n', 'utf8');

    const tracker = new SessionSummaryTracker({ id: 's17', startedAt: ts, meta: baseMeta });
    await tracker.recomputeFromDisk(filePath);
    const summary = tracker.snapshot();
    expect(summary.messageCount).toBe(2);
  });

  it('reset clears all counters and stashes the session name', () => {
    const tracker = new SessionSummaryTracker({
      id: 's18', startedAt: ts, meta: baseMeta,
      initialSummary: { id: 's18', title: 'Named Session', startedAt: ts, model: 'm', provider: 'p', tokenTotal: 100, name: 'original-name' },
    });
    tracker.observe(ev({ type: 'user_input', content: 'hello' }) as never);
    tracker.observe(ev({ type: 'llm_response', content: [], usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 } }) as never);
    tracker.reset('2026-02-01T00:00:00.000Z');
    const summary = tracker.currentSummary;
    expect(summary.tokenTotal).toBe(0);
    expect(summary.title).toBe('(empty session)');
    expect(summary.name).toBe('original-name');
    expect(summary.lastActivityAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('snapshot returns a copy with live counters merged in', () => {
    const tracker = new SessionSummaryTracker({
      id: 's19', startedAt: ts, meta: baseMeta,
      initialSummary: { id: 's19', title: 'T', startedAt: ts, model: 'm', provider: 'p', tokenTotal: 50 },
    });
    tracker.observe(ev({ type: 'user_input', content: 'hi' }) as never);
    const snap = tracker.snapshot();
    expect(snap.lastUserMessage).toBeDefined();
    expect(snap.id).toBe('s19');
    expect(snap.messageCount).toBe(1);
  });

  it('snapshot omits outcome when undefined and includes when set', () => {
    const tracker = new SessionSummaryTracker({ id: 's20', startedAt: ts, meta: baseMeta });
    const snapNoOutcome = tracker.snapshot();
    expect(snapNoOutcome.outcome).toBeUndefined();

    const tracker2 = new SessionSummaryTracker({ id: 's21', startedAt: ts, meta: baseMeta });
    tracker2.observe(ev({ type: 'error', error: { type: 'test', message: 'boom' } }) as never);
    const snapWithOutcome = tracker2.snapshot();
    expect(snapWithOutcome.outcome).toBe('error');
  });

  it('updates lastActivityAt from observed events', () => {
    const tracker = new SessionSummaryTracker({ id: 's22', startedAt: ts, meta: baseMeta });
    tracker.observe({ type: 'user_input', ts: '2026-06-15T12:00:00.000Z', content: 'hello' } as never);
    expect(tracker.snapshot().lastActivityAt).toBe('2026-06-15T12:00:00.000Z');
  });

  it('increments iterationCount on in_flight_start', () => {
    const tracker = new SessionSummaryTracker({ id: 's23', startedAt: ts, meta: baseMeta });
    tracker.observe(ev({ type: 'in_flight_start', context: 'iteration 1' }) as never);
    tracker.observe(ev({ type: 'in_flight_start', context: 'iteration 2' }) as never);
    expect(tracker.snapshot().iterationCount).toBe(2);
  });

  it('defaults model and provider to "unknown" when meta omits them', () => {
    const tracker = new SessionSummaryTracker({
      id: 's24', startedAt: ts,
      meta: { ...baseMeta, model: undefined as never, provider: undefined as never },
    });
    expect(tracker.currentSummary.model).toBe('unknown');
    expect(tracker.currentSummary.provider).toBe('unknown');
  });

  it('resets outcome to undefined when resumed, even if initialSummary had one', async () => {
    const tracker = new SessionSummaryTracker({
      id: 's25', startedAt: ts, meta: baseMeta, resumed: true,
      initialSummary: { id: 's25', title: 'T', startedAt: ts, model: 'm', provider: 'p', tokenTotal: 0, outcome: 'error' },
    });
    const summary = await tracker.finalize();
    // this.outcome is undefined (resumed=true → L68:0), so finalize defaults to 'completed'
    expect(summary.outcome).toBe('completed');
  });

  it('handles llm_response content with non-tool_use blocks', () => {
    const tracker = new SessionSummaryTracker({ id: 's26', startedAt: ts, meta: baseMeta });
    tracker.observe(ev({ type: 'llm_response', content: [{ type: 'text', text: 'hello' } as never], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }) as never);
    expect(tracker.pendingToolUses).toEqual([]);
  });

  it('recomputeFromDisk skips blank lines', async () => {
    const filePath = path.join(dir, 'blanks.jsonl');
    await fsp.appendFile(filePath, JSON.stringify(ev({ type: 'user_input', content: 'hi' })) + '\n\n\n', 'utf8');
    const tracker = new SessionSummaryTracker({ id: 's27', startedAt: ts, meta: baseMeta });
    await tracker.recomputeFromDisk(filePath);
    const summary = tracker.snapshot();
    expect(summary.messageCount).toBe(1);
  });

  it('preserves a future lastActivityAt through finalize', async () => {
    const tracker = new SessionSummaryTracker({
      id: 's28', startedAt: ts, meta: baseMeta,
      initialSummary: { id: 's28', title: 'T', startedAt: ts, model: 'm', provider: 'p', tokenTotal: 0, lastActivityAt: '2099-12-31T23:59:59.999Z' },
    });
    const summary = await tracker.finalize();
    expect(summary.lastActivityAt).toBe('2099-12-31T23:59:59.999Z');
  });

  it('preserves the initial name through finalize', async () => {
    const tracker = new SessionSummaryTracker({
      id: 's29', startedAt: ts, meta: baseMeta,
      initialSummary: { id: 's29', title: 'T', startedAt: ts, model: 'm', provider: 'p', tokenTotal: 0, name: 'Initial Name' },
    });
    const summary = await tracker.finalize();
    expect(summary.name).toBe('Initial Name');
  });

  it('finalizes with a resolved name that has no name property', async () => {
    const tracker = new SessionSummaryTracker({
      id: 's30', startedAt: ts, meta: baseMeta,
      resolveName: async () => ({} as never),
    });
    const summary = await tracker.finalize();
    expect(summary.name).toBeUndefined();
  });

  it('reset uses "unknown" when model and provider are missing', () => {
    const tracker = new SessionSummaryTracker({
      id: 's31', startedAt: ts,
      meta: { ...baseMeta, model: undefined as never, provider: undefined as never },
      initialSummary: { id: 's31', title: 'Named', startedAt: ts, model: 'm', provider: 'p', tokenTotal: 0, name: 'saved' },
    });
    tracker.reset('2026-02-01T00:00:00.000Z');
    expect(tracker.currentSummary.model).toBe('unknown');
    expect(tracker.currentSummary.provider).toBe('unknown');
    expect(tracker.currentSummary.name).toBe('saved');
  });

  it('reset omits name when the session had no name', () => {
    const tracker = new SessionSummaryTracker({ id: 's33', startedAt: ts, meta: baseMeta });
    tracker.reset('2026-02-01T00:00:00.000Z');
    expect(tracker.currentSummary.name).toBeUndefined();
  });
});
