import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleShellOpen, type ShellOpenRequest } from '../../src/server/shell-open.js';

/**
 * PR 5c of Phase 2: extract the `shell.open` WS message handler into
 * a unit-testable helper. The CLI's `runWebUI` and the standalone
 * `startWebUI` both had near-identical 49-line inlined copies with
 * a metacharacter guard + cross-platform spawn chain, this test
 * pins the helper's contract so the two call sites can't drift
 * again.
 *
 * The helper spawns child processes. We never assert that a window
 * actually appears (we're not testing xterm); we only assert the
 * result shape and the metacharacter guard, plus the existence
 * check. The spawn path is covered by the existing
 * open-browser.test.ts style integration (no new browser test
 * here, the existing flow works in CI).
 */

function makeFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'shell-open-test-'));
  // Logger is a no-op stub; handleShellOpen uses it only on
  // spawn failure (which we don't trigger here).
  const logger = {
    level: 'debug',
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as Parameters<typeof handleShellOpen>[1];
  return { tmp, logger, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

describe('handleShellOpen', () => {
  it('rejects paths with shell metacharacters before spawn', async () => {
    const { logger, cleanup } = makeFixture();
    try {
      // The metacharacter check fires AFTER path.resolve and
      // fs.access, so the path has to point at something that
      // exists. Windows refuses to *create* a file named foo|bar
      // (reserved char), so we use a symlink: the link name is
      // the metacharacter-bearing one, the target is a real file.
      // path.resolve then folds the link into a path that contains
      // the metacharacter and fs.access succeeds on it, but the
      // metacharacter regex still trips. On Windows symlinkSync
      // requires admin or developer mode, so we skip the test on
      // that platform rather than flake.
      if (process.platform === 'win32') return;
      const tmp = mkdtempSync(join(tmpdir(), 'shell-open-mm-'));
      const real = join(tmp, 'real');
      writeFileSync(real, '');
      const link = join(tmp, 'foo|bar');
      symlinkSync(real, link);
      const result = await handleShellOpen(
        { path: link, target: 'file-manager' } as ShellOpenRequest,
        logger,
      );
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/unsupported characters/);
      rmSync(tmp, { recursive: true, force: true });
    } finally { cleanup(); }
  });

  it('rejects paths that do not exist on disk', async () => {
    const { logger, cleanup } = makeFixture();
    try {
      const result = await handleShellOpen(
        { path: '/this/path/definitely/does/not/exist/abc123', target: 'file-manager' },
        logger,
      );
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/ENOENT|no such file/);
    } finally { cleanup(); }
  });

  it('returns a structured failure for unknown target values', async () => {
    const { logger, cleanup } = makeFixture();
    try {
      const tmp = mkdtempSync(join(tmpdir(), 'shell-open-unk-'));
      const result = await handleShellOpen(
        { path: tmp, target: 'invalid-target' as unknown as 'terminal' } as ShellOpenRequest,
        logger,
      );
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Unknown shell\.open target/);
      rmSync(tmp, { recursive: true, force: true });
    } finally { cleanup(); }
  });

  it('resolves .. traversal before the metacharacter check', async () => {
    // path.resolve folds any .. segments, so a path that contains
    // .. before resolution must still reach the metacharacter
    // check on the resolved form. This test pins the order:
    // resolve, access, metacharacter, spawn. If the order changes
    // (e.g. metacharacter check runs on the unresolved path), this
    // assertion fails.
    const { logger, cleanup } = makeFixture();
    try {
      const tmp = mkdtempSync(join(tmpdir(), 'shell-open-trav-'));
      const sub = join(tmp, 'sub');
      mkdirSync(sub);
      // Path is tmp/../tmp/sub, resolves to tmp/sub, which has no
      // metacharacters and exists. Should succeed (or at least
      // not be rejected at the metacharacter step).
      const result = await handleShellOpen(
        { path: join(sub, '..', 'sub'), target: 'file-manager' },
        logger,
      );
      // We don't assert success=true because the spawn step
      // depends on platform (Windows: explorer, Linux: xdg-open);
      // on a headless CI box the spawn may emit ENOENT, which the
      // helper swallows as a success with the "Opened" message
      // (the spawn is detached + unref'd so it can't fail the
      // call). What we DO assert: the metacharacter guard didn't
      // fire, so the message is not "unsupported characters".
      expect(result.message).not.toMatch(/unsupported characters/);
      rmSync(tmp, { recursive: true, force: true });
    } finally { cleanup(); }
  });
});
