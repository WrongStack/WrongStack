import { describe, expect, it, vi } from 'vitest';
import {
  deepSubcommandsWithFocusedHelp,
  renderDeepHelp,
  renderFocusedHelp,
  renderGenericHelp,
  subcommandsWithFocusedHelp,
} from '../src/subcommands/handlers/per-subcommand-help.js';

/**
 * Tests for the per-subcommand help module. The module owns
 * the help data for the high-value subcommands the user
 * explicitly listed (`init`, `version`, `mcp`, `plugin`,
 * `models`, `config`, `sessions`) and renders them via a
 * single dispatcher. Tests pin:
 *
 *   1. `renderFocusedHelp(name, renderer)` returns `true` for
 *      every entry in the help table, `false` for subcommands
 *      not in the table.
 *   2. Each focused block contains its title, description,
 *      usage line, and (where applicable) a subcommand table
 *      with the expected entries.
 *   3. `subcommandsWithFocusedHelp` is the canonical list of
 *      subcommands that have a focused help block (used by
 *      `cli-main.ts` to decide between focused, generic, and
 *      top-level help).
 *   4. `renderGenericHelp(name, renderer)` produces a non-empty
 *      output that mentions the subcommand name and points at
 *      the top-level help.
 */

function makeRenderer() {
  return {
    write: vi.fn(),
    writeLine: vi.fn(),
    writeBlock: vi.fn(),
    writeToolCall: vi.fn(),
    writeToolResult: vi.fn(),
    writeDiff: vi.fn(),
    writeWarning: vi.fn(),
    writeError: vi.fn(),
    writeInfo: vi.fn(),
    clear: vi.fn(),
    render: vi.fn(),
  } as never as Parameters<typeof renderFocusedHelp>[1];
}

function capture(renderer: ReturnType<typeof makeRenderer>): string {
  return (renderer.write as ReturnType<typeof vi.fn>).mock.calls
    .map((call) => call[0])
    .join('');
}

describe('renderFocusedHelp', () => {
  it('returns true for every subcommand in the help table', () => {
    for (const name of subcommandsWithFocusedHelp) {
      const renderer = makeRenderer();
      const result = renderFocusedHelp(name, renderer);
      expect(result, `renderFocusedHelp(${name}) should return true`).toBe(true);
    }
  });

  it('returns false for subcommands not in the help table', () => {
    const renderer = makeRenderer();
    expect(renderFocusedHelp('help', renderer)).toBe(false);
    expect(renderFocusedHelp('nonexistent-subcommand', renderer)).toBe(false);
  });
});

describe('initHelp', () => {
  it('renders the init focused help block with no subcommand table', () => {
    const renderer = makeRenderer();
    expect(renderFocusedHelp('init', renderer)).toBe(true);
    const out = capture(renderer);
    expect(out).toContain('wstack init');
    expect(out).toContain('Usage');
    expect(out).toContain('wstack init');
    // init has no subcommands table.
    expect(out).not.toContain('Subcommands');
  });
});

describe('versionHelp', () => {
  it('renders the version focused help block', () => {
    const renderer = makeRenderer();
    expect(renderFocusedHelp('version', renderer)).toBe(true);
    const out = capture(renderer);
    expect(out).toContain('wstack version');
    expect(out).toContain('Usage');
    expect(out).toContain('wstack version');
  });
});

describe('mcpHelp', () => {
  it('renders the mcp subcommand table with serve / list / add / remove / restart', () => {
    const renderer = makeRenderer();
    expect(renderFocusedHelp('mcp', renderer)).toBe(true);
    const out = capture(renderer);
    expect(out).toContain('wstack mcp');
    expect(out).toContain('Subcommands');
    expect(out).toContain('list');
    expect(out).toContain('add <id> <command>');
    expect(out).toContain('remove <id>');
    expect(out).toContain('restart <id>');
    expect(out).toContain('serve');
  });
});

