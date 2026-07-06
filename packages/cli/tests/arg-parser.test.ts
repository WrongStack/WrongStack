import { describe, expect, it } from 'vitest';
import { parseArgs, parseAuthFlags, parseSpawnFlags, BOOLEAN_FLAGS } from '../src/arg-parser.js';

describe('parseArgs', () => {
  it('returns empty result for empty argv', () => {
    expect(parseArgs([])).toEqual({ flags: {}, positional: [] });
  });

  it('treats listed BOOLEAN_FLAGS as true even when next arg looks value-like', () => {
    for (const flag of ['yolo', 'yolo-destructive', 'force-all-yolo', 'verbose', 'help', 'tui']) {
      const result = parseArgs([`--${flag}`, 'next']);
      expect(result.flags[flag]).toBe(true);
      // "next" should remain positional since the flag is boolean-only
      expect(result.positional).toContain('next');
    }
  });

  it('parses --flag=value form', () => {
    const r = parseArgs(['--label=foo', '--name=bar']);
    expect(r.flags.label).toBe('foo');
    expect(r.flags.name).toBe('bar');
  });

  it('handles --flag value pairs for non-boolean flags', () => {
    const r = parseArgs(['--label', 'foo', '--name', 'bar']);
    expect(r.flags.label).toBe('foo');
    expect(r.flags.name).toBe('bar');
  });

  it('treats non-boolean flag at end of argv as true', () => {
    const r = parseArgs(['--label']);
    expect(r.flags.label).toBe(true);
  });

  it('treats non-boolean flag followed by another flag as true', () => {
    const r = parseArgs(['--label', '--other=x']);
    expect(r.flags.label).toBe(true);
    expect(r.flags.other).toBe('x');
  });

  it('treats --no-hooks as a boolean flag', () => {
    expect(BOOLEAN_FLAGS.has('no-hooks')).toBe(true);
    const r = parseArgs(['--no-hooks', 'prompt']);
    expect(r.flags['no-hooks']).toBe(true);
    expect(r.positional).toContain('prompt');
  });

  it('treats --webui-require-token as a boolean flag', () => {
    expect(BOOLEAN_FLAGS.has('webui-require-token')).toBe(true);
    const r = parseArgs(['--webui', '--webui-require-token', 'prompt']);
    expect(r.flags['webui-require-token']).toBe(true);
    expect(r.positional).toContain('prompt');
  });

  it('treats --desktop as a boolean flag', () => {
    expect(BOOLEAN_FLAGS.has('desktop')).toBe(true);
    const r = parseArgs(['--desktop', 'next']);
    expect(r.flags.desktop).toBe(true);
    expect(r.positional).toEqual(['next']);
  });

  it('normalizes desktop, webui, and hq launcher subcommands to flags', () => {
    expect(parseArgs(['desktop'])).toEqual({ flags: { desktop: true }, positional: [] });
    expect(parseArgs(['webui', '--open'])).toEqual({
      flags: { webui: true, open: true },
      positional: [],
    });
    expect(parseArgs(['hq'])).toEqual({ flags: { hq: true }, positional: [] });
    expect(parseArgs(['hq', 'serve', '--port', '4000'])).toEqual({
      flags: { hq: true, port: '4000' },
      positional: [],
    });
  });

  it('keeps hq token management as a real subcommand', () => {
    const r = parseArgs(['hq', 'token', 'list', '--client']);
    expect(r.flags.client).toBe(true);
    expect(r.flags.hq).toBeUndefined();
    expect(r.positional).toEqual(['hq', 'token', 'list']);
  });

  it('parses --fallback-model as a value flag (comma list preserved)', () => {
    expect(BOOLEAN_FLAGS.has('fallback-model')).toBe(false);
    const r = parseArgs(['--fallback-model', 'planner,haiku']);
    expect(r.flags['fallback-model']).toBe('planner,haiku');
  });

  it('stops parsing at "--" and collects rest as positional', () => {
    const r = parseArgs(['--yolo', '--', '--not-a-flag', 'extra']);
    expect(r.flags.yolo).toBe(true);
    expect(r.positional).toEqual(['--not-a-flag', 'extra']);
  });

  it('expands -v to verbose', () => {
    const r = parseArgs(['-v']);
    expect(r.flags.verbose).toBe(true);
  });

  it('treats unknown -X short flags as the literal letter', () => {
    const r = parseArgs(['-x']);
    expect(r.flags.x).toBe(true);
  });

  it('skips empty argv entries', () => {
    const r = parseArgs(['', 'pos', '']);
    expect(r.positional).toEqual(['pos']);
  });

  it('collects bare words as positional', () => {
    const r = parseArgs(['cmd', 'sub', '--yolo']);
    expect(r.positional).toEqual(['cmd', 'sub']);
    expect(r.flags.yolo).toBe(true);
  });

  it('exports a non-empty BOOLEAN_FLAGS set including key flags', () => {
    expect(BOOLEAN_FLAGS.size).toBeGreaterThan(0);
    expect(BOOLEAN_FLAGS.has('yolo')).toBe(true);
    expect(BOOLEAN_FLAGS.has('yolo-destructive')).toBe(true);
    expect(BOOLEAN_FLAGS.has('force-all-yolo')).toBe(true);
    expect(BOOLEAN_FLAGS.has('version')).toBe(true);
    expect(BOOLEAN_FLAGS.has('desktop')).toBe(true);
  });
});

