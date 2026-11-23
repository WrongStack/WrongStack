import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrainDecisionLedger } from '../../src/brain/brain-ledger.js';

/**
 * F29 (WS-045 class): BrainDecisionLedger.append() writes brain decision/outcome
 * rows — model reasoning detail that may echo secrets — via appendFile + mode
 * 0o600 (a Windows no-op) with no owner-only hardening. On Windows the ledger
 * stayed readable by other local accounts where inheritance was not owner-only.
 * The ledger now hardens once per active file via restrictFilePermissions and
 * re-hardens after rotation.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the ledger path.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f29-'));
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

describe('BrainDecisionLedger owner-only hardening (F29)', () => {
  it('hardens the ledger file on a recorded outcome', async () => {
    const filePath = path.join(dir, 'ledger.jsonl');
    const ledger = new BrainDecisionLedger({
      filePath,
      events: { emit: () => {} } as never,
      now: () => 0,
    });
    ledger.recordOutcome('req-1', 'success', 'reasoning detail SECRET', 'sess-1');
    await ledger.stop();
    expect(hardened(filePath), 'append issues icacls for the ledger').toBe(true);
  });
});
