import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { projectsJsonPath, saveManifest } from '../src/server/projects-manifest.js';

/**
 * F96 (WS-045 no-mode class): saveManifest writes the WebUI project registry
 * (project paths, names, slugs — WrongStack's own state beside the global
 * config) via fs.writeFile with NO mode and no hardening. On Windows it stayed
 * readable by other local accounts where inheritance was not owner-only. The
 * manifest is hardened (best-effort) and the write requests 0o600 for POSIX.
 *
 * (The memory flight recorder was the original F96 candidate; its capture
 * writer is module-private and the observe-threshold harness is heavy —
 * dropped in favor of this equally-unhardened state writer.)
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f96-'));
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
  await fs.rm(dir, { recursive: true, force: true });
});

describe('projects manifest owner-only hardening (F96)', () => {
  it('hardens the manifest on save', async () => {
    const globalConfigPath = path.join(dir, 'config.json');
    await saveManifest({ projects: [] } as never, globalConfigPath);
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'manifest is hardened').toContain(projectsJsonPath(globalConfigPath));
  });
});
