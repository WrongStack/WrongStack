import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emitReviewIfChanged } from '../src/review-claim-registry.js';
import { claimsFilePath } from '../src/review-claim-store-lock.js';
import type { ReviewContextBundle } from '../src/review-types.js';

/**
 * F61 (WS-045 class): the review claim ledger — session ids, file claim keys —
 * is created via fsp.appendFile with NO mode, and compactLedger rewrites it via
 * a tmp fsp.writeFile with NO mode + rename/copyFile fallback. On Windows both
 * stayed readable by other local accounts where inheritance was not
 * owner-only. The ledger is hardened once per path on append; the compaction
 * temp is hardened before publish and the copyFile fallback destination
 * explicitly.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the ledger and compaction temp; maxLedgerLines=1 forces compaction
 * on the second claim.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let storeDir: string;

beforeEach(async () => {
  storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f61-'));
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
  await fs.rm(storeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const hardened = (t: string) => icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === t);

function bundle(content: string): ReviewContextBundle {
  return {
    cwd: 'C:\\project',
    config: {
      enabled: true,
      provider: 'test',
      model: 'test',
      maxFiles: 15,
      autoFix: 'off',
      fallbackModels: [],
      fallbackProfile: undefined,
      cascadeOn: 'off',
      maxCascadeDepth: 0,
    },
    files: [{ path: 'src/file.ts', status: 'modified', content }],
  } as ReviewContextBundle;
}

describe('review claim ledger owner-only hardening (F61)', () => {
  it('hardens the ledger on append and the compaction temp', async () => {
    const api = { events: {}, emitCustom: () => {} } as never;
    const first = await emitReviewIfChanged(api, bundle('v1'), { storeDir, maxLedgerLines: 1 });
    expect(first, 'first claim emits').not.toBeNull();
    expect(hardened(claimsFilePath(storeDir)), 'ledger append is hardened').toBe(true);

    const second = await emitReviewIfChanged(api, bundle('v2'), { storeDir, maxLedgerLines: 1 });
    expect(second, 'second claim emits').not.toBeNull();
    const tmpCalls = icaclsCalls.filter(
      (c) => c.file === 'icacls' && c.args[0].startsWith(`${claimsFilePath(storeDir)}.tmp-`),
    );
    expect(tmpCalls.length, 'compaction temp is hardened').toBe(1);
    // Valid-input control: the compacted ledger still holds the live claim.
    const raw = await fs.readFile(claimsFilePath(storeDir), 'utf8');
    expect(raw).toContain('"op":"claim"');
  });
});
