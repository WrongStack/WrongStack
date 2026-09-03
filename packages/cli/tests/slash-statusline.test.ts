import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HIDDEN_ITEMS } from '@wrongstack/core/statusline';
import {
  buildStatuslineCommand,
  DEFAULTS,
  ensureStatuslineConfig,
  loadStatuslineConfig,
  STATUSLINE_CONFIG_KEYS,
  STATUSLINE_CONFIG_VERSION,
  type StatuslineCommandDeps,
  type StatuslineConfig,
  type StatuslineDocument,
  saveStatuslineConfig,
} from '../src/slash-commands/statusline.js';

let tmp: string;
let prevHome: string | undefined;
let prevEnv: string | undefined;
let prevWrongstackHome: string | undefined;

function profileDir(): string {
  return path.join(tmp, '.wrongstack', 'profiles', 'default');
}

/** Build a v2 document from a partial chips map (the pre-v2 fixture shape). */
function doc(chips: StatuslineConfig, lines: StatuslineDocument['lines'] = {}): StatuslineDocument {
  return { version: STATUSLINE_CONFIG_VERSION, chips, lines, densities: {} };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sl-test-'));
  prevHome = process.env.HOME;
  prevEnv = process.env.WRONGSTACK_STATUSLINE_CONFIG;
  prevWrongstackHome = process.env.WRONGSTACK_HOME;
  process.env.HOME = tmp;
  delete process.env.WRONGSTACK_HOME;
  delete process.env.WRONGSTACK_STATUSLINE_CONFIG;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevEnv === undefined) delete process.env.WRONGSTACK_STATUSLINE_CONFIG;
  else process.env.WRONGSTACK_STATUSLINE_CONFIG = prevEnv;
  if (prevWrongstackHome === undefined) delete process.env.WRONGSTACK_HOME;
  else process.env.WRONGSTACK_HOME = prevWrongstackHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('loadStatuslineConfig', () => {
  it('keeps DEFAULTS in sync with the canonical key list', () => {
    expect(Object.keys(DEFAULTS).sort()).toEqual([...STATUSLINE_CONFIG_KEYS].sort());
  });

  it('returns DEFAULTS when no file present', async () => {
    const cfg = await loadStatuslineConfig();
    expect(cfg.chips.todos).toBe(true);
    expect(cfg.chips.cost).toBe(true);
    // Static identity trivia starts off (DEFAULT_HIDDEN_ITEMS): each costs
    // 10-30 permanent columns and is recoverable from a slash command.
    expect(cfg.chips.working_dir).toBe(false);
    expect(cfg.chips.theme).toBe(false);
    expect(cfg.lines).toEqual({});
    expect(cfg.densities).toEqual({});
  });

  it('returns DEFAULTS merged with user overrides', async () => {
    const dir = profileDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'statusline.json'),
      JSON.stringify({ git: false, cost: false }),
    );
    const cfg = await loadStatuslineConfig();
    expect(cfg.chips.git).toBe(false);
    expect(cfg.chips.cost).toBe(false);
    expect(cfg.chips.todos).toBe(true); // not overridden
  });

  it('returns DEFAULTS on malformed JSON', async () => {
    const dir = profileDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'statusline.json'), '{not json');
    const cfg = await loadStatuslineConfig();
    expect(cfg.chips).toMatchObject({ todos: true, plan: true });
  });

  it('honors WRONGSTACK_STATUSLINE_CONFIG env path', async () => {
    const custom = path.join(tmp, 'override.json');
    process.env.WRONGSTACK_STATUSLINE_CONFIG = custom;
    await fs.writeFile(custom, JSON.stringify({ fleet: false }));
    const cfg = await loadStatuslineConfig();
    expect(cfg.chips.fleet).toBe(false);
  });

  it('honors WRONGSTACK_HOME over HOME for config resolution', async () => {
    const wstackHome = await fs.mkdtemp(path.join(os.tmpdir(), 'sl-wshome-'));
    const prevWsHome = process.env.WRONGSTACK_HOME;
    try {
      process.env.WRONGSTACK_HOME = wstackHome;
      // Write config under the WRONGSTACK_HOME profile dir, NOT under HOME/tmp
      const dir = path.join(wstackHome, 'profiles', 'default');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'statusline.json'),
        JSON.stringify({ fleet: false, cost: false }),
      );
      const cfg = await loadStatuslineConfig();
      // If WRONGSTACK_HOME were ignored, we'd get DEFAULTS (all true) from the
      // empty HOME-based path. The overrides prove the env var took precedence.
      expect(cfg.chips.fleet).toBe(false);
      expect(cfg.chips.cost).toBe(false);
    } finally {
      if (prevWsHome === undefined) delete process.env.WRONGSTACK_HOME;
      else process.env.WRONGSTACK_HOME = prevWsHome;
      await fs.rm(wstackHome, { recursive: true, force: true });
    }
  });
});