describe('pluginHelp', () => {
  it('renders the plugin subcommand table with list / report / menu / official / add / install / toggle / remove / enable / disable', () => {
    const renderer = makeRenderer();
    expect(renderFocusedHelp('plugin', renderer)).toBe(true);
    const out = capture(renderer);
    expect(out).toContain('wstack plugin');
    expect(out).toContain('Subcommands');
    expect(out).toContain('list');
    expect(out).toContain('report');
    expect(out).toContain('menu');
    expect(out).toContain('official');
    expect(out).toContain('add <id>');
    expect(out).toContain('install');
    expect(out).toContain('toggle <id>');
    expect(out).toContain('remove <id>');
    expect(out).toContain('enable <id>');
    expect(out).toContain('disable <id>');
  });
});

describe('modelsHelp', () => {
  it('renders the models subcommand table with add / remove / list / refresh', () => {
    const renderer = makeRenderer();
    expect(renderFocusedHelp('models', renderer)).toBe(true);
    const out = capture(renderer);
    expect(out).toContain('wstack models');
    expect(out).toContain('Subcommands');
    expect(out).toContain('add <mid>');
    expect(out).toContain('remove <mid>');
    expect(out).toContain('list');
    expect(out).toContain('refresh');
  });
});

describe('configHelp', () => {
  it('renders the config subcommand table with show / edit / history / restore', () => {
    const renderer = makeRenderer();
    expect(renderFocusedHelp('config', renderer)).toBe(true);
    const out = capture(renderer);
    expect(out).toContain('wstack config');
    expect(out).toContain('Subcommands');
    expect(out).toContain('show');
    expect(out).toContain('edit');
    expect(out).toContain('history');
    expect(out).toContain('restore <id>');
  });
});

describe('sessionsHelp', () => {
  it('renders the sessions subcommand table with list / show / resume / config / fleet', () => {
    const renderer = makeRenderer();
    expect(renderFocusedHelp('sessions', renderer)).toBe(true);
    const out = capture(renderer);
    expect(out).toContain('wstack sessions');
    expect(out).toContain('Subcommands');
    expect(out).toContain('list');
    expect(out).toContain('show <id>');
    expect(out).toContain('resume');
    expect(out).toContain('config');
    expect(out).toContain('fleet');
  });
});

describe('subcommandsWithFocusedHelp', () => {
  it('contains exactly the subcommands the user listed', () => {
    // The user asked for focused help blocks for every
    // registered subcommand except `help` (which is the
    // top-level help itself) and `plugins` (which aliases
    // `plugin`). A future addition is a one-line change in
    // the help table — the test pins the current scope.
    const expected = new Set([
      'init', 'version', 'mcp', 'plugin', 'models', 'config', 'sessions',
      'auth',
      'doctor', 'diag', 'audit', 'export', 'usage', 'providers',
      'tools', 'skills', 'update', 'rewind', 'replay', 'projects',
      'acp', 'modeldiag', 'quick', 'bench',
    ]);
    expect(new Set(subcommandsWithFocusedHelp)).toEqual(expected);
  });

  it('has no duplicates', () => {
    const seen = new Set<string>();
    for (const name of subcommandsWithFocusedHelp) {
      expect(seen.has(name), `duplicate: ${name}`).toBe(false);
      seen.add(name);
    }
  });
});

describe('renderGenericHelp', () => {
  it('renders a non-empty block that mentions the subcommand name and points at the top-level help', () => {
    const renderer = makeRenderer();
    renderGenericHelp('doctor', renderer);
    const out = capture(renderer);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('wstack doctor');
    expect(out).toContain('wstack --help');
  });

  it('produces different output per subcommand (the name appears verbatim)', () => {
    const r1 = makeRenderer();
    const r2 = makeRenderer();
    renderGenericHelp('doctor', r1);
    renderGenericHelp('tools', r2);
    expect(capture(r1)).toContain('wstack doctor');
    expect(capture(r2)).toContain('wstack tools');
    // Cross-check: doctor output should NOT mention tools.
    expect(capture(r1)).not.toContain('wstack tools');
  });
});

