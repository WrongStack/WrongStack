import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── auth handler ────────────────────────────────────────────────────────────
const runAuthMenu = vi.fn().mockResolvedValue(0);
const runAuthDirect = vi.fn().mockResolvedValue(0);
const runAuthLocal = vi.fn().mockResolvedValue(0);
const runOAuthLoginKind = vi.fn().mockResolvedValue(0);
vi.mock('../src/auth-menu/index.js', () => ({
  runAuthMenu: (...a: unknown[]) => runAuthMenu(...a),
  runAuthDirect: (...a: unknown[]) => runAuthDirect(...a),
  runAuthLocal: (...a: unknown[]) => runAuthLocal(...a),
  runOAuthLoginKind: (...a: unknown[]) => runOAuthLoginKind(...a),
  resolveOAuthKind: (id: string) => (id === 'chatgpt' ? id : undefined),
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

import { parseArgs } from '../src/arg-parser.js';
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
  runAuthLocal.mockClear();
  runOAuthLoginKind.mockClear();
  listHistory.mockReset();
  getHistoryEntry.mockReset();
  restoreFromHistory.mockReset();
  restoreLast.mockReset();
});

it.each(['openai', 'login'])(
  'forwards an auth profile alias through real top-level flag parsing for %s',
  async (kind) => {
    const argv =
      kind === 'login'
        ? ['auth', 'login', 'chatgpt', '--alias', 'work-account']
        : ['auth', 'openai', '--alias', 'work-account'];
    const parsed = parseArgs(argv);
    const deps = fakeDeps();
    deps.flags = parsed.flags;
    expect(await authCmd(parsed.positional.slice(1), deps)).toBe(0);
    if (kind === 'login')
      expect(runOAuthLoginKind).toHaveBeenCalledWith(expect.anything(), 'chatgpt', {
        providerId: 'work-account',
      });
    else
      expect(runAuthDirect).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ providerId: 'openai', alias: 'work-account' }),
      );
  },
);

it.each(['claude', 'anthropic', 'claude-max'])(
  'answers the removed Claude sign-in (%s) with the API-key route instead of a login',
  async (name) => {
    const deps = fakeDeps();
    expect(await authCmd(['login', name], deps)).toBe(1);
    expect(runOAuthLoginKind).not.toHaveBeenCalled();
    expect(deps.renderer.writeError).toHaveBeenCalledWith(
      expect.stringContaining('wstack auth anthropic'),
    );
  },
);

it('makes account/profile help available without starting an interactive auth flow', async () => {
  const deps = fakeDeps();
  deps.flags = { help: true };
  expect(await authCmd([], deps)).toBe(0);
  expect(deps.renderer.write).toHaveBeenCalledWith(expect.stringContaining('--alias'));
  expect(runAuthMenu).not.toHaveBeenCalled();
});

it('forwards a local auth profile alias through dispatcher-stripped flags', async () => {
  const parsed = parseArgs([
    'auth',
    'local',
    '--name',
    'ollama',
    '--alias',
    'local-work',
    '--no-probe',
  ]);
  const deps = fakeDeps();
  deps.flags = parsed.flags;
  expect(await authCmd(parsed.positional.slice(1), deps)).toBe(0);
  expect(runAuthLocal).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ name: 'ollama', alias: 'local-work', noProbe: true }),
  );
});

it('rejects a missing alias value instead of silently adding a key to the default account', async () => {
  const deps = fakeDeps();
  expect(await authCmd(['openai', '--alias'], deps)).toBe(1);
  expect(runAuthDirect).not.toHaveBeenCalled();
  expect(runAuthMenu).not.toHaveBeenCalled();
});

