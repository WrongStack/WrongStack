import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionWriter } from '../../src/types/session.js';
import {
  createSessionEventBridge,
} from '../../src/storage/session-event-bridge.js';

function makeMockWriter() {
  const append = vi.fn().mockResolvedValue(undefined);
  const writer: SessionWriter = {
    id: 'test',
    transcriptPath: undefined,
    pendingToolUses: [],
    append,
    appendBatch: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    recordFileChange: vi.fn(),
    writeCheckpoint: vi.fn().mockResolvedValue(undefined),
    writeFileSnapshot: vi.fn().mockResolvedValue(undefined),
    truncateToCheckpoint: vi.fn().mockResolvedValue(0),
    clearSession: vi.fn().mockResolvedValue(undefined),
    writeInFlightMarker: vi.fn().mockResolvedValue(undefined),
    clearInFlightMarker: vi.fn().mockResolvedValue(undefined),
  };
  return { writer, append };
}

function makeProgressEvent(
  type: 'log' | 'warning' | 'metric' | 'file_changed' | 'partial_output',
  overrides: Partial<{ name: string; id: string; text: string }> = {}
) {
  return {
    type: 'tool_progress' as const,
    ts: new Date().toISOString(),
    name: overrides.name ?? 'bash',
    id: overrides.id ?? 'call_123',
    event: {
      type,
      text: overrides.text ?? 'some output',
    },
  };
}

