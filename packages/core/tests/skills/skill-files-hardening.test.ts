import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { replaceSkillDirectory } from '../../src/skills/skill-files.js';

/**
 * F62 (WS-045 copy-time class): replaceSkillDirectory stages an installed
 * skill package via fs.copyFile. Skill content is user-authored instruction
 * material (the plugin-trust surface). On Windows copyFile gives the copies the
 * destination's inherited ACL, not the source's, so the installed skill stayed
 * readable by other local accounts where inheritance was not owner-only. Each
 * staged copy is hardened (best-effort); the staging dir is then renamed into
 * place, carrying the hardened ACLs with it.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the staged file paths.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f62-'));
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

describe('skill install copy-time hardening (F62)', () => {
  it('hardens every staged skill file', async () => {
    const source = path.join(dir, 'source');
    const target = path.join(dir, 'installed');
    await fs.mkdir(path.join(source, 'sub'), { recursive: true });
    await fs.writeFile(path.join(source, 'SKILL.md'), '# private skill');
    await fs.writeFile(path.join(source, 'sub', 'ref.md'), 'reference');

    await replaceSkillDirectory(source, target, ['SKILL.md', path.join('sub', 'ref.md')]);
    // Valid-input control: the install still lands.
    expect(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe('# private skill');
    const staged = icaclsCalls.filter(
      (c) => c.file === 'icacls' && c.args[0].includes('.skill-stage-'),
    );
    expect(
      staged.some((c) => c.args[0].endsWith('SKILL.md')),
      'SKILL.md copy is hardened',
    ).toBe(true);
    expect(
      staged.some((c) => c.args[0].endsWith('ref.md')),
      'nested copy is hardened',
    ).toBe(true);
  });
});
