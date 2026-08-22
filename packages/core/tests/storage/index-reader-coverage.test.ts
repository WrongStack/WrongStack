import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySessionIndexLines, readFileRange } from '../../src/storage/session-store/index-reader.js';
import type { SessionSummary } from '../../src/types/session.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-idx-reader-'));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('applySessionIndexLines', () => {
  it('processes delete, create, and ordinary rows', () => {
    const byId = new Map<string, SessionSummary>();
    const deleted = new Set<string>();

    const summary = { id: 'a', title: 'A', startedAt: '2026-01-01T00:00:00Z', model: 'm', provider: 'p', tokenTotal: 0 };

    const raw = [
      JSON.stringify(summary),
      JSON.stringify({ action: 'delete', id: 'b' }),
      JSON.stringify({ action: 'create', id: 'c' }),
      '{not json',
      '',
    ].join('\n');

    applySessionIndexLines(raw, byId, deleted);
    expect(byId.has('a')).toBe(true);
    expect(deleted.has('b')).toBe(true);
    expect(deleted.has('c')).toBe(false);
    expect(byId.has('c')).toBe(false);
  });

  it('does not overwrite tombstoned entries with ordinary rows', () => {
    const byId = new Map<string, SessionSummary>();
    const deleted = new Set<string>();

    const summary = { id: 'x', title: 'X', startedAt: '2026-01-01T00:00:00Z', model: 'm', provider: 'p', tokenTotal: 0 };

    const raw = [
      JSON.stringify(summary),
      JSON.stringify({ action: 'delete', id: 'x' }),
      // This ordinary row should NOT resurrect x because deleted.has('x') is true
      JSON.stringify(summary),
    ].join('\n');

    applySessionIndexLines(raw, byId, deleted);
    expect(deleted.has('x')).toBe(true);
  });
});

describe('readFileRange', () => {
  it('returns a zero-length range when start === end', async () => {
    const file = path.join(tmp, 'range.jsonl');
    await fsp.writeFile(file, 'hello\nworld\n', 'utf8');
    const result = await readFileRange(file, 5, 5);
    expect(result).toEqual({ raw: '', end: 5 });
  });

  it('returns the full appended chunk when it ends on a newline', async () => {
    const file = path.join(tmp, 'range.jsonl');
    const line = JSON.stringify({ id: 'a', title: 'A', startedAt: '2026-01-01T00:00:00Z', model: 'm', provider: 'p', tokenTotal: 0 });
    await fsp.writeFile(file, line + '\n', 'utf8');
    const result = await readFileRange(file, 0, (await fsp.stat(file)).size);
    expect(result).not.toBeNull();
    expect(result!.raw).toBe(line + '\n');
    expect(result!.end).toBeGreaterThan(0);
  });

  it('truncates to the last complete newline when the chunk ends mid-line', async () => {
    const file = path.join(tmp, 'range.jsonl');
    await fsp.writeFile(file, 'partial_line_without_newline', 'utf8');
    const result = await readFileRange(file, 0, 10);
    expect(result).not.toBeNull();
    // No newline in the first 10 bytes → completeLength = lastNewline + 1 = -1 + 1 = 0
    expect(result!.end).toBe(0);
  });

  it('handles trailing whitespace after the last complete line', async () => {
    const file = path.join(tmp, 'range.jsonl');
    const valid = '{"id":"a"}' + '\n';
    await fsp.writeFile(file, valid + '   ', 'utf8');
    const st = await fsp.stat(file);
    const result = await readFileRange(file, 0, st.size);
    expect(result).not.toBeNull();
    expect(result!.raw).toBe(valid);
  });

  it('retries an incomplete JSON suffix from the last complete newline', async () => {
    const file = path.join(tmp, 'range.jsonl');
    // First complete line, then an invalid trailing fragment.
    const valid = '{"id":"a"}' + '\n';
    const partial = '{"incomple';
    const content = valid + partial;
    await fsp.writeFile(file, content, 'utf8');
    const st = await fsp.stat(file);
    // Read the full file — the trailing partial should be truncated.
    const result = await readFileRange(file, 0, st.size);
    expect(result).not.toBeNull();
    expect(result!.raw).toBe(valid);
  });

  it('returns null when the file cannot be opened', async () => {
    const file = path.join(tmp, 'missing.jsonl');
    const result = await readFileRange(file, 0, 100);
    expect(result).toBeNull();
  });

  it('returns null when read returns zero bytes past EOF', async () => {
    const file = path.join(tmp, 'range.jsonl');
    await fsp.writeFile(file, 'ab', 'utf8');
    const result = await readFileRange(file, 100, 200);
    expect(result).toBeNull();
  });
});
