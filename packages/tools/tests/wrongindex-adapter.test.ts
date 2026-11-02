/**
 * WrongIndex service adapter: framing, result mapping, mode selection, the
 * ownership guard on local writers, and (when a `wrongindexd` binary is
 * supplied in WRONGINDEX_TEST_DAEMON) an end-to-end run through the service.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

process.env['WRONGSTACK_INDEX_INLINE'] = '1';

import { dispatchIndexOp } from '../src/codebase-index/index-worker-rpc.js';
import { IndexStore } from '../src/codebase-index/writer.js';
import { encodeFrame, FrameReader } from '../src/codebase-index/wrongindex/client.js';
import {
  IndexOwnedExternallyError,
  isOwnedByWrongIndex,
  OWNER_LOCK_FILE,
} from '../src/codebase-index/wrongindex/owner-lock.js';
import {
  resetWrongIndexConnection,
  resolveIndexRoute,
  resolveIndexServiceMode,
  setIndexServiceMode,
  toIndexResult,
} from '../src/codebase-index/wrongindex/service.js';

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

const holders: ChildProcess[] = [];

afterEach(() => {
  setIndexServiceMode(undefined);
  delete process.env['WRONGSTACK_INDEX_SERVICE'];
  for (const h of holders.splice(0)) h.kill();
  resetWrongIndexConnection();
});

/** Hold `<dir>/.wrongindex-owner.lock` the way the service does (no sharing). */
async function holdLock(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, OWNER_LOCK_FILE).replace(/'/g, "''");
  const child = spawn(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$f=[IO.File]::Open('${lock}','OpenOrCreate','ReadWrite','None'); 'ready'; Start-Sleep 60`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  holders.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes('ready')) resolve();
    });
    child.once('exit', () => reject(new Error('lock holder exited')));
  });
}

function writeProject(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'a.ts'),
    "import { helper } from './b';\nexport function alphaEntry() {\n  return helper();\n}\n",
  );
  fs.writeFileSync(
    path.join(root, 'src', 'b.ts'),
    'export function helper(): number {\n  return 42;\n}\n',
  );
}

describe('WrongIndex framing', () => {
  it('round-trips frames split across chunks', () => {
    const a = encodeFrame({ n: 1, s: 'çalışma' });
    const b = encodeFrame({ n: 2 });
    const all = Buffer.concat([a, b]);
    const r = new FrameReader();
    expect(r.push(all.subarray(0, 3))).toEqual([]);
    expect(r.push(all.subarray(3, a.length + 2))).toEqual([{ n: 1, s: 'çalışma' }]);
    expect(r.push(all.subarray(a.length + 2))).toEqual([{ n: 2 }]);
  });

  it('uses a little-endian u32 byte length', () => {
    const f = encodeFrame('é');
    expect(f.readUInt32LE(0)).toBe(Buffer.byteLength('"é"'));
  });

  it('refuses an oversized frame header', () => {
    const head = Buffer.alloc(4);
    head.writeUInt32LE(9 * 1024 * 1024, 0);
    expect(() => new FrameReader().push(head)).toThrow(/exceeds/);
  });
});

describe('WrongIndex job results', () => {
  it('maps a native result', () => {
    const r = toIndexResult({
      backend: 'native',
      native: {
        outcome: 'updated',
        filesIndexed: 3,
        symbolsIndexed: 40,
        changedFiles: 2,
        durationMs: 12,
      },
    });
    expect(r).toMatchObject({
      filesIndexed: 3,
      symbolsIndexed: 40,
      durationMs: 12,
      changedFiles: 2,
    });
  });

  it('maps an unchanged native run to zero changed files', () => {
    const r = toIndexResult({ backend: 'native', native: { outcome: 'unchanged' } });
    expect((r as { changedFiles?: number }).changedFiles).toBe(0);
  });

  it('maps a compatibility-worker result', () => {
    const r = toIndexResult({ filesIndexed: 1, symbolsIndexed: 5, errors: ['x'], changedFiles: 1 });
    expect(r).toMatchObject({ filesIndexed: 1, symbolsIndexed: 5, errors: ['x'], changedFiles: 1 });
  });
});

describe('index service mode', () => {
  it('defaults to local and lets the environment override the config', () => {
    expect(resolveIndexServiceMode()).toBe('local');
    setIndexServiceMode('auto');
    expect(resolveIndexServiceMode()).toBe('auto');
    process.env['WRONGSTACK_INDEX_SERVICE'] = 'wrongindex';
    expect(resolveIndexServiceMode()).toBe('wrongindex');
    process.env['WRONGSTACK_INDEX_SERVICE'] = 'bogus';
    expect(resolveIndexServiceMode()).toBe('auto');
  });

  it('auto routes to the service only for an index it owns', async () => {
    const root = tmp('wi-route-');
    const indexDir = path.join(root, '.idx');
    setIndexServiceMode('auto');
    expect(resolveIndexRoute(root, indexDir)).toBe('local');
    if (process.platform !== 'win32') return;
    await holdLock(indexDir);
    expect(isOwnedByWrongIndex(indexDir)).toBe(true);
    expect(resolveIndexRoute(root, indexDir)).toBe('wrongindex');
  });
});

describe.runIf(process.platform === 'win32')('an index the service owns', () => {
  it('is not detected as owned once the holder is gone', async () => {
    const dir = path.join(tmp('wi-lock-'), 'idx');
    expect(isOwnedByWrongIndex(dir)).toBe(false);
    await holdLock(dir);
    expect(isOwnedByWrongIndex(dir)).toBe(true);
    const h = holders.pop();
    await new Promise<void>((resolve) => {
      h?.once('exit', () => resolve());
      h?.kill();
    });
    expect(fs.existsSync(path.join(dir, OWNER_LOCK_FILE))).toBe(true);
    expect(isOwnedByWrongIndex(dir)).toBe(false);
  });

  it('is never written locally: index runs are refused, stores open query-only', async () => {
    const root = tmp('wi-owned-');
    writeProject(root);
    const indexDir = path.join(root, '.idx');
    const opts = { timeoutMs: 60_000 };
    const first = await dispatchIndexOp('index', { projectRoot: root, indexDir }, opts, true);
    expect(first.symbolsIndexed).toBeGreaterThan(0);
    const before = fs.statSync(path.join(indexDir, 'index.db')).mtimeMs;

    await holdLock(indexDir);
    await expect(
      dispatchIndexOp('index', { projectRoot: root, indexDir }, opts, true),
    ).rejects.toBeInstanceOf(IndexOwnedExternallyError);
    await expect(
      dispatchIndexOp('stats', { projectRoot: root, indexDir }, opts, false),
    ).rejects.toBeInstanceOf(IndexOwnedExternallyError);

    const store = new IndexStore(root, { indexDir });
    try {
      expect(store.ownedExternally).toBe(true);
      expect(store.getMetadata('version')).toBe('5');
      expect(() => store.setMetadata('probe', '1')).toThrow();
    } finally {
      store.close();
    }
    expect(fs.statSync(path.join(indexDir, 'index.db')).mtimeMs).toBe(before);
  });
});

describe('WrongStack without WrongIndex', () => {
  it('indexes and searches with its own engine when the service is not there', async () => {
    const root = tmp('wi-none-');
    writeProject(root);
    const indexDir = path.join(root, '.idx');
    const opts = { timeoutMs: 60_000 };
    for (const mode of ['local', 'auto', 'wrongindex'] as const) {
      // An empty data root: no service, no discovery metadata.
      setIndexServiceMode(mode, { dataRoot: tmp('wi-nohome-') });
      resetWrongIndexConnection();
      const run = await dispatchIndexOp('index', { projectRoot: root, indexDir }, opts, true);
      expect(run.symbolsIndexed, mode).toBeGreaterThan(0);
      const hits = await dispatchIndexOp(
        'search',
        { projectRoot: root, indexDir, query: 'alphaEntry', limit: 5 },
        opts,
        false,
      );
      expect(JSON.stringify(hits), mode).toContain('alphaEntry');
    }
  });

  it('a lock file left behind by a service that is gone does not block it', async () => {
    const root = tmp('wi-stale-');
    writeProject(root);
    const indexDir = path.join(root, '.idx');
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(path.join(indexDir, OWNER_LOCK_FILE), '');
    fs.writeFileSync(
      path.join(indexDir, '.wrongindex-owner.json'),
      JSON.stringify({ owner: 'wrongindexd', pid: process.pid, epoch: 3 }),
    );
    expect(isOwnedByWrongIndex(indexDir)).toBe(false);
    const run = await dispatchIndexOp(
      'index',
      { projectRoot: root, indexDir },
      { timeoutMs: 60_000 },
      true,
    );
    expect(run.symbolsIndexed).toBeGreaterThan(0);
  });

  it.runIf(process.platform === 'win32')(
    'an index the service holds is still never written when the service cannot be reached',
    async () => {
      const root = tmp('wi-held-');
      writeProject(root);
      const indexDir = path.join(root, '.idx');
      await holdLock(indexDir);
      setIndexServiceMode('wrongindex', { dataRoot: tmp('wi-nohome-') });
      resetWrongIndexConnection();
      await expect(
        dispatchIndexOp('index', { projectRoot: root, indexDir }, { timeoutMs: 60_000 }, true),
      ).rejects.toThrow(/WrongIndex service unavailable/);
      expect(fs.existsSync(path.join(indexDir, 'index.db'))).toBe(false);
    },
  );
});

const daemonExe = process.env['WRONGINDEX_TEST_DAEMON'];

describe.runIf(Boolean(daemonExe) && process.platform === 'win32')(
  'end to end through wrongindexd',
  () => {
    it('registers, claims, indexes and queries; local writers then refuse', async () => {
      const home = tmp('wi-home-');
      const root = tmp('wi-e2e-');
      writeProject(root);
      const indexDir = path.join(root, '.idx');
      const daemon = spawn(daemonExe as string, ['--data-root', home, '--backend', 'native'], {
        stdio: 'ignore',
      });
      holders.push(daemon);
      const endpoint = path.join(home, 'runtime', 'endpoint.json');
      const until = Date.now() + 15_000;
      while (!fs.existsSync(endpoint)) {
        if (Date.now() > until) throw new Error('daemon did not publish its endpoint');
        await new Promise((r) => setTimeout(r, 50));
      }
      setIndexServiceMode('wrongindex', { dataRoot: home });
      const opts = { timeoutMs: 120_000 };

      const run = await dispatchIndexOp('index', { projectRoot: root, indexDir }, opts, true);
      expect(run.symbolsIndexed).toBeGreaterThan(0);
      expect(isOwnedByWrongIndex(indexDir)).toBe(true);

      const hits = await dispatchIndexOp(
        'search',
        { projectRoot: root, indexDir, query: 'alphaEntry', limit: 5 },
        opts,
        false,
      );
      expect(JSON.stringify(hits)).toContain('alphaEntry');

      fs.writeFileSync(
        path.join(root, 'src', 'c.ts'),
        'export function gammaAdded() {\n  return 1;\n}\n',
      );
      const inc = await dispatchIndexOp(
        'index',
        { projectRoot: root, indexDir, files: [path.join(root, 'src', 'c.ts')] },
        opts,
        true,
      );
      expect(inc.symbolsIndexed).toBeGreaterThan(run.symbolsIndexed);

      setIndexServiceMode('local');
      await expect(
        dispatchIndexOp('index', { projectRoot: root, indexDir }, opts, true),
      ).rejects.toBeInstanceOf(IndexOwnedExternallyError);
      setIndexServiceMode('auto', { dataRoot: home });
      const stats = await dispatchIndexOp('stats', { projectRoot: root, indexDir }, opts, false);
      expect(JSON.stringify(stats)).toContain('ts');
    }, 180_000);
  },
);
