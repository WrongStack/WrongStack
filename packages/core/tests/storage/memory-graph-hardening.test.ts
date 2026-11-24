import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _filePermOps } from '@wrongstack/persistence';
import { GraphMemoryBackend } from '../../src/storage/memory-graph-backend.js';

/**
 * F89 (WS-045 no-mode class): GraphMemoryBackend._saveGraph writes the memory
 * graph (user memory relationships) via fs.writeFile(tmp, JSON) with NO mode
 * and no hardening, then renames into place. On Windows the graph stayed
 * readable by other local accounts where inheritance was not owner-only.
 * The temp is hardened before the rename (best-effort).
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f89-'));
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

describe('memory graph owner-only hardening (F89)', () => {
  it('hardens the graph on save', async () => {
    const graphPath = path.join(dir, 'memory-graph.json');
    const backend = new GraphMemoryBackend({
      paths: { projectDir: dir },
      graphPath,
    } as never);
    await backend.remember(
      'project-memory',
      { scope: 'project-memory', text: 'private note', ts: '2026-01-01T00:00:00Z' } as never,
      path.join(dir, 'memory.md'),
    );
    await backend.flush();
    const targets = icaclsCalls.filter((c) => c.file === 'icacls').map((c) => c.args[0]);
    expect(
      targets.some((t) => t === graphPath || t === `${graphPath}.tmp`),
      'graph save is hardened',
    ).toBe(true);
  });
});
