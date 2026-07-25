/**
 * @wrongstack/plugins — commit-validator message extraction.
 *
 * The validator reads the commit message out of a `bash` command line.
 * Three defects made it check the wrong text, or nothing at all:
 *
 *  1. It collected every double-quoted `-m` value, THEN every
 *     single-quoted one. Git joins repeated `-m` values in command-line
 *     order and the first is the subject — so a mixed-quoting command put
 *     the body first and the body got validated as the subject.
 *  2. A bare (unquoted) `-m value` matched nothing, so the hook found no
 *     message and let the commit through unchecked.
 *  3. The `--message=…` spelling was likewise invisible.
 */
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const plugin = (await import('../src/commit-validator/index.js')).default;

interface HookInput {
  event: string;
  toolName: string;
  toolInput: unknown;
  cwd: string;
}

interface HookOutcome {
  decision?: string;
  reason?: string;
  additionalContext?: string;
}

function makeApi(extensions: Record<string, unknown> = {}) {
  const hooks: Array<{ event: string; hook: (i: HookInput) => HookOutcome | undefined }> = [];
  const tools: Array<{ name: string; execute(i: unknown): Promise<Any> }> = [];
  return {
    tools: { register: (t: Any) => tools.push(t), list: () => tools },
    slashCommands: { register() {} },
    config: { extensions },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    metrics: { counter() {}, histogram() {}, gauge() {} },
    session: { append: async () => {} },
    extensions: { register: () => ({ unregister() {} }) },
    registerSystemPromptContributor: () => () => {},
    registerHook: (event: string, _m: unknown, hook: Any) => {
      hooks.push({ event, hook });
      return () => {};
    },
    onEvent: () => () => {},
    onPattern: () => () => {},
    emitCustom() {},
    onConfigChange: () => () => {},
    _hooks: hooks,
    _tools: tools,
  };
}

function preHook(api: { _hooks: Array<{ event: string; hook: (i: HookInput) => Any }> }) {
  const h = api._hooks.find((x) => x.event === 'PreToolUse');
  if (!h) throw new Error('PreToolUse hook not registered');
  return h.hook;
}

/** Run the gate against a raw bash command line. The hook is async. */
async function check(
  command: string,
  extensions: Record<string, unknown> = {},
): Promise<HookOutcome | undefined> {
  const api = makeApi({ 'commit-validator': { enabled: true, mode: 'block', ...extensions } });
  plugin.setup(api as Any);
  const out = await preHook(api as Any)({
    event: 'PreToolUse',
    toolName: 'bash',
    toolInput: { command },
    cwd: '/tmp',
  });
  plugin.teardown?.(api as Any);
  return out;
}

describe('message extraction — ordering', () => {
  it('validates the first -m as the subject regardless of quote style', async () => {
    // Subject is valid conventional-commit; the body is not. Reading them
    // in the wrong order rejects a perfectly good commit.
    const out = await check(`git commit -m 'feat: add the thing' -m "some free-form body"`);
    expect(out?.decision).not.toBe('block');
  });

  it('still blocks when the FIRST -m is the invalid one', async () => {
    const out = await check(`git commit -m "not a conventional subject" -m 'feat: body'`);
    expect(out?.decision).toBe('block');
  });

  it('preserves order across three mixed-quoted flags', async () => {
    const out = await check(`git commit -m "fix: a" -m 'b' -m "c"`);
    expect(out?.decision).not.toBe('block');
  });
});

describe('message extraction — flag spellings', () => {
  it('sees a bare unquoted -m value', async () => {
    // Previously matched nothing, so the gate silently let it through.
    const out = await check('git commit -m totally-invalid-subject');
    expect(out?.decision).toBe('block');
  });

  it('accepts a valid bare unquoted -m value', async () => {
    const out = await check('git commit -m chore:tidy');
    expect(out?.decision).not.toBe('block');
  });

  it('sees --message="…"', async () => {
    const out = await check('git commit --message="nope not conventional"');
    expect(out?.decision).toBe('block');
  });

  it("sees --message='…'", async () => {
    const out = await check("git commit --message='nope not conventional'");
    expect(out?.decision).toBe('block');
  });

  it('sees -m="…"', async () => {
    const out = await check('git commit -m="nope not conventional"');
    expect(out?.decision).toBe('block');
  });

  it('still validates the plain quoted form', async () => {
    expect((await check('git commit -m "feat: fine"'))?.decision).not.toBe('block');
    expect((await check('git commit -m "broken subject"'))?.decision).toBe('block');
  });
});

describe('message extraction — non-commit commands', () => {
  it('ignores a command that is not a git commit', async () => {
    expect((await check('echo -m "not a commit"'))?.decision).not.toBe('block');
  });

  it('lets a commit with no message flag through', async () => {
    // Nothing to validate — git will open an editor.
    expect((await check('git commit --amend --no-edit'))?.decision).not.toBe('block');
  });
});