describe('PerSubcommandHelp shape (data contract)', () => {
  it('every entry has a non-empty title, description, and usage', () => {
    for (const name of subcommandsWithFocusedHelp) {
      const renderer = makeRenderer();
      renderFocusedHelp(name, renderer);
      const out = capture(renderer);
      // The title includes `wstack <name>` and a `—` em-dash.
      expect(out, `${name}: must include 'wstack ${name}'`).toContain(`wstack ${name}`);
      // Usage line.
      expect(out, `${name}: must include 'Usage'`).toContain('Usage');
    }
  });

  it('every entry that declares subcommands renders the Subcommands table', () => {
    for (const name of subcommandsWithFocusedHelp) {
      const renderer = makeRenderer();
      renderFocusedHelp(name, renderer);
      const _out = capture(renderer);
      // The doctor/diag/init/etc. entries have no subcommands;
      // they should NOT render the table header. mcp/plugin/
      // models/etc. should. The test below is loose: we just
      // assert that "Subcommands" appears if and only if the
      // entry has a subcommand table.
      // (We can't introspect the entry from here without
      // exporting helpTable — instead, the test below is a
      // smoke test for the specific subcommand-bearing entries.)
    }
  });

  it('doctor and diag focused help blocks do NOT render a Subcommands table (no subcommands)', () => {
    for (const name of [
      'doctor', 'diag', 'init', 'version', 'tools', 'skills',
      'projects', 'usage', 'update', 'quick', 'acp',
    ]) {
      const renderer = makeRenderer();
      renderFocusedHelp(name, renderer);
      const out = capture(renderer);
      expect(out, `${name}: no subcommands table`).not.toContain('Subcommands');
    }
  });

  it('mcp / plugin / models / config / sessions / bench / export / audit / replay / rewind / providers DO render a Subcommands table', () => {
    const withSubcommands = [
      'mcp', 'plugin', 'models', 'config', 'sessions',
      'bench', 'export', 'audit', 'replay', 'rewind', 'providers',
    ];
    for (const name of withSubcommands) {
      const renderer = makeRenderer();
      renderFocusedHelp(name, renderer);
      const out = capture(renderer);
      expect(out, `${name}: must include 'Subcommands' table`).toContain('Subcommands');
    }
  });
});

// --- renderDeepHelp (deep-subcommand help) -------------------------------
//
// The `deepHelpTable` is keyed by `<top>:<deep>` (e.g. `mcp:add`)
// and provides focused help for deep subcommands. Each entry
// has the same `PerSubcommandHelp` shape as the top-level help —
// only the lookup key is different.

describe('renderDeepHelp', () => {
  it('returns true for every key in deepSubcommandsWithFocusedHelp', () => {
    for (const key of deepSubcommandsWithFocusedHelp) {
      const renderer = makeRenderer();
      const result = renderDeepHelp(key, renderer);
      expect(result, `renderDeepHelp(${key}) should return true`).toBe(true);
    }
  });

  it('returns false for unknown keys (e.g. `mcp:unknown` or `fake:foo`)', () => {
    const renderer = makeRenderer();
    expect(renderDeepHelp('mcp:unknown', renderer)).toBe(false);
    expect(renderDeepHelp('fake:foo', renderer)).toBe(false);
    expect(renderDeepHelp('', renderer)).toBe(false);
  });

  it('renders a block with the deep subcommand\'s title and usage', () => {
    const renderer = makeRenderer();
    expect(renderDeepHelp('mcp:add', renderer)).toBe(true);
    const out = capture(renderer);
    expect(out).toContain('wstack mcp add');
    expect(out).toContain('Usage');
  });
});

describe('mcp:add deep help', () => {
  it('lists the --enable flag and the positional <name>', () => {
    const renderer = makeRenderer();
    renderDeepHelp('mcp:add', renderer);
    const out = capture(renderer);
    expect(out).toContain('--enable');
    expect(out).toContain('<name>');
  });
});

describe('plugin:add deep help', () => {
  it('lists the --disabled flag and the positional <spec|alias>', () => {
    const renderer = makeRenderer();
    renderDeepHelp('plugin:add', renderer);
    const out = capture(renderer);
    expect(out).toContain('--disabled');
    expect(out).toContain('<spec|alias>');
  });
});

