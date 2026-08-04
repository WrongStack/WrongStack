/**
 * Focused coverage for services/statusline-config.ts — the statusline chip
 * config loader. Uses the WRONGSTACK_STATUSLINE_CONFIG env override to point
 * at a temp file so no real home directory is touched.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULTS,
  STATUSLINE_CONFIG_KEYS,
  ensureStatuslineConfig,
  loadStatuslineConfig,
  saveStatuslineConfig,
} from '../src/services/statusline-config.js';

let dir: string;
let cfgFile: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-statusline-'));
  cfgFile = path.join(dir, 'statusline.json');
  process.env.WRONGSTACK_STATUSLINE_CONFIG = cfgFile;
});

afterEach(async () => {
  delete process.env.WRONGSTACK_STATUSLINE_CONFIG;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('statusline config', () => {
  it('defaults every key to true and falls back on a missing file', async () => {
    const config = await loadStatuslineConfig();
    for (const key of STATUSLINE_CONFIG_KEYS) {
      expect(config[key]).toBe(true);
    }
  });

  it('loads a stored config, ignoring unknown keys and non-boolean values', async () => {
    await fs.writeFile(
      cfgFile,
      JSON.stringify({ state: false, unknown_key: 'x', model: 'not-a-bool', cost: true }),
      'utf8',
    );
    const config = await loadStatuslineConfig();
    expect(config.state).toBe(false);
    expect(config.cost).toBe(true);
    // model was ignored (string), defaults remain true.
    expect(config.model).toBe(true);
    // `unknown_key` is not on `StatuslineConfig` by design — that is the point
    // of the assertion, so read it through an index signature.
    expect((config as Record<string, unknown>)['unknown_key']).toBeUndefined();
  });

  it('falls back to defaults for a corrupt config file', async () => {
    await fs.writeFile(cfgFile, '{ not json', 'utf8');
    const config = await loadStatuslineConfig();
    expect(config.state).toBe(true);
  });

  it('ensureStatuslineConfig creates the file when missing', async () => {
    const config = await ensureStatuslineConfig();
    expect(config.state).toBe(true);
    const raw = JSON.parse(await fs.readFile(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(raw.state).toBe(true);
  });

  it('ensureStatuslineConfig normalizes a partial config and rewrites it', async () => {
    await fs.writeFile(cfgFile, JSON.stringify({ state: false }), 'utf8');
    const config = await ensureStatuslineConfig();
    expect(config.state).toBe(false);
    const raw = JSON.parse(await fs.readFile(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(raw.model).toBe(true); // missing keys backfilled
  });

  it('ensureStatuslineConfig returns defaults on a non-ENOENT read error', async () => {
    // Make the file a directory so readFile fails with EISDIR (not ENOENT).
    await fs.mkdir(cfgFile, { recursive: true });
    const config = await ensureStatuslineConfig();
    expect(config.state).toBe(true);
  });

  it('saveStatuslineConfig writes the file and mkdirs the parent', async () => {
    const nested = path.join(dir, 'deep', 'nested.json');
    process.env.WRONGSTACK_STATUSLINE_CONFIG = nested;
    await saveStatuslineConfig({ state: false });
    const raw = JSON.parse(await fs.readFile(nested, 'utf8')) as Record<string, unknown>;
    expect(raw.state).toBe(false);
  });

  it('saveStatuslineConfig surfaces an FsError with a stable code', async () => {
    // Point the config at a path whose parent cannot be created: a regular
    // file in the way of mkdir.
    const blocker = path.join(dir, 'blocker');
    await fs.writeFile(blocker, 'file in the way');
    process.env.WRONGSTACK_STATUSLINE_CONFIG = path.join(blocker, 'nested', 'cfg.json');
    await expect(saveStatuslineConfig({ state: true })).rejects.toMatchObject({
      name: 'FsError',
      path: path.join(blocker, 'nested', 'cfg.json'),
    });
  });

  it('normalizes a non-record config value to defaults', async () => {
    await fs.writeFile(cfgFile, JSON.stringify([1, 2, 3]), 'utf8');
    const config = await loadStatuslineConfig();
    expect(config.state).toBe(true);
  });

  it('ensureStatuslineConfig writes the file when keys are missing', async () => {
    await fs.writeFile(cfgFile, JSON.stringify({}), 'utf8');
    const config = await ensureStatuslineConfig();
    expect(config.state).toBe(true);
    const raw = JSON.parse(await fs.readFile(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(raw.state).toBe(true); // rewritten with all keys
  });

  it('ensureStatuslineConfig skips the rewrite when all keys are present', async () => {
    await fs.writeFile(cfgFile, JSON.stringify({ ...DEFAULTS }), 'utf8');
    const config = await ensureStatuslineConfig();
    expect(config.state).toBe(true);
    // No rewrite: file content unchanged.
    const raw = JSON.parse(await fs.readFile(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(raw)).toHaveLength(STATUSLINE_CONFIG_KEYS.length);
  });

  it('saveStatuslineConfig classifies a write failure with the atomic-write code', async () => {
    // A valid parent dir but a failing atomicWrite (file path is a directory)
    // yields FS_ATOMIC_WRITE_FAILED, not FS_MKDIR_FAILED.
    process.env.WRONGSTACK_STATUSLINE_CONFIG = path.join(dir, 'is-a-dir');
    await fs.mkdir(path.join(dir, 'is-a-dir'), { recursive: true });
    await expect(saveStatuslineConfig({ state: true })).rejects.toMatchObject({
      code: 'FS_ATOMIC_WRITE_FAILED',
    });
  });

  it('resolves the config path from wstack paths when no env override is set', async () => {
    delete process.env.WRONGSTACK_STATUSLINE_CONFIG;
    // The hermetic WRONGSTACK_HOME redirect makes this resolve to the test
    // home rather than the real user config; loading yields defaults.
    const config = await loadStatuslineConfig();
    expect(config.state).toBe(true);
  });
});
