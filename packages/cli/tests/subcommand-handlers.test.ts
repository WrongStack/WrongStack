import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── auth handler ────────────────────────────────────────────────────────────
const runAuthMenu = vi.fn().mockResolvedValue(0);
const runAuthDirect = vi.fn().mockResolvedValue(0);
vi.mock('../src/auth-menu/index.js', () => ({
  runAuthMenu: (...a: unknown[]) => runAuthMenu(...a),
  runAuthDirect: (...a: unknown[]) => runAuthDirect(...a),
}));

// ── history handler — mock the underlying store calls ──────────────────────
const listHistory = vi.fn();
const getHistoryEntry = vi.fn();
const restoreFromHistory = vi.fn();
const restoreLast = vi.fn();
vi.mock('../src/config-history.js', () => ({
  listHistory: (...a: unknown[]) => listHistory(...a),
  getHistoryEntry: (...a: unknown[]) => getHistoryEntry(...a),
  restoreFromHistory: (...a: unknown[]) => restoreFromHistory(...a),
  restoreLast: (...a: unknown[]) => restoreLast(...a),
}));

import { authCmd } from '../src/subcommands/handlers/auth.js';
import { historyCmd, restoreCmd } from '../src/subcommands/handlers/config-history.js';
import { helpCmd } from '../src/subcommands/handlers/version-help.js';

function fakeDeps() {
  return {
    config: {} as Parameters<typeof authCmd>[1]['config'],
    renderer: { write: vi.fn(), writeError: vi.fn(), writeInfo: vi.fn(), writeWarning: vi.fn() },
    reader: { readLine: vi.fn() },
    modelsRegistry: {},
    vault: {},
    paths: { globalConfig: '/tmp/cfg.json', profileConfig: () => '/tmp/cfg.json' },
    cwd: '/tmp',
    projectRoot: '/tmp',
    userHome: '/tmp',
    flags: {},
  } as never as Parameters<typeof authCmd>[1];
}

beforeEach(() => {
  runAuthMenu.mockClear();
  runAuthDirect.mockClear();
  listHistory.mockReset();
  getHistoryEntry.mockReset();
  restoreFromHistory.mockReset();
  restoreLast.mockReset();
});

describe('helpCmd', () => {
  it('documents YOLO and the destructive compatibility flags', async () => {
    const deps = fakeDeps();
    const code = await helpCmd([], deps);
    expect(code).toBe(0);
    const output = (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0])
      .join('');
    expect(output).toContain('--yolo');
    expect(output).toContain('--no-yolo');
    expect(output).toContain('--confirm-destructive');
    expect(output).toContain('YOLO no longer prompts by destructiveness');
    expect(output).toContain('wstack desktop');
    expect(output).toContain('--desktop');
    expect(output).toContain('wstack webui');
    expect(output).toContain('wstack hq');
    expect(output).toContain('--hq');
    expect(output).toContain('wstack governance status');
  });
});

