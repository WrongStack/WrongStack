import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultPromptStore } from '@wrongstack/core/storage';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPromptsCommand } from '../src/prompts-command.js';

/**
 * F94 (WS-045 no-mode class): /prompts export writes the user's prompt library
 * via fs.writeFile with NO mode and no hardening. Prompt content is user
 * material. On Windows the export stayed readable by other local accounts
 * where inheritance was not owner-only. The export is hardened (best-effort)
 * and the write requests 0o600 for POSIX.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f94-'));
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

describe('prompts export owner-only hardening (F94)', () => {
  it('hardens the exported prompt library', async () => {
    const store = new DefaultPromptStore(dir);
    const entry = store.createNew('Test', 'private prompt content');
    await store.save(entry);
    const loader = { list: async () => [entry] };
    const cmd = buildPromptsCommand(
      () => store,
      () => loader as never,
      () => undefined,
    );
    const result = await cmd.run('export out.json', { projectRoot: dir } as never);
    expect(result?.message).toContain('Exported');
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'export is hardened').toContain(path.join(dir, 'out.json'));
  });
});
