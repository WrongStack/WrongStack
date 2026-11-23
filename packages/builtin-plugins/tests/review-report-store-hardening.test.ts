import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlReportStore } from '../src/review-report-store.js';

/**
 * F28 (WS-045 class): JsonlReportStore appends review reports — rawText holds
 * the full review report (code snippets, possibly secrets) — via fsp.appendFile
 * + mode 0o600 (a Windows no-op) on persist/transition/updateEvidence/addNote,
 * with no owner-only hardening (only compaction rewrites via atomicWrite). On
 * Windows the report log stayed readable by other local accounts where
 * inheritance was not owner-only. The store now hardens once per active file via
 * restrictFilePermissions and re-hardens after compaction.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the store path.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

const input = (id: string) => ({
  id,
  sessionId: 'sess-1',
  agentId: 'chimera-review',
  reviewerModel: 'gpt-5',
  source: 'chimera',
  reviewStatus: 'success',
  files: [{ path: 'src/a.ts', status: 'modified' }],
  counts: { critical: 1, high: 2, medium: 0, low: 0 },
  totalFindings: 3,
  unparseableCount: 0,
  rawText: '### Critical (1)\n1. src/a.ts:1 — bug SECRET-VALUE',
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f28-'));
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

describe('JsonlReportStore owner-only hardening (F28)', () => {
  it('hardens the report log on persist', async () => {
    const store = new JsonlReportStore(dir);
    await store.persist(input('r1') as never);
    expect(hardened(store.storePath), 'persist issues icacls for the report log').toBe(true);
  });

  it('hardens ONCE across multiple persists', async () => {
    const store = new JsonlReportStore(dir);
    await store.persist(input('r1') as never);
    await store.persist(input('r2') as never);
    const count = icaclsCalls.filter(
      (c) => c.file === 'icacls' && c.args[0] === store.storePath,
    ).length;
    expect(count).toBe(1);
  });
});
