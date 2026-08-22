import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../../src/types/session.js';
import { SessionWriteBuffer } from '../../src/storage/session-write-buffer.js';

const now = () => new Date().toISOString();

function toolResult(content: string): SessionEvent {
  return {
    type: 'tool_result',
    ts: now(),
    id: 'tu-1',
    content,
    isError: false,
  } as SessionEvent;
}

describe('SessionWriteBuffer.flushSync', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-flushsync-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('keeps buffered events when the sync append cannot open the file', () => {
    const filePath = path.join(tmp, 'missing-dir', 'sess.jsonl');
    const buffer = new SessionWriteBuffer({
      sessionId: 's',
      filePath,
      getHandle: () => {
        throw new Error('no handle');
      },
      setHandle: () => undefined,
    });
    expect(buffer.push(toolResult('must survive'))).toBe(true);
    buffer.flushSync();
    expect(buffer.length).toBe(1);
  });

  it('clears the buffer only after a successful sync append', async () => {
    const filePath = path.join(tmp, 'sess.jsonl');
    await fs.writeFile(filePath, '');
    const buffer = new SessionWriteBuffer({
      sessionId: 's',
      filePath,
      getHandle: () => {
        throw new Error('no handle');
      },
      setHandle: () => undefined,
    });
    expect(buffer.push(toolResult('on disk'))).toBe(true);
    buffer.flushSync();
    expect(buffer.length).toBe(0);
    const text = await fs.readFile(filePath, 'utf8');
    expect(text).toContain('"on disk"');
  });

  it('steals a queued async batch so flushSync writes it once, in order', async () => {
    const filePath = path.join(tmp, 'race.jsonl');
    await fs.writeFile(filePath, '');
    let releaseWrite: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let handleWrites = 0;
    const handle = {
      appendFile: async (data: string) => {
        handleWrites += 1;
        await gate;
        await fs.appendFile(filePath, `ASYNC:${data}`);
      },
      datasync: async () => undefined,
    };
    const buffer = new SessionWriteBuffer({
      sessionId: 's',
      filePath,
      getHandle: () => handle as never,
      setHandle: () => undefined,
    });
    expect(buffer.push(toolResult('queued'))).toBe(true);
    const flushing = buffer.flushBuffer();
    expect(buffer.push(toolResult('tail'))).toBe(true);
    buffer.flushSync();
    releaseWrite?.();
    await flushing.catch(() => undefined);
    const text = await fs.readFile(filePath, 'utf8');
    expect(text).toContain('"queued"');
    expect(text).toContain('"tail"');
    expect(text.indexOf('"queued"')).toBeLessThan(text.indexOf('"tail"'));
    expect(text).not.toContain('ASYNC:');
    expect(handleWrites).toBe(0);
  });

  it('reports a failed sync append instead of dropping events silently', () => {
    const filePath = path.join(tmp, 'missing-dir', 'sess.jsonl');
    const buffer = new SessionWriteBuffer({
      sessionId: 'sess-warn',
      filePath,
      getHandle: () => {
        throw new Error('no handle');
      },
      setHandle: () => undefined,
    });
    expect(buffer.push(toolResult('unwritten'))).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let calls: unknown[][] = [];
    try {
      buffer.flushSync();
      // mockRestore() also clears mock.calls, so snapshot before restoring.
      calls = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
    }
    const payloads = calls
      .map((call) => {
        try {
          return JSON.parse(String(call[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((p): p is Record<string, unknown> => p?.event === 'session.flush_sync_failed');
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      sessionId: 'sess-warn',
      filePath,
      pendingEvents: 1,
      hadInFlightBatch: false,
    });
    // The warning describes a pending write, not a lost one: the events are
    // still buffered for the next flush.
    expect(buffer.length).toBe(1);
  });

  it('hands a stolen batch back to the async chain when the sync append fails', async () => {
    const asyncTarget = path.join(tmp, 'async.jsonl');
    await fs.writeFile(asyncTarget, '');
    // openSync fails (parent directory does not exist) while the fake handle
    // still writes successfully, isolating the rollback path.
    const filePath = path.join(tmp, 'missing-dir', 'sess.jsonl');
    const handle = {
      appendFile: async (data: string) => {
        await fs.appendFile(asyncTarget, data);
      },
      datasync: async () => undefined,
    };
    const buffer = new SessionWriteBuffer({
      sessionId: 's',
      filePath,
      getHandle: () => handle as never,
      setHandle: () => undefined,
    });
    expect(buffer.push(toolResult('stolen then returned'))).toBe(true);
    const flushing = buffer.flushBuffer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      buffer.flushSync();
    } finally {
      warn.mockRestore();
    }
    await flushing.catch(() => undefined);
    expect(await fs.readFile(asyncTarget, 'utf8')).toContain('"stolen then returned"');
  });
});
