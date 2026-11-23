import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { patchTool } from '../src/patch.js';

/**
 * F52 (WS-045 class): patchTool writes the submitted diff — project source
 * content — into a private temp file via fs.writeFile + mode 0o600 (a Windows
 * no-op) with no owner-only hardening (the temp DIR chmod 0700 is likewise a
 * Windows no-op, as its own comment admits). On Windows the diff stayed
 * readable by other local accounts where inheritance was not owner-only. The
 * patch file is hardened right after the write (best-effort).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the in.diff temp path; a real apply against a real temp file.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f52-'));
  icaclsCalls.length = 0;
  _filePermOps.platform = 'win32';
  _filePermOps.userInfo = (() => ({
    username: 'tester',
    uid: -1,
    gid: -1,
    homedir: 'C:\\Users\\tester',
    shell: null,
  })) as typeof _filePermOps.userInfo;
  _filePermOps.execFileAsync = async (file, args) => {
    icaclsCalls.push({ file, args });
    return { stdout: '', stderr: '' };
  };
});

afterEach(async () => {
  _filePermOps.platform = process.platform;
  _filePermOps.userInfo = undefined;
  _filePermOps.execFileAsync = undefined;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('patch temp diff owner-only hardening (F52)', () => {
  it('hardens the in.diff temp file before running the patch engine', async () => {
    const file = path.join(tmpDir, 'f.txt');
    await fs.writeFile(file, 'initial\n');
    const ctx = { cwd: tmpDir, tools: [], projectRoot: tmpDir } as never;
    const patchBody = '--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-initial\n+updated\n';
    const result = await patchTool.execute({ patch: patchBody }, ctx, {
      signal: new AbortController().signal,
    });
    // Valid-input control: the apply itself still works.
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect(await fs.readFile(file, 'utf8')).toContain('updated');
    const diffCalls = icaclsCalls.filter(
      (c) => c.file === 'icacls' && (c.args[0] ?? '').endsWith('in.diff'),
    );
    expect(diffCalls.length, 'patch issues icacls for the temp diff').toBe(1);
  });
});
