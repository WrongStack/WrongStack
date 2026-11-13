import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePdfPageRange } from '../src/pdf-text.js';
import { readTool } from '../src/read.js';
import { makePdf } from './pdf-fixture.js';

describe('read on a PDF', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-pdf-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ cwd: dir, projectRoot: dir, workingDir: dir, meta: {} }) as never;
  const read = (input: Record<string, unknown>) =>
    readTool.execute(input as never, ctx(), { signal: new AbortController().signal });

  it('returns the text of each page instead of refusing a binary file', async () => {
    await fs.writeFile(path.join(dir, 'doc.pdf'), makePdf(['Alpha page', 'Beta page']));
    const out = await read({ path: 'doc.pdf' });
    expect(out.text).toBe('--- page 1 ---\nAlpha page\n\n--- page 2 ---\nBeta page');
    expect(out.encoding).toBe('pdf-text');
    expect(out.truncated).toBe(false);
    expect(out.note).toContain('PDF, 2 pages; pages 1-2 shown.');
  });

  it('reads a long PDF in ranges and says where to continue', async () => {
    const pages = Array.from({ length: 25 }, (_, i) => `Text of page ${i + 1}`);
    await fs.writeFile(path.join(dir, 'long.pdf'), makePdf(pages));

    const firstRead = await read({ path: 'long.pdf' });
    expect(firstRead.text).toContain('--- page 20 ---\nText of page 20');
    expect(firstRead.text).not.toContain('page 21');
    expect(firstRead.truncated).toBe(true);
    expect(firstRead.note).toContain('Read more with pages: "21-25"');

    const rest = await read({ path: 'long.pdf', pages: '21-' });
    expect(rest.text.startsWith('--- page 21 ---\nText of page 21')).toBe(true);
    expect(rest.text).toContain('Text of page 25');
    expect(rest.truncated).toBe(false);
  });

  it('says so when the pages have no text layer', async () => {
    await fs.writeFile(path.join(dir, 'scan.pdf'), makePdf([null]));
    const out = await read({ path: 'scan.pdf' });
    expect(out.note).toContain('no text layer');
  });

  it('finds a PDF saved without its extension', async () => {
    await fs.writeFile(path.join(dir, 'download'), makePdf(['Hidden PDF']));
    const out = await read({ path: 'download' });
    expect(out.text).toContain('Hidden PDF');
  });

  it('refuses a malformed or out-of-range page request with a clear reason', async () => {
    await fs.writeFile(path.join(dir, 'doc.pdf'), makePdf(['one', 'two']));
    await expect(read({ path: 'doc.pdf', pages: '5' })).rejects.toThrow(
      /starts past the last page/,
    );
    await expect(read({ path: 'doc.pdf', pages: 'abc' })).rejects.toThrow(/pages must look like/);
  });
});

describe('parsePdfPageRange', () => {
  it('defaults to the first 20 pages and caps a range at 20', () => {
    expect(parsePdfPageRange(undefined, 50)).toEqual({ first: 1, last: 20 });
    expect(parsePdfPageRange('3', 50)).toEqual({ first: 3, last: 3 });
    expect(parsePdfPageRange('45-', 50)).toEqual({ first: 45, last: 50 });
    expect(parsePdfPageRange('2-9', 5)).toEqual({ first: 2, last: 5 });
    expect(() => parsePdfPageRange('1-21', 50)).toThrow(/at most 20/);
    expect(() => parsePdfPageRange('4-2', 50)).toThrow(/not a valid range/);
  });

  it('measures the per-call cap against pages that exist, not the requested end', () => {
    // A range past the last page is clamped (see '2-9' on 5 pages above), so the
    // 20-page cap must apply to the clamped span: '1-25' on a 10-page PDF reads
    // 10 pages and must not be rejected as "spans 25 pages".
    expect(parsePdfPageRange('1-25', 10)).toEqual({ first: 1, last: 10 });
    expect(parsePdfPageRange('5-100', 8)).toEqual({ first: 5, last: 8 });
    // The cap still applies when the clamped span really exceeds it.
    expect(() => parsePdfPageRange('1-100', 50)).toThrow(/spans 50 pages/);
  });
});