describe('helpCmd', () => {
  it('documents YOLO, the lockdown modes and the surfaces', async () => {
    const deps = fakeDeps();
    const code = await helpCmd([], deps);
    expect(code).toBe(0);
    const output = (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0])
      .join('');
    expect(output).toContain('--yolo');
    expect(output).toContain('--no-yolo');
    expect(output).toContain('--restricted');
    expect(output).toContain('--safe-mode');
    expect(output).toContain('wstack import-claude-code');
    // Parsed for old launch scripts, but read nowhere: not advertised.
    expect(output).not.toContain('--confirm-destructive');
    // The removed Electron app's `--desktop` switch stays unadvertised;
    // `wstack desktop` is the Tauri app's open/install/update subcommand.
    expect(output).not.toContain('--desktop');
    expect(output).toContain('wstack desktop');
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

  it('routes the --model value to the allowlist, never the preset name (full chain)', async () => {
    // Regression: `wstack auth local --model <spec>` (no --name) leaked the
    // spec into positional[1], which the local branch reads as the preset
    // name — runAuthLocal then hard-failed with `Unknown local server`.
    const parsed = parseArgs(['auth', 'local', '--model', 'llama3.1:8b']);
    await authCmd(parsed.positional.slice(1), { ...fakeDeps(), flags: parsed.flags });
    expect(runAuthLocal).toHaveBeenCalledTimes(1);
    const [, opts] = runAuthLocal.mock.calls[0]!;
    expect(opts.name).toBeUndefined();
    expect(opts.models).toBe('llama3.1:8b');
  });

  it('routes the -m short form through the same path', async () => {
    const parsed = parseArgs(['auth', 'local', '-m', 'llama3.1:8b']);
    await authCmd(parsed.positional.slice(1), { ...fakeDeps(), flags: parsed.flags });
    expect(runAuthLocal).toHaveBeenCalledTimes(1);
    const [, opts] = runAuthLocal.mock.calls[0]!;
    expect(opts.name).toBeUndefined();
    expect(opts.models).toBe('llama3.1:8b');
  });

  it('documented `--name ollama --model <spec>` example still selects both', async () => {
    const parsed = parseArgs([
      'auth',
      'local',
      '--name',
      'ollama',
      '--no-probe',
      '--model',
      'llama3.1:8b',
    ]);
    await authCmd(parsed.positional.slice(1), { ...fakeDeps(), flags: parsed.flags });
    expect(runAuthLocal).toHaveBeenCalledTimes(1);
    const [, opts] = runAuthLocal.mock.calls[0]!;
    expect(opts.name).toBe('ollama');
    expect(opts.models).toBe('llama3.1:8b');
  });

  it('wires `--audit stdout` to a logger that emits JSONL (documented contract)', async () => {
    // Regression: `--audit [target]` is documented in LOCAL_AUTH_FLAGS but
    // was dropped — it was missing from the restoreFlags name list, absent
    // from AuthFlags, and never resolved to a sink, so the flag was inert.
    const parsed = parseArgs([
      'auth',
      'local',
      '--name',
      'ollama',
      '--no-probe',
      '--audit',
      'stdout',
    ]);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await authCmd(parsed.positional.slice(1), { ...fakeDeps(), flags: parsed.flags });
      expect(runAuthLocal).toHaveBeenCalledTimes(1);
      const opts = runAuthLocal.mock.calls[0]![1] as { audit?: { emit(e: unknown): void } };
      expect(opts.audit).toBeDefined();
      opts.audit!.emit({
        type: 'auth.local.add',
        providerId: 'ollama',
        baseUrl: 'http://localhost:11434',
        models: [],
      });
      expect(out.mock.calls.map((c) => String(c[0])).join('')).toContain('"type":"auth.local.add"');
    } finally {
      out.mockRestore();
    }
  });

  it('stays silent when `--audit` is absent (documented default)', async () => {
    const parsed = parseArgs(['auth', 'local', '--name', 'ollama', '--no-probe']);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await authCmd(parsed.positional.slice(1), { ...fakeDeps(), flags: parsed.flags });
      const opts = runAuthLocal.mock.calls[0]![1] as { audit?: { emit(e: unknown): void } };
      opts.audit?.emit({
        type: 'auth.local.add',
        providerId: 'ollama',
        baseUrl: 'http://localhost:11434',
        models: [],
      });
      expect(out.mock.calls.map((c) => String(c[0])).join('')).not.toContain('auth.local.add');
    } finally {
      out.mockRestore();
    }
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
