import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drive runPatch deterministically by faking the `patch` child process, so the
// success path (extractPatchedFiles) and the error/non-zero paths run without
// depending on a GNU `patch` binary being installed.
const cfg: {
  stdout: string;
  stderr: string;
  code: number;
  error?: string | undefined;
  errorCode?: string | undefined;
  /** Runs inside the faked process: use it to write files the "patch" would have. */
  onSpawn?: (() => void) | undefined;
} = {
  stdout: '',
  stderr: '',
  code: 0,
};

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      process.nextTick(() => {
        cfg.onSpawn?.();
        if (cfg.error) {
          child.emit('error', Object.assign(new Error(cfg.error), { code: cfg.errorCode }));
          return;
        }
        if (cfg.stdout) child.stdout.emit('data', Buffer.from(cfg.stdout));
        if (cfg.stderr) child.stderr.emit('data', Buffer.from(cfg.stderr));
        child.emit('close', cfg.code);
      });
      return child;
    },
  };
});

import { hasModifiedPaths } from '@wrongstack/contracts/types';
import { patchTool } from '../src/patch.js';

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-spawn-'));
  cfg.stdout = '';
  cfg.stderr = '';
  cfg.code = 0;
  cfg.error = undefined;
  cfg.errorCode = undefined;
  cfg.onSpawn = undefined;
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const ctx = () => ({ cwd: tmpDir, tools: [], projectRoot: tmpDir }) as any;
const opts = () => ({ signal: new AbortController().signal });
const goodPatch = '--- a/foo.txt\n+++ b/foo.txt\n@@ -1 +1 @@\n-old\n+new';

describe('patchTool (faked patch process)', () => {
  it('reports files a failed apply left changed, as a typed PartialWriteError', async () => {
    // `patch --merge` writes git-style conflict markers into the target and
    // THEN exits non-zero, so the call fails while the working tree is dirtied.
    await fs.writeFile(path.join(tmpDir, 'foo.txt'), 'old\n');
    cfg.onSpawn = () => {
      writeFileSync(
        path.join(tmpDir, 'foo.txt'),
        '<<<<<<< original\nold\n=======\nnew\n>>>>>>> patch\n',
      );
    };
    cfg.stderr = 'Hunk #1 FAILED at 1.\n';
    cfg.code = 1;

    const thrown = await patchTool.execute({ patch: goodPatch }, ctx(), opts()).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(hasModifiedPaths(thrown)).toBe(true);
    // Relative: the chronicle journal must not carry an absolute home path.
    expect((thrown as { modifiedPaths?: string[] }).modifiedPaths).toEqual(['foo.txt']);
    expect((thrown as Error).message).toMatch(/patch failed/);
  });

  it('does not claim modified paths when a failure wrote nothing', async () => {
    await fs.writeFile(path.join(tmpDir, 'foo.txt'), 'old\n');
    cfg.stderr = 'patch: **** Only garbage was found in the patch input.\n';
    cfg.code = 2;

    const thrown = await patchTool.execute({ patch: goodPatch }, ctx(), opts()).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(hasModifiedPaths(thrown)).toBe(false);
  });

  it('reports the files GNU patch said it patched', async () => {
    cfg.stdout = 'patching file foo.txt\npatching file bar.txt\n';
    cfg.code = 0;
    const result = await patchTool.execute({ patch: goodPatch }, ctx(), opts());
    expect(result.applied).toBe(2);
    expect(result.files).toEqual(['foo.txt', 'bar.txt']);
    expect(result.rejected).toBe(0);
  });

  it('throws with the engine message on non-zero exit (non dry-run)', async () => {
    cfg.stdout = '';
    cfg.stderr = 'patch: **** malformed patch';
    cfg.code = 1;
    await expect(patchTool.execute({ patch: goodPatch }, ctx(), opts())).rejects.toThrow(
      /patch failed: patch: \*\*\*\* malformed patch/,
    );
  });

  it('still reports patched files in dry-run even on a non-zero exit', async () => {
    cfg.stdout = 'patching file foo.txt\n';
    cfg.code = 1; // dry-run ignores the non-zero gate
    const result = await patchTool.execute({ patch: goodPatch, dry_run: true }, ctx(), opts());
    expect(result.dry_run).toBe(true);
    expect(result.files).toEqual(['foo.txt']);
  });

  it('reports rejected=1 in dry-run when patch would conflict (non-zero exit)', async () => {
    // GNU patch --dry-run exits non-zero when the patch would conflict.
    // Previously the dry-run path fell through to the success return and
    // reported rejected: 0 for a patch that would actually fail.
    cfg.stdout = 'checking file foo.txt\n';
    cfg.stderr = '1 out of 1 hunk FAILED';
    cfg.code = 1;
    const result = await patchTool.execute({ patch: goodPatch, dry_run: true }, ctx(), opts());
    expect(result.dry_run).toBe(true);
    expect(result.rejected).toBe(1);
    expect(result.files).toEqual(['foo.txt']);
    expect(result.message).toMatch(/would conflict/);
  });

  it('parses "checking file" output in dry-run (realistic GNU patch)', async () => {
    // GNU patch prints "checking file X" (not "patching file X") in --dry-run.
    // The old regex only matched "patching file", so dry-run always returned
    // applied: 0 and files: [].
    cfg.stdout = 'checking file foo.txt\nchecking file bar.txt\n';
    cfg.code = 0;
    const result = await patchTool.execute({ patch: goodPatch, dry_run: true }, ctx(), opts());
    expect(result.applied).toBe(2);
    expect(result.files).toEqual(['foo.txt', 'bar.txt']);
  });

  it('honours an explicit directory', async () => {
    await fs.mkdir(path.join(tmpDir, 'sub'));
    cfg.stdout = 'patching file foo.txt\n';
    const result = await patchTool.execute({ patch: goodPatch, directory: 'sub' }, ctx(), opts());
    expect(result.applied).toBe(1);
  });

  it('throws on a spawn error (non-ENOENT process failure)', async () => {
    cfg.error = 'spawn patch EACCES';
    await expect(patchTool.execute({ patch: goodPatch }, ctx(), opts())).rejects.toThrow(
      /patch failed: spawn patch EACCES/,
    );
  });

  it('throws when neither GNU patch nor git can be started — even in dry-run', async () => {
    cfg.error = 'spawn ENOENT';
    cfg.errorCode = 'ENOENT';
    await expect(
      patchTool.execute({ patch: goodPatch, dry_run: true }, ctx(), opts()),
    ).rejects.toThrow(/no patch engine could be started/);
  });
});