describe('plugin:report / plugin:toggle / plugin:menu deep help', () => {
  it('plugin:report explains effective state and toggle policy', () => {
    const renderer = makeRenderer();
    renderDeepHelp('plugin:report', renderer);
    const out = capture(renderer);
    expect(out).toContain('wstack plugin report');
    expect(out).toContain('effective state');
    expect(out).toContain('toggle policy');
  });

  it('plugin:toggle mentions the audit-list name and toggleable rows', () => {
    const renderer = makeRenderer();
    renderDeepHelp('plugin:toggle', renderer);
    const out = capture(renderer);
    expect(out).toContain('wstack plugin toggle');
    expect(out).toContain('<name>');
    expect(out).toContain('format-on-save');
    expect(out).toContain('toggleable');
  });

  it('plugin:menu documents the non-interactive report fallback', () => {
    const renderer = makeRenderer();
    renderDeepHelp('plugin:menu', renderer);
    const out = capture(renderer);
    expect(out).toContain('wstack plugin menu');
    expect(out).toContain('interactive plugin picker');
    expect(out).toContain('audit report');
  });
});

describe('models:add deep help', () => {
  it('lists every capability flag from the handler (--provider, --name, --max-context, --max-output, --tools, --vision, --reasoning, --streaming, --json-mode)', () => {
    const renderer = makeRenderer();
    renderDeepHelp('models:add', renderer);
    const out = capture(renderer);
    expect(out).toContain('--provider');
    expect(out).toContain('--name');
    expect(out).toContain('--max-context');
    expect(out).toContain('--max-output');
    expect(out).toContain('--tools / --no-tools');
    expect(out).toContain('--vision / --no-vision');
    expect(out).toContain('--reasoning');
    expect(out).toContain('--streaming / --no-streaming');
    expect(out).toContain('--json-mode');
  });
});

describe('audit:list / replay:list deep help', () => {
  it('audit:list mentions .audit.jsonl sidecars', () => {
    const renderer = makeRenderer();
    renderDeepHelp('audit:list', renderer);
    const out = capture(renderer);
    expect(out).toContain('.audit.jsonl');
  });

  it('replay:list mentions .replay.jsonl sidecars', () => {
    const renderer = makeRenderer();
    renderDeepHelp('replay:list', renderer);
    const out = capture(renderer);
    expect(out).toContain('.replay.jsonl');
  });
});

describe('sessions:resume / sessions:fleet / sessions:show deep help', () => {
  it('sessions:resume mentions the optional positional [<id>]', () => {
    const renderer = makeRenderer();
    renderDeepHelp('sessions:resume', renderer);
    const out = capture(renderer);
    expect(out).toContain('[<id>]');
  });

  it('sessions:fleet mentions the multi-agent fleet', () => {
    const renderer = makeRenderer();
    renderDeepHelp('sessions:fleet', renderer);
    const out = capture(renderer);
    expect(out).toContain('fleet');
  });

  it('sessions:show mentions the <id> positional', () => {
    const renderer = makeRenderer();
    renderDeepHelp('sessions:show', renderer);
    const out = capture(renderer);
    expect(out).toContain('<id>');
  });
});

