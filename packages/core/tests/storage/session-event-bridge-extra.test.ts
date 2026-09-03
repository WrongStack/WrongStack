import { describe, it, expect, vi } from 'vitest';
import type { SessionEvent, SessionWriter } from '../../src/types/session.js';
import {
  createSessionEventBridge,
  resolveAuditLevel,
  resolveSessionLoggingConfig,
} from '../../src/storage/session-event-bridge.js';

function makeMockWriter(): {
  writer: SessionWriter;
  append: ReturnType<typeof vi.fn>;
  appendBatch: ReturnType<typeof vi.fn>;
} {
  const append = vi.fn().mockResolvedValue(undefined);
  const appendBatch = vi.fn().mockResolvedValue(undefined);
  const writer = {
    id: 'test',
    transcriptPath: undefined,
    pendingToolUses: [],
    append,
    appendBatch,
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    recordFileChange: vi.fn(),
    writeCheckpoint: vi.fn().mockResolvedValue(undefined),
    writeFileSnapshot: vi.fn().mockResolvedValue(undefined),
    truncateToCheckpoint: vi.fn().mockResolvedValue(0),
    clearSession: vi.fn().mockResolvedValue(undefined),
    writeInFlightMarker: vi.fn().mockResolvedValue(undefined),
    clearInFlightMarker: vi.fn().mockResolvedValue(undefined),
  } as never as SessionWriter;
  return { writer, append, appendBatch };
}

const userInput = (): SessionEvent =>
  ({ type: 'user_input', ts: new Date().toISOString(), content: 'hi' }) as SessionEvent;

describe('session-event-bridge — extra coverage', () => {
  it('append is a no-op when the writer getter resolves to null', async () => {
    const bridge = createSessionEventBridge(() => null, 'full');
    await expect(bridge.append(userInput())).resolves.toBeUndefined();
  });

  it('append swallows writer errors (best-effort logging)', async () => {
    const { writer, append } = makeMockWriter();
    append.mockRejectedValueOnce(new Error('disk full'));
    const bridge = createSessionEventBridge(writer, 'full');
    await expect(bridge.append(userInput())).resolves.toBeUndefined();
  });

  it('allows an uncategorized event at full level (allow-everything tail)', async () => {
    const { writer, append } = makeMockWriter();
    const bridge = createSessionEventBridge(writer, 'full');
    await bridge.append({
      type: 'task_created',
      ts: new Date().toISOString(),
      taskId: 't',
      title: 'x',
    } as never as SessionEvent);
    expect(append).toHaveBeenCalled();
  });

  it('lets a tool_progress with an unrecognized inner type through (sample tail)', async () => {
    const { writer, append } = makeMockWriter();
    const bridge = createSessionEventBridge(writer, 'full');
    await bridge.append({
      type: 'tool_progress',
      ts: new Date().toISOString(),
      name: 'bash',
      id: 'c1',
      event: { type: 'final', output: {} },
    } as never as SessionEvent);
    expect(append).toHaveBeenCalled();
  });

  describe('appendBatch', () => {
    it('no-ops on empty input and on a null writer', async () => {
      const { writer, appendBatch } = makeMockWriter();
      const bridge = createSessionEventBridge(writer, 'full');
      await bridge.appendBatch([]);
      expect(appendBatch).not.toHaveBeenCalled();

      const nullBridge = createSessionEventBridge(() => null, 'full');
      await expect(nullBridge.appendBatch([userInput()])).resolves.toBeUndefined();
    });

    it('forwards only the allowed events', async () => {
      const { writer, appendBatch } = makeMockWriter();
      const bridge = createSessionEventBridge(writer, 'minimal');
      await bridge.appendBatch([
        userInput(),
        {
          type: 'tool_progress',
          ts: new Date().toISOString(),
          name: 'b',
          id: 'c',
          event: { type: 'log', text: 'x' },
        } as never as SessionEvent,
      ]);
      expect(appendBatch).toHaveBeenCalledTimes(1);
      expect(appendBatch.mock.calls[0]?.[0]).toHaveLength(1);
    });

    it('no-ops when nothing passes the filter', async () => {
      const { writer, appendBatch } = makeMockWriter();
      const bridge = createSessionEventBridge(writer, 'minimal');
      await bridge.appendBatch([
        {
          type: 'tool_progress',
          ts: new Date().toISOString(),
          name: 'b',
          id: 'c',
          event: { type: 'log', text: 'x' },
        } as never as SessionEvent,
      ]);
      expect(appendBatch).not.toHaveBeenCalled();
    });

    it('swallows appendBatch writer errors', async () => {
      const { writer, appendBatch } = makeMockWriter();
      appendBatch.mockRejectedValueOnce(new Error('io'));
      const bridge = createSessionEventBridge(writer, 'full');
      await expect(bridge.appendBatch([userInput()])).resolves.toBeUndefined();
    });
  });

  describe('resolveAuditLevel / resolveSessionLoggingConfig', () => {
    it('resolveAuditLevel honors valid values and falls back to standard', () => {
      expect(resolveAuditLevel({ session: { auditLevel: 'minimal' } })).toBe('minimal');
      expect(resolveAuditLevel({ session: { auditLevel: 'full' } })).toBe('full');
      expect(resolveAuditLevel({ session: { auditLevel: 'bogus' as never } })).toBe('standard');
      expect(resolveAuditLevel(null)).toBe('standard');
      expect(resolveAuditLevel(undefined)).toBe('standard');
    });

    it('resolveSessionLoggingConfig applies defaults and clamps the sample rate', () => {
      expect(resolveSessionLoggingConfig(null)).toEqual({
        auditLevel: 'standard',
        sampling: { toolProgress: { sampleRate: 8 } },
        storage: {
          hotKeepSessions: 20,
          archiveAfterDays: 7,
          autoArchive: true,
          includeSubagents: true,
        },
      });
      expect(
        resolveSessionLoggingConfig({
          session: { auditLevel: 'full', sampling: { toolProgress: { sampleRate: 0 } } },
        }),
      ).toEqual({
        auditLevel: 'full',
        sampling: { toolProgress: { sampleRate: 1 } },
        storage: {
          hotKeepSessions: 20,
          archiveAfterDays: 7,
          autoArchive: true,
          includeSubagents: true,
        },
      });
      expect(
        resolveSessionLoggingConfig({
          session: { sampling: { toolProgress: { sampleRate: 3.9 } } },
        }).sampling.toolProgress.sampleRate,
      ).toBe(3);
    });
  });
});
