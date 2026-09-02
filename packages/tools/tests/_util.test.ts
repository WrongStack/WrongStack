import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_OUTPUT_MAX_BYTES,
  assertRealInsideRoot,
  collapseCarriageReturns,
  collapseConsecutiveDuplicates,
  detectPackageManager,
  ensureInsideRoot,
  isBinaryBuffer,
  normalizeCommandOutput,
  resolvePath,
  safeResolve,
  truncateHeadTail,
  truncateMiddle,
} from '../src/_util.js';

const ctx = (overrides: Partial<Context> = {}): Context =>
  ({
    cwd: overrides.cwd ?? path.resolve('/tmp/project'),
    projectRoot: overrides.projectRoot ?? path.resolve('/tmp/project'),
  }) as Context;

describe('resolvePath', () => {
  it('returns absolute input normalized', () => {
    const c = ctx();
    const abs = path.resolve('/tmp/project/a/b/c.txt');
    expect(resolvePath(abs, c)).toBe(path.normalize(abs));
  });

  it('resolves relative input against ctx.cwd', () => {
    const c = ctx({ cwd: path.resolve('/tmp/project') });
    const out = resolvePath('sub/file.txt', c);
    expect(path.isAbsolute(out)).toBe(true);
    expect(out).toBe(path.resolve('/tmp/project/sub/file.txt'));
  });
});

describe('ensureInsideRoot', () => {
  it('returns the resolved target when inside the root', () => {
    const c = ctx();
    const target = path.resolve('/tmp/project/a.txt');
    expect(ensureInsideRoot(target, c)).toBe(target);
  });

  it('throws when the path is outside the root', () => {
    const c = ctx({ projectRoot: path.resolve('/tmp/project') });
    const outside = path.resolve('/tmp/elsewhere/a.txt');
    expect(() => ensureInsideRoot(outside, c)).toThrow(/outside project root/);
  });

  it('allows the root itself', () => {
    const c = ctx();
    const root = c.projectRoot;
    expect(ensureInsideRoot(root, c)).toBe(path.resolve(root));
  });

  it('rejects parent traversal', () => {
    const c = ctx({ projectRoot: path.resolve('/tmp/project') });
    const parent = path.resolve('/tmp');
    expect(() => ensureInsideRoot(parent, c)).toThrow(/outside project root/);
  });
});

describe('safeResolve', () => {
  it('resolves and validates in one step', () => {
    const c = ctx();
    const out = safeResolve('a.txt', c);
    expect(out).toBe(path.resolve(c.cwd, 'a.txt'));
  });

  it('throws when the resolved path escapes the root', () => {
    const c = ctx({
      cwd: path.resolve('/tmp/project/sub'),
      projectRoot: path.resolve('/tmp/project'),
    });
    expect(() => safeResolve('../../escape.txt', c)).toThrow(/outside project root/);
  });
});

describe('unrestricted filesystem access (allowOutsideProjectRoot === true)', () => {
  // The runtime constructs the leader/subagent Context with allowOutsideProjectRoot
  // derived from `features.allowOutsideProjectRoot` (default true). When true, the
  // project-root containment checks are bypassed so tools can reach outside.
  const open = (overrides: Partial<Context> = {}): Context =>
    ({
      cwd: overrides.cwd ?? path.resolve('/tmp/project'),
      projectRoot: overrides.projectRoot ?? path.resolve('/tmp/project'),
      allowOutsideProjectRoot: true,
    }) as Context;

  it('ensureInsideRoot returns an outside path instead of throwing', () => {
    const c = open();
    const outside = path.resolve('/tmp/elsewhere/a.txt');
    expect(ensureInsideRoot(outside, c)).toBe(outside);
  });

  it('safeResolve resolves a `..` escape without throwing', () => {
    const c = open({
      cwd: path.resolve('/tmp/project/sub'),
      projectRoot: path.resolve('/tmp/project'),
    });
    expect(safeResolve('../../escape.txt', c)).toBe(path.resolve('/tmp/escape.txt'));
  });

  it('assertRealInsideRoot resolves for an outside path without throwing', async () => {
    const c = open();
    await expect(
      assertRealInsideRoot(path.resolve('/tmp/elsewhere/a.txt'), c),
    ).resolves.toBeUndefined();
  });

  it('still confines when the flag is omitted (defaults to restricted)', () => {
    const c = ctx({ projectRoot: path.resolve('/tmp/project') });
    expect(() => ensureInsideRoot(path.resolve('/tmp/elsewhere/a.txt'), c)).toThrow(
      /outside project root/,
    );
  });
});