describe('ensureStatuslineConfig', () => {
  it('writes a v2 document with all default chips when no file is present', async () => {
    const cfg = await ensureStatuslineConfig();
    const written = JSON.parse(
      await fs.readFile(path.join(profileDir(), 'statusline.json'), 'utf8'),
    );

    expect(cfg.chips).toEqual(DEFAULTS);
    expect(cfg.lines).toEqual({});
    expect(written['version']).toBe(STATUSLINE_CONFIG_VERSION);
    expect(written['chips']).toEqual(DEFAULTS);
    expect(written['lines']).toEqual({});
  });

  it('persists missing default keys for old partial config files', async () => {
    const dir = profileDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'statusline.json'), JSON.stringify({ git: false }));

    const cfg = await ensureStatuslineConfig();
    const written = JSON.parse(await fs.readFile(path.join(dir, 'statusline.json'), 'utf8'));

    expect(cfg.chips.git).toBe(false);
    expect(cfg.chips.mailbox).toBe(true);
    const chips = written['chips'] as Record<string, unknown>;
    expect(chips['git']).toBe(false);
    expect(chips['mailbox']).toBe(true);
    expect(Object.keys(chips).sort()).toEqual([...STATUSLINE_CONFIG_KEYS].sort());
  });
});

describe('saveStatuslineConfig', () => {
  it('writes the config atomically to the resolved path', async () => {
    await saveStatuslineConfig(doc({ todos: false, plan: true }));
    const written = JSON.parse(
      await fs.readFile(path.join(profileDir(), 'statusline.json'), 'utf8'),
    );
    expect(written['version']).toBe(STATUSLINE_CONFIG_VERSION);
    // save normalizes chips to the canonical full map (defaults filled, junk dropped).
    expect(written['chips']).toEqual({ ...DEFAULTS, todos: false, plan: true });
  });

  it('creates parent directory if missing', async () => {
    const dir = profileDir();
    // Directory does not exist yet — save must mkdir -p.
    await saveStatuslineConfig(doc({ cost: false }));
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });
});

// ── /statusline command ──────────────────────────────────────────────────────

function makeDeps(
  initial: StatuslineConfig = {
    todos: true,
    plan: true,
    fleet: true,
    git: true,
    elapsed: true,
    context: true,
    cost: true,
    working_dir: true,
  },
): StatuslineCommandDeps & { _cfg: StatuslineDocument } {
  const state = {
    cfg: { version: STATUSLINE_CONFIG_VERSION, chips: { ...initial }, lines: {} },
  };
  return {
    cwd: tmp,
    hiddenItems: [],
    setHiddenItems: vi.fn(function (this: { hiddenItems: typeof state }, _items) {
      // mutated externally; track separately
    }) as never,
    getConfig: vi.fn(async () => state.cfg),
    setConfig: vi.fn(async (cfg) => {
      state.cfg = cfg;
    }),
    _cfg: state.cfg,
  } as never;
}

