import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SecretScrubber } from '@wrongstack/contracts/types/secret-scrubber';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import {
  INPUT_HISTORY_DEFAULT_MAX,
  InputHistoryStore,
} from '../../src/storage/input-history-store.js';

/**
 * A minimal SecretScrubber stand-in for tests. The real DefaultSecretScrubber
 * covers ~22 regex patterns; here we only need to assert the store's contract:
 * scrub runs before write, and entries that still contain the redaction marker
 * are dropped. The marker string is matched against the production sentinel.
 */
const REDACTED = '***REDACTED***';
const fakeScrubber: SecretScrubber = {
  scrub: (text: string) => text.replace(/sk-(?:live|test|prod)-[A-Za-z0-9]{16,}/g, REDACTED),
  scrubObject: <T>(obj: T) => obj,
};

async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'input-history-test-'));
  return path.join(dir, 'input-history.json');
}

describe('InputHistoryStore', () => {
  let file: string;

  beforeEach(async () => {
    file = await tmpFile();
  });

  afterEach(async () => {
    await fs.rm(path.dirname(file), { recursive: true, force: true });
  });

  describe('load', () => {
    it('returns an empty array when the file does not exist', async () => {
      const store = new InputHistoryStore(file, fakeScrubber);
      expect(await store.load()).toEqual([]);
    });

    it('returns an empty array when the file is corrupt JSON', async () => {
      await fs.writeFile(file, '{ not json');
      const store = new InputHistoryStore(file, fakeScrubber);
      expect(await store.load()).toEqual([]);
    });

    it('returns the persisted entries (newest first)', async () => {
      await fs.writeFile(
        file,
        JSON.stringify({
          version: 1,
          updatedAt: '2026-01-01',
          entries: ['newest', 'older', 'oldest'],
        }),
      );
      const store = new InputHistoryStore(file, fakeScrubber);
      expect(await store.load()).toEqual(['newest', 'older', 'oldest']);
    });

    it('rejects a file whose entries are not all strings', async () => {
      await fs.writeFile(
        file,
        JSON.stringify({ version: 1, updatedAt: '2026-01-01', entries: ['ok', 42, 'bad'] }),
      );
      const store = new InputHistoryStore(file, fakeScrubber);
      expect(await store.load()).toEqual([]);
    });

    it('caps the loaded entries at maxEntries', async () => {
      const many = Array.from({ length: 150 }, (_, i) => `e-${i}`);
      await fs.writeFile(file, JSON.stringify({ version: 1, updatedAt: 'x', entries: many }));
      const store = new InputHistoryStore(file, fakeScrubber, 100);
      const loaded = await store.load();
      expect(loaded).toHaveLength(100);
      expect(loaded[0]).toBe('e-0');
    });
  });

  describe('save', () => {
    it('writes a valid versioned file that load can read back', async () => {
      const store = new InputHistoryStore(file, fakeScrubber);
      await store.save(['alpha', 'beta']);
      expect(await store.load()).toEqual(['alpha', 'beta']);
    });

    it('scrubs secrets before writing', async () => {
      const store = new InputHistoryStore(file, fakeScrubber);
      await store.save(['normal prompt', 'key is sk-live-ABCDEFGHIJKLMNOP']);
      // The secret-bearing entry is dropped post-scrub; only the clean one persists.
      expect(await store.load()).toEqual(['normal prompt']);
    });

    it('drops an entry that still contains the redaction marker after scrubbing', async () => {
      const store = new InputHistoryStore(file, fakeScrubber);
      // A literal REDACTED marker in the prompt text would be useless as history.
      await store.save(['keep me', `noise ${REDACTED} noise`]);
      expect(await store.load()).toEqual(['keep me']);
    });

    it('works with production DefaultSecretScrubber and drops entries containing redacted secrets', async () => {
      const realScrubber = new DefaultSecretScrubber();
      const store = new InputHistoryStore(file, realScrubber);
      await store.save([
        'explain this code',
        'export ANTHROPIC_API_KEY=sk-ant-api03-abcdef1234567890abcdef1234567890abcdef1234567890-abcdef1234AA',
      ]);
      expect(await store.load()).toEqual(['explain this code']);
    });

    it('caps at maxEntries on write', async () => {
      const store = new InputHistoryStore(file, fakeScrubber, 5);
      const entries = Array.from({ length: 10 }, (_, i) => `e-${i}`);
      await store.save(entries);
      const loaded = await store.load();
      expect(loaded).toHaveLength(5);
      expect(loaded[0]).toBe('e-0');
    });

    it('creates the parent directory if it does not exist', async () => {
      const nested = path.join(path.dirname(file), 'nested', 'deep', 'input-history.json');
      const store = new InputHistoryStore(nested, fakeScrubber);
      await store.save(['x']);
      expect(await store.load()).toEqual(['x']);
    });
  });

  describe('clear', () => {
    it('overwrites with an empty entry list', async () => {
      const store = new InputHistoryStore(file, fakeScrubber);
      await store.save(['a', 'b']);
      await store.clear();
      expect(await store.load()).toEqual([]);
    });

    it('preserves the version field', async () => {
      const store = new InputHistoryStore(file, fakeScrubber);
      await store.clear();
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      expect(raw.version).toBe(1);
      expect(raw.entries).toEqual([]);
    });
  });

  describe('defaults', () => {
    it('exposes a default max constant', () => {
      expect(INPUT_HISTORY_DEFAULT_MAX).toBe(100);
    });
  });

  describe('two instances on one file (two TUIs on one project)', () => {
    it('a later save does not erase the prompts the other instance added', async () => {
      await new InputHistoryStore(file, fakeScrubber).save(['old']);
      const a = new InputHistoryStore(file, fakeScrubber);
      const b = new InputHistoryStore(file, fakeScrubber);
      const memA = await a.load();
      const memB = await b.load();
      await a.save(['from a', ...memA]);
      await b.save(['from b', ...memB]);
      expect(await new InputHistoryStore(file, fakeScrubber).load()).toEqual([
        'from b',
        'from a',
        'old',
      ]);
    });

    // F468: save() merges foreign entries through readEntries(strict), but
    // strict only covered read errors — a torn file read as [] and the save
    // wrote this instance's list over the other session's prompts.
    it('refuses to save over a file it cannot parse, leaving its bytes alone', async () => {
      await new InputHistoryStore(file, fakeScrubber).save(['foreign prompt']);
      const b = new InputHistoryStore(file, fakeScrubber);
      await b.load();
      const torn = '{"version":1,"entries":["foreign prompt"';
      await fs.writeFile(file, torn);
      await expect(b.save(['my prompt'])).rejects.toThrow();
      expect(await fs.readFile(file, 'utf8')).toBe(torn);
    });

    it('keeps the entries behind a BOM when saving', async () => {
      await fs.writeFile(
        file,
        `\uFEFF${JSON.stringify({ version: 1, updatedAt: 'x', entries: ['foreign prompt'] })}`,
      );
      const store = new InputHistoryStore(file, fakeScrubber);
      await store.save(['my prompt']);
      expect(await new InputHistoryStore(file, fakeScrubber).load()).toEqual([
        'my prompt',
        'foreign prompt',
      ]);
    });

    it("still honors an instance's own removals", async () => {
      const a = new InputHistoryStore(file, fakeScrubber);
      await a.load();
      await a.save(['x', 'y']);
      await a.save(['x']);
      expect(await new InputHistoryStore(file, fakeScrubber).load()).toEqual(['x']);
    });
  });
});
