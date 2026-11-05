import { describe, expect, it } from 'vitest';
import { BOOLEAN_FLAGS, parseArgs, parseAuthFlags } from '../src/arg-parser.js';
import { resolveExecutionMode } from '../src/boot/execution-mode.js';

it.each([['--alias', 'work-account'], ['--alias=work-account']])(
  'parses auth account alias %j separately from key labels',
  (...flags) => {
    expect(parseAuthFlags(['openai', ...flags, '--label', 'main'])).toMatchObject({
      positional: ['openai'],
      alias: 'work-account',
      label: 'main',
    });
  },
);

describe('parseArgs', () => {
  it('keeps --tunnel boolean without consuming a following password flag', () => {
    expect(parseArgs(['--hq', '--tunnel', '--password', 'secret'])).toEqual({
      flags: { hq: true, tunnel: true, password: 'secret' },
      positional: [],
    });
  });
  it('returns empty result for empty argv', () => {
    expect(parseArgs([])).toEqual({ flags: {}, positional: [] });
  });

  it('treats listed BOOLEAN_FLAGS as true even when next arg looks value-like', () => {
    // Must cover the entire yolo/autonomy boolean family — if any of these
    // drops out of BOOLEAN_FLAGS, parseArgs consumes the following token as
    // the flag's value and launch scripts silently lose an argument.
    for (const flag of [
      'yolo',
      'no-yolo',
      'yolo-destructive',
      'confirm-destructive',
      'force-all-yolo',
      'verbose',
      'help',
      'tui',
    ]) {
      expect(BOOLEAN_FLAGS.has(flag)).toBe(true);
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

  it('short flag that is not a known boolean consumes the next token as its value', () => {
    // `auth local -m <spec>` must classify like `--model <spec>`; forcing
    // shorts boolean dropped the value into `positional`, where the
    // auth-local handler read it as the preset name.
    expect(parseArgs(['auth', 'local', '-m', 'llama3.1:8b'])).toEqual({
      flags: { m: 'llama3.1:8b' },
      positional: ['auth', 'local'],
    });
  });

  it('boolean short flags (-v/-y/-h) never consume a following token', () => {
    expect(parseArgs(['-v', 'task'])).toEqual({ flags: { verbose: true }, positional: ['task'] });
    expect(parseArgs(['-y', 'task'])).toEqual({ flags: { yes: true }, positional: ['task'] });
    // (avoid surface-alias words like `webui` — normalizeSurfaceAliases
    // legitimately converts them from positional to flag)
    expect(parseArgs(['-h', 'auth'])).toEqual({ flags: { help: true }, positional: ['auth'] });
  });

  it('non-boolean short flag followed by another flag or end of argv stays boolean', () => {
    expect(parseArgs(['-m', '--yolo'])).toEqual({ flags: { m: true, yolo: true }, positional: [] });
    expect(parseArgs(['-m'])).toEqual({ flags: { m: true }, positional: [] });
  });

  it('preserves the session id consumed by the value-taking --resume flag', () => {
    expect(BOOLEAN_FLAGS.has('resume')).toBe(false);
    expect(parseArgs(['--resume', 'sess1'])).toEqual({
      flags: { resume: 'sess1' },
      positional: [],
    });
  });

  it('expands -c to a boolean --continue that keeps the following prompt', () => {
    expect(parseArgs(['-c', 'next step'])).toEqual({
      flags: { continue: true },
      positional: ['next step'],
    });
    expect(parseArgs(['--continue', 'next step'])).toEqual({
      flags: { continue: true },
      positional: ['next step'],
    });
  });

  it('expands -r to --resume, with or without a session id', () => {
    expect(parseArgs(['-r', 'sess1'])).toEqual({ flags: { resume: 'sess1' }, positional: [] });
    expect(parseArgs(['-r'])).toEqual({ flags: { resume: true }, positional: [] });
  });

  it('keeps the task after --record (a boolean the replay wiring reads as === true)', () => {
    expect(parseArgs(['--record', 'fix it'])).toEqual({
      flags: { record: true },
      positional: ['fix it'],
    });
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

  it('treats --no-yolo as a boolean flag without consuming the task', () => {
    expect(BOOLEAN_FLAGS.has('no-yolo')).toBe(true);
    expect(parseArgs(['--no-yolo', 'review this'])).toEqual({
      flags: { 'no-yolo': true },
      positional: ['review this'],
    });
  });

  it('treats --webui-require-token as a boolean flag', () => {
    expect(BOOLEAN_FLAGS.has('webui-require-token')).toBe(true);
    const r = parseArgs(['--webui', '--webui-require-token', 'prompt']);
    expect(r.flags['webui-require-token']).toBe(true);
    expect(r.positional).toContain('prompt');
  });

  it('keeps update boolean flags from consuming following positional tokens', () => {
    expect(parseArgs(['update', '--check-only', 'sentinel'])).toEqual({
      flags: { 'check-only': true },
      positional: ['update', 'sentinel'],
    });
    expect(parseArgs(['update', '--allow-scripts'])).toEqual({
      flags: { 'allow-scripts': true },
      positional: ['update'],
    });
  });

  it('normalizes webui, vibeui, and hq launcher subcommands to flags', () => {
    expect(parseArgs(['webui', '--open'])).toEqual({
      flags: { webui: true, open: true },
      positional: [],
    });
    expect(parseArgs(['vibeui', '--open'])).toEqual({
      flags: { open: true, vibeui: true, webui: true },
      positional: [],
    });
    expect(parseArgs(['hq'])).toEqual({ flags: { hq: true }, positional: [] });
    expect(parseArgs(['hq', 'serve', '--port', '4000'])).toEqual({
      flags: { hq: true, port: '4000' },
      positional: [],
    });
  });

  it('redirects the retired SimpleUI launch shapes to VibeUI and marks the retirement', () => {
    const redirected = { vibeui: true, webui: true, 'simpleui-retired': true };
    expect(parseArgs(['--simpleui'])).toEqual({ flags: redirected, positional: [] });
    expect(parseArgs(['simpleui', '--open'])).toEqual({
      flags: { ...redirected, open: true },
      positional: [],
    });
    // `--simpleui` stays boolean so it never swallows the next positional.
    expect(parseArgs(['--simpleui', 'task'])).toEqual({ flags: redirected, positional: ['task'] });
  });

  it('still parses the retired --full-auto flag as a boolean', () => {
    expect(parseArgs(['vibeui', '--full-auto', '--open'])).toEqual({
      flags: { vibeui: true, webui: true, 'full-auto': true, open: true },
      positional: [],
    });
  });

  it('parses --prompt as a value flag (one-shot prompt text reaches the agent)', () => {
    // Every consumer string-checks flags['prompt'] (execution.ts unshifts it
    // into the query, boot/execution-mode.ts selects single-shot from it,
    // boot.ts and boot/launch-menu.ts gate on it), and launch-menu documents
    // `--prompt <x>`. While 'prompt' sat in BOOLEAN_FLAGS the value was
    // demoted to a positional and the flag contract was dead on arrival.
    expect(BOOLEAN_FLAGS.has('prompt')).toBe(false);
    expect(parseArgs(['--prompt', 'deploy notes'])).toEqual({
      flags: { prompt: 'deploy notes' },
      positional: [],
    });
  });

  it('runs a surface-keyword --prompt value as a one-shot query, not a surface launch', () => {
    // Regression: `wstack --prompt hq` used to normalize the demoted
    // positional into flags.hq / flags.webui with an empty positional, so the
    // CLI launched that surface instead of running the user's prompt.
    for (const kw of ['hq', 'webui']) {
      const r = parseArgs(['--prompt', kw]);
      expect(r.flags['prompt']).toBe(kw);
      expect(r.positional).toEqual([]);
      expect(resolveExecutionMode(r.positional, r.flags)).toBe('single-shot');
    }
  });

  it('still treats a valueless --prompt as boolean true', () => {
    // A bare --prompt (next token is another flag) stays truthy, which every
    // string-checking consumer reads as "no prompt supplied".
    expect(parseArgs(['--prompt', '--yolo'])).toEqual({
      flags: { prompt: true, yolo: true },
      positional: [],
    });
  });

  it('keeps hq token management as a real subcommand', () => {
    const r = parseArgs(['hq', 'token', 'list', '--client']);
    expect(r.flags.client).toBe(true);
    expect(r.flags.hq).toBeUndefined();
    expect(r.positional).toEqual(['hq', 'token', 'list']);
  });

  it('does not consume the token label after the boolean --client flag', () => {
    const r = parseArgs(['hq', 'token', 'create', '--client', 'build-agent']);
    expect(r.flags.client).toBe(true);
    expect(r.positional).toEqual(['hq', 'token', 'create', 'build-agent']);
  });

  it('treats --strict-port as a boolean HQ flag', () => {
    const r = parseArgs(['hq', 'serve', '--strict-port', 'leftover']);
    expect(r.flags['strict-port']).toBe(true);
    expect(r.positional).toEqual(['leftover']);
  });

  it.each(['no-probe', 'probe-only', 'no-key'])(
    'treats --%s as a boolean flag without swallowing following positional',
    (flag) => {
      const r = parseArgs(['auth', 'local', `--${flag}`, 'ollama']);
      expect(r.flags[flag]).toBe(true);
      expect(r.positional).toEqual(['auth', 'local', 'ollama']);
    },
  );

  it.each(['vision', 'tools', 'reasoning'])(
    'treats --%s as a boolean capability switch without swallowing positional',
    (flag) => {
      const r = parseArgs(['models', 'add', `--${flag}`, 'my-custom-model']);
      expect(r.flags[flag]).toBe(true);
      expect(r.positional).toEqual(['models', 'add', 'my-custom-model']);
    },
  );

  it('parses space-form --tools as boolean + positional CSV (whitelist recovered by mcp serve)', () => {
    // 'tools' is a BOOLEAN_FLAGS member (models-add capability toggle), so the
    // space form cannot carry its value inline; mcp serve recovers the CSV
    // from the positional (parseToolsFlag). Lock the parse shape so a future
    // BOOLEAN_FLAGS change cannot silently break `mcp serve --tools a,b,c`.
    expect(BOOLEAN_FLAGS.has('tools')).toBe(true);
    const r = parseArgs(['mcp', 'serve', '--tools', 'read,grep']);
    expect(r.flags.tools).toBe(true);
    expect(r.positional).toEqual(['mcp', 'serve', 'read,grep']);
    // Equals form still carries the value inline.
    const eq = parseArgs(['mcp', 'serve', '--tools=read,grep']);
    expect(eq.flags.tools).toBe('read,grep');
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

  it('parses project rekey confirmation flags in any argv position', () => {
    expect(parseArgs(['project', 'rekey', '--yes'])).toEqual({
      flags: { yes: true },
      positional: ['project', 'rekey'],
    });
    expect(parseArgs(['project', '-y', 'rekey'])).toEqual({
      flags: { yes: true },
      positional: ['project', 'rekey'],
    });
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

  it('unknown flag owns its value token — value must not leak into positional', () => {
    // Regression: `wstack auth local --model <spec>` (no --name) fed the
    // model spec into positional[1], which the auth-local handler reads as
    // the preset name — runAuthLocal then hard-failed with
    // `Unknown local server "<spec>"`.
    expect(parseAuthFlags(['local', '--model', 'llama3.1:8b']).positional).toEqual(['local']);
  });

  it('unknown short flag owns its value token', () => {
    expect(parseAuthFlags(['local', '-m', 'llama3.1:8b']).positional).toEqual(['local']);
  });

  it('unknown boolean flag does not swallow the following positional', () => {
    expect(parseAuthFlags(['local', '--no-key', 'ollama']).positional).toEqual(['local', 'ollama']);
  });

  it('bare -- separator does not consume the following token', () => {
    expect(parseAuthFlags(['local', '--', 'ollama']).positional).toEqual(['local', 'ollama']);
  });

  it('inline unknown flag form does not consume the next token', () => {
    expect(parseAuthFlags(['local', '--model=llama3.1:8b', 'extra']).positional).toEqual([
      'local',
      'extra',
    ]);
  });

  it('unknown flag followed by another flag does not consume it', () => {
    expect(parseAuthFlags(['local', '--model', '--no-key', 'ollama']).positional).toEqual([
      'local',
      'ollama',
    ]);
  });

  it('parses `--audit <target>` into AuthFlags.audit', () => {
    expect(parseAuthFlags(['local', '--audit', 'stdout']).audit).toBe('stdout');
    expect(parseAuthFlags(['local', '--audit', 'stderr']).audit).toBe('stderr');
    expect(parseAuthFlags(['local', '--audit', '/var/log/auth.jsonl']).audit).toBe(
      '/var/log/auth.jsonl',
    );
  });

  it('parses a bare `--audit` as true (documented stdout default)', () => {
    expect(parseAuthFlags(['local', '--audit']).audit).toBe(true);
    expect(parseAuthFlags(['local', '--audit', '--no-key']).audit).toBe(true);
    // `--audit=` (empty target) is ignored, like `--label=`.
    expect(parseAuthFlags(['local', '--audit=']).audit).toBeUndefined();
    expect(parseAuthFlags(['local']).audit).toBeUndefined();
  });

  it('parses the inline `--audit=<target>` form without consuming the next token', () => {
    const r = parseAuthFlags(['local', '--audit=stderr', 'ollama']);
    expect(r.audit).toBe('stderr');
    expect(r.positional).toEqual(['local', 'ollama']);
  });
});

describe('parseArgs — inline boolean values', () => {
  it('reads --switch=true / --switch=false as booleans, not strings every reader ignores', () => {
    const { flags } = parseArgs([
      '--restricted=true',
      '--safe-mode=TRUE',
      '--dry-run=false',
      '--model=true',
    ]);
    expect(flags['restricted']).toBe(true);
    expect(flags['safe-mode']).toBe(true);
    expect(flags['dry-run']).toBe(false);
    expect(flags['model']).toBe('true');
  });
});
