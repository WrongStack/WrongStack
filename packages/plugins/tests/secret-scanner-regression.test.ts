/**
 * @wrongstack/plugins — secret-scanner regression tests.
 *
 * Three defects, each of which made the gate quietly weaker than it looked:
 *
 *  1. The combined regex maps a matched capture group back to the pattern
 *     that fired, but assumed pattern `i` owns group `i + 1`. That holds
 *     only while no pattern contains a capture group of its own — and
 *     user-supplied `customPatterns` are appended verbatim, so one custom
 *     pattern spelled `(a|b)_…` shifted every later pattern and matches
 *     were attributed to (and redacted as) the wrong type.
 *  2. The compiled-regex cache keyed on pattern *type names* only, so
 *     changing a custom pattern's regex under the same type reused the
 *     stale compiled regex and the edit had no effect.
 *  3. Any input longer than the scan window was skipped outright, making
 *     file size itself a bypass.
 */
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const secretScannerPlugin = (await import('../src/secret-scanner/index.js')).default;

interface RegisteredTool {
  name: string;
  execute(input: unknown): Promise<unknown>;
}

interface HookInput {
  event: string;
  toolName: string;
  toolInput: unknown;
  cwd: string;
}

interface HookOutcome {
  decision?: string;
  reason?: string;
  modifiedInput?: unknown;
}

interface MockApi {
  tools: { register(t: RegisteredTool): void; list(): RegisteredTool[] };
  slashCommands: { register(): void };
  config: { extensions?: Record<string, unknown> };
  log: { info(): void; warn(): void; error(): void; debug(): void };
  metrics: { counter(): void; histogram(): void; gauge(): void };
  session: { append(): Promise<void> };
  registerHook(event: string, matcher: unknown, hook: unknown): () => void;
  onEvent(): () => void;
  onPattern(): () => void;
  emitCustom(): void;
  onConfigChange(): () => void;
  _tools: RegisteredTool[];
  _hooks: Array<{ event: string; hook: (i: HookInput) => HookOutcome | undefined }>;
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  const tools: RegisteredTool[] = [];
  const hooks: MockApi['_hooks'] = [];
  return {
    tools: {
      register(t: RegisteredTool) {
        tools.push(t);
      },
      list: () => tools,
    },
    slashCommands: { register() {} },
    config: { extensions: overrides.extensions ?? {} },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    metrics: { counter() {}, histogram() {}, gauge() {} },
    session: { append: async () => {} },
    registerHook(event: string, _matcher: unknown, hook: unknown) {
      hooks.push({ event, hook: hook as (i: HookInput) => HookOutcome | undefined });
      return () => {};
    },
    onEvent: () => () => {},
    onPattern: () => () => {},
    emitCustom() {},
    onConfigChange: () => () => {},
    _tools: tools,
    _hooks: hooks,
  };
}

function getTool(api: MockApi, name: string): RegisteredTool {
  const t = api._tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
}

/** The PreToolUse hook (the blocking/redacting one). */
function getPreHook(api: MockApi): (i: HookInput) => HookOutcome | undefined {
  const h = api._hooks.find((x) => x.event === 'PreToolUse');
  if (!h) throw new Error('PreToolUse hook not registered');
  return h.hook;
}

function githubPat(): string {
  return `ghp_${'a'.repeat(36)}`;
}

async function matchedTypes(api: MockApi, text: string): Promise<string[]> {
  const res = (await getTool(api, 'secret_scanner_test').execute({ text })) as {
    matched: string[];
  };
  return res.matched;
}

describe('capture-group offsets', () => {
  it('attributes matches to the right type despite inner groups', async () => {
    const api = makeApi({
      extensions: {
        'secret-scanner': {
          customPatterns: [
            // Two inner groups — consumes three group slots, not one.
            { type: 'first_custom', regex: '(?:X)(AAA|BBB)-(\\d{6})' },
            { type: 'second_custom', regex: 'ZZZ-[0-9]{8}' },
          ],
        },
      },
    });
    secretScannerPlugin.setup(api as Any);

    expect(await matchedTypes(api, 'XAAA-123456')).toContain('first_custom');
    // The pattern AFTER the group-bearing one must still be identified.
    const second = await matchedTypes(api, 'ZZZ-12345678');
    expect(second).toContain('second_custom');
    expect(second).not.toContain('first_custom');

    secretScannerPlugin.teardown?.(api as Any);
  });

  it('redacts under the correct type label', () => {
    const api = makeApi({
      extensions: {
        'secret-scanner': {
          mode: 'redact',
          customPatterns: [
            { type: 'grouped_one', regex: '(?:P)(QQ|RR)-(\\d{5})' },
            { type: 'plain_two', regex: 'WWW-[0-9]{7}' },
          ],
        },
      },
    });
    secretScannerPlugin.setup(api as Any);
    const result = getPreHook(api)({
      event: 'PreToolUse',
      toolName: 'write',
      toolInput: { path: 'a.txt', content: 'value WWW-1234567 here' },
      cwd: '/tmp',
    });
    const modified = result?.modifiedInput as { content: string } | undefined;
    expect(modified?.content).toContain('[REDACTED:plain_two]');
    expect(modified?.content).not.toContain('[REDACTED:grouped_one]');
    secretScannerPlugin.teardown?.(api as Any);
  });
});

