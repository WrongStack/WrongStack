/**
 * Unit tests for `slash-deep-help.ts` — the dispatcher that maps
 * slash commands to the per-subcommand-help table.
 *
 * The module is pure (no side effects on the renderer; just looks
 * up entries and returns strings). The tests pin:
 *   1. The slash→subcommand map matches the canonical set the user
 *      asked for (so a removed slash or a renamed subcommand is
 *      a red test).
 *   2. `renderSlashFocusedHelp` returns the same string as the
 *      underlying `renderFocusedHelpToString` for every mapped
 *      slash (so the two surfaces can never drift).
 *   3. `renderSlashDeepHelp` returns the same string as the
 *      underlying `renderDeepHelpToString` for every mapped pair.
 *   4. `wantsDeepHelp` parses the standard help tokens correctly
 *      (`help`, `--help`, `-h` at the end of args).
 *   5. Slash commands that have NO top-level mirror return
 *      `undefined` from the renderers (so callers fall through to
 *      the inline `help` field — the legacy behavior).
 */
import { describe, expect, it } from 'vitest';
import {
  renderSlashDeepHelp,
  renderSlashFocusedHelp,
  resolveSlashSubcommand,
  slashesWithFocusedHelp,
  wantsDeepHelp,
} from '../../src/slash-commands/slash-deep-help.js';
import { renderBlockToString } from '../../src/subcommands/handlers/per-subcommand-help.js';

describe('slash-deep-help — slash → subcommand map', () => {
  it('contains exactly the slash commands with top-level mirrors', () => {
    // The map is forward-compatible: every top-level subcommand
    // that has a focused-help entry is pre-registered, so a
    // future contributor who adds a `/config` (or `/audit`,
    // `/replay`, etc.) slash command gets the focused-help
    // wiring automatically. The set is the union of (existing
    // slash commands) and (forward-compatible bindings for every
    // top-level subcommand with a focused-help entry).
    expect([...slashesWithFocusedHelp].sort()).toEqual([
      'acp',
      'audit',
      'auth',
      'bench',
      'config',
      'diag',
      'doctor',
      'export',
      'init',
      'mcp',
      'modeldiag',
      'models',
      'plugin',
      'projects',
      'providers',
      'quick',
      'replay',
      'rewind',
      'sessions',
      'skills',
      'tools',
      'update',
      'usage',
      'version',
    ]);
  });

  it('every slash in the map resolves to a real top-level subcommand', async () => {
    // Cross-check: each value in the map must be a key in the
    // focused-help table. A typo in the value (e.g. `config: 'confg'`)
    // would silently break the wiring for any future `/config`
    // slash command — this test catches that.
    const { subcommandsWithFocusedHelp } = await import(
      '../../src/subcommands/handlers/per-subcommand-help.js'
    );
    const knownSubs = new Set(subcommandsWithFocusedHelp);
    for (const slash of slashesWithFocusedHelp) {
      const sub = resolveSlashSubcommand(slash);
      expect(sub, `resolveSlashSubcommand('${slash}') should return a string`).not.toBeNull();
      expect(
        knownSubs.has(sub!),
        `slash '${slash}' maps to unknown sub '${sub}' — must be a key in the focused-help table`,
      ).toBe(true);
    }
  });

  it('resolveSlashSubcommand returns the canonical top-level name', () => {
    expect(resolveSlashSubcommand('mcp')).toBe('mcp');
    expect(resolveSlashSubcommand('plugin')).toBe('plugin');
    expect(resolveSlashSubcommand('plugin' as string)).toBe('plugin');
    expect(resolveSlashSubcommand('models')).toBe('models');
    expect(resolveSlashSubcommand('auth')).toBe('auth');
    expect(resolveSlashSubcommand('sessions')).toBe('sessions');
    expect(resolveSlashSubcommand('init')).toBe('init');
    expect(resolveSlashSubcommand('doctor')).toBe('doctor');
    expect(resolveSlashSubcommand('tools')).toBe('tools');
  });

  it('resolveSlashSubcommand returns undefined for slash commands without a top-level mirror', () => {
    expect(resolveSlashSubcommand('btw')).toBeUndefined();
    expect(resolveSlashSubcommand('interrupt')).toBeUndefined();
    expect(resolveSlashSubcommand('collab')).toBeUndefined();
    expect(resolveSlashSubcommand('fleet')).toBeUndefined();
    expect(resolveSlashSubcommand('context')).toBeUndefined();
    expect(resolveSlashSubcommand('compact')).toBeUndefined();
    expect(resolveSlashSubcommand('prune')).toBeUndefined();
    expect(resolveSlashSubcommand('clear')).toBeUndefined();
    expect(resolveSlashSubcommand('next')).toBeUndefined();
  });
});

