import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearCodemapGraphCache,
  codemapCacheKey,
  codemapGraphCacheChars,
  codemapGraphCacheSize,
  getCachedCodemapBody,
  indexDbVersion,
  setCachedCodemapBody,
} from '../src/server/codemap-cache.js';

describe('codemap graph cache', () => {
  afterEach(() => {
    clearCodemapGraphCache();
  });

  it('returns undefined on cold miss and stores bodies by version', () => {
    const key = codemapCacheKey('/proj', undefined, 'packages');
    expect(getCachedCodemapBody(key, 'v1')).toBeUndefined();
    setCachedCodemapBody(key, 'v1', '{"nodes":[],"edges":[]}');
    expect(getCachedCodemapBody(key, 'v1')).toBe('{"nodes":[],"edges":[]}');
    expect(codemapGraphCacheSize()).toBe(1);
  });

  it('invalidates when the index version changes', () => {
    const key = codemapCacheKey('/proj', undefined, 'packages');
    setCachedCodemapBody(key, 'v1', '{"nodes":[1]}');
    expect(getCachedCodemapBody(key, 'v2')).toBeUndefined();
    expect(codemapGraphCacheSize()).toBe(0);
  });

  it('evicts oldest entries when the soft cap is exceeded', () => {
    for (let i = 0; i < 130; i++) {
      setCachedCodemapBody(`k${i}`, 'v', `body-${i}`);
    }
    expect(codemapGraphCacheSize()).toBeLessThanOrEqual(128);
    expect(getCachedCodemapBody('k0', 'v')).toBeUndefined();
    expect(getCachedCodemapBody('k129', 'v')).toBe('body-129');
  });

  it('refreshes LRU order on hit so hot scopes are not evicted first', () => {
    setCachedCodemapBody('hot', 'v', 'hot-body');
    for (let i = 0; i < 127; i++) {
      setCachedCodemapBody(`cold${i}`, 'v', `cold-${i}`);
    }
    // Touch hot so it moves to the end before the next insert would evict the oldest.
    expect(getCachedCodemapBody('hot', 'v')).toBe('hot-body');
    setCachedCodemapBody('newest', 'v', 'new');
    expect(getCachedCodemapBody('hot', 'v')).toBe('hot-body');
  });

  it('bounds retained serialized graph bodies by individual and total size', () => {
    const body = 'x'.repeat(4 * 1024 * 1024);
    setCachedCodemapBody('too-large', 'v', `${body}x`);
    expect(codemapGraphCacheSize()).toBe(0);

    for (let i = 0; i < 5; i++) setCachedCodemapBody(`large-${i}`, 'v', body);
    expect(codemapGraphCacheSize()).toBe(4);
    expect(codemapGraphCacheChars()).toBe(16 * 1024 * 1024);
    expect(getCachedCodemapBody('large-0', 'v')).toBeUndefined();
    expect(getCachedCodemapBody('large-4', 'v')).toBe(body);
  });

  it('reads index.db mtime:size as the version fingerprint', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-cache-'));
    try {
      const dbPath = path.join(dir, 'index.db');
      fs.writeFileSync(dbPath, 'sqlite');
      const version = await indexDbVersion('/any', dir);
      expect(version).toMatch(/^\d+(\.\d+)?:\d+$/);
      const st = fs.statSync(dbPath);
      expect(version).toBe(`${st.mtimeMs}:${st.size}`);
      expect(await indexDbVersion('/missing', path.join(dir, 'nope'))).toBe('missing');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes WAL file stats in the fingerprint so WAL-mode writes invalidate the cache', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-cache-wal-'));
    try {
      const dbPath = path.join(dir, 'index.db');
      const walPath = path.join(dir, 'index.db-wal');
      fs.writeFileSync(dbPath, 'sqlite');

      // Without WAL — base fingerprint.
      const versionNoWal = await indexDbVersion('/any', dir);

      // Simulate a WAL write (indexer writes to index.db-wal, not index.db).
      fs.writeFileSync(walPath, 'wal-data');
      const versionWithWal = await indexDbVersion('/any', dir);

      // The fingerprint must change when a WAL file appears.
      expect(versionWithWal).not.toBe(versionNoWal);
      expect(versionWithWal).toContain('wal-data'.length.toString());

      // A subsequent WAL append (more data written) must also invalidate.
      fs.writeFileSync(walPath, 'wal-data-appended');
      const versionAfterAppend = await indexDbVersion('/any', dir);
      expect(versionAfterAppend).not.toBe(versionWithWal);

      // Deleting the WAL (post-checkpoint) reverts to the base fingerprint.
      fs.rmSync(walPath);
      expect(await indexDbVersion('/any', dir)).toBe(versionNoWal);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
