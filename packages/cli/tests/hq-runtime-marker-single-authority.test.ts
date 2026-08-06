import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hqRuntimeFilePath, readHqRuntimeFileSync } from '@wrongstack/core/hq';
import { afterEach, describe, expect, it } from 'vitest';
import { writeHqRuntimeMarker } from '../src/hq-server/startup.js';

/**
 * `<dataDir>/runtime.json` carries the local HQ client token, and four pieces
 * of code disagreed about it:
 *
 *  - core `writeHqRuntimeFile` — `atomicWrite` + `restrictFilePermissions`
 *    (WS-045: `mode: 0o600` is a no-op on Windows beyond the read-only bit, so
 *    every other account on the machine could read the token);
 *  - the CLI's `writeHqRuntimeMarker` — a hand-rolled `fs.writeFile` with
 *    `mode: 0o600` and no ACL hardening. This is the ONLY site that actually
 *    writes the marker, so the hardening protected a path nothing used;
 *  - core `readHqRuntimeFileSync` — requires a url, rejects a dead pid,
 *    ACCEPTS a marker with no pid;
 *  - boot's `isHqAlreadyRunning` — ignores the url, REJECTS a marker with no
 *    pid.
 *
 * The last two returned opposite answers from the same bytes: core said "an HQ
 * is running, attach", boot said "nothing running, start one".
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wstack-hq-marker-'));
  dirs.push(dir);
  return dir;
}

describe('HQ runtime marker has one writer and one parser', () => {
  it('the CLI writer produces a marker core can read back', async () => {
    const dataDir = tempDataDir();
    await writeHqRuntimeMarker(dataDir, 'http://127.0.0.1:4599');

    const marker = readHqRuntimeFileSync(dataDir);
    expect(marker?.url).toBe('http://127.0.0.1:4599');
    // The pid is what proves liveness; a marker without one cannot.
    expect(marker?.pid).toBe(process.pid);
    expect(marker?.updatedAt).not.toBe('');
  });

  it('creates the data directory when it does not exist yet', async () => {
    const parent = tempDataDir();
    const dataDir = path.join(parent, 'nested', 'hq');
    await writeHqRuntimeMarker(dataDir, 'http://127.0.0.1:4600');
    expect(fs.existsSync(hqRuntimeFilePath(dataDir))).toBe(true);
  });

  it('writes through the hardened path, not a bare fs.writeFile', async () => {
    const dataDir = tempDataDir();
    await writeHqRuntimeMarker(dataDir, 'http://127.0.0.1:4601');
    const file = hqRuntimeFilePath(dataDir);

    // On POSIX the mode is directly observable. On Windows the mode bits are
    // meaningless and `restrictFilePermissions` does the real work through an
    // ACL, which this test cannot read portably — so assert what IS portable:
    // the file exists at the canonical path with the canonical shape, which
    // only core's writer produces.
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['pid', 'updatedAt', 'url']);
  });

  it('overwrites a previous marker rather than appending', async () => {
    const dataDir = tempDataDir();
    await writeHqRuntimeMarker(dataDir, 'http://127.0.0.1:1111');
    await writeHqRuntimeMarker(dataDir, 'http://127.0.0.1:2222');
    expect(readHqRuntimeFileSync(dataDir)?.url).toBe('http://127.0.0.1:2222');
  });

  it('core rejects a marker whose pid is dead', () => {
    const dataDir = tempDataDir();
    // A pid that cannot be alive: 0 is never a valid process id here.
    fs.writeFileSync(
      hqRuntimeFilePath(dataDir),
      JSON.stringify({ url: 'http://127.0.0.1:4602', pid: 2_147_483_646, updatedAt: 'x' }),
      'utf8',
    );
    expect(readHqRuntimeFileSync(dataDir)).toBeUndefined();
  });

  it('core rejects a marker with no url', () => {
    const dataDir = tempDataDir();
    fs.writeFileSync(
      hqRuntimeFilePath(dataDir),
      JSON.stringify({ pid: process.pid, updatedAt: 'x' }),
      'utf8',
    );
    expect(readHqRuntimeFileSync(dataDir)).toBeUndefined();
  });

  it('a pid-less marker parses, and proving liveness is the caller’s job', () => {
    // This is the case the two readers disagreed on. Core returns it — the
    // file is well-formed — and a caller that needs PROOF of life (boot,
    // deciding whether to skip starting a server) checks the pid itself.
    const dataDir = tempDataDir();
    fs.writeFileSync(
      hqRuntimeFilePath(dataDir),
      JSON.stringify({ url: 'http://127.0.0.1:4603', updatedAt: 'x' }),
      'utf8',
    );
    const marker = readHqRuntimeFileSync(dataDir);
    expect(marker?.url).toBe('http://127.0.0.1:4603');
    expect(marker?.pid).toBeUndefined();
  });
});
