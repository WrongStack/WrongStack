import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWstackPaths, stripAnsi } from '@wrongstack/core/utils';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildProfileCommand } from '../src/slash-commands/profile.js';

/**
 * F59 (WS-045 copy-time class): /profile copy clones the COMPLETE profile tree
 * (config.json with provider settings, memory, skills, sync state) via cp
 * recursive. On Windows the copied children land with the destination's
 * inherited ACL, NOT the source's owner-only ACL, so the cloned profile stayed
 * readable by other local accounts. Every copied file and directory is
 * hardened after the copy (best-effort).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the cloned paths; the real /profile command flow.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let tmp: string;
let paths: ReturnType<typeof resolveWstackPaths>;
let messages: string[];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f59-'));
  const globalRoot = path.join(tmp, '.wrongstack');
  await fs.mkdir(path.join(globalRoot, 'profiles', 'default'), { recursive: true });
  await fs.writeFile(
    path.join(globalRoot, 'config.json'),
    JSON.stringify({ version: 1, activeProfile: 'default' }),
  );
  await fs.writeFile(
    path.join(globalRoot, 'profiles', 'default', 'config.json'),
    JSON.stringify({ provider: 'anthropic', model: 'claude' }),
  );
  paths = resolveWstackPaths({ projectRoot: path.join(tmp, 'project'), globalRoot });
  messages = [];
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
  await fs.rm(tmp, { recursive: true, force: true });
});

const hardened = (t: string) => icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === t);

function command() {
  return buildProfileCommand({
    paths,
    configStore: { get: () => ({ activeProfile: 'default' }), update: vi.fn() },
    renderer: {
      write: (message: string) => messages.push(message),
      writeWarning: (message: string) => messages.push(message),
    },
  } as never as SlashCommandContext);
}

describe('/profile copy clone copy-time hardening (F59)', () => {
  it('hardens the cloned profile tree, including nested files', async () => {
    await fs.writeFile(path.join(paths.profileDir, 'memory.md'), 'remember this');
    await fs.mkdir(path.join(paths.profileDir, 'skills', 'demo'), { recursive: true });
    await fs.writeFile(path.join(paths.profileDir, 'skills', 'demo', 'SKILL.md'), '# demo');

    const result = await command().run('copy work');
    const workDir = path.join(paths.profilesDir, 'work');
    // Valid-input control: the clone still works.
    expect(stripAnsi(result?.message ?? '')).toContain('Copied profile');
    expect(await fs.readFile(path.join(workDir, 'memory.md'), 'utf8')).toBe('remember this');
    expect(hardened(path.join(workDir, 'config.json')), 'cloned config is hardened').toBe(true);
    expect(hardened(path.join(workDir, 'memory.md')), 'cloned memory is hardened').toBe(true);
    expect(
      hardened(path.join(workDir, 'skills', 'demo', 'SKILL.md')),
      'nested cloned file is hardened',
    ).toBe(true);
  });
});
