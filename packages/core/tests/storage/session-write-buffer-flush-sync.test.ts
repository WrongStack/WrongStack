import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
