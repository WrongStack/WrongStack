import { describe, expect, it } from 'vitest';
import { BOOLEAN_FLAGS, parseArgs } from '../src/arg-parser.js';
import { restoreFlags } from '../src/subcommands/flags.js';

/**
 * The dispatch contract, exercised for real.
 *
 * `boot.ts` calls `subcommands[first](positional.slice(1), { …, flags })` after
 * `parseArgs` has already pulled every `--flag` out of argv. Every handler test
 * in this suite hand-builds an `args` array that still contains those tokens —
 * a shape the dispatcher can never produce — which is why a whole class of
 * "the documented flag does nothing" bugs survived a green suite.
 */
function dispatchArgs(argv: string[]): { args: string[]; flags: Record<string, string | boolean> } {
  const { flags, positional } = parseArgs(argv);
  return { args: positional.slice(1), flags };
}

describe('parseArgs strips flags before the handler sees them', () => {
  it('hands the handler positionals only', () => {
    const { args, flags } = dispatchArgs(['rewind', '--last', '2']);
    expect(args).toEqual([]);
    expect(flags['last']).toBe('2');
  });
});

describe('restoreFlags', () => {
  it('re-attaches a declared boolean flag', () => {
    const { args, flags } = dispatchArgs(['audit', '--list']);
    expect(restoreFlags(args, { flags }, ['list'])).toEqual(['--list']);
  });

  it('re-attaches a declared value flag with its value', () => {
    const { args, flags } = dispatchArgs(['rewind', '--last', '2']);
    expect(restoreFlags(args, { flags }, ['last'])).toEqual(['--last', '2']);
  });

  it('keeps positionals ahead of the restored flags', () => {
    const { args, flags } = dispatchArgs(['sessions', 'fork', 'abc', '--to', '3']);
    expect(restoreFlags(args, { flags }, ['to'])).toEqual(['fork', 'abc', '--to', '3']);
  });

  it('emits a single-character name in short form', () => {
    const { args, flags } = dispatchArgs(['audit', '-l']);
    expect(restoreFlags(args, { flags }, ['l'])).toEqual(['-l']);
  });

  it('restores only the flags the handler declares', () => {
    // A top-level switch must never leak into a subcommand's argv: handlers
    // like `export` reject unknown flags outright.
    const { args, flags } = dispatchArgs(['export', 's1', '--verbose', '--out', 'r.json']);
    expect(restoreFlags(args, { flags }, ['out'])).toEqual(['s1', '--out', 'r.json']);
  });

  it('lets a spelling already in args win', () => {
    // A directly-invoked handler (or anything after `--`) keeps overriding.
    const restored = restoreFlags(['--out', 'local.json'], { flags: { out: 'global.json' } }, [
      'out',
    ]);
    expect(restored).toEqual(['--out', 'local.json']);
  });

  it('is a no-op when the dispatcher supplied no flags', () => {
    const args = ['abc'];
    expect(restoreFlags(args, {}, ['to'])).toBe(args);
  });

  it('skips a flag that is absent or explicitly false', () => {
    expect(restoreFlags([], { flags: { all: false } }, ['all', 'list'])).toEqual([]);
  });
});

describe('BOOLEAN_FLAGS covers the subcommand booleans', () => {
  // A boolean flag missing from the set makes `parseArgs` consume the NEXT
  // positional as its value.
  it.each([
    ['rewind --all sess123', ['rewind', '--all', 'sess123'], 'all', ['rewind', 'sess123']],
    [
      'export --no-tools out.md',
      ['export', '--no-tools', 'out.md'],
      'no-tools',
      ['export', 'out.md'],
    ],
    [
      'plugin add x --disabled',
      ['plugin', 'add', 'x', '--disabled'],
      'disabled',
      ['plugin', 'add', 'x'],
    ],
    ['audit --list x', ['audit', '--list', 'x'], 'list', ['audit', 'x']],
  ])('%s does not swallow the following positional', (_label, argv, flag, expectedPositional) => {
    expect(BOOLEAN_FLAGS.has(flag)).toBe(true);
    const { flags, positional } = parseArgs(argv);
    expect(flags[flag]).toBe(true);
    expect(positional).toEqual(expectedPositional);
  });

  it('does not make --resume boolean (it takes a session id)', () => {
    // Top-level `--resume <id>` is the documented value-taking form; making it
    // boolean here would break every resume invocation.
    expect(BOOLEAN_FLAGS.has('resume')).toBe(false);
  });
});
