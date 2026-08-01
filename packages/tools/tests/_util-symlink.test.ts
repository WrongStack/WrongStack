import type { Context } from '@wrongstack/core/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

const realpathMock = vi.fn();

vi.mock('node:fs/promises', async (orig) => ({
  ...(await orig<typeof import('node:fs/promises')>()),
  realpath: (...a: unknown[]) => realpathMock(...a),
}));

import { assertRealInsideRoot, safeResolveReal } from '../src/_util.js';

const ctx = () => ({ cwd: '/tmp/project', projectRoot: '/tmp/project' }) as Context;

afterEach(() => {
  realpathMock.mockReset();
  vi.restoreAllMocks();
});

describe('assertRealInsideRoot — realpath error handling', () => {
  it('rethrows a non-ENOENT realpath error (e.g. EACCES)', async () => {
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    realpathMock.mockRejectedValue(eacces);
    // realRoot resolution swallows the error (.catch), but the probe realpath
    // rethrows because the code is not ENOENT.
    await expect(assertRealInsideRoot('/tmp/project/a.txt', ctx())).rejects.toThrow(
      /permission denied/,
    );
  });

  it('walks up past ENOENT ancestors and passes when nothing escapes', async () => {
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    // `allowedRoots` returns TWO roots (project root + ~/.wrongstack), so the
    // mock queue must supply both before the probe loop runs. It previously
    // supplied one, which shifted every later mock up by a call: the ENOENT
    // intended for the target was swallowed by the second root's `.catch`, and
    // the walk this test is named for never executed. It passed anyway because
    // the old `safeResolveReal` echoed its input back regardless of what the
    // check resolved — the very bug WS-048 is about.
    realpathMock
      .mockResolvedValueOnce('/tmp/project') // realRoot[0]
      .mockResolvedValueOnce('/home/u/.wrongstack') // realRoot[1]
      .mockRejectedValueOnce(enoent) // target does not exist yet
      .mockResolvedValueOnce('/tmp/project/new'); // nearest existing ancestor
    const resolved = await safeResolveReal('new/file.txt', ctx());
    // The not-yet-created tail is re-attached to the RESOLVED ancestor.
    expect(resolved).toContain('file.txt');
    expect(resolved.replace(/\\/g, '/')).toBe('/tmp/project/new/file.txt');
  });

  it('returns the RESOLVED path, not the path it was handed (WS-048)', async () => {
    // The finding: the containment check resolved symlinks, proved the target
    // was inside the root, and then returned the unresolved input. The caller
    // opened a path still made of symlinks, so what the check proved was not
    // what the caller touched.
    realpathMock
      .mockResolvedValueOnce('/tmp/project') // realRoot[0]
      .mockResolvedValueOnce('/home/u/.wrongstack') // realRoot[1]
      .mockResolvedValueOnce('/tmp/project/real/target.txt'); // link → real file
    const resolved = await safeResolveReal('link.txt', ctx());
    expect(resolved).toBe('/tmp/project/real/target.txt');
    expect(resolved).not.toContain('link.txt');
  });

  it('returns safely when every ancestor is missing (walks up to fs root)', async () => {
    const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
    realpathMock.mockRejectedValue(enoent); // realRoot + every probe ENOENT
    await expect(assertRealInsideRoot('/tmp/project/a/b.txt', ctx())).resolves.toBeUndefined();
  });

  it('throws when the realpath escapes the project root via a symlink', async () => {
    realpathMock
      .mockResolvedValueOnce('/tmp/project') // realRoot[0] = project root
      .mockResolvedValueOnce('/home/u/.wrongstack') // realRoot[1] = ~/.wrongstack (always-allowed)
      .mockResolvedValueOnce('/tmp/elsewhere/secret'); // target resolves outside both
    await expect(assertRealInsideRoot('/tmp/project/link.txt', ctx())).rejects.toThrow(
      /outside project root/,
    );
  });
});