describe('parseAuthFlags', () => {
  it('parses positional arg', () => {
    expect(parseAuthFlags(['anthropic'])).toEqual({ positional: ['anthropic'] });
  });

  it('parses --label / --family / --base-url', () => {
    const r = parseAuthFlags([
      'openai',
      '--label',
      'prod',
      '--family',
      'openai',
      '--base-url',
      'https://x',
    ]);
    expect(r.positional).toEqual(['openai']);
    expect(r.label).toBe('prod');
    expect(r.family).toBe('openai');
    expect(r.baseUrl).toBe('https://x');
  });

  it('parses --env as comma-separated env-var names with trimming', () => {
    const r = parseAuthFlags(['--env', ' A_KEY , B_KEY ,  ']);
    expect(r.envVars).toEqual(['A_KEY', 'B_KEY']);
  });

  it('greedy consumption: a flag will consume the next token even if it starts with --', () => {
    const r = parseAuthFlags(['--label', '--family', 'fam']);
    // --label consumes "--family" as its value; "fam" becomes positional.
    expect(r.label).toBe('--family');
    expect(r.positional).toEqual(['fam']);
  });

  it('ignores unknown bare flags but keeps positional words', () => {
    const r = parseAuthFlags(['provider', '--unknown']);
    expect(r.positional).toEqual(['provider']);
  });
});

describe('parseSpawnFlags', () => {
  it('returns empty opts when input is empty', () => {
    expect(parseSpawnFlags('')).toEqual({ description: '', opts: {} });
  });

  it('parses --provider= / --model=', () => {
    const r = parseSpawnFlags('--provider=openai --model=gpt-4 do something');
    expect(r.opts.provider).toBe('openai');
    expect(r.opts.model).toBe('gpt-4');
    expect(r.description).toBe('do something');
  });

  it('parses --name= with quoted value', () => {
    const r = parseSpawnFlags('--name="bug hunter" find bugs');
    expect(r.opts.name).toBe('bug hunter');
    expect(r.description).toBe('find bugs');
  });

  it('parses --name= unquoted', () => {
    const r = parseSpawnFlags('--name=quick run it');
    expect(r.opts.name).toBe('quick');
    expect(r.description).toBe('run it');
  });

  it('parses --tools= and splits on commas', () => {
    const r = parseSpawnFlags('--tools=read,grep,write do task');
    expect(r.opts.tools).toEqual(['read', 'grep', 'write']);
    expect(r.description).toBe('do task');
  });

  it('parses -p / -m / -n short flags', () => {
    const r = parseSpawnFlags('-p openai -m gpt-4 -n agent7 chase the bug');
    expect(r.opts.provider).toBe('openai');
    expect(r.opts.model).toBe('gpt-4');
    expect(r.opts.name).toBe('agent7');
    expect(r.description).toBe('chase the bug');
  });

  it('handles -n with quoted multi-word name', () => {
    const r = parseSpawnFlags('-n "code monkey" hello');
    expect(r.opts.name).toBe('code monkey');
    expect(r.description).toBe('hello');
  });

  it('stops at the first non-flag and returns rest as description', () => {
    const r = parseSpawnFlags('describe this task');
    expect(r.opts).toEqual({});
    expect(r.description).toBe('describe this task');
  });

  it('trims trailing whitespace from description', () => {
    const r = parseSpawnFlags('--provider=x   hello world   ');
    expect(r.description).toBe('hello world');
  });

  it('handles all flags together', () => {
    const r = parseSpawnFlags(
      '--provider=openai --model=gpt-4 --name="my agent" --tools=a,b do it',
    );
    expect(r.opts.provider).toBe('openai');
    expect(r.opts.model).toBe('gpt-4');
    expect(r.opts.name).toBe('my agent');
    expect(r.opts.tools).toEqual(['a', 'b']);
    expect(r.description).toBe('do it');
  });
});
