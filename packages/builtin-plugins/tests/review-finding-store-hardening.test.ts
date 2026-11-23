import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlFindingStore } from '../src/review-finding-store.js';
import type { ChimeraFinding } from '../src/review-finding-types.js';

/**
 * F27 (WS-045 class): JsonlFindingStore appends review findings — code snippets
 * and descriptions that may carry secrets — via fsp.appendFile + mode 0o600 (a
 * Windows no-op) on the upsert/transition paths, with no owner-only hardening
 * (only the rare compaction rewrites via atomicWrite, which hardens). On Windows
 * the finding log stayed readable by other local accounts where inheritance was
 * not owner-only. The store now hardens once per active file via
 * restrictFilePermissions and re-hardens after compaction.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the store path.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

function makeFinding(): ChimeraFinding {
  const id = `f-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    fingerprint: `fp-${id}`,
    severity: 'medium',
    source: 'auto',
    title: 'Test finding',
    description: 'A test finding description with SECRET-VALUE',
    createdAt: new Date().toISOString(),
    status: 'active',
    originReport: {
      reportId: 'r-1',
      sessionId: 's-1',
      agentId: 'a-1',
      reviewerModel: 'test-model',
    },
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f27-'));
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

const hardened = (t: string) => icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === t);

describe('JsonlFindingStore owner-only hardening (F27)', () => {
  it('hardens the finding log on upsert', async () => {
    const store = new JsonlFindingStore(dir);
    await store.upsert([makeFinding()], {
      sessionId: 's1',
      reportId: 'r1',
      agentId: 'a1',
      model: 'm1',
    });
    expect(hardened(store.storePath), 'upsert issues icacls for the finding log').toBe(true);
  });

  it('hardens ONCE across multiple upserts', async () => {
    const store = new JsonlFindingStore(dir);
    await store.upsert([makeFinding()], {
      sessionId: 's1',
      reportId: 'r1',
      agentId: 'a1',
      model: 'm1',
    });
    await store.upsert([makeFinding()], {
      sessionId: 's1',
      reportId: 'r2',
      agentId: 'a1',
      model: 'm1',
    });
    const count = icaclsCalls.filter(
      (c) => c.file === 'icacls' && c.args[0] === store.storePath,
    ).length;
    expect(count).toBe(1);
  });
});
