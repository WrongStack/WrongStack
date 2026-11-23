import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAtomicFile } from '../../src/session-catalog/session-registry-atomic-file.js';

/**
 * F60 (WS-045 class): writeAtomicFile writes the cross-process session registry
 * (session ids, project roots, pids, agent entries) via fs.open(tmp, 'w') with
 * NO mode and no owner-only hardening, then publishes by rename (or the
 * Windows EPERM copyFile fallback). On Windows the registry stayed readable by
 * other local accounts where inheritance was not owner-only. The temp is
 * hardened before publish (rename preserves the ACL); the copyFile fallback
 * destination is hardened explicitly.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the temp path.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f60-'));
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

describe('session registry owner-only hardening (F60)', () => {
  it('hardens the temp before publishing the registry', async () => {
    const filePath = path.join(dir, 'session-registry.json');
    await writeAtomicFile(filePath, {
      sess1: {
        sessionId: 'sess1',
        projectSlug: 'p',
        projectRoot: dir,
        projectName: 'P',
        workingDir: dir,
        status: 'live',
        pid: 123,
        startedAt: '2026-01-01T00:00:00Z',
        lastHeartbeatAt: '2026-01-01T00:00:00Z',
        agentCount: 0,
        agents: [],
      },
    } as never);
    // Valid-input control: the registry published correctly.
    const published = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
    expect(published['sess1']).toBeTruthy();
    const tmpCalls = icaclsCalls.filter(
      (c) =>
        c.file === 'icacls' &&
        (c.args[0] ?? '').startsWith(path.join(dir, '.session-registry.json.')) &&
        (c.args[0] ?? '').endsWith('.tmp'),
    );
    expect(tmpCalls.length, 'writeAtomicFile issues icacls for the temp').toBe(1);
  });
});