describe('buildStatuslineCommand', () => {
  it('shows current config with on/off bullets when called bare', async () => {
    const deps = makeDeps({
      todos: true,
      plan: false,
      fleet: true,
      git: true,
      elapsed: true,
      context: true,
      cost: true,
    });
    const cmd = buildStatuslineCommand(deps);
    const res = await cmd.run('');
    expect(res?.message ?? '').toContain('● todos');
    expect(res?.message ?? '').toContain('○ plan');
  });

  it('reset writes DEFAULTS and re-applies the default hidden set', async () => {
    const setHidden = vi.fn();
    const deps = { ...makeDeps(), setHiddenItems: setHidden } as never as StatuslineCommandDeps;
    const cmd = buildStatuslineCommand(deps);
    const res = await cmd.run('reset');
    expect(res?.message ?? '').toContain('reset to defaults');
    // Reset restores the shipped defaults, which hide the static identity
    // trivia rather than turning every chip on.
    expect(setHidden).toHaveBeenCalledWith(DEFAULT_HIDDEN_ITEMS);
  });

  it('moves a chip to another line and reports the rail name', async () => {
    const setConfig = vi.fn();
    const deps = { ...makeDeps(), setConfig } as never as StatuslineCommandDeps;
    const cmd = buildStatuslineCommand(deps);
    const res = await cmd.run('cost line 3');
    expect(res?.message ?? '').toContain('line 3');
    expect(res?.message ?? '').toContain('SAFETY & WORK');
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ lines: { cost: 3 } }));
  });

  it('rejects an out-of-range line', async () => {
    const setConfig = vi.fn();
    const deps = { ...makeDeps(), setConfig } as never as StatuslineCommandDeps;
    const res = await buildStatuslineCommand(deps).run('cost line 9');
    expect(res?.message ?? '').toContain('Usage:');
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('pins a density, and `auto` clears the pin rather than storing it', async () => {
    const setConfig = vi.fn();
    const deps = { ...makeDeps(), setConfig } as never as StatuslineCommandDeps;
    const cmd = buildStatuslineCommand(deps);
    await cmd.run('cache density micro');
    expect(setConfig).toHaveBeenCalledWith(
      expect.objectContaining({ densities: { cache: 'micro' } }),
    );
    setConfig.mockClear();
    await cmd.run('cache density auto');
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ densities: {} }));
  });

  it('rejects an unknown density level', async () => {
    const setConfig = vi.fn();
    const deps = { ...makeDeps(), setConfig } as never as StatuslineCommandDeps;
    const res = await buildStatuslineCommand(deps).run('cache density huge');
    expect(res?.message ?? '').toContain('auto|full|short|micro');
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('layout reset clears lines and densities but leaves visibility alone', async () => {
    const setConfig = vi.fn();
    const deps = { ...makeDeps(), setConfig } as never as StatuslineCommandDeps;
    const cmd = buildStatuslineCommand(deps);
    await cmd.run('layout reset');
    const written = setConfig.mock.calls[0]?.[0] as { lines: unknown; densities: unknown };
    expect(written.lines).toEqual({});
    expect(written.densities).toEqual({});
    expect(setConfig.mock.calls[0]?.[0]).toHaveProperty('chips');
  });

  it('preview groups the enabled chips under their four rails', async () => {
    const res = await buildStatuslineCommand(makeDeps()).run('preview');
    const message = res?.message ?? '';
    for (const title of ['IDENTITY', 'VITALS', 'SAFETY & WORK', 'ASYNC']) {
      expect(message).toContain(title);
    }
    expect(message).toContain('model');
  });

  it('unknown item reports available choices', async () => {
    const cmd = buildStatuslineCommand(makeDeps());
    const res = await cmd.run('foo on');
    expect(res?.message ?? '').toContain('Unknown item "foo"');
    expect(res?.message ?? '').toContain('Run /statusline to see available items');
  });

  it('valid item but missing on|off toggles the item', async () => {
    const setHidden = vi.fn();
    const deps = {
      ...makeDeps(),
      hiddenItems: [],
      setHiddenItems: setHidden,
    } as never as StatuslineCommandDeps;
    const cmd = buildStatuslineCommand(deps);
    // git is visible by default (not in hiddenItems), so toggling should hide it
    const res = await cmd.run('git');
    expect(res?.message ?? '').toBe('statusline git: off');
    expect(setHidden).toHaveBeenCalledWith(['git']);
  });

  it('valid item with invalid action returns usage', async () => {
    const cmd = buildStatuslineCommand(makeDeps());
    const res = await cmd.run('git maybe');
    expect(res?.message ?? '').toContain('Usage: /statusline git on|off');
  });

  it('item off persists and appends to hidden items', async () => {
    const setHidden = vi.fn();
    const deps = {
      ...makeDeps(),
      hiddenItems: ['cost'],
      setHiddenItems: setHidden,
    } as never as StatuslineCommandDeps;
    const cmd = buildStatuslineCommand(deps);
    const res = await cmd.run('git off');
    expect(res?.message ?? '').toBe('statusline git: off');
    expect(setHidden).toHaveBeenCalledWith(['cost', 'git']);
  });

  it('item on persists and removes from hidden items', async () => {
    const setHidden = vi.fn();
    const deps = {
      ...makeDeps(),
      hiddenItems: ['git', 'cost'],
      setHiddenItems: setHidden,
    } as never as StatuslineCommandDeps;
    const cmd = buildStatuslineCommand(deps);
    await cmd.run('git on');
    expect(setHidden).toHaveBeenCalledWith(['cost']);
  });

  it('case-insensitive ON|Off accepted', async () => {
    const cmd = buildStatuslineCommand(makeDeps());
    const res = await cmd.run('todos OFF');
    expect(res?.message ?? '').toBe('statusline todos: off');
  });

  it('working_dir off persists and appends to hidden items', async () => {
    const setHidden = vi.fn();
    const deps = {
      ...makeDeps(),
      hiddenItems: ['cost'],
      setHiddenItems: setHidden,
    } as never as StatuslineCommandDeps;
    const cmd = buildStatuslineCommand(deps);
    const res = await cmd.run('working_dir off');
    expect(res?.message ?? '').toBe('statusline working_dir: off');
    expect(setHidden).toHaveBeenCalledWith(['cost', 'working_dir']);
  });

  it('working_dir on persists and removes from hidden items', async () => {
    const setHidden = vi.fn();
    const deps = {
      ...makeDeps(),
      hiddenItems: ['working_dir', 'cost'],
      setHiddenItems: setHidden,
    } as never as StatuslineCommandDeps;
    const cmd = buildStatuslineCommand(deps);
    await cmd.run('working_dir on');
    expect(setHidden).toHaveBeenCalledWith(['cost']);
  });

  it('all off sets every item to false and populates hiddenItems', async () => {
    const setHidden = vi.fn();
    const setConfig = vi.fn();
    const deps = {
      ...makeDeps(),
      hiddenItems: [],
      setHiddenItems: setHidden,
      setConfig,
    } as never as StatuslineCommandDeps;
    const cmd = buildStatuslineCommand(deps);
    const res = await cmd.run('all off');
    expect(res?.message ?? '').toBe('statusline all: hiding all chips');
    expect(setConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        chips: expect.objectContaining({
          todos: false,
          plan: false,
          tasks: false,
          fleet: false,
          git: false,
          elapsed: false,
          context: false,
          cost: false,
          working_dir: false,
        }),
      }),
    );
    expect(setHidden).toHaveBeenCalledWith(
      expect.arrayContaining([
        'todos',
        'plan',
        'tasks',
        'fleet',
        'git',
        'elapsed',
        'context',
        'cost',
        'working_dir',
      ]),
    );
  });

  it('all on sets every item to true and clears hiddenItems', async () => {
    const setHidden = vi.fn();
    const setConfig = vi.fn();
    const deps = {
      ...makeDeps(),
      hiddenItems: ['git', 'cost'],
      setHiddenItems: setHidden,
      setConfig,
    } as never as StatuslineCommandDeps;
    const cmd = buildStatuslineCommand(deps);
    const res = await cmd.run('all on');
    expect(res?.message ?? '').toBe('statusline all: showing all chips');
    expect(setConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        chips: expect.objectContaining({
          todos: true,
          plan: true,
          tasks: true,
          fleet: true,
          git: true,
          elapsed: true,
          context: true,
          cost: true,
          working_dir: true,
        }),
      }),
    );
    expect(setHidden).toHaveBeenCalledWith([]);
  });

  it('all without on|off returns usage error', async () => {
    const cmd = buildStatuslineCommand(makeDeps());
    const res = await cmd.run('all');
    expect(res?.message ?? '').toContain('Usage: /statusline all on|off');
  });

  it('all with invalid action returns usage error', async () => {
    const cmd = buildStatuslineCommand(makeDeps());
    const res = await cmd.run('all maybe');
    expect(res?.message ?? '').toContain('Usage: /statusline all on|off');
  });
});
