import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { appendPipedStdin, readPipedStdin } from '../src/boot/piped-stdin.js';

describe('readPipedStdin', () => {
  it('returns nothing for a TTY without touching the stream', async () => {
    const stream = Object.assign(new PassThrough(), { isTTY: true });
    stream.write('ignored');
    const result = await readPipedStdin(stream);
    expect(result).toEqual({ text: '', truncated: false, timedOut: false });
  });

  it('reads a pipe to EOF and trims trailing whitespace', async () => {
    const stream = new PassThrough();
    const pending = readPipedStdin(stream, { firstByteTimeoutMs: 1_000 });
    stream.write('diff --git a/x b/x\n');
    stream.end('+line\n\n');
    await expect(pending).resolves.toEqual({
      text: 'diff --git a/x b/x\n+line',
      truncated: false,
      timedOut: false,
    });
  });

  it('gives up on an open pipe that never writes (harness-held stdin)', async () => {
    const stream = new PassThrough();
    const result = await readPipedStdin(stream, { firstByteTimeoutMs: 20 });
    expect(result).toEqual({ text: '', truncated: false, timedOut: true });
  });

  it('keeps reading a slow producer once the first byte arrived', async () => {
    const stream = new PassThrough();
    const pending = readPipedStdin(stream, { firstByteTimeoutMs: 20 });
    stream.write('a');
    await new Promise((r) => setTimeout(r, 60));
    stream.end('b');
    await expect(pending).resolves.toMatchObject({ text: 'ab', timedOut: false });
  });

  it('caps oversized input and reports truncation', async () => {
    const stream = new PassThrough();
    const pending = readPipedStdin(stream, { maxBytes: 4 });
    stream.write('abcdefgh');
    await expect(pending).resolves.toEqual({ text: 'abcd', truncated: true, timedOut: false });
  });

  it('treats input exactly at the cap as complete, not truncated', async () => {
    const stream = new PassThrough();
    const pending = readPipedStdin(stream, { maxBytes: 4 });
    stream.write('abcd');
    stream.end();
    // `truncated` means the input EXCEEDED the cap; an exact fit cut nothing.
    await expect(pending).resolves.toEqual({ text: 'abcd', truncated: false, timedOut: false });
  });

  it('treats an exact cap reached across chunks as complete, not truncated', async () => {
    const stream = new PassThrough();
    const pending = readPipedStdin(stream, { maxBytes: 8 });
    stream.write('abcd');
    stream.write('efgh');
    stream.end();
    await expect(pending).resolves.toEqual({ text: 'abcdefgh', truncated: false, timedOut: false });
  });

  it('flags truncation for one byte past the cap and keeps the capped text', async () => {
    const stream = new PassThrough();
    const pending = readPipedStdin(stream, { maxBytes: 4 });
    stream.write('abcde');
    stream.end();
    await expect(pending).resolves.toEqual({ text: 'abcd', truncated: true, timedOut: false });
  });

  it('treats an immediately closed stdin as empty', async () => {
    const stream = new PassThrough();
    const pending = readPipedStdin(stream, { firstByteTimeoutMs: 1_000 });
    stream.end();
    await expect(pending).resolves.toEqual({ text: '', truncated: false, timedOut: false });
  });
});

describe('appendPipedStdin', () => {
  it('leaves the prompt alone when nothing was piped', () => {
    expect(appendPipedStdin('review this', '')).toBe('review this');
  });

  it('keeps the prompt first and fences the piped context', () => {
    expect(appendPipedStdin('review this', 'x = 1')).toBe(
      'review this\n\n<stdin>\nx = 1\n</stdin>',
    );
  });

  it('uses the piped text as the prompt when argv carried none', () => {
    expect(appendPipedStdin('  ', 'fix the build')).toBe('fix the build');
  });
});
