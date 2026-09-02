/**
 * Focused coverage for services/statusline-config.ts — the statusline config
 * loader (schema v2: `{version: 2, chips, lines}`). Uses the
 * WRONGSTACK_STATUSLINE_CONFIG env override to point at a temp file so no
 * real home directory is touched.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULTS,
  ensureStatuslineConfig,
  loadStatuslineConfig,
  loadStatuslineLines,
  saveStatuslineConfig,
  saveStatuslineLines,
  STATUSLINE_CONFIG_KEYS,
  STATUSLINE_CONFIG_VERSION,
  type StatuslineDocument,
} from '../src/services/statusline-config.js';

let dir: string;
let cfgFile: string;

function doc(
  chips: StatuslineDocument['chips'],
  lines: StatuslineDocument['lines'] = {},
): StatuslineDocument {
  return { version: STATUSLINE_CONFIG_VERSION, chips, lines };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-statusline-'));
  cfgFile = path.join(dir, 'statusline.json');
  process.env.WRONGSTACK_STATUSLINE_CONFIG = cfgFile;
});

afterEach(async () => {
  delete process.env.WRONGSTACK_STATUSLINE_CONFIG;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('statusline config (schema v2)', () => {
  it('defaults every chip to true and falls back on a missing file', async () => {
    const config = await loadStatuslineConfig();
    expect(config.version).toBe(STATUSLINE_CONFIG_VERSION);
    for (const key of STATUSLINE_CONFIG_KEYS) {
      expect(config.chips[key]).toBe(true);
    }
    expect(config.lines).toEqual({});
  });

  it('loads a v1 flat config, ignoring unknown keys and non-boolean values', async () => {
    await fs.writeFile(
      cfgFile,
      JSON.stringify({ state: false, unknown_key: 'x', model: 'not-a-bool', cost: true }),
      'utf8',
    );
    const config = await loadStatuslineConfig();
    expect(config.chips.state).toBe(false);
    expect(config.chips.cost).toBe(true);
    // model was ignored (string), defaults remain true.
    expect(config.chips.model).toBe(true);
    expect(config.lines).toEqual({});
  });

  it('falls back to defaults for a corrupt config file', async () => {
    await fs.writeFile(cfgFile, '{ not json', 'utf8');
    const config = await loadStatuslineConfig();
    expect(config.chips.state).toBe(true);
  });

  it('ensureStatuslineConfig creates a v2 file when missing', async () => {
    const config = await ensureStatuslineConfig();
    expect(config.chips.state).toBe(true);
    const raw = JSON.parse(await fs.readFile(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(raw['version']).toBe(STATUSLINE_CONFIG_VERSION);
    expect((raw['chips'] as Record<string, unknown>)['state']).toBe(true);
  });

  it('migrates a partial v1 config to the v2 shape on ensure', async () => {
    await fs.writeFile(cfgFile, JSON.stringify({ state: false }), 'utf8');
    const config = await ensureStatuslineConfig();
    expect(config.chips.state).toBe(false);
    const raw = JSON.parse(await fs.readFile(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(raw['version']).toBe(STATUSLINE_CONFIG_VERSION);
    expect((raw['chips'] as Record<string, unknown>)['model']).toBe(true); // backfilled
  });

  it('migrates a COMPLETE v1 config to the v2 shape on ensure', async () => {
    // Even a fully-populated v1 file is rewritten so exactly one on-disk
    // shape survives; chip toggles must survive the migration byte-for-byte.
    await fs.writeFile(cfgFile, JSON.stringify({ ...DEFAULTS, state: false }), 'utf8');
    const config = await ensureStatuslineConfig();
    expect(config.chips.state).toBe(false);
    const raw = JSON.parse(await fs.readFile(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(raw['version']).toBe(STATUSLINE_CONFIG_VERSION);
    const chips = raw['chips'] as Record<string, unknown>;
    for (const key of STATUSLINE_CONFIG_KEYS) {
      expect(chips[key]).toBe(key !== 'state');
    }
  });

  it('skips the rewrite for a canonical v2 document', async () => {
    await saveStatuslineConfig(doc({ ...DEFAULTS, state: false }, { fleet: 2 }));
    const before = await fs.readFile(cfgFile, 'utf8');
    const config = await ensureStatuslineConfig();
    expect(config.chips.state).toBe(false);
    expect(await fs.readFile(cfgFile, 'utf8')).toBe(before); // unchanged
  });

  it('rewrites a v2-shaped file whose version is missing or wrong', async () => {
    const chips = Object.fromEntries(STATUSLINE_CONFIG_KEYS.map((k) => [k, true]));
    await fs.writeFile(cfgFile, JSON.stringify({ version: 1, chips, lines: {} }), 'utf8');
    const config = await ensureStatuslineConfig();
    expect(config.version).toBe(STATUSLINE_CONFIG_VERSION);
    expect(config.chips.state).toBe(true);
    const raw = JSON.parse(await fs.readFile(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(raw['version']).toBe(STATUSLINE_CONFIG_VERSION);
  });

  it('preserves the lines map of a v2-shaped file that lost its chips record', async () => {
    await fs.writeFile(
      cfgFile,
      JSON.stringify({ version: STATUSLINE_CONFIG_VERSION, lines: { fleet: 2 } }),
      'utf8',
    );
    const config = await loadStatuslineConfig();
    expect(config.lines).toEqual({ fleet: 2 });
    // Chips were absent, so defaults are served — but ensure must not clobber
    // the stored lines when it rewrites the file into canonical shape.
    const after = await ensureStatuslineConfig();
    expect(after.lines).toEqual({ fleet: 2 });
    expect(after.chips.state).toBe(true);
    const raw = JSON.parse(await fs.readFile(cfgFile, 'utf8')) as Record<string, unknown>;
    expect((raw['lines'] as Record<string, unknown>)['fleet']).toBe(2);
  });

  it('normalizes lines on load: unknown keys dropped, out-of-range clamped, non-integers dropped', async () => {
    await saveStatuslineConfig(
      doc({ ...DEFAULTS }, {
        fleet: 9, // clamped to 4
        elapsed: 0, // clamped to 1
        todos: 2.5, // dropped (non-integer)
        plan: '3', // dropped (non-numeric)
        not_a_chip: 2, // dropped (unknown key)
        hint: 3, // kept
      } as never),
    );
    const config = await loadStatuslineConfig();
    expect(config.lines).toEqual({ fleet: 4, elapsed: 1, hint: 3 });
  });

  it('round-trips lines through loadStatuslineLines/saveStatuslineLines, preserving chips', async () => {
    await saveStatuslineConfig(doc({ ...DEFAULTS, theme: false }, {}));
    await saveStatuslineLines({ fleet: 2, hint: 1 });
    expect(await loadStatuslineLines()).toEqual({ fleet: 2, hint: 1 });
    const config = await loadStatuslineConfig();
    expect(config.chips.theme).toBe(false); // chips preserved across a lines-only write
    expect(config.lines).toEqual({ fleet: 2, hint: 1 });
  });

  it('saveStatuslineLines normalizes its input (clamp + drop) before writing', async () => {
    await saveStatuslineConfig(doc({ ...DEFAULTS }, {}));
    await saveStatuslineLines({ todos: 7, breaker: -3 } as never);
    expect(await loadStatuslineLines()).toEqual({ todos: 4, breaker: 1 });
  });

  it('ensureStatuslineConfig returns defaults on a non-ENOENT read error', async () => {
    // Make the file a directory so readFile fails with EISDIR (not ENOENT).
    await fs.mkdir(cfgFile, { recursive: true });
    const config = await ensureStatuslineConfig();
    expect(config.chips.state).toBe(true);
  });

  it('quarantines a corrupt file on ensure instead of destroying it', async () => {
    const corruptBytes = '{ not json';
    await fs.writeFile(cfgFile, corruptBytes, 'utf8');
    const config = await ensureStatuslineConfig();
    expect(config.chips.state).toBe(true); // fresh defaults served
    // The corrupt bytes survive next to the fresh file.
    const entries = await fs.readdir(dir);
    const quarantined = entries.find((name) => name.startsWith('statusline.json.corrupt-'));
    expect(quarantined).toBeDefined();
    expect(await fs.readFile(path.join(dir, quarantined!), 'utf8')).toBe(corruptBytes);
    // And the live file is a fresh v2 document.
    const raw = JSON.parse(await fs.readFile(cfgFile, 'utf8')) as Record<string, unknown>;
    expect(raw['version']).toBe(STATUSLINE_CONFIG_VERSION);
  });

  it('saveStatuslineConfig writes the document and mkdirs the parent', async () => {
    const nested = path.join(dir, 'deep', 'nested.json');
    process.env.WRONGSTACK_STATUSLINE_CONFIG = nested;
    await saveStatuslineConfig(doc({ state: false }, { fleet: 1 }));
    const raw = JSON.parse(await fs.readFile(nested, 'utf8')) as Record<string, unknown>;
    expect(raw['version']).toBe(STATUSLINE_CONFIG_VERSION);
    expect((raw['chips'] as Record<string, unknown>)['state']).toBe(false);
    expect(raw['lines']).toEqual({ fleet: 1 });
  });

  it('saveStatuslineConfig surfaces an FsError with a stable code', async () => {
    // Point the config at a path whose parent cannot be created: a regular
    // file in the way of mkdir.
    const blocker = path.join(dir, 'blocker');
    await fs.writeFile(blocker, 'file in the way');
    process.env.WRONGSTACK_STATUSLINE_CONFIG = path.join(blocker, 'nested', 'cfg.json');
    await expect(saveStatuslineConfig(doc({ state: true }))).rejects.toMatchObject({
      name: 'FsError',
      path: path.join(blocker, 'nested', 'cfg.json'),
    });
  });

  it('normalizes a non-record config value to defaults', async () => {
    await fs.writeFile(cfgFile, JSON.stringify([1, 2, 3]), 'utf8');
    const config = await loadStatuslineConfig();
    expect(config.chips.state).toBe(true);
  });

  it('ensureStatuslineConfig writes the file when chips are missing', async () => {
    await fs.writeFile(cfgFile, JSON.stringify({}), 'utf8');
    const config = await ensureStatuslineConfig();
    expect(config.chips.state).toBe(true);
    const raw = JSON.parse(await fs.readFile(cfgFile, 'utf8')) as Record<string, unknown>;
    expect((raw['chips'] as Record<string, unknown>)['state']).toBe(true); // rewritten with all keys
  });

  it('saveStatuslineConfig classifies a write failure with the atomic-write code', async () => {
    // A valid parent dir but a failing atomicWrite (file path is a directory)
    // yields FS_ATOMIC_WRITE_FAILED, not FS_MKDIR_FAILED.
    process.env.WRONGSTACK_STATUSLINE_CONFIG = path.join(dir, 'is-a-dir');
    await fs.mkdir(path.join(dir, 'is-a-dir'), { recursive: true });
    await expect(saveStatuslineConfig(doc({ state: true }))).rejects.toMatchObject({
      code: 'FS_ATOMIC_WRITE_FAILED',
    });
  });

  it('resolves the config path from wstack paths when no env override is set', async () => {
    delete process.env.WRONGSTACK_STATUSLINE_CONFIG;
    // The hermetic WRONGSTACK_HOME redirect makes this resolve to the test
    // home rather than the real user config; loading yields defaults.
    const config = await loadStatuslineConfig();
    expect(config.chips.state).toBe(true);
  });
});
