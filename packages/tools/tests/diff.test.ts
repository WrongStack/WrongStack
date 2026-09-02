import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diffTool } from '../src/diff.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'diff-tool-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const makeCtx = () => ({ cwd: tmpDir, tools: [], projectRoot: tmpDir }) as any;
const makeOpts = () => ({ signal: new AbortController().signal });

describe('diffTool', () => {
  it('has correct metadata', () => {
    expect(diffTool.name).toBe('diff');
    expect(diffTool.permission).toBe('auto');
    expect(diffTool.mutating).toBe(false);
  });

  it('rejects when no files specified for file diff', async () => {
    const ctx = makeCtx();
    const result = await diffTool.execute({}, ctx, makeOpts());
    expect(result.diff).toBe('No files specified');
    expect(result.files).toEqual([]);
  });

  it('resolves files relative to input.path when provided', async () => {
    const sub = path.join(tmpDir, 'sub');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, 'target.txt'), 'hello inside sub\n');
    const ctx = makeCtx();
    const result = await diffTool.execute({ path: 'sub', files: 'target.txt' }, ctx, makeOpts());
    expect(result.diff).toContain('hello inside sub');
    expect(result.mode).toBe('dump');
  });

  it('returns error when not in git repo for git diff', async () => {
    const ctx = { cwd: '/', tools: [], projectRoot: '/' } as any;
    const result = await diffTool.execute({ a: 'HEAD~1', b: 'HEAD' }, ctx, makeOpts());
    expect(result.diff).toBe('');
    expect(result.files).toEqual([]);
  });

  it('handles staged diff', async () => {
    const ctx = { cwd: '/', tools: [], projectRoot: '/' } as any;
    const result = await diffTool.execute({ staged: true }, ctx, makeOpts());
    expect(result).toHaveProperty('mode');
  });

  // F-01: argument injection via leading-dash git refs (CWE-88/CWE-22).
  // `a: '--output=<path>'` would make `git diff --output=<path>` write to an
  // arbitrary path with no confirmation (this tool is permission:'auto').
  it('rejects a git ref `a` that begins with "-" (flag injection)', async () => {
    const ctx = makeCtx();
    await expect(
      diffTool.execute({ a: '--output=/tmp/pwned', b: 'HEAD' }, ctx, makeOpts()),
    ).rejects.toThrow(/unsafe ref|flag injection/);
  });

  it('rejects a git ref `b` that begins with "-" (flag injection)', async () => {
    const ctx = makeCtx();
    await expect(
      diffTool.execute({ a: 'HEAD', b: '--output=/tmp/pwned' }, ctx, makeOpts()),
    ).rejects.toThrow(/unsafe ref|flag injection/);
  });

  it('does not write a file when given an --output injection ref', async () => {
    const ctx = makeCtx();
    const sentinel = path.join(tmpDir, 'should-not-exist');
    await diffTool
      .execute({ a: `--output=${sentinel}`, b: 'HEAD' }, ctx, makeOpts())
      .catch(() => undefined);
    await expect(fs.access(sentinel)).rejects.toThrow();
  });

  it('handles context option (dump path reports mode "dump")', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.writeFile(filePath, 'hello\nworld', 'utf8');
    const ctx = makeCtx();
    const result = await diffTool.execute({ files: 'file.txt', context: 5 }, ctx, makeOpts());
    expect(result.mode).toBe('dump');
  });

  it('side-by-side request on the dump path reports the real mode with a note', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.writeFile(filePath, 'hello\nworld', 'utf8');
    const ctx = makeCtx();
    const result = await diffTool.execute(
      { files: 'file.txt', mode: 'side-by-side' },
      ctx,
      makeOpts(),
    );
    // Honest mode: the files-only path never honors `mode` — it produces a
    // line-numbered dump, and says so instead of echoing the request back.
    expect(result.mode).toBe('dump');
    expect(result.note).toMatch(/line-numbered dump/);
  });

  it('stat request on the dump path reports the real mode with a note', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.writeFile(filePath, 'hello\nworld', 'utf8');
    const ctx = makeCtx();
    const result = await diffTool.execute({ files: 'file.txt', mode: 'stat' }, ctx, makeOpts());
    expect(result.mode).toBe('dump');
    expect(result.note).toMatch(/line-numbered dump/);
  });

  it('git path honors mode "stat" (runs git diff --stat)', async () => {
    const gitCtx = { cwd: process.cwd(), tools: [], projectRoot: process.cwd() } as any;
    const result = await diffTool.execute({ a: 'HEAD', mode: 'stat' }, gitCtx, makeOpts());
    expect(result.mode).toBe('stat');
    // --stat output never contains unified hunk headers.
    expect(result.diff).not.toMatch(/^@@ /m);
  });

  it('git path maps side-by-side to unified and reports what it produced', async () => {
    const gitCtx = { cwd: process.cwd(), tools: [], projectRoot: process.cwd() } as any;
    const result = await diffTool.execute({ a: 'HEAD', mode: 'side-by-side' }, gitCtx, makeOpts());
    expect(result.mode).toBe('unified');
    expect(result.note).toMatch(/side-by-side/);
  });

  it('git path passes context as -U<n> without failing', async () => {
    const gitCtx = { cwd: process.cwd(), tools: [], projectRoot: process.cwd() } as any;
    const result = await diffTool.execute({ a: 'HEAD', context: 0 }, gitCtx, makeOpts());
    expect(result).toHaveProperty('diff');
    expect(result.mode).toBe('unified');
  });

  // ─── new coverage tests ─────────────────────────────────────────────────────

  it('fileDiff skips non-existent files in diff output', async () => {
    const ctx = makeCtx();
    const result = await diffTool.execute({ files: 'nonexistent.txt' }, ctx, makeOpts());
    // files field preserves original input
    expect(result.files).toContain('nonexistent.txt');
    // but diff is empty since file doesn't exist
    expect(result.diff).toBe('');
  });

  it('fileDiff skips directories in diff output', async () => {
    await fs.mkdir(path.join(tmpDir, 'subdir'), { recursive: true });
    const ctx = makeCtx();
    const result = await diffTool.execute({ files: 'subdir' }, ctx, makeOpts());
    // files field preserves original input
    expect(result.files).toContain('subdir');
    // but diff is empty since it's a directory
    expect(result.diff).toBe('');
  });

  it('fileDiff handles comma-separated files list', async () => {
    const filePath = path.join(tmpDir, 'a.txt');
    await fs.writeFile(filePath, 'line1\nline2');
    const ctx = makeCtx();
    const result = await diffTool.execute({ files: 'a.txt,nonExistent.txt' }, ctx, makeOpts());
    expect(result.files).toContain('a.txt');
  });

  it('fileDiff handles array of files', async () => {
    const filePath = path.join(tmpDir, 'b.txt');
    await fs.writeFile(filePath, 'content');
    const ctx = makeCtx();
    const result = await diffTool.execute({ files: ['b.txt'] }, ctx, makeOpts());
    expect(result.files).toContain('b.txt');
  });

  it('fileDiff returns truncated false for small output', async () => {
    const filePath = path.join(tmpDir, 'small.txt');
    await fs.writeFile(filePath, 'short');
    const ctx = makeCtx();
    const result = await diffTool.execute({ files: 'small.txt' }, ctx, makeOpts());
    expect(result.truncated).toBe(false);
  });

  it('gitDiff uses a and b args to build git diff command', async () => {
    // Use a real git repo - the WrongStack repo itself
    const gitCtx = { cwd: process.cwd(), tools: [], projectRoot: process.cwd() } as any;
    const result = await diffTool.execute({ a: 'HEAD', b: 'HEAD~1' }, gitCtx, makeOpts());
    // Just verify it doesn't throw and produces a result
    expect(result).toHaveProperty('diff');
    expect(result).toHaveProperty('mode', 'unified');
  });

  it('gitDiff truncates large output', async () => {
    const gitCtx = { cwd: process.cwd(), tools: [], projectRoot: process.cwd() } as any;
    // The diff field truncation happens when stdout > 100_000
    const result = await diffTool.execute({ a: 'HEAD' }, gitCtx, makeOpts());
    expect(typeof result.truncated).toBe('boolean');
  });

  it('gitDiff handles files as array', async () => {
    const gitCtx = { cwd: process.cwd(), tools: [], projectRoot: process.cwd() } as any;
    const result = await diffTool.execute({ files: ['README.md'] }, gitCtx, makeOpts());
    expect(result).toHaveProperty('diff');
  });

  it('gitDiff handles comma-separated files', async () => {
    const gitCtx = { cwd: process.cwd(), tools: [], projectRoot: process.cwd() } as any;
    const result = await diffTool.execute({ files: 'README.md' }, gitCtx, makeOpts());
    expect(result).toHaveProperty('diff');
  });

  it('gitDiff appends a files filter after the -- separator (a + files)', async () => {
    const gitCtx = { cwd: process.cwd(), tools: [], projectRoot: process.cwd() } as any;
    const result = await diffTool.execute({ a: 'HEAD', files: ['README.md'] }, gitCtx, makeOpts());
    expect(result).toHaveProperty('diff');
    expect(result.mode).toBe('unified');
  });

  it('gitDiff appends a comma-separated files filter (a + files string)', async () => {
    const gitCtx = { cwd: process.cwd(), tools: [], projectRoot: process.cwd() } as any;
    const result = await diffTool.execute({ a: 'HEAD', files: 'README.md' }, gitCtx, makeOpts());
    expect(result).toHaveProperty('diff');
  });

  it('gitDiff works with only b set (a undefined)', async () => {
    const gitCtx = { cwd: process.cwd(), tools: [], projectRoot: process.cwd() } as any;
    const result = await diffTool.execute({ b: 'HEAD' }, gitCtx, makeOpts());
    expect(result).toHaveProperty('diff');
  });

  it('gitDiff adds --staged when staged is set alongside a ref', async () => {
    const gitCtx = { cwd: process.cwd(), tools: [], projectRoot: process.cwd() } as any;
    const result = await diffTool.execute({ a: 'HEAD', staged: true }, gitCtx, makeOpts());
    expect(result).toHaveProperty('diff');
  });

  it('gitDiff resolves (capturing git stderr) on an invalid ref', async () => {
    const gitCtx = { cwd: process.cwd(), tools: [], projectRoot: process.cwd() } as any;
    // A bogus revision makes git write to stderr (exercises the stderr handler).
    const result = await diffTool.execute({ a: 'HEAD~99999999', b: 'HEAD' }, gitCtx, makeOpts());
    expect(result).toHaveProperty('diff');
  });

  it('findGitDir returns null when no git repo exists up the tree', async () => {
    // Create a temp dir with no parent git repo
    const isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'no-git-'));
    try {
      const ctx = { cwd: isolatedDir, tools: [], projectRoot: isolatedDir } as any;
      const result = await diffTool.execute({ a: 'HEAD' }, ctx, makeOpts());
      // Should return empty diff since no git repo
      expect(result.diff).toBe('');
      expect(result.files).toEqual([]);
    } finally {
      await fs.rm(isolatedDir, { recursive: true, force: true });
    }
  });

  it('fileDiff produces a line-numbered dump (NOT a unified diff)', async () => {
    // After CRIT-002 (code-review) fix: the `files`-only path is a line-numbered
    // dump, not a unified diff. There must be no `+`/`-` prefixes and no
    // `+++ <file>` header — the previous implementation produced a misleading
    // fake-diff that marked every line as a context line.
    //
    // 12 lines → `width = 2` so padding is observable (lines 1-9 are right-
    // aligned with a leading space; line 12 fills the full width).
    const filePath = path.join(tmpDir, 'context.txt');
    const content = Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n');
    await fs.writeFile(filePath, content);
    const ctx = makeCtx();
    const result = await diffTool.execute({ files: 'context.txt', context: 2 }, ctx, makeOpts());

    // Header explicitly says it is NOT a unified diff
    expect(result.diff).toContain('--- context.txt (line-numbered dump, not a unified diff) ---');
    // Each original line is rendered with its 1-based index, right-aligned
    // to the digit-count of the line count (width = 2 here).
    expect(result.diff).toContain(' 1 | line0');
    expect(result.diff).toContain(' 9 | line8');
    expect(result.diff).toContain('12 | line11');
    // Negative invariants — must not look like a unified diff
    expect(result.diff).not.toContain('+++ context.txt');
    expect(result.diff).not.toMatch(/^ [^\d|]/m); // no space-prefixed bare context lines
  });

  it('fileDiff always reports mode "dump" regardless of the requested mode', async () => {
    const filePath = path.join(tmpDir, 'mode.txt');
    await fs.writeFile(filePath, 'test');
    const ctx = makeCtx();
    const result = await diffTool.execute({ files: 'mode.txt', mode: 'unified' }, ctx, makeOpts());
    expect(result.mode).toBe('dump');
  });

  // ─── RAM guard: oversized files are skipped, not read whole ──────────────

  it('fileDiff skips files exceeding the size cap and sets truncated=true', async () => {
    // 6 MiB — over the 5 MiB dump cap
    const bigFile = path.join(tmpDir, 'huge.txt');
    await fs.writeFile(bigFile, 'x'.repeat(6 * 1024 * 1024), 'utf8');
    const ctx = makeCtx();
    const result = await diffTool.execute({ files: 'huge.txt' }, ctx, makeOpts());
    expect(result.truncated).toBe(true);
    expect(result.diff).toContain('skipped');
    expect(result.diff).toContain('exceeds the');
  });

  it('fileDiff reads files just under the size cap without truncation', async () => {
    const okFile = path.join(tmpDir, 'ok.txt');
    await fs.writeFile(okFile, 'small content', 'utf8');
    const ctx = makeCtx();
    const result = await diffTool.execute({ files: 'ok.txt' }, ctx, makeOpts());
    expect(result.truncated).toBe(false);
    expect(result.diff).toContain('small content');
  });

  it('safely executes without opts and falls back to ctx.signal or default signal', async () => {
    const ctx = makeCtx();
    const result = await diffTool.execute({}, ctx);
    expect(result.diff).toBe('No files specified');
    expect(result.files).toEqual([]);

    const ac = new AbortController();
    const ctxWithSignal = { ...ctx, signal: ac.signal };
    const resultWithSignal = await diffTool.execute({ staged: true }, ctxWithSignal);
    expect(resultWithSignal).toHaveProperty('mode');
  });
});

