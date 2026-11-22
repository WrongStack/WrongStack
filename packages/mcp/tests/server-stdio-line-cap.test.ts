import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { MCPServer, serveStdio } from '../src/server.js';
import { HTTP_BODY_CAP } from '../src/server-stdio.js';

const host = {
  listTools: () => [],
  callTool: async () => ({ content: 'unused', isError: false }),
};

/** A ping request padded with JSON whitespace to exactly `bytes` bytes. */
function ping(id: number, bytes?: number): string {
  const head = `{"jsonrpc":"2.0","id":${id},`;
  const tail = '"method":"ping"}';
  if (bytes === undefined) return head + tail;
  return head + ' '.repeat(bytes - head.length - tail.length) + tail;
}

async function answeredIds(chunks: string[]): Promise<number[]> {
  const stdin = new PassThrough();
  const ids: number[] = [];
  let pending = '';
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      pending += String(chunk);
      let idx = pending.indexOf('\n');
      while (idx !== -1) {
        ids.push((JSON.parse(pending.slice(0, idx)) as { id: number }).id);
        pending = pending.slice(idx + 1);
        idx = pending.indexOf('\n');
      }
      cb();
    },
  });
  const handle = serveStdio(new MCPServer({ host }), { stdin, stdout });
  for (const chunk of chunks) if (!stdin.destroyed) stdin.write(chunk);
  if (!stdin.destroyed) stdin.end();
  await handle.done;
  return ids.sort((a, b) => a - b);
}

describe('serveStdio line cap', () => {
  it('bounds one line, not the complete lines that share a read', async () => {
    // F1050: the read that finished a near-cap request also carried the next
    // pipelined requests; the cap was checked on the whole buffer first, so
    // the stream was torn down and none of them were answered.
    const followers = Array.from({ length: 40 }, (_, i) => `${ping(i + 2)}\n`).join('');
    const ids = await answeredIds([ping(1, HTTP_BODY_CAP - 1024), `\n${followers}`]);
    expect(ids).toEqual(Array.from({ length: 41 }, (_, i) => i + 1));
  });

  it('still refuses a complete line over the cap', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await answeredIds([`${ping(9, HTTP_BODY_CAP + 1)}\n`])).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('line_buffer_overflow'));
    } finally {
      consoleError.mockRestore();
    }
  });

  it('answers complete lines read before an over-cap unterminated tail', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const ids = await answeredIds([`${ping(3)}\n${ping(4)}\n${'b'.repeat(HTTP_BODY_CAP + 1)}`]);
      expect(ids).toEqual([3, 4]);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('line_buffer_overflow'));
    } finally {
      consoleError.mockRestore();
    }
  });
});
