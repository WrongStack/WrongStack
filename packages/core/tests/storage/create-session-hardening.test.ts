import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CreateSessionHost,
  executeCreateSession,
} from '../../src/storage/session-store/create-session.js';

/**
 * F46 (WS-045 class): executeCreateSession creates the session journal via
 * fsp.open(file, 'w', 0o600) and appends the index create row via
 * fsp.appendFile + mode 0o600 — both Windows no-ops with no owner-only
 * hardening. The journal is the verbatim session transcript. On Windows both
 * files stayed readable by other local accounts where inheritance was not
 * owner-only. Creation is not a hot path: harden the journal on every create
 * (a reused id truncates) and the index after the create row.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the journal/index paths; a minimal fake host over real temp files.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;
let host: CreateSessionHost;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f46-'));
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
  host = {
    dir,
    events: undefined,
    secretScrubber: { scrub: (t: string) => t },
    checkpointCas: undefined,
    isSessionInUse: undefined,
    catalogClient: undefined,
    indexFile: path.join(dir, '_index.jsonl'),
    storagePolicy: {},
    autoArchive: false,
    logWarn: () => {},
    ensureShardDir: async () => dir,
    sessionPath: (id: string, ext: string) => path.join(dir, `${id}${ext}`),
    invalidateShardManifestBySessionId: async () => {},
    readSummaryManifest: async () => null,
    persistCatalogSummary: async () => {},
    archiveIdle: async () => ({}),
    onIndexAppendCreate: () => {},
    clearIndexCache: () => {},
  } as unknown as CreateSessionHost;
});

afterEach(async () => {
  _filePermOps.platform = process.platform;
  _filePermOps.userInfo = undefined;
  _filePermOps.execFileAsync = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

const hardened = (t: string) => icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === t);

describe('session creation owner-only hardening (F46)', () => {
  it('hardens the new journal and the index create row', async () => {
    const writer = await executeCreateSession(host, {
      id: 'sess1',
      title: 't',
      model: 'm',
      provider: 'p',
    } as never);
    await writer.close();
    expect(hardened(path.join(dir, 'sess1.jsonl')), 'create issues icacls for the journal').toBe(
      true,
    );
    expect(hardened(path.join(dir, '_index.jsonl')), 'create issues icacls for the index').toBe(
      true,
    );
  });
});