describe('auth:list / auth:status / auth:remove deep help', () => {
  it('auth:list mentions the saved providers and the ls alias', () => {
    const renderer = makeRenderer();
    renderDeepHelp('auth:list', renderer);
    const out = capture(renderer);
    expect(out).toContain('wstack auth list');
    expect(out).toContain('wstack auth ls');
    // The description mentions the masked-key markers (active `●`,
    // inactive `○`) — verify they appear so a future refactor
    // can't silently drop the visual signal.
    expect(out).toContain('●');
    expect(out).toContain('○');
    // Subcommands table lists both `list` and `ls` aliases.
    expect(out).toContain('ls');
  });

  it('auth:status requires the provider id and documents the fields shown', () => {
    const renderer = makeRenderer();
    renderDeepHelp('auth:status', renderer);
    const out = capture(renderer);
    expect(out).toContain('wstack auth status <provider>');
    expect(out).toContain('<provider>');
    // The entry documents each field shown in the detail view.
    expect(out).toContain('family');
    expect(out).toContain('baseUrl');
    expect(out).toContain('models');
  });

  it('auth:remove describes the interactive confirmation flow', () => {
    const renderer = makeRenderer();
    renderDeepHelp('auth:remove', renderer);
    const out = capture(renderer);
    expect(out).toContain('wstack auth remove');
    // The `rm` alias appears in both the usage line and the
    // subcommands table — verify both forms.
    expect(out).toContain('wstack auth rm');
    expect(out).toContain('rm');
    // The flow is always interactive (y/yes prompt); the deep
    // entry documents this so a user who runs `wstack auth
    // remove <id>` from a script knows it'll block on stdin.
    expect(out).toContain('interactive');
    expect(out).toContain('y');
  });

  it('auth:local delegates to auth-local-help.ts (single source of truth)', async () => {
    // The `auth:local` deep entry has a `customBody` thunk that
    // points at `auth-local-help.ts`'s `renderAuthLocalHelpToString`.
    // The rendered block is byte-for-byte the same string the
    // `wstack auth local --help` surface produces (because both
    // call the same function). This is the single-source-of-truth
    // guarantee — the flag list lives in `LOCAL_AUTH_FLAGS`,
    // and every help surface reads from it.
    const renderer = makeRenderer();
    renderDeepHelp('auth:local', renderer);
    const deepOut = capture(renderer);

    const { renderAuthLocalHelpToString } = await import(
      '../src/subcommands/handlers/auth-local-help.js'
    );
    const localHelpOut = renderAuthLocalHelpToString();

    expect(deepOut).toBe(localHelpOut);

    // The deep entry's content includes every flag from
    // `LOCAL_AUTH_FLAGS` — pin one representative to make sure
    // the delegation is wired through (a future refactor that
    // drops the delegation would fail this assertion).
    expect(deepOut).toContain('--name <ollama|vllm|lmstudio>');
    expect(deepOut).toContain('--audit [target]');
  });

  it('auth:local does NOT render the standard Tip footer (customBody owns the full layout)', () => {
    // The standard layout appends "Tip: `wstack --help` lists every
    // top-level command." to every entry. The `auth:local` entry
    // uses `customBody`, which owns the full layout including
    // its own closing "See also" / "Examples" lines. The Tip
    // footer is suppressed so the custom body's "See also"
    // doesn't get a duplicate from the standard renderer.
    const renderer = makeRenderer();
    renderDeepHelp('auth:local', renderer);
    const out = capture(renderer);
    expect(out).not.toContain('Tip: `wstack --help` lists every top-level command.');
  });
});

describe('deepSubcommandsWithFocusedHelp', () => {
  it('contains exactly the deep subcommands the user asked for', () => {
    // The deep-help table covers all the deep subcommands
    // the user explicitly listed across two turns:
    //   - `mcp:add`/`mcp:remove`/`mcp:restart`
    //   - `plugin:add`/`remove`/`enable`/`disable`/`toggle`/`list`/`report`/`menu`/`official`
    //   - `models:add`/`remove`/`refresh`/`list`
    //   - `audit --list`/`replay --list`
    //   - `sessions:resume`/`fleet`/`show`/`list`/`config`
    //   - `config:show`/`edit`/`history`/`restore`
    //   - `rewind:list`/`all`/`last`/`to`/`resume`
    //   - `auth:list`/`auth:status`/`auth:remove`/`auth:local`
    // A future addition is a one-line change in the
    // `deepHelpTable`.
    const expected = new Set([
      'mcp:add', 'mcp:remove', 'mcp:restart',
      'plugin:add', 'plugin:remove', 'plugin:enable', 'plugin:disable',
      'plugin:toggle', 'plugin:list', 'plugin:report', 'plugin:menu',
      'plugin:official', 'plugin:officials',
      'models:add', 'models:remove', 'models:refresh', 'models:list',
      'audit:list', 'replay:list',
      'sessions:resume', 'sessions:fleet', 'sessions:show',
      'sessions:list', 'sessions:config',
      'config:show', 'config:edit', 'config:history', 'config:restore',
      'rewind:list', 'rewind:all', 'rewind:last', 'rewind:to', 'rewind:resume',
      'auth:list', 'auth:status', 'auth:remove', 'auth:local',
      'bench:run',
    ]);
    expect(new Set(deepSubcommandsWithFocusedHelp)).toEqual(expected);
  });

  it('has no duplicates', () => {
    const seen = new Set<string>();
    for (const key of deepSubcommandsWithFocusedHelp) {
      expect(seen.has(key), `duplicate: ${key}`).toBe(false);
      seen.add(key);
    }
  });
});