describe('pattern cache invalidation', () => {
  it('recompiles when a custom regex changes under the same type name', async () => {
    const firstApi = makeApi({
      extensions: {
        'secret-scanner': {
          customPatterns: [{ type: 'same_name', regex: 'ALPHA-[0-9]{6}' }],
        },
      },
    });
    secretScannerPlugin.setup(firstApi as Any);
    expect(await matchedTypes(firstApi, 'ALPHA-123456')).toContain('same_name');
    secretScannerPlugin.teardown?.(firstApi as Any);

    // Same type name, different regex.
    const secondApi = makeApi({
      extensions: {
        'secret-scanner': {
          customPatterns: [{ type: 'same_name', regex: 'BETA-[0-9]{6}' }],
        },
      },
    });
    secretScannerPlugin.setup(secondApi as Any);
    expect(await matchedTypes(secondApi, 'BETA-654321')).toContain('same_name');
    // The superseded regex must no longer fire.
    expect(await matchedTypes(secondApi, 'ALPHA-123456')).not.toContain('same_name');
    secretScannerPlugin.teardown?.(secondApi as Any);
  });
});

describe('large inputs are scanned, not skipped', () => {
  it('blocks a credential buried deep inside a large file', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as Any);
    const filler = 'x'.repeat(250_000);
    const result = getPreHook(api)({
      event: 'PreToolUse',
      toolName: 'write',
      toolInput: { path: 'big.txt', content: `${filler}\n${githubPat()}\n${filler}` },
      cwd: '/tmp',
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('github_pat');
    secretScannerPlugin.teardown?.(api as Any);
  });

  it('finds a credential straddling a window boundary', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as Any);
    const token = githubPat();
    // Straddle the 100_000-char window edge. The separator matters: the
    // patterns carry a `(?<![A-Za-z0-9])` boundary guard, so the token has
    // to start at a non-alphanumeric character to be a match at all.
    const prefix = `${'y'.repeat(100_000 - Math.floor(token.length / 2) - 1)}\n`;
    const result = getPreHook(api)({
      event: 'PreToolUse',
      toolName: 'write',
      toolInput: { path: 'edge.txt', content: `${prefix}${token}\n${'y'.repeat(50_000)}` },
      cwd: '/tmp',
    });
    expect(result?.decision).toBe('block');
    secretScannerPlugin.teardown?.(api as Any);
  });

  it('reports an unscannable input rather than treating it as clean', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as Any);
    const result = getPreHook(api)({
      event: 'PreToolUse',
      toolName: 'write',
      toolInput: { path: 'huge.txt', content: 'z'.repeat(9 * 1024 * 1024) },
      cwd: '/tmp',
    });
    // "We could not check this" must not render as "this is fine".
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('unscannable');
    secretScannerPlugin.teardown?.(api as Any);
  });
});

describe('expanded credential coverage', () => {
  it.each([
    ['github_oauth_token', `ghs_${'a'.repeat(36)}`],
    ['gitlab_pat', `glpat-${'A'.repeat(20)}`],
    ['npm_token', `npm_${'b'.repeat(36)}`],
    ['slack_app_token', `xapp-1-${'A'.repeat(20)}`],
    ['sendgrid_key', `SG.${'a'.repeat(22)}.${'b'.repeat(43)}`],
    ['digitalocean_token', `dop_v1_${'a'.repeat(64)}`],
    ['docker_pat', `dckr_pat_${'a'.repeat(30)}`],
    ['linear_key', `lin_api_${'c'.repeat(40)}`],
    ['google_oauth_client_secret', `GOCSPX-${'d'.repeat(28)}`],
    ['shopify_token', `shpat_${'a'.repeat(32)}`],
  ])('detects %s', async (type, sample) => {
    const api = makeApi();
    secretScannerPlugin.setup(api as Any);
    expect(await matchedTypes(api, `token = ${sample}`)).toContain(type);
    secretScannerPlugin.teardown?.(api as Any);
  });
});
