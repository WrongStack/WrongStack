/**
 * @wrongstack/plugins — loop-breaker's no-diff detector keeps large payloads
 * distinguishable.
 *
 * `gitDiffFingerprint` fingerprints an UNTRACKED file by path + content, so
 * rewriting a scaffolded file unchanged still counts as a repeat. That digest
 * used to stop after the first 1,000,000 characters, so a 1.2 MB file whose
 * tail was rewritten produced the identical fingerprint: the post hook counted
 * a genuinely changing step as "no diff", the streak advanced, and the run was
 * eventually BLOCKED as if it were looping. The digest now covers the whole
 * payload.
 *
 * The git spawn is an external boundary and is mocked; the digest itself and
 * the untracked-file branch are the production code under test.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _file: unknown,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      // `gitIsolationEnv` lists the filter config; an empty successful listing
      // leaves the isolation environment intact.
      if (args.includes('config')) {
        callback(null, '');
        return { unref: vi.fn() } as never;
      }
      // The target is untracked: `ls-files --error-unmatch` fails, which selects
      // the content-fingerprint branch.
      if (args[0] === 'ls-files') {
        callback(new Error('error: pathspec did not match any file(s) known to git'), '');
        return { unref: vi.fn() } as never;
      }
      // Empty diff: an untracked file never shows one.
      callback(null, '');
      return { unref: vi.fn() } as never;
    },
  ),
}));

const { gitDiffFingerprint } = await import('../src/loop-breaker/loop-breaker-fingerprint.js');

let dir: string;
const signal = new AbortController().signal;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'loop-breaker-fingerprint-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function fingerprint(content: string): Promise<string> {
  const file = join(dir, 'generated.txt');
  writeFileSync(file, content, 'utf8');
  const value = await gitDiffFingerprint(dir, file, signal);
  // A null fingerprint makes the post hook skip the no-diff check entirely, so
  // a null-vs-null "difference" would be a broken harness, not a passing test.
  expect(value).toMatch(/^untracked:/);
  return value as string;
}

describe('loop-breaker no-diff fingerprint over large payloads', () => {
  it('distinguishes a 1.2 MB file rewritten past the first megabyte', async () => {
    const prefix = 'x'.repeat(1_200_000);
    const before = await fingerprint(`${prefix}ALPHA`);
    const after = await fingerprint(`${prefix}BETA`);

    expect(after).not.toBe(before);
  });

  it('distinguishes content that differs exactly at the old 1,000,000-char cut', async () => {
    const prefix = 'x'.repeat(1_000_000);
    const before = await fingerprint(`${prefix}A`);
    const after = await fingerprint(`${prefix}B`);

    expect(after).not.toBe(before);
  });

  it('keeps reporting a repeat when the same large content is rewritten unchanged', async () => {
    const content = `${'y'.repeat(1_200_000)}TAIL`;
    const first = await fingerprint(content);
    const second = await fingerprint(content);

    expect(second).toBe(first);
  });

  it('distinguishes a small content change (control)', async () => {
    const before = await fingerprint('first version\n');
    const after = await fingerprint('second version\n');

    expect(after).not.toBe(before);
  });
});
