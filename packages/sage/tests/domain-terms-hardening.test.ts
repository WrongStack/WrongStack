import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { renderDomainTermsMarkdown } from '../src/domain-term-candidates.js';

/**
 * F98 (WS-045 no-mode class): renderDomainTermsMarkdown writes the project
 * domain glossary (learned project jargon) via fs.writeFile with NO mode and
 * no hardening. On Windows it stayed readable by other local accounts where
 * inheritance was not owner-only. The glossary is hardened (best-effort) and
 * the write requests 0o600 for POSIX.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f98-'));
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

describe('domain glossary owner-only hardening (F98)', () => {
  it('hardens the glossary mirror', async () => {
    await renderDomainTermsMarkdown(dir, [
      { term: 'MailboxBridge', definition: 'the bridge', confidence: 0.9 },
    ] as never);
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(targets, 'glossary is hardened').toContain(
      path.join(dir, '.wrongstack', 'domain-terms.md'),
    );
  });
});