describe('SessionEventBridge', () => {
  let writer: SessionWriter;
  let append: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const mock = makeMockWriter();
    writer = mock.writer;
    append = mock.append;
  });

  describe('auditLevel filtering', () => {
    it('minimal: only writes core reconstruct events', async () => {
      const bridge = createSessionEventBridge(writer, 'minimal');

      await bridge.append({ type: 'user_input', ts: 't', content: 'hi' });
      await bridge.append({
        type: 'file_observation',
        ts: 't',
        path: '/project/a.ts',
        hash: 'a'.repeat(64),
        mtimeMs: 1,
        source: 'user',
      });
      await bridge.append({
        type: 'context_snapshot',
        ts: 't',
        reason: 'compaction',
        messages: [{ role: 'system', content: 'compacted' }],
      });
      await bridge.append({ type: 'compaction', ts: 't', before: 100, after: 50 });
      await bridge.append({ type: 'error', ts: 't', message: 'boom', phase: 'agent' });

      expect(append).toHaveBeenCalledTimes(3);
      expect(append.mock.calls[0]![0].type).toBe('user_input');
      expect(append.mock.calls[1]![0].type).toBe('file_observation');
      expect(append.mock.calls[2]![0].type).toBe('context_snapshot');
    });

    it('standard: writes core + standard audit events', async () => {
      const bridge = createSessionEventBridge(writer, 'standard');

      await bridge.append({ type: 'user_input', ts: 't', content: 'hi' });
      await bridge.append({ type: 'compaction', ts: 't', before: 100, after: 50 });
      await bridge.append({ type: 'tool_call_end', ts: 't', name: 'bash', id: '1', durationMs: 10, outputSize: 100 });

      expect(append).toHaveBeenCalledTimes(3);
    });

    it('full: allows everything (including tool_progress)', async () => {
      const bridge = createSessionEventBridge(writer, 'full');

      await bridge.append(makeProgressEvent('log'));
      await bridge.append(makeProgressEvent('warning'));

      expect(append).toHaveBeenCalledTimes(2);
    });
  });

  describe('tool_progress sampling (full level)', () => {
    it('always forwards warning, metric, file_changed', async () => {
      const bridge = createSessionEventBridge(writer, 'full');

      for (let i = 0; i < 20; i++) {
        await bridge.append(makeProgressEvent('warning', { id: 'call_1' }));
        await bridge.append(makeProgressEvent('metric', { id: 'call_1' }));
        await bridge.append(makeProgressEvent('file_changed', { id: 'call_1' }));
      }

      // All 60 events should have been forwarded
      expect(append).toHaveBeenCalledTimes(60);
    });

    it('samples log and partial_output (first + every Nth, default rate 8)', async () => {
      const bridge = createSessionEventBridge(writer, 'full');

      for (let i = 0; i < 20; i++) {
        await bridge.append(makeProgressEvent('log', { id: 'call_42' }));
      }

      // First message + messages 8, 16 → 3 messages
      expect(append).toHaveBeenCalledTimes(3);
    });

    it('respects custom sampleRate from options', async () => {
      const bridge = createSessionEventBridge(writer, 'full', {
        sampling: {
          toolProgress: { sampleRate: 3 },
        },
      });

      for (let i = 0; i < 10; i++) {
        await bridge.append(makeProgressEvent('partial_output', { id: 'call_x' }));
      }

      // First + every 3rd → 1,4,7,10 → 4 messages
      expect(append).toHaveBeenCalledTimes(4);
    });

    it('maintains independent counters per tool call id', async () => {
      const bridge = createSessionEventBridge(writer, 'full');

      // 5 logs on call_a
      for (let i = 0; i < 5; i++) {
        await bridge.append(makeProgressEvent('log', { id: 'call_a' }));
      }
      // 5 logs on call_b (different id)
      for (let i = 0; i < 5; i++) {
        await bridge.append(makeProgressEvent('log', { id: 'call_b' }));
      }

      // call_a: 1st + (none, since 8 > 5) → 1
      // call_b: same → 1
      // Total 2
      expect(append).toHaveBeenCalledTimes(2);
    });

    it('does not sample tool_progress when level is not full', async () => {
      const bridge = createSessionEventBridge(writer, 'standard');

      for (let i = 0; i < 30; i++) {
        await bridge.append(makeProgressEvent('log', { id: 'call_1' }));
      }

      expect(append).toHaveBeenCalledTimes(0);
    });
  });

  describe('allows()', () => {
    it('reflects the current auditLevel correctly', () => {
      const minimal = createSessionEventBridge(null, 'minimal');
      const standard = createSessionEventBridge(null, 'standard');
      const full = createSessionEventBridge(null, 'full');

      expect(minimal.allows('user_input')).toBe(true);
      expect(minimal.allows('compaction')).toBe(false);
      expect(minimal.allows('tool_progress')).toBe(false);

      expect(standard.allows('compaction')).toBe(true);
      expect(standard.allows('tool_progress')).toBe(false);

      expect(full.allows('tool_progress')).toBe(true);
    });

    it('classifies resume markers and fleet lifecycle as standard audit detail', () => {
      // These reach disk today only because their producers append to the raw
      // SessionWriter and bypass the bridge. While they were in NEITHER set,
      // routing any of them through it would have silently dropped them at the
      // DEFAULT level — the resume timeline would just lose them.
      const standard = createSessionEventBridge(null, 'standard');
      const minimal = createSessionEventBridge(null, 'minimal');
      for (const type of [
        'mode_changed',
        'agent_spawned',
        'agent_stopped',
        'agent_error',
        'task_created',
        'task_updated',
        'task_completed',
        'task_failed',
        'side_effect',
      ] as const) {
        expect(standard.allows(type), `${type} at standard`).toBe(true);
        // 'minimal' is an explicit opt-out of audit detail; only the core
        // reconstruct set survives there.
        expect(minimal.allows(type), `${type} at minimal`).toBe(false);
      }
    });
  });

  describe('setAuditLevel()', () => {
    it('changes the live level so later appends use the new filter', async () => {
      const append = vi.fn().mockResolvedValue(undefined);
      const writer = { append } as never;
      const bridge = createSessionEventBridge(writer, 'minimal');

      // At 'minimal', a 'compaction' (standard-tier) event is dropped.
      expect(bridge.level).toBe('minimal');
      expect(bridge.allows('compaction')).toBe(false);

      // Raise the level live — the same event type is now allowed.
      bridge.setAuditLevel('standard');
      expect(bridge.level).toBe('standard');
      expect(bridge.allows('compaction')).toBe(true);

      await bridge.append({ type: 'compaction', ts: new Date().toISOString() } as never);
      expect(append).toHaveBeenCalledTimes(1);

      // Lower it again — subsequent standard-tier events are dropped.
      bridge.setAuditLevel('minimal');
      await bridge.append({ type: 'compaction', ts: new Date().toISOString() } as never);
      expect(append).toHaveBeenCalledTimes(1);
    });

    it('normalizes a nullish level to standard', () => {
      const bridge = createSessionEventBridge(null, 'full');
      bridge.setAuditLevel(undefined as never);
      expect(bridge.level).toBe('standard');
    });
  });
});
