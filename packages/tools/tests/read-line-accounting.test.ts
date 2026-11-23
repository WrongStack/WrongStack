import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTool } from '../src/read.js';
import { mkSandbox, newSignal, type Sandbox } from './fixtures.js';

/**
 * Line accounting for a file whose last line is newline-terminated.
 *
 * A trailing newline TERMINATES the last line; it does not start a new empty
 * one. The split-based reader used to keep that phantom element, which
 * inflated `total_lines` by one, flipped `truncated` on an exact-boundary
 * page, and let a model "read" a line past the real end of the file.
 */
describe('read tool line accounting', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await mkSandbox();
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  it('counts a newline-terminated file without a phantom line', async () => {
    await fs.writeFile(path.join(sb.dir, 'eol.txt'), 'a\nb\n');
    const out = await readTool.execute({ path: 'eol.txt' }, sb.ctx, { signal: newSignal() });
    expect(out.total_lines).toBe(2);
    expect(out.text).toContain('1→a');
    expect(out.text).toContain('2→b');
    expect(out.text).not.toContain('3→');
  });

  it('does not mark an exact-boundary page truncated', async () => {
    await fs.writeFile(path.join(sb.dir, 'exact.txt'), 'a\nb\n');
    const out = await readTool.execute({ path: 'exact.txt', offset: 1, limit: 2 }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.total_lines).toBe(2);
    expect(out.truncated).toBe(false);
  });

  it('reports an offset past EOF with the real line count', async () => {
    await fs.writeFile(path.join(sb.dir, 'past.txt'), 'a\nb\n');
    const out = await readTool.execute({ path: 'past.txt', offset: 3 }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.text).toContain('past end of file');
    expect(out.text).toContain('2 line(s)');
  });

  it('counts CRLF-terminated and single-line files the same way', async () => {
    await fs.writeFile(path.join(sb.dir, 'crlf.txt'), 'a\r\nb\r\n');
    const crlf = await readTool.execute({ path: 'crlf.txt' }, sb.ctx, { signal: newSignal() });
    expect(crlf.total_lines).toBe(2);

    await fs.writeFile(path.join(sb.dir, 'one.txt'), 'a\n');
    const one = await readTool.execute({ path: 'one.txt' }, sb.ctx, { signal: newSignal() });
    expect(one.total_lines).toBe(1);
  });

  it('keeps a no-EOL file and an empty file unchanged', async () => {
    await fs.writeFile(path.join(sb.dir, 'noeol.txt'), 'a\nb');
    const noEol = await readTool.execute({ path: 'noeol.txt' }, sb.ctx, { signal: newSignal() });
    expect(noEol.total_lines).toBe(2);
    const past = await readTool.execute({ path: 'noeol.txt', offset: 3 }, sb.ctx, {
      signal: newSignal(),
    });
    expect(past.text).toContain('past end of file');

    await fs.writeFile(path.join(sb.dir, 'empty.txt'), '');
    const empty = await readTool.execute({ path: 'empty.txt' }, sb.ctx, { signal: newSignal() });
    expect(empty.total_lines).toBe(0);
  });
});