describe('truncateMiddle', () => {
  it('returns input unchanged when under the byte limit', () => {
    expect(truncateMiddle('hello', 100)).toBe('hello');
  });

  it('uses byte length, not character length', () => {
    // 'é' is 2 UTF-8 bytes — 4 chars but 8 bytes.
    const s = 'éééé';
    expect(truncateMiddle(s, 8)).toBe(s); // 8 bytes fits exactly at limit 8
    // Budget 4 leaves no room for the marker (MARKER_RESERVE = 64) — hard cut.
    const out = truncateMiddle(s, 4);
    expect(out).not.toBe(s);
    expect(out).toBe('éé');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(4);
  });

  it('truncates the middle and notes the true byte count removed', () => {
    const s = 'a'.repeat(1000);
    const out = truncateMiddle(s, 100);
    expect(out).toContain('truncated');
    // Marker room is reserved from the budget: 18+18 content bytes are kept,
    // 964 reported — and content + marker together stay within the 100-byte cap.
    expect(out).toContain('964 bytes');
    expect(out.startsWith('a'.repeat(18))).toBe(true);
    expect(out.endsWith('a'.repeat(18))).toBe(true);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(100);
  });

  it('handles exact-fit input without truncation', () => {
    const s = 'a'.repeat(10);
    expect(truncateMiddle(s, 10)).toBe(s);
  });

  // Regression (elite-bug-hunter r1-truncate-middle-byte-budget-20260902):
  // the pre-fix implementation gated on byte length but sliced by UTF-16 code
  // units, so multibyte content (3-4 UTF-8 bytes per code unit) sailed past
  // the budget — the fetch tool's declared maxOutputBytes — and the marker
  // reported `total - max` regardless of what was actually kept.
  it('multibyte content never exceeds the byte budget (fetch-tool scale)', () => {
    const s = '中'.repeat(400_000); // 400k UTF-16 units = 1.2 MB UTF-8
    const max = 131_072; // fetchTool MAX_BYTES / maxOutputBytes
    const out = truncateMiddle(s, max);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(max);
    expect(out).toContain('truncated');
  });

  it('marker reports the dropped content byte count truthfully', () => {
    const s = 'é'.repeat(100); // 100 units = 200 UTF-8 bytes
    const out = truncateMiddle(s, 100);
    const m = /truncated (\d+) bytes/.exec(out);
    expect(m).not.toBeNull();
    const claimed = Number(m?.[1] ?? -1);
    // House semantic (truncateHeadTail/truncateDiffPayload): the marker counts
    // dropped CONTENT bytes — output minus the marker itself.
    const marker = `\n…[truncated ${claimed} bytes from middle]…\n`;
    const keptContent = Buffer.byteLength(out, 'utf8') - Buffer.byteLength(marker, 'utf8');
    expect(claimed).toBe(Buffer.byteLength(s, 'utf8') - keptContent);
  });
});

describe('isBinaryBuffer', () => {
  it('returns true when the buffer contains a NUL byte in the first 8KB', () => {
    const buf = Buffer.concat([Buffer.from('text'), Buffer.from([0]), Buffer.from('more')]);
    expect(isBinaryBuffer(buf)).toBe(true);
  });

  it('returns false for ASCII text', () => {
    expect(isBinaryBuffer(Buffer.from('hello world'))).toBe(false);
  });

  it('returns false for UTF-8 multi-byte content with no NUL', () => {
    expect(isBinaryBuffer(Buffer.from('éà漢字'))).toBe(false);
  });

  it('returns false for an empty buffer', () => {
    expect(isBinaryBuffer(Buffer.alloc(0))).toBe(false);
  });

  it('only scans the first 8KB', () => {
    // Place NUL at byte 9000, well past the scan window.
    const buf = Buffer.alloc(10_000, 0x61);
    buf[9000] = 0;
    expect(isBinaryBuffer(buf)).toBe(false);
  });

  it('detects NUL right at the start', () => {
    const buf = Buffer.concat([Buffer.from([0]), Buffer.from('rest')]);
    expect(isBinaryBuffer(buf)).toBe(true);
  });
});

