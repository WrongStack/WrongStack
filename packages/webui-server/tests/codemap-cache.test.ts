import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearCodemapGraphCache,
  codemapCacheKey,
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

  it('reads index.db mtime:size as the version fingerprint', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-cache-'));
    try {
      const dbPath = path.join(dir, 'index.db');
      fs.writeFileSync(dbPath, 'sqlite');
      const version = indexDbVersion('/any', dir);
      expect(version).toMatch(/^\d+(\.\d+)?:\d+$/);
      const st = fs.statSync(dbPath);
      expect(version).toBe(`${st.mtimeMs}:${st.size}`);
      expect(indexDbVersion('/missing', path.join(dir, 'nope'))).toBe('missing');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
