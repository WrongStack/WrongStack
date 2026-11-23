import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { replaceSkillDirectory } from '../../src/skills/skill-files.js';

/**
 * F76 (WS-045 directory-hardening-on-creation class): replaceSkillDirectory
 * stages the install into an mkdtemp dir that is then renamed into place as
 * the installed skill directory. The staged FILES are hardened (F62) but the
 * directory itself is not — on Windows anything else created inside the
 * installed skill dir inherits whatever the skills root grants. Hardening the
 * staging dir AT CREATION (icacls (OI)(CI) inheritance) covers future children
 * (best-effort); the rename carries the ACL into place.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the staging directory path.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f76-'));
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

describe('skill staging directory-hardening-on-creation (F76)', () => {
  it('hardens the staging directory that becomes the installed skill dir', async () => {
    const source = path.join(dir, 'source');
    const target = path.join(dir, 'installed');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'SKILL.md'), '# skill');
    await replaceSkillDirectory(source, target, ['SKILL.md']);
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(
      targets.some((t) => t.includes('.skill-stage-') && !t.endsWith('.md')),
      'staging dir is hardened',
    ).toBe(true);
  });
});
