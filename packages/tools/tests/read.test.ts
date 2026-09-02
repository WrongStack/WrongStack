import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isFsError, isToolValidationError } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTool } from '../src/read.js';
import { mkSandbox, newSignal, type Sandbox } from './fixtures.js';

// ── Symbol injection mocks ──────────────────────────────────────────────────
// Mutable state shared with the vi.mock factory. The existing tests never set
// includeSymbols or the advanced-mode meta flag, so they never trigger
// fetchSymbolsForFile — the mock is transparent for them.
const mockIndexState = vi.hoisted(() => ({ ready: false }));
const mockSymbols = vi.hoisted(() => ({
  results: [] as Array<{
    name: string;
    kind: string;
    line: number;
    col: number;
    signature: string;
  }>,
}));
const mockSearch = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());
mockSearch.mockResolvedValue(mockSymbols);

vi.mock('../src/codebase-index/background-indexer.js', () => ({
  getIndexState: () => mockIndexState,
  searchCodebaseIndex: mockSearch,
}));
// ─────────────────────────────────────────────────────────────────────────────

describe('read tool', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await mkSandbox();
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  it('reads with line numbers', async () => {
    const file = path.join(sb.dir, 'a.txt');
    await fs.writeFile(file, 'first\nsecond\nthird\n');
    const out = await readTool.execute({ path: 'a.txt' }, sb.ctx, { signal: newSignal() });
    expect(out.text).toContain('1→first');
    expect(out.text).toContain('2→second');
    expect(out.total_lines).toBeGreaterThanOrEqual(3);
  });

  it('supports offset and limit', async () => {
    const file = path.join(sb.dir, 'b.txt');
    await fs.writeFile(file, Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n'));
    const out = await readTool.execute({ path: 'b.txt', offset: 10, limit: 5 }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.text).toContain('10→line10');
    expect(out.text).toContain('14→line14');
    expect(out.text).not.toContain('15→');
  });

  it('suppresses repeated reads of an unchanged already-seen range', async () => {
    const file = path.join(sb.dir, 'repeat.txt');
    await fs.writeFile(file, 'first\nsecond\nthird\n');
    const first = await readTool.execute({ path: 'repeat.txt' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(first.text).toContain('1→first');

    const second = await readTool.execute({ path: 'repeat.txt' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(second.cached).toBe(true);
    expect(second.text).toContain('unchanged since previous read');
    expect(second.text).not.toContain('1→first');
  });

  it('does not suppress a new explicit range that was not seen yet', async () => {
    const file = path.join(sb.dir, 'ranges.txt');
    await fs.writeFile(file, Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n'));
    await readTool.execute({ path: 'ranges.txt', offset: 1, limit: 3 }, sb.ctx, {
      signal: newSignal(),
    });

    const out = await readTool.execute({ path: 'ranges.txt', offset: 10, limit: 2 }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.cached).toBeUndefined();
    expect(out.text).toContain('10→line10');
    expect(out.text).toContain('11→line11');
  });

  it('supports compact summary mode', async () => {
    const file = path.join(sb.dir, 'summary.ts');
    await fs.writeFile(
      file,
      [
        "import { value } from './value';",
        'const hidden = 1;',
        'export function run() {',
        '  return value + hidden;',
        '}',
      ].join('\n'),
    );
    const out = await readTool.execute({ path: 'summary.ts', mode: 'summary' }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.text).toContain('summary: summary.ts');
    expect(out.text).toContain('1: import');
    expect(out.text).toContain('3: export function run');
    expect(out.text).not.toContain('return value');
  });

  it('requires a path', async () => {
    await expect(readTool.execute({ path: '' }, sb.ctx, { signal: newSignal() })).rejects.toThrow(
      /path is required/,
    );
  });

  it('rejects a directory (not a regular file)', async () => {
    await fs.mkdir(path.join(sb.dir, 'adir'));
    await expect(
      readTool.execute({ path: 'adir' }, sb.ctx, { signal: newSignal() }),
    ).rejects.toThrow(/not a regular file/);
  });

  it('rejects files larger than the 5MB cap', async () => {
    const file = path.join(sb.dir, 'big.txt');
    await fs.writeFile(file, Buffer.alloc(5 * 1024 * 1024 + 1, 0x61)); // 5MB+1 of 'a'
    await expect(
      readTool.execute({ path: 'big.txt' }, sb.ctx, { signal: newSignal() }),
    ).rejects.toThrow(/file too large/);
  });

  it('rejects binary files', async () => {
    const file = path.join(sb.dir, 'bin.bin');
    await fs.writeFile(file, Buffer.from([0, 1, 2, 3, 0, 5]));
    await expect(
      readTool.execute({ path: 'bin.bin' }, sb.ctx, { signal: newSignal() }),
    ).rejects.toThrow(/binary/);
  });

  it('records read in context', async () => {
    const file = path.join(sb.dir, 'c.txt');
    await fs.writeFile(file, 'x');
    await readTool.execute({ path: 'c.txt' }, sb.ctx, { signal: newSignal() });
    const abs = path.normalize(path.resolve(sb.dir, 'c.txt'));
    expect(sb.ctx.hasRead(abs)).toBe(true);
  });

  it('rejects sandbox escape', async () => {
    await expect(
      readTool.execute({ path: '../../etc/passwd' }, sb.ctx, { signal: newSignal() }),
    ).rejects.toThrow();
  });

  it('rejects file that does not exist', async () => {
    await expect(
      readTool.execute({ path: 'nonexistent.txt' }, sb.ctx, { signal: newSignal() }),
    ).rejects.toThrow(/not found/);
  });

  it('returns empty text with truncated=true when limit=0', async () => {
    const file = path.join(sb.dir, 'd.txt');
    await fs.writeFile(file, 'first\nsecond\nthird\n');
    const out = await readTool.execute({ path: 'd.txt', limit: 0 }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.text).toBe('');
    expect(out.truncated).toBe(true);
    expect(out.total_lines).toBeGreaterThan(0);
    // ctx.recordRead should still be called
    const abs = path.normalize(path.resolve(sb.dir, 'd.txt'));
    expect(sb.ctx.hasRead(abs)).toBe(true);
  });

  it('returns past-EOF message when offset exceeds file length', async () => {
    const file = path.join(sb.dir, 'eof.txt');
    await fs.writeFile(file, 'line1\nline2\nline3\n');
    const out = await readTool.execute({ path: 'eof.txt', offset: 999 }, sb.ctx, {
      signal: newSignal(),
    });
    // Must NOT be an empty string — empty results cause tool-use loops on
    // models with weak instruction-following (k2p7, etc.).
    expect(out.text).not.toBe('');
    expect(out.text).toContain('past end of file');
    expect(out.text).toContain('999');
    expect(out.text).toContain('line'); // "N line(s)" — exact count varies by trailing newline
    expect(out.total_lines).toBeGreaterThanOrEqual(3);
    // Still records the read so edit safety checks pass.
    const abs = path.normalize(path.resolve(sb.dir, 'eof.txt'));
    expect(sb.ctx.hasRead(abs)).toBe(true);
  });

  it('returns past-EOF message when offset equals total+1 (boundary)', async () => {
    const file = path.join(sb.dir, 'boundary.txt');
    await fs.writeFile(file, 'only\n');
    // File has ~2 lines after split (content + empty trailing), so offset 10
    // is safely past EOF.
    const out = await readTool.execute({ path: 'boundary.txt', offset: 10 }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.text).toContain('past end of file');
  });

  it('repeated read past EOF does not return inverted range message from cache', async () => {
    const file = path.join(sb.dir, 'repeated-eof.txt');
    await fs.writeFile(file, 'line 1\nline 2\n');
    const out1 = await readTool.execute(
      { path: 'repeated-eof.txt', offset: 10, limit: 10 },
      sb.ctx,
      {
        signal: newSignal(),
      },
    );
    expect(out1.text).toContain('past end of file');

    const out2 = await readTool.execute(
      { path: 'repeated-eof.txt', offset: 10, limit: 10 },
      sb.ctx,
      {
        signal: newSignal(),
      },
    );
    expect(out2.text).toContain('past end of file');
    expect(out2.text).not.toContain('already shown');
  });

  // F-04 (CWE-59): a symlink that lives INSIDE the project root but points
  // outside must not be followed — `safeResolve`'s syntactic check passes it,
  // the realpath cross-check (safeResolveReal) must reject it.
  it('refuses to read through an in-root symlink pointing outside the root', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-outside-'));
    try {
      const secret = path.join(outside, 'secret.txt');
      await fs.writeFile(secret, 'TOP SECRET');
      const link = path.join(sb.dir, 'escape.txt');
      try {
        await fs.symlink(secret, link);
      } catch (err) {
        // Symlink creation can require privileges (Windows without dev mode).
        if ((err as NodeJS.ErrnoException).code === 'EPERM') return; // skip
        throw err;
      }
      await expect(
        readTool.execute({ path: 'escape.txt' }, sb.ctx, { signal: newSignal() }),
      ).rejects.toThrow(/symlink outside project root/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  describe('includeSymbols / symbols feature', () => {
    beforeEach(() => {
      // Default: index is not ready, no mock symbols. Reset mock function
      // so per-test mockRejectedValueOnce calls from previous tests don't
      // leak (the vi.fn starts with the default implementation each time).
      mockIndexState.ready = false;
      mockSymbols.results = [];
      mockSearch.mockReset();
      mockSearch.mockResolvedValue(mockSymbols);
    });

    it('omits symbols field when advanced mode is off and includeSymbols is not set', async () => {
      const file = path.join(sb.dir, 'plain.txt');
      await fs.writeFile(file, 'hello\n');
      const out = await readTool.execute({ path: 'plain.txt' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.symbols).toBeUndefined();
    });

    it('omits symbols field when index unavailable even if includeSymbols is set', async () => {
      const file = path.join(sb.dir, 'req.txt');
      await fs.writeFile(file, 'hello\n');
      const out = await readTool.execute({ path: 'req.txt', includeSymbols: true }, sb.ctx, {
        signal: newSignal(),
      });
      // Index not ready in test env, so symbols key must be absent.
      // The important invariant is that the read itself succeeds.
      expect(out.text).toContain('1→hello');
      expect(out.symbols).toBeUndefined();
      expect('symbols' in out).toBe(false);
    });

    it('omits symbols field when meta flag is on but index unavailable', async () => {
      const file = path.join(sb.dir, 'adv.txt');
      await fs.writeFile(file, 'hello\n');
      sb.ctx.meta['tools.read.advancedMode'] = true;
      const out = await readTool.execute({ path: 'adv.txt' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.text).toContain('1→hello');
      expect(out.symbols).toBeUndefined();
    });

    it('per-call includeSymbols: false suppresses symbols even with meta flag on', async () => {
      const file = path.join(sb.dir, 'suppress.txt');
      await fs.writeFile(file, 'hello\n');
      sb.ctx.meta['tools.read.advancedMode'] = true;
      const out = await readTool.execute({ path: 'suppress.txt', includeSymbols: false }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.symbols).toBeUndefined();
      expect(out.text).toContain('1→hello');
    });

    it('includes symbols with summary mode when index is ready', async () => {
      const file = path.join(sb.dir, 'sum-sym.ts');
      await fs.writeFile(file, 'export const x = 1;\n');
      mockIndexState.ready = true;
      mockSymbols.results = [
        { name: 'x', kind: 'const', line: 1, col: 12, signature: 'const x = 1' },
      ];
      sb.ctx.meta['tools.read.advancedMode'] = true;
      const out = await readTool.execute({ path: 'sum-sym.ts', mode: 'summary' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.text).toContain('summary:');
      expect(out.symbols).toBeDefined();
      expect(out.symbols).toHaveLength(1);
      expect(out.symbols![0]!.name).toBe('x');
    });

    it('returns SymbolEntry entries with correct shape when index is ready', async () => {
      const file = path.join(sb.dir, 'shapes.ts');
      await fs.writeFile(file, 'function a() {}\nclass B {}\nconst C = 1;\n');
      mockIndexState.ready = true;
      mockSymbols.results = [
        { name: 'a', kind: 'function', line: 1, col: 9, signature: 'function a()' },
        { name: 'B', kind: 'class', line: 2, col: 6, signature: 'class B' },
        { name: 'C', kind: 'const', line: 3, col: 6, signature: 'const C = 1' },
      ];
      const out = await readTool.execute({ path: 'shapes.ts', includeSymbols: true }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.symbols).toBeDefined();
      expect(out.symbols).toHaveLength(3);
      // Verify SymbolEntry shape: name, kind, line, col, signature
      expect(out.symbols![0]).toEqual({
        name: 'a',
        kind: 'function',
        line: 1,
        col: 9,
        signature: 'function a()',
      });
      expect(out.symbols![1]).toEqual({
        name: 'B',
        kind: 'class',
        line: 2,
        col: 6,
        signature: 'class B',
      });
      expect(out.symbols![2]).toEqual({
        name: 'C',
        kind: 'const',
        line: 3,
        col: 6,
        signature: 'const C = 1',
      });
    });

    it('includes symbols on a cached repeated read when index is ready', async () => {
      const file = path.join(sb.dir, 'cached-sym.ts');
      await fs.writeFile(file, 'export const X = 1;\nexport function y() {}\n');
      // First read — establishes cache range, no includeSymbols
      mockIndexState.ready = true;
      mockSymbols.results = [];

      const first = await readTool.execute({ path: 'cached-sym.ts' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(first.text).toContain('1→export');
      expect(first.cached).toBeUndefined();

      // Second read — cached hit with includeSymbols: true
      mockSymbols.results = [
        { name: 'X', kind: 'const', line: 1, col: 12, signature: 'const X = 1' },
        { name: 'y', kind: 'function', line: 2, col: 15, signature: 'function y()' },
      ];
      const second = await readTool.execute(
        { path: 'cached-sym.ts', includeSymbols: true },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(second.cached).toBe(true);
      expect(second.symbols).toBeDefined();
      expect(second.symbols).toHaveLength(2);
      expect(second.symbols![0]!.name).toBe('X');
      expect(second.symbols![1]!.name).toBe('y');
    });

    it('includes symbols on limit=0 read when index is ready', async () => {
      const file = path.join(sb.dir, 'limit0-sym.ts');
      await fs.writeFile(file, 'const A = 1;\n');
      mockIndexState.ready = true;
      mockSymbols.results = [
        { name: 'A', kind: 'const', line: 1, col: 6, signature: 'const A = 1' },
      ];
      const out = await readTool.execute(
        { path: 'limit0-sym.ts', limit: 0, includeSymbols: true },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.text).toBe('');
      expect(out.total_lines).toBeGreaterThan(0);
      expect(out.symbols).toBeDefined();
      expect(out.symbols).toHaveLength(1);
      expect(out.symbols![0]!.name).toBe('A');
    });

    it('includes symbols on offset>total read when index is ready', async () => {
      const file = path.join(sb.dir, 'eof-sym.ts');
      await fs.writeFile(file, 'const Z = 1;\n');
      mockIndexState.ready = true;
      mockSymbols.results = [
        { name: 'Z', kind: 'const', line: 1, col: 6, signature: 'const Z = 1' },
      ];
      const out = await readTool.execute(
        { path: 'eof-sym.ts', offset: 999, includeSymbols: true },
        sb.ctx,
        { signal: newSignal() },
      );
      expect(out.text).toContain('past end of file');
      expect(out.symbols).toBeDefined();
      expect(out.symbols).toHaveLength(1);
      expect(out.symbols![0]!.name).toBe('Z');
    });

    it('returns no symbols without throwing when the index is not ready', async () => {
      const file = path.join(sb.dir, 'noindex.txt');
      await fs.writeFile(file, 'const secret = 42;\n');
      mockIndexState.ready = false;
      const out = await readTool.execute({ path: 'noindex.txt', includeSymbols: true }, sb.ctx, {
        signal: newSignal(),
      });
      // Index not ready — symbols key should be absent entirely.
      expect('symbols' in out).toBe(false);
      expect(out.symbols).toBeUndefined();
      // The read itself must still succeed.
      expect(out.text).toContain('1→const');
    });

    it('does not throw when searchCodebaseIndex throws (fetchSymbolsForFile catches)', async () => {
      const file = path.join(sb.dir, 'throws.txt');
      await fs.writeFile(file, 'const a = 1;\n');
      mockIndexState.ready = true;
      // Make searchCodebaseIndex throw — fetchSymbolsForFile catches all
      // errors internally and returns { symbols: undefined }.
      mockSearch.mockRejectedValueOnce(new Error('db fail'));
      const out = await readTool.execute({ path: 'throws.txt', includeSymbols: true }, sb.ctx, {
        signal: newSignal(),
      });
      // Index threw, so no symbols in output.
      expect('symbols' in out).toBe(false);
      expect(out.symbols).toBeUndefined();
      // The read itself must still succeed.
      expect(out.text).toContain('1→const');
    });
  });

  describe('structured error shape', () => {
    it('throws ToolValidationError when path is missing', async () => {
      let caught: unknown;
      try {
        await readTool.execute({ path: '' }, sb.ctx, { signal: newSignal() });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(isToolValidationError(caught)).toBe(true);
      const ve = caught as ReturnType<typeof isToolValidationError> & {
        code: string;
        context?: Record<string, unknown>;
      };
      expect(ve.code).toBe('VALIDATION_ERROR');
      expect(ve.context?.field).toBe('path');
    });

    it('throws FsError(FS_READ_FAILED) when the file does not exist', async () => {
      let caught: unknown;
      try {
        await readTool.execute({ path: 'missing.txt' }, sb.ctx, {
          signal: newSignal(),
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(isFsError(caught)).toBe(true);
      const fe = caught as ReturnType<typeof isFsError> & {
        code: string;
        path?: string;
        context?: Record<string, unknown>;
      };
      expect(fe.code).toBe('FS_READ_FAILED');
      expect(fe.context?.errno).toBe('ENOENT');
    });

    it('throws FsError when the target is not a regular file', async () => {
      await fs.mkdir(path.join(sb.dir, 'a-dir'));
      let caught: unknown;
      try {
        await readTool.execute({ path: 'a-dir' }, sb.ctx, { signal: newSignal() });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(isFsError(caught)).toBe(true);
      const fe = caught as ReturnType<typeof isFsError> & {
        code: string;
        context?: Record<string, unknown>;
      };
      expect(fe.code).toBe('FS_READ_FAILED');
      expect(fe.context?.reason).toBe('not-a-regular-file');
    });

    it('throws when ctx.signal is aborted and execOpts is omitted', async () => {
      const file = path.join(sb.dir, 'abort.txt');
      await fs.writeFile(file, 'hello world\n');
      const ctrl = new AbortController();
      ctrl.abort();
      const ctxWithSignal = { ...sb.ctx, signal: ctrl.signal };
      await expect(
        readTool.execute({ path: 'abort.txt' }, ctxWithSignal as any),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('throws when execOpts.signal is pre-aborted', async () => {
      const file = path.join(sb.dir, 'abort2.txt');
      await fs.writeFile(file, 'hello world\n');
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(
        readTool.execute({ path: 'abort2.txt' }, sb.ctx, { signal: ctrl.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
});
