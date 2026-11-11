import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultPathResolver } from '../../src/infrastructure/path-resolver.js';

// Bun's os.homedir() on POSIX ignores HOME changes made at runtime; Node
// re-reads the variable on every call. Re-read it here so the home-guard
// tests below steer the guard the same way under both runtimes.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () =>
    (process.platform === 'win32' ? process.env['USERPROFILE'] : process.env['HOME']) ||
    actual.homedir();
  return { ...actual, default: { ...actual, homedir }, homedir };
});

describe('DefaultPathResolver', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-path-'));
    // marker
    await fs.writeFile(path.join(tmp, 'package.json'), '{}');
    await fs.mkdir(path.join(tmp, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'src', 'a.ts'), 'x');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('detects project root via marker file', async () => {
    const inner = path.join(tmp, 'src');
    const pr = new DefaultPathResolver(inner);
    // realpath normalises on macOS (/var → /private/var)
    expect(path.resolve(pr.projectRoot)).toBe(path.resolve(tmp));
  });

  it('cwd is absolute and resolved', () => {
    const pr = new DefaultPathResolver(tmp);
    expect(path.isAbsolute(pr.cwd)).toBe(true);
  });

  it('uses the selected directory as the project root for a host that already chose one', async () => {
    const nested = path.join(tmp, 'registered');
    await fs.mkdir(nested);
    expect(new DefaultPathResolver(nested).projectRoot).toBe(tmp);
    const resolver = new DefaultPathResolver(nested, true);
    expect(resolver.projectRoot).toBe(nested);
    expect(resolver.isInsideRoot(path.join(nested, 'file.ts'))).toBe(true);
    expect(resolver.isInsideRoot(path.join(tmp, 'parent-only.ts'))).toBe(false);
  });

  it('resolve handles relative paths', () => {
    const pr = new DefaultPathResolver(tmp);
    const r = pr.resolve('src/a.ts');
    expect(path.resolve(r)).toBe(path.resolve(tmp, 'src', 'a.ts'));
  });

  it('isInsideRoot rejects parent escapes', () => {
    const pr = new DefaultPathResolver(tmp);
    expect(pr.isInsideRoot(path.join(tmp, 'src', 'a.ts'))).toBe(true);
    expect(pr.isInsideRoot(path.dirname(tmp))).toBe(false);
  });

  it('isInsideRoot accepts a legal in-root ..-prefixed first segment', () => {
    // `..hidden` is a legal directory name; a bare startsWith('..') misread it
    // as a parent traversal.
    const pr = new DefaultPathResolver(tmp);
    expect(pr.isInsideRoot(path.join(tmp, '..hidden', 'a.ts'))).toBe(true);
  });

  it('ensureInsideRoot throws for outside paths', () => {
    const pr = new DefaultPathResolver(tmp);
    expect(() => pr.ensureInsideRoot(path.dirname(tmp))).toThrow(/outside the project root/);
  });

  it('ensureInsideRoot returns resolved path for inside paths', () => {
    const pr = new DefaultPathResolver(tmp);
    const out = pr.ensureInsideRoot('src/a.ts');
    expect(path.basename(out)).toBe('a.ts');
  });

  it('does not treat bare .wrongstack/ (without AGENTS.md) as a project marker', async () => {
    // Regression: a parent directory with .wrongstack/ but no AGENTS.md
    // (e.g. the global ~/.wrongstack config directory) should NOT be
    // detected as the project root.  Only .wrongstack/AGENTS.md counts.
    //
    // Use a FRESH temp dir (not `tmp` from beforeEach) so the parent's
    // package.json doesn't leak into the walk-up and shadow the result.
    const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-bare-'));
    try {
      // Put a .git at the isolated root so the walk-up stops here and
      // doesn't escape into the user's home (which may have its own markers).
      await fs.mkdir(path.join(isolated, '.git'));
      const parent = path.join(isolated, 'has-wrongstack-dir');
      const child = path.join(parent, 'actual-cwd');
      await fs.mkdir(path.join(parent, '.wrongstack'), { recursive: true });
      // Intentionally: NO AGENTS.md inside .wrongstack/
      await fs.mkdir(child, { recursive: true });

      const pr = new DefaultPathResolver(child);
      // Bare .wrongstack/ skipped → walk-up continues → finds .git at isolated.
      // projectRoot should be isolated, NOT parent (which has bare .wrongstack/).
      expect(path.resolve(pr.projectRoot)).toBe(path.resolve(isolated));
    } finally {
      await fs.rm(isolated, { recursive: true, force: true });
    }
  });

  it('treats .wrongstack/AGENTS.md as a project marker', async () => {
    // Isolated temp dir so beforeEach's package.json doesn't interfere.
    const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-agents-'));
    try {
      const parent = path.join(isolated, 'has-agents-md');
      const child = path.join(parent, 'sub');
      await fs.mkdir(path.join(parent, '.wrongstack'), { recursive: true });
      await fs.writeFile(path.join(parent, '.wrongstack', 'AGENTS.md'), '# Project');
      await fs.mkdir(child, { recursive: true });

      const pr = new DefaultPathResolver(child);
      // AGENTS.md exists → parent is the project root.
      expect(path.resolve(pr.projectRoot)).toBe(path.resolve(parent));
    } finally {
      await fs.rm(isolated, { recursive: true, force: true });
    }
  });

  describe('home-directory guard', () => {
    it('still checks markers when cwd IS the home directory', async () => {
      // When the user runs wrongstack FROM their home directory, markers
      // there should still be detected.  The guard only fires during the
      // upward walk from a subdirectory.
      const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-home-cwd-'));
      const prevUserProfile = process.env['USERPROFILE'];
      const prevHome = process.env['HOME'];
      try {
        await fs.writeFile(path.join(fakeHome, 'package.json'), '{}');
        // os.homedir() reads USERPROFILE (win) or HOME (unix).
        process.env['USERPROFILE'] = fakeHome;
        process.env['HOME'] = fakeHome;

        const pr = new DefaultPathResolver(fakeHome);
        // cwd === home → guard skipped → marker found → projectRoot = home
        expect(path.resolve(pr.projectRoot)).toBe(path.resolve(fakeHome));
      } finally {
        process.env['USERPROFILE'] = prevUserProfile;
        process.env['HOME'] = prevHome;
        await fs.rm(fakeHome, { recursive: true, force: true });
      }
    });

    it('does not walk past home when cwd is a subdirectory', async () => {
      // Regression: home often has stray markers (.git for dotfiles,
      // global tool configs) — a subdirectory of home should NOT
      // inherit those as its project root.
      const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-home-sub-'));
      const prevUserProfile = process.env['USERPROFILE'];
      const prevHome = process.env['HOME'];
      try {
        // Put markers in fakeHome — simulating a home with dotfile .git etc.
        await fs.mkdir(path.join(fakeHome, '.git'));
        await fs.writeFile(path.join(fakeHome, 'package.json'), '{}');

        const child = path.join(fakeHome, 'empty-subdir');
        await fs.mkdir(child, { recursive: true });

        process.env['USERPROFILE'] = fakeHome;
        process.env['HOME'] = fakeHome;

        const pr = new DefaultPathResolver(child);
        // Walk-up: child (no markers) → fakeHome → GUARD HITS → break
        // → falls back to start path (child).
        expect(path.resolve(pr.projectRoot)).toBe(path.resolve(child));
      } finally {
        process.env['USERPROFILE'] = prevUserProfile;
        process.env['HOME'] = prevHome;
        await fs.rm(fakeHome, { recursive: true, force: true });
      }
    });

    it.runIf(process.platform === 'win32')(
      'holds the home guard when cwd spells home with a different case',
      async () => {
        const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-home-case-'));
        const prevUserProfile = process.env['USERPROFILE'];
        const prevHome = process.env['HOME'];
        try {
          await fs.mkdir(path.join(fakeHome, '.git'));
          const child = path.join(fakeHome, 'Empty-Subdir');
          await fs.mkdir(child, { recursive: true });
          process.env['USERPROFILE'] = fakeHome;
          process.env['HOME'] = fakeHome;

          const pr = new DefaultPathResolver(child.toUpperCase());
          expect(pr.projectRoot.toLowerCase()).toBe(child.toLowerCase());
        } finally {
          process.env['USERPROFILE'] = prevUserProfile;
          process.env['HOME'] = prevHome;
          await fs.rm(fakeHome, { recursive: true, force: true });
        }
      },
    );
  });
});
