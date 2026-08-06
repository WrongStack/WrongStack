import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drive runPatch deterministically by faking the `patch` child process, so the
// success path (extractPatchedFiles) and the error/non-zero paths run without
// depending on a GNU `patch` binary being installed.
const cfg: { stdout: string; stderr: string; code: number; error?: string } = {
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
        if (cfg.error) {
          child.emit('error', new Error(cfg.error));
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

import { patchTool } from '../src/patch.js';

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-spawn-'));
  cfg.stdout = '';
  cfg.stderr = '';
  cfg.code = 0;
  cfg.error = undefined;
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const ctx = () => ({ cwd: tmpDir, tools: [], projectRoot: tmpDir }) as any;
const opts = () => ({ signal: new AbortController().signal });
const goodPatch = '--- a/foo.txt\n+++ b/foo.txt\n@@ -1 +1 @@\n-old\n+new';

describe('patchTool (faked patch process)', () => {
  it('reports the files GNU patch said it patched', async () => {
    cfg.stdout = 'patching file foo.txt\npatching file bar.txt\n';
    cfg.code = 0;
    const result = await patchTool.execute({ patch: goodPatch }, ctx(), opts());
    expect(result.applied).toBe(2);
    expect(result.files).toEqual(['foo.txt', 'bar.txt']);
    expect(result.rejected).toBe(0);
  });

  it('returns rejected=1 with the error message on non-zero exit (non dry-run)', async () => {
    cfg.stdout = '';
    cfg.stderr = 'patch: **** malformed patch';
    cfg.code = 1;
    const result = await patchTool.execute({ patch: goodPatch }, ctx(), opts());
    expect(result.applied).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.message).toMatch(/patch failed/);
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

  it('handles a spawn error (patch binary missing)', async () => {
    cfg.error = 'spawn patch ENOENT';
    const result = await patchTool.execute({ patch: goodPatch }, ctx(), opts());
    expect(result.applied).toBe(0);
    expect(result.rejected).toBe(1);
  });
});