describe('authCmd', () => {
  it('invokes the menu when no positional args', async () => {
    await authCmd([], fakeDeps());
    expect(runAuthMenu).toHaveBeenCalledTimes(1);
    expect(runAuthDirect).not.toHaveBeenCalled();
  });

  it('invokes the menu when "list" is passed (read-only, no mock needed)', async () => {
    // runAuthList handles ENOENT gracefully and prints "No providers".
    const deps = fakeDeps();
    const code = await authCmd(['list'], deps);
    expect(code).toBe(0);
    expect(runAuthMenu).not.toHaveBeenCalled();
    expect(runAuthDirect).not.toHaveBeenCalled();
    expect(deps.renderer.write).toHaveBeenCalledWith(
      expect.stringContaining('No providers configured'),
    );
  });

  it('invokes the menu when "ls" alias is passed', async () => {
    const deps = fakeDeps();
    const code = await authCmd(['ls'], deps);
    expect(code).toBe(0);
    expect(runAuthMenu).not.toHaveBeenCalled();
    expect(runAuthDirect).not.toHaveBeenCalled();
  });

  it('routes direct flow with positional providerId and flags', async () => {
    await authCmd(
      ['anthropic', '--label', 'work', '--family', 'anthropic', '--base-url', 'https://x'],
      fakeDeps(),
    );
    expect(runAuthDirect).toHaveBeenCalledTimes(1);
    const [, opts] = runAuthDirect.mock.calls[0]!;
    expect(opts.providerId).toBe('anthropic');
    expect(opts.label).toBe('work');
    expect(opts.family).toBe('anthropic');
    expect(opts.baseUrl).toBe('https://x');
  });

  it('status with no provider id prints usage and exits 1', async () => {
    const deps = fakeDeps();
    const code = await authCmd(['status'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('status with unknown provider reports not found', async () => {
    const deps = fakeDeps();
    const code = await authCmd(['status', 'unknown-prov'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it('remove with no provider id prints usage and exits 1', async () => {
    const deps = fakeDeps();
    const code = await authCmd(['remove'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('rm alias works like remove', async () => {
    const deps = fakeDeps();
    const code = await authCmd(['rm'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });
});

describe('historyCmd', () => {
  it('shows missing-entry message when --id not found', async () => {
    getHistoryEntry.mockResolvedValue(null);
    const deps = fakeDeps();
    const code = await historyCmd(['--id', 'abc'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.write).toHaveBeenCalledWith(expect.stringContaining("'abc' not found"));
  });

  it('prints entry details when --id resolves', async () => {
    getHistoryEntry.mockResolvedValue({
      id: 'x1',
      timestamp: 0,
      description: 'changed model',
      diffSummary: '~ provider',
      snapshotMasked: { provider: 'a' },
    });
    const deps = fakeDeps();
    const code = await historyCmd(['--id', 'x1'], deps);
    expect(code).toBe(0);
    const calls = (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join('');
    expect(calls).toContain('ID:       x1');
    expect(calls).toContain('changed model');
  });

  it('prints "no history" when list empty', async () => {
    listHistory.mockResolvedValue([]);
    const deps = fakeDeps();
    const code = await historyCmd([], deps);
    expect(code).toBe(0);
    expect(deps.renderer.write).toHaveBeenCalledWith(expect.stringContaining('No config history'));
  });

  it('prints a numbered list when entries exist (truncates long descriptions)', async () => {
    listHistory.mockResolvedValue([
      { id: 'a', timestamp: 1700000000000, description: 'short', diffSummary: '' },
      { id: 'b', timestamp: 1700000100000, description: 'x'.repeat(100), diffSummary: '' },
    ]);
    const deps = fakeDeps();
    await historyCmd([], deps);
    const all = (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .join('');
    expect(all).toContain('[1] a');
    expect(all).toContain('[2] b');
    // Truncated long line ends with ellipsis
    expect(all).toContain('…');
  });
});

describe('restoreCmd', () => {
  it('--latest happy path returns 0 and writes confirmation', async () => {
    restoreLast.mockResolvedValue({ ok: true });
    const deps = fakeDeps();
    const code = await restoreCmd(['--latest'], deps);
    expect(code).toBe(0);
    expect(deps.renderer.write).toHaveBeenCalledWith(expect.stringContaining('config.json.last'));
  });

  it('--latest failure surfaces error and exits 1', async () => {
    restoreLast.mockResolvedValue({ ok: false, error: 'no backup' });
    const deps = fakeDeps();
    const code = await restoreCmd(['-l'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.write).toHaveBeenCalledWith(expect.stringContaining('no backup'));
  });

  it('missing id prints usage and exits 1', async () => {
    const deps = fakeDeps();
    const code = await restoreCmd([], deps);
    expect(code).toBe(1);
    expect(deps.renderer.write).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('positional id calls restoreFromHistory', async () => {
    restoreFromHistory.mockResolvedValue({ ok: true });
    const deps = fakeDeps();
    const code = await restoreCmd(['abc-123'], deps);
    expect(restoreFromHistory).toHaveBeenCalledWith('abc-123');
    expect(code).toBe(0);
  });

  it('--id flag form works too', async () => {
    restoreFromHistory.mockResolvedValue({ ok: true });
    const deps = fakeDeps();
    const code = await restoreCmd(['--id', 'flag-id'], deps);
    expect(restoreFromHistory).toHaveBeenCalledWith('flag-id');
    expect(code).toBe(0);
  });

  it('--id=value (combined) form works', async () => {
    restoreFromHistory.mockResolvedValue({ ok: true });
    const deps = fakeDeps();
    await restoreCmd(['--id=combined'], deps);
    expect(restoreFromHistory).toHaveBeenCalledWith('combined');
  });

  it('restore failure exits 1 and prints error', async () => {
    restoreFromHistory.mockResolvedValue({ ok: false, error: 'corrupt' });
    const deps = fakeDeps();
    const code = await restoreCmd(['abc'], deps);
    expect(code).toBe(1);
    expect(deps.renderer.write).toHaveBeenCalledWith(expect.stringContaining('corrupt'));
  });
});
