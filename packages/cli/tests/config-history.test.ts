import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendHistory,
  getHistoryEntry,
  listHistory,
  restoreFromHistory,
  restoreLast,
} from '../src/config-history.js';

describe('config-history', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-ch-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  // homeFn that returns our temp dir — inject into all API calls
  const home = () => tmp;
  const profileDir = () => path.join(tmp, '.wrongstack', 'profiles', 'default');

  // ─────────────────────────────────────────────────────────────── appendHistory

  describe('appendHistory()', () => {
    it('creates history index and entry file', async () => {
      const oldCfg = { provider: 'anthropic', model: 'claude-3' };
      const newCfg = { provider: 'openai', model: 'gpt-4o' };

      const id = await appendHistory(oldCfg, newCfg, 'Switched provider', home);

      const entries = await listHistory(home);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.id).toBe(id);
      expect(entries[0]!.description).toBe('Switched provider');

      const entry = (await getHistoryEntry(id, home))!;
      expect(entry.snapshotMasked.provider).toBe('openai');
      expect(entry.snapshotMasked.model).toBe('gpt-4o');
    });

    it('masks apiKey in snapshot', async () => {
      const oldCfg = { provider: 'test', apiKey: 'sk-secret-123' };
      const newCfg = { provider: 'test', apiKey: 'sk-new-456' };

      const id = await appendHistory(oldCfg, newCfg, 'Changed API key', home);

      const entry = (await getHistoryEntry(id, home))!;
      expect(entry.snapshotMasked).toEqual({ provider: 'test', apiKey: '[REDACTED]' });
      expect(entry.diffSummary).toContain('[CHANGED]');
    });

    it('prepends new entries (newest first)', async () => {
      await appendHistory({}, { a: 1 }, 'first', home);
      await appendHistory({}, { b: 2 }, 'second', home);

      const entries = await listHistory(home);
      expect(entries[0]!.description).toBe('second');
      expect(entries[1]!.description).toBe('first');
    });
  });

  // ───────────────────────────────────────────────────── getHistoryEntry

  describe('getHistoryEntry()', () => {
    it('returns null for unknown ID', async () => {
      const entry = await getHistoryEntry('nonexistent-id-20260101', home);
      expect(entry).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────── restoreFromHistory

  describe('restoreFromHistory()', () => {
    it('restores config from a history snapshot', async () => {
      // Create a history entry
      const newCfg = { provider: 'openai', model: 'gpt-4o' };
      const id = await appendHistory({}, newCfg, 'Set openai', home);

      // Write a different current config
      const cfgDir = profileDir();
      await fs.mkdir(cfgDir, { recursive: true });
      const cfgPath = path.join(cfgDir, 'config.json');
      await fs.writeFile(cfgPath, JSON.stringify({ provider: 'anthropic' }));

      // Restore
      const result = await restoreFromHistory(id, home);
      expect(result.ok).toBe(true);

      const restored = await fs.readFile(cfgPath, 'utf8');
      const parsed = JSON.parse(restored);
      expect(parsed.provider).toBe('openai');
      expect(parsed.model).toBe('gpt-4o');
    });

    it('returns error for unknown history ID', async () => {
      const result = await restoreFromHistory('nonexistent-id', home);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  // ───────────────────────────────────────────────────── restoreLast

  describe('restoreLast()', () => {
    it('restores from config.json.last', async () => {
      const cfgDir = profileDir();
      await fs.mkdir(cfgDir, { recursive: true });
      const cfgPath = path.join(cfgDir, 'config.json');
      const lastPath = path.join(cfgDir, 'config.json.last');

      // Write current and .last
      await fs.writeFile(cfgPath, JSON.stringify({ provider: 'anthropic' }));
      await fs.writeFile(lastPath, JSON.stringify({ provider: 'openai', model: 'gpt-4o' }));

      const result = await restoreLast(home);
      expect(result.ok).toBe(true);

      const restored = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
      expect(restored.provider).toBe('openai');
    });

    it('returns error when no .last backup exists', async () => {
      const cfgDir = profileDir();
      await fs.mkdir(cfgDir, { recursive: true });
      await fs.writeFile(path.join(cfgDir, 'config.json'), '{}');

      const result = await restoreLast(home);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('No prior backup');
    });
  });

  // ──────────────────────────────────────────────────── diffSummary

  describe('diffSummary()', () => {
    it('describes changed fields', async () => {
      const id = await appendHistory(
        { provider: 'a', model: 'old-model' },
        { provider: 'b', model: 'new-model' },
        'changed',
        home,
      );
      const entry = (await getHistoryEntry(id, home))!;
      expect(entry.diffSummary).toContain('provider');
      expect(entry.diffSummary).toContain('model');
    });
  });
});