describe('tmpdir round-trip', () => {
  it('resolvePath + ensureInsideRoot together work with real os.tmpdir', () => {
    const root = os.tmpdir();
    const c = ctx({ cwd: root, projectRoot: root });
    const target = path.join(root, 'demo.txt');
    expect(safeResolve('demo.txt', c)).toBe(target);
  });
});

describe('collapseCarriageReturns', () => {
  it('normalizes CRLF to LF', () => {
    expect(collapseCarriageReturns('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('collapses a progress bar into its final frame, not N lines', () => {
    const progress = 'Progress: 1%\rProgress: 2%\rProgress: 100%';
    expect(collapseCarriageReturns(progress)).toBe('Progress: 100%');
  });

  it('keeps only the text after the last CR per line', () => {
    expect(collapseCarriageReturns('aaa\rbbb\rccc\nnext')).toBe('ccc\nnext');
  });

  it('leaves CR-free text untouched', () => {
    expect(collapseCarriageReturns('clean\noutput')).toBe('clean\noutput');
  });
});

describe('collapseConsecutiveDuplicates', () => {
  it('collapses a run of >=3 identical lines into one + a marker', () => {
    const out = collapseConsecutiveDuplicates('warn\nwarn\nwarn\nwarn\ndone');
    expect(out).toBe('warn\n… ⟨repeated 4×⟩\ndone');
  });

  it('leaves short runs (<3) intact', () => {
    expect(collapseConsecutiveDuplicates('a\na\nb')).toBe('a\na\nb');
  });

  it('only collapses CONSECUTIVE duplicates, never reorders', () => {
    expect(collapseConsecutiveDuplicates('a\nb\na\nb')).toBe('a\nb\na\nb');
  });
});

describe('truncateHeadTail', () => {
  it('returns the input unchanged when within the cap', () => {
    expect(truncateHeadTail('short', 100)).toBe('short');
  });

  it('keeps both ends and never exceeds the cap', () => {
    const s = `${'H'.repeat(500)}${'M'.repeat(500)}${'T'.repeat(500)}`;
    const out = truncateHeadTail(s, 200);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(200);
    expect(out.startsWith('H')).toBe(true); // head kept
    expect(out.endsWith('T')).toBe(true); // tail kept
    expect(out).toContain('truncated');
  });

  it('reports the number of dropped bytes', () => {
    const out = truncateHeadTail('x'.repeat(1000), 200);
    expect(out).toMatch(/truncated \d+ bytes/);
  });

  it('handles a cap smaller than the marker reserve (zero head/tail budget)', () => {
    // cap < MARKER_RESERVE (64) → avail clamps to 0 → takeHead/TailBytes return ''.
    const out = truncateHeadTail('y'.repeat(500), 50);
    expect(out).toContain('truncated');
    expect(out).not.toContain('yyyyy'); // none of the original run survives
  });
});

describe('normalizeCommandOutput', () => {
  it('strips ANSI, collapses progress, dedups, and squeezes blanks', () => {
    const raw =
      '[32mok[0m\n' + 'step 1%\rstep 99%\n' + 'warn\nwarn\nwarn\nwarn\n' + '\n\n\n' + 'done   ';
    const out = normalizeCommandOutput(raw);
    expect(out).not.toContain('['); // no ANSI
    expect(out).toContain('step 99%');
    expect(out).not.toContain('step 1%');
    expect(out).toContain('… ⟨repeated 4×⟩');
    expect(out).not.toMatch(/\n{3,}/); // no 3+ blank runs
    expect(out).toContain('done');
    expect(out.includes('done   ')).toBe(false); // trailing ws trimmed
  });

  it('caps oversized output at COMMAND_OUTPUT_MAX_BYTES', () => {
    // Distinct lines so the dedup pass can't shrink it before truncation.
    let big = '';
    for (let i = 0; i < 50_000; i++) big += `line ${i}\n`;
    const out = normalizeCommandOutput(big);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(COMMAND_OUTPUT_MAX_BYTES);
    expect(out).toContain('truncated');
  });

  it('passes through empty input', () => {
    expect(normalizeCommandOutput('')).toBe('');
  });
});

describe('detectPackageManager', () => {
  // Spin up an isolated temp dir, optionally pre-seeded with lockfiles, and
  // clean it up afterwards. The detection is cwd-local so each test must own
  // its own directory to avoid flake from leftover state.
  async function withDir(files: string[], fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wrongstack-detect-pm-'));
    try {
      for (const f of files) {
        await fsp.writeFile(path.join(dir, f), '');
      }
      await fn(dir);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  it('detects pnpm when pnpm-lock.yaml is present', async () => {
    await withDir(['pnpm-lock.yaml'], async (dir) => {
      expect(await detectPackageManager(dir)).toBe('pnpm');
    });
  });

  it('detects yarn when only yarn.lock is present', async () => {
    await withDir(['yarn.lock'], async (dir) => {
      expect(await detectPackageManager(dir)).toBe('yarn');
    });
  });

  it('falls back to npm when no lockfile is present', async () => {
    await withDir([], async (dir) => {
      expect(await detectPackageManager(dir)).toBe('npm');
    });
  });

  it('prefers pnpm when both pnpm and yarn lockfiles coexist', async () => {
    await withDir(['pnpm-lock.yaml', 'yarn.lock'], async (dir) => {
      expect(await detectPackageManager(dir)).toBe('pnpm');
    });
  });

  it('returns npm for a non-existent directory (does not throw)', async () => {
    // Stat on a missing path throws ENOENT; the helper must catch and fall
    // back to npm rather than aborting the tool.
    const ghost = path.join(os.tmpdir(), `definitely-missing-${Date.now()}`);
    expect(await detectPackageManager(ghost)).toBe('npm');
  });

  it('detects npm from package-lock.json', async () => {
    await withDir(['package-lock.json'], async (dir) => {
      expect(await detectPackageManager(dir)).toBe('npm');
    });
  });

  it('treats bun lockfiles as npm-compatible', async () => {
    await withDir(['bun.lockb'], async (dir) => {
      expect(await detectPackageManager(dir)).toBe('npm');
    });
    await withDir(['bun.lock'], async (dir) => {
      expect(await detectPackageManager(dir)).toBe('npm');
    });
  });

  it('honors package.json#packageManager over lockfiles', async () => {
    await withDir(['yarn.lock'], async (dir) => {
      await fsp.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ packageManager: 'pnpm@9.0.0' }),
      );
      expect(await detectPackageManager(dir)).toBe('pnpm');
    });
  });

  it('ignores an unrecognized packageManager declaration', async () => {
    await withDir(['yarn.lock'], async (dir) => {
      await fsp.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ packageManager: 'weirdpm@1.0.0' }),
      );
      expect(await detectPackageManager(dir)).toBe('yarn');
    });
  });

  it('walks up from a nested package dir to the project root lockfile', async () => {
    await withDir(['pnpm-lock.yaml'], async (dir) => {
      const nested = path.join(dir, 'packages', 'app');
      await fsp.mkdir(nested, { recursive: true });
      expect(await detectPackageManager(nested, dir)).toBe('pnpm');
    });
  });

  it('does not walk above cwd when no stopAt root is given', async () => {
    await withDir(['pnpm-lock.yaml'], async (dir) => {
      const nested = path.join(dir, 'packages', 'app');
      await fsp.mkdir(nested, { recursive: true });
      // Single-argument form keeps the historical cwd-local behavior.
      expect(await detectPackageManager(nested)).toBe('npm');
    });
  });

  it('does not walk when cwd is outside stopAt', async () => {
    await withDir([], async (dir) => {
      const other = await fsp.mkdtemp(path.join(os.tmpdir(), 'wrongstack-detect-outside-'));
      try {
        await fsp.writeFile(path.join(other, 'yarn.lock'), '');
        // cwd (other) is not inside stopAt (dir): only cwd itself is probed.
        expect(await detectPackageManager(other, dir)).toBe('yarn');
        expect(await detectPackageManager(path.join(other, 'sub'), dir)).toBe('npm');
      } finally {
        await fsp.rm(other, { recursive: true, force: true });
      }
    });
  });
});