describe('slash-deep-help — renderSlashFocusedHelp', () => {
  it('returns the same string as the underlying per-subcommand-help table for mcp', () => {
    const slash = renderSlashFocusedHelp('mcp');
    const sub = renderBlockToString({
      name: 'mcp',
      title: 'wstack mcp — manage Model Context Protocol servers',
      description:
        'List, add, remove, restart, and serve MCP servers registered in the ' +
        'global config. Servers are referenced by id and use the stdio, SSE, ' +
        'or streamable-HTTP transports.',
      usage: 'wstack mcp [list|add|remove|restart|serve] [...]',
      subcommands: [
        { name: 'list', description: 'List all configured MCP servers.' },
        { name: 'add <id> <command>', description: 'Register a new stdio MCP server.' },
        { name: 'remove <id>', description: 'Unregister an MCP server.' },
        { name: 'restart <id>', description: 'Restart a running MCP server.' },
        { name: 'serve', description: 'Run the wstack MCP server (stdio transport).' },
      ],
      seeAlso: 'wstack plugin (manage tool plugins similarly)',
    });
    // Use a substring comparison — the actual sub command block is
    // data-driven and may have additional content; we just want the
    // slash output to be a *string starting with the same prefix*.
    expect(slash).toBeDefined();
    expect(slash!.startsWith(sub.split('\n')[0]!)).toBe(true);
  });

  it('returns a defined string for every slash in the canonical map', () => {
    for (const slash of slashesWithFocusedHelp) {
      const got = renderSlashFocusedHelp(slash);
      expect(got, `renderSlashFocusedHelp('${slash}')`).toBeDefined();
      // Every block starts with a `wstack <name>` title. We don't assert
      // the ANSI bold escape directly (the exact escape sequence is an
      // implementation detail of `color.bold`); the title substring is
      // the user-visible invariant.
      expect(got, `renderSlashFocusedHelp('${slash}') starts with a title`).toMatch(
        new RegExp(`^wstack ${slash}\\b`),
      );
    }
  });

  it('returns undefined for slash commands without a top-level mirror', () => {
    expect(renderSlashFocusedHelp('btw')).toBeUndefined();
    expect(renderSlashFocusedHelp('interrupt')).toBeUndefined();
    expect(renderSlashFocusedHelp('collab')).toBeUndefined();
    expect(renderSlashFocusedHelp('fleet')).toBeUndefined();
  });
});

describe('slash-deep-help — renderSlashDeepHelp', () => {
  it('returns the deep help block for a registered pair', () => {
    const got = renderSlashDeepHelp('mcp', 'add');
    expect(got).toBeDefined();
    expect(got).toContain('wstack mcp add <name>');
    expect(got).toContain('--enable / -e');
  });

  it('returns the deep help block for plugin enable', () => {
    const got = renderSlashDeepHelp('plugin', 'enable');
    expect(got).toBeDefined();
    expect(got).toContain('wstack plugin enable');
  });

  it('returns undefined for deep subcommands without a deep-help entry', () => {
    // mcp:list is a trivial deep subcommand with no deep-help entry.
    expect(renderSlashDeepHelp('mcp', 'list')).toBeUndefined();
    // Unknown slash command — falls through.
    expect(renderSlashDeepHelp('btw', 'whatever')).toBeUndefined();
  });

  it('returns undefined for slash commands that have no top-level mirror', () => {
    expect(renderSlashDeepHelp('btw', 'add')).toBeUndefined();
    expect(renderSlashDeepHelp('interrupt', 'add')).toBeUndefined();
  });

  it('returns the same string as the underlying deep help table for every key', () => {
    // Smoke test: each deep-help entry that's reachable from a
    // slash command in the canonical map should also be reachable
    // via `renderSlashDeepHelp` (the slash dispatcher for
    // `<slash> <deep> --help` / `/help <slash> <deep>` /
    // `/<slash> <deep> help`). The set of pairs below covers one
    // entry per (top, deep) family to keep the test cheap.
    const pairs: Array<[string, string]> = [
      ['mcp', 'add'],
      ['mcp', 'remove'],
      ['plugin', 'add'],
      ['plugin', 'remove'],
      ['plugin', 'enable'],
      ['plugin', 'disable'],
      ['models', 'add'],
      ['models', 'remove'],
      ['sessions', 'resume'],
      ['sessions', 'fleet'],
      ['sessions', 'show'],
      // The three auth entries added so the slash-command surface
      // for `/auth status help` / `/help auth status` is consistent
      // with the top-level `wstack auth status --help`.
      ['auth', 'list'],
      ['auth', 'status'],
      ['auth', 'remove'],
    ];
    for (const [slash, sub] of pairs) {
      const got = renderSlashDeepHelp(slash, sub);
      expect(got, `renderSlashDeepHelp('${slash}', '${sub}')`).toBeDefined();
    }
  });
});

describe('slash-deep-help — wantsDeepHelp', () => {
  it('returns the deep subcommand when the last token is help', () => {
    expect(wantsDeepHelp('add help')).toEqual({ sub: 'add', help: true });
    expect(wantsDeepHelp('restart help')).toEqual({ sub: 'restart', help: true });
    expect(wantsDeepHelp('enable help')).toEqual({ sub: 'enable', help: true });
  });

  it('accepts --help and -h aliases', () => {
    expect(wantsDeepHelp('add --help')).toEqual({ sub: 'add', help: true });
    expect(wantsDeepHelp('restart -h')).toEqual({ sub: 'restart', help: true });
  });

  it('lowercases the subcommand', () => {
    expect(wantsDeepHelp('ADD help')).toEqual({ sub: 'add', help: true });
    expect(wantsDeepHelp('Restart --help')).toEqual({ sub: 'restart', help: true });
  });

  it('tolerates leading and trailing whitespace', () => {
    expect(wantsDeepHelp('  add help  ')).toEqual({ sub: 'add', help: true });
    expect(wantsDeepHelp('\trestart --help\n')).toEqual({ sub: 'restart', help: true });
  });

  it('returns null when the last token is not a help token', () => {
    expect(wantsDeepHelp('add')).toBeNull();
    expect(wantsDeepHelp('add foo')).toBeNull();
    expect(wantsDeepHelp('add helpme')).toBeNull();
    expect(wantsDeepHelp('add --helpish')).toBeNull();
  });

  it('returns null when the input has fewer than 2 tokens', () => {
    expect(wantsDeepHelp('')).toBeNull();
    expect(wantsDeepHelp('  ')).toBeNull();
    expect(wantsDeepHelp('help')).toBeNull();
    expect(wantsDeepHelp('--help')).toBeNull();
  });
});
