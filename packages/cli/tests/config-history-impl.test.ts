import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendHistory,
  backupCurrent,
  getHistoryEntry,
  listHistory,
  MAX_CONFIG_HISTORY_ENTRIES,
  restoreFromHistory,
  restoreLast,
} from '../src/config-history.js';

let tmp: string;
let homeFn: () => string;

async function readJson(p: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-hist-'));
  homeFn = () => tmp;
  await fs.mkdir(path.join(tmp, '.wrongstack', 'profiles', 'default'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const wsRoot = () => path.join(tmp, '.wrongstack');
const profileRoot = () => path.join(wsRoot(), 'profiles', 'default');
const cfgPath = () => path.join(profileRoot(), 'config.json');
const lastPath = () => path.join(profileRoot(), 'config.json.last');

describe('backupCurrent', () => {
  it('is a no-op when config.json does not exist', async () => {
    await backupCurrent(homeFn);
    await expect(fs.access(lastPath())).rejects.toThrow();
  });

  it('writes config.json.last and a .bak snapshot when config exists', async () => {
    await fs.writeFile(cfgPath(), JSON.stringify({ provider: 'a' }));
    await backupCurrent(homeFn);
    const last = await readJson(lastPath());
    expect(last).toEqual({ provider: 'a' });
    const baks = (await fs.readdir(profileRoot())).filter(
      (f) => f.startsWith('config.json.') && f.endsWith('.bak'),
    );
    expect(baks.length).toBeGreaterThanOrEqual(1);
  });

  it('prunes older .bak files keeping only 10 newest', async () => {
    await fs.writeFile(cfgPath(), JSON.stringify({ v: 1 }));
    // Pre-seed 12 valid bak files (all timestamped)
    for (let i = 1; i <= 12; i++) {
      await fs.writeFile(
        path.join(profileRoot(), `config.json.${1700000000000 + i * 1000}.bak`),
        JSON.stringify({ v: i }),
      );
    }
    await backupCurrent(homeFn);
    const remaining = (await fs.readdir(profileRoot())).filter(
      (f) => f.startsWith('config.json.') && f.endsWith('.bak'),
    );
    expect(remaining.length).toBeLessThanOrEqual(10);
  });

  it('safeDelete refuses to delete protected files (smoke: planted bad name stays)', async () => {
    await fs.writeFile(cfgPath(), JSON.stringify({ v: 1 }));
    // Plant an unprotected non-bak file with config.json prefix. Naming
    // breaks the bak suffix invariant, so the cleanup must skip it.
    const fake = path.join(profileRoot(), 'config.json.evil');
    await fs.writeFile(fake, 'not a bak');
    await backupCurrent(homeFn);
    // safeDelete sees ".evil" suffix, which fails the "endsWith('.bak')" guard,
    // so the file is never offered for deletion.
    await expect(fs.access(fake)).resolves.toBeUndefined();
  });
});

describe('appendHistory + listHistory + getHistoryEntry', () => {
  it('appends an entry and lists it', async () => {
    const id = await appendHistory(
      { provider: 'a' },
      { provider: 'b' },
      'switched providers',
      homeFn,
    );
    expect(id).toBeTruthy();

    const list = await listHistory(homeFn);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(id);
    expect(list[0]?.description).toBe('switched providers');

    const entry = await getHistoryEntry(id, homeFn);
    expect(entry?.snapshotMasked.provider).toBe('b');
    expect(entry?.diffSummary).toMatch(/provider/);
  });

  it('masks apiKey/apiKeys/secret/secrets in snapshot', async () => {
    const id = await appendHistory(
      {},
      { apiKey: 'sk-real', apiKeys: [{ k: 'v' }], secret: 'shh', secrets: { x: 1 }, provider: 'a' },
      'add keys',
      homeFn,
    );
    const entry = await getHistoryEntry(id, homeFn);
    expect(entry?.snapshotMasked.apiKey).toBe('[REDACTED]');
    expect(entry?.snapshotMasked.apiKeys).toBe('[REDACTED]');
    expect(entry?.snapshotMasked.secret).toBe('[REDACTED]');
    expect(entry?.snapshotMasked.secrets).toBe('[REDACTED]');
    expect(entry?.snapshotMasked.provider).toBe('a');
  });

  it('masks authToken, password, bearer, refreshToken via isSecretField', async () => {
    const id = await appendHistory(
      {},
      { authToken: 'tok123', password: 'p4ss', bearer: 'b123', refreshToken: 'r123', port: 8080 },
      'add auth fields',
      homeFn,
    );
    const entry = await getHistoryEntry(id, homeFn);
    expect(entry?.snapshotMasked.authToken).toBe('[REDACTED]');
    expect(entry?.snapshotMasked.password).toBe('[REDACTED]');
    expect(entry?.snapshotMasked.bearer).toBe('[REDACTED]');
    expect(entry?.snapshotMasked.refreshToken).toBe('[REDACTED]');
    expect(entry?.snapshotMasked.port).toBe(8080);
  });

  it('recursively masks nested secrets inside nested objects', async () => {
    const id = await appendHistory(
      {},
      { providers: { anthropic: { apiKey: 'sk', baseUrl: 'http://x' } } },
      'nested',
      homeFn,
    );
    const entry = await getHistoryEntry(id, homeFn);
    const nested = (entry?.snapshotMasked.providers as Record<string, Record<string, unknown>>)
      ?.anthropic;
    expect(nested?.apiKey).toBe('[REDACTED]');
    expect(nested?.baseUrl).toBe('http://x');
  });

  it('diffSummary marks apiKey/secret changes as [CHANGED] without exposing values', async () => {
    const id = await appendHistory(
      { apiKey: 'old' },
      { apiKey: 'new', secret: 'fresh' },
      'rotate',
      homeFn,
    );
    const entry = await getHistoryEntry(id, homeFn);
    expect(entry?.diffSummary).toContain('apiKey: [CHANGED]');
    expect(entry?.diffSummary).not.toContain('old');
    expect(entry?.diffSummary).not.toContain('new');
  });

  it('diffSummary reports plain scalar deltas inline', async () => {
    const id = await appendHistory({ model: 'a' }, { model: 'b' }, 'm', homeFn);
    const entry = await getHistoryEntry(id, homeFn);
    expect(entry?.diffSummary).toMatch(/model: a → b/);
  });

  it('diffSummary reports "no changes" when configs match', async () => {
    const id = await appendHistory({ a: 1 }, { a: 1 }, 'noop', homeFn);
    const entry = await getHistoryEntry(id, homeFn);
    expect(entry?.diffSummary).toBe('no changes');
  });

  it('diffSummary truncates to 5 changes', async () => {
    const oldCfg: Record<string, unknown> = {};
    const newCfg: Record<string, unknown> = {};
    for (let i = 0; i < 8; i++) {
      oldCfg[`k${i}`] = 0;
      newCfg[`k${i}`] = 1;
    }
    const id = await appendHistory(oldCfg, newCfg, 'many', homeFn);
    const entry = await getHistoryEntry(id, homeFn);
    const changes = (entry?.diffSummary ?? '').split(', ');
    expect(changes.length).toBeLessThanOrEqual(5);
  });

  it('diffSummary reports nested-object change as [CHANGED]', async () => {
    const id = await appendHistory({ obj: { a: 1 } }, { obj: { a: 2 } }, 'nested-obj', homeFn);
    const entry = await getHistoryEntry(id, homeFn);
    expect(entry?.diffSummary).toContain('obj: [CHANGED]');
  });

  it('getHistoryEntry returns null for unknown id', async () => {
    const entry = await getHistoryEntry('missing', homeFn);
    expect(entry).toBeNull();
  });

  it('caps history entries and removes pruned entry files', async () => {
    for (let i = 0; i < MAX_CONFIG_HISTORY_ENTRIES + 5; i++) {
      await appendHistory({}, { i }, `entry ${i}`, homeFn);
    }

    const list = await listHistory(homeFn);
    expect(list).toHaveLength(MAX_CONFIG_HISTORY_ENTRIES);
    expect(list[0]?.description).toBe(`entry ${MAX_CONFIG_HISTORY_ENTRIES + 4}`);
    expect(list.at(-1)?.description).toBe('entry 5');

    const entryDir = path.join(profileRoot(), 'config.history', 'entries');
    const files = (await fs.readdir(entryDir)).filter((fileName) => fileName.endsWith('.json'));
    expect(files).toHaveLength(MAX_CONFIG_HISTORY_ENTRIES);
    expect(files.some((fileName) => fileName.includes('entry'))).toBe(false);
  });

  it('removes orphaned history entry files while appending', async () => {
    const entryDir = path.join(profileRoot(), 'config.history', 'entries');
    await fs.mkdir(entryDir, { recursive: true });
    await fs.writeFile(path.join(entryDir, 'orphan.json'), '{}');

    await appendHistory({}, { provider: 'b' }, 'new entry', homeFn);

    await expect(fs.access(path.join(entryDir, 'orphan.json'))).rejects.toThrow();
  });

  it('listHistory returns empty when index missing', async () => {
    const list = await listHistory(homeFn);
    expect(list).toEqual([]);
  });
});

describe('restoreFromHistory', () => {
  it('returns ok:false when entry id is unknown', async () => {
    const res = await restoreFromHistory('nope', homeFn);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not found');
  });

  it('writes the snapshot back to config.json and appends a Restored entry', async () => {
    await fs.writeFile(cfgPath(), JSON.stringify({ model: 'old' }));
    const id = await appendHistory({}, { model: 'new' }, 'before', homeFn);
    const res = await restoreFromHistory(id, homeFn);
    expect(res.ok).toBe(true);
    expect(res.backupId).toBeTruthy();
    const restored = await readJson(cfgPath());
    expect(restored).toEqual({ model: 'new' });
    const list = await listHistory(homeFn);
    expect(list[0]?.description).toMatch(/Restored from history/);
  });

  it('still restores when no prior config.json exists', async () => {
    const id = await appendHistory({}, { x: 1 }, 'init', homeFn);
    const res = await restoreFromHistory(id, homeFn);
    expect(res.ok).toBe(true);
    expect(await readJson(cfgPath())).toEqual({ x: 1 });
  });
});

describe('restoreLast', () => {
  it('returns ok:false when no .last exists', async () => {
    const res = await restoreLast(homeFn);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('No prior backup');
  });

  it('restores from .last when present and appends history', async () => {
    await fs.writeFile(cfgPath(), JSON.stringify({ model: 'current' }));
    await fs.writeFile(lastPath(), JSON.stringify({ model: 'previous' }));
    const res = await restoreLast(homeFn);
    expect(res.ok).toBe(true);
    expect(await readJson(cfgPath())).toEqual({ model: 'previous' });
    const list = await listHistory(homeFn);
    expect(list[0]?.description).toBe('Restored from config.json.last');
  });

  it('survives unreadable current config (treats as empty oldCfg)', async () => {
    await fs.writeFile(lastPath(), JSON.stringify({ model: 'previous' }));
    // No cfgPath() file present at all — read will throw and be ignored.
    const res = await restoreLast(homeFn);
    expect(res.ok).toBe(true);
    expect(await readJson(cfgPath())).toEqual({ model: 'previous' });
  });
});

describe('restoreFromHistory — credentials must survive', () => {
  // History deliberately never stores secrets, so `snapshotMasked` holds the
  // literal "[REDACTED]" wherever a credential was. Writing that snapshot back
  // verbatim replaced every live API key with that string; the next boot read
  // it as a plaintext key and every request 401'd, recoverable only from a
  // .bak the user is never told about.
  it('keeps the live API key instead of writing [REDACTED] over it', async () => {
    const live = {
      provider: 'anthropic',
      model: 'claude-opus-5',
      apiKey: 'sk-ant-REAL-KEY',
      providers: {
        anthropic: {
          apiKey: 'sk-ant-REAL-KEY',
          apiKeys: [{ id: 'default', apiKey: 'sk-ant-REAL-ARRAY-KEY', isActive: true }],
        },
      },
    };
    await fs.writeFile(cfgPath(), JSON.stringify(live, null, 2));

    // A history entry taken when the model was different.
    const id = await appendHistory(
      {},
      { ...live, model: 'claude-sonnet-5' },
      'switched model',
      homeFn,
    );

    const res = await restoreFromHistory(id, homeFn);
    expect(res.ok).toBe(true);

    const after = await readJson(cfgPath());
    expect(after['model']).toBe('claude-sonnet-5'); // the point of the restore
    expect(after['apiKey']).toBe('sk-ant-REAL-KEY'); // …without losing this
    const providers = after['providers'] as Record<string, Record<string, unknown>>;
    expect(providers['anthropic']?.['apiKey']).toBe('sk-ant-REAL-KEY');
    expect(JSON.stringify(after)).not.toContain('[REDACTED]');
  });

  it('never writes a secret into the history entry itself', async () => {
    // `maskConfigSecrets` did not recurse into arrays, so the per-key entries
    // under `providers.<id>.apiKeys[]` went to disk in cleartext.
    const id = await appendHistory(
      {},
      {
        providers: {
          anthropic: { apiKeys: [{ id: 'default', apiKey: 'sk-ant-LEAKED', isActive: true }] },
        },
      },
      'added key',
      homeFn,
    );
    const entry = await getHistoryEntry(id, homeFn);
    expect(JSON.stringify(entry)).not.toContain('sk-ant-LEAKED');
  });
});
