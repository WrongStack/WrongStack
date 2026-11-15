import type { SessionSummary } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import {
  buildInspectPayload,
  toSessionHistoryEntries,
  toSessionHistoryEntry,
} from '../src/server/session-history.js';

const summary: SessionSummary = {
  id: '2026-07-14/session-a',
  title: 'Automatic title',
  name: 'Operator session',
  startedAt: '2026-07-14T10:00:00.000Z',
  endedAt: '2026-07-14T11:00:00.000Z',
  model: 'gpt-5',
  provider: 'openai',
  tokenTotal: 42_000,
  lastActivityAt: '2026-07-14T12:00:00.000Z',
  messageCount: 8,
  lastUserMessage: 'Restore the correct session',
  iterationCount: 12,
  toolCallCount: 30,
  toolErrorCount: 2,
  fileChangeCount: 7,
  toolBreakdown: { read: 18, edit: 12 },
  compactionCount: 1,
  outcome: 'completed',
};

describe('session history wire projection', () => {
  it('preserves the rich summary and marks the current session', () => {
    expect(toSessionHistoryEntry(summary, summary.id)).toEqual({
      ...summary,
      isCurrent: true,
    });
  });

  it('maps lists without adding undefined optional properties', () => {
    const minimal: SessionSummary = {
      id: 'minimal',
      title: 'Minimal',
      startedAt: '2026-07-14T12:00:00.000Z',
      model: 'model',
      provider: 'provider',
      tokenTotal: 0,
    };
    const [entry] = toSessionHistoryEntries([minimal], summary.id);
    expect(entry).toEqual({ ...minimal, isCurrent: false });
    expect(entry).not.toHaveProperty('name');
    expect(entry).not.toHaveProperty('outcome');
  });

  it('aggregates toolBreakdown safely when tool names match Object.prototype keys', () => {
    const payload = buildInspectPayload(
      undefined,
      [
        {
          type: 'tool_call_start',
          ts: '2026-01-01T00:00:00Z',
          name: 'toString',
          id: '1',
          input: {},
        } as never,
        {
          type: 'tool_call_start',
          ts: '2026-01-01T00:00:01Z',
          name: 'toString',
          id: '2',
          input: {},
        } as never,
      ],
      { id: 's1', title: 't', model: 'm', provider: 'p', startedAt: '2026-01-01T00:00:00Z' },
    );
    expect(payload.toolBreakdown['toString']).toBe(2);
  });
});
