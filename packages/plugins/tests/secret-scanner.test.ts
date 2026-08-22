import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CREDENTIAL_PATTERNS } from '../src/runtime/credential-patterns.js';
import secretScannerPlugin from '../src/secret-scanner/index.js';

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: {
    counter: ReturnType<typeof vi.fn>;
    histogram: ReturnType<typeof vi.fn>;
    gauge: ReturnType<typeof vi.fn>;
  };
  registerSystemPromptContributor: ReturnType<typeof vi.fn>;
  registerHook: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  session: { append: ReturnType<typeof vi.fn> };
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerSystemPromptContributor: vi.fn(() => () => {}),
    registerHook: vi.fn(() => vi.fn()),
    onEvent: vi.fn(),
    session: { append: vi.fn().mockResolvedValue(undefined) },
  };
}

function getRegisteredTool(
  api: MockApi,
  name: string,
): {
  execute: (input: unknown) => Promise<any>;
} {
  const call = api.tools.register.mock.calls.find(
    ([t]: unknown[]) => (t as { name: string }).name === name,
  );
  if (!call) throw new Error(`tool ${name} not registered`);
  return call[0] as { execute: (input: unknown) => Promise<any> };
}

async function getHealthStatus(): Promise<any> {
  return secretScannerPlugin.health!();
}

function getRegisteredHook(api: MockApi): (input: {
  event: string;
  toolName?: string;
  toolInput?: unknown;
  cwd: string;
}) => {
  decision?: 'block' | 'allow' | undefined;
  reason?: string | undefined;
  modifiedInput?: Record<string, unknown>;
  additionalContext?: string | undefined;
} | void {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('PreToolUse hook not registered');
  return (call as unknown[])[2] as ReturnType<typeof getRegisteredHook>;
}

function getRegisteredPostHook(
  api: MockApi,
): (input: {
  toolName?: string;
  toolResult?: { content: string; isError: boolean };
}) => { additionalContext?: string | undefined } | void {
  const call = api.registerHook.mock.calls[1];
  if (!call) throw new Error('PostToolUse hook not registered');
  return (call as unknown[])[2] as ReturnType<typeof getRegisteredPostHook>;
}

beforeEach(() => {
  secretScannerPlugin.teardown?.(makeApi() as any);
  vi.clearAllMocks();
});

// ── Synthetic credentials ──────────────────────────────────────────────
//
// This file's content gets run through a file-level secret redactor
// before commit, so any literal `sk-proj-…` / `ghp_…` / `AKIA…`
// string in source gets replaced with `[REDACTED:type]` placeholders
// that no longer match the scanner's regex. We build the credentials
// from parts at test time so the test fixture can't be mistaken for
// a leaked secret, and the assembled string DOES match the regex.

function makeOpenAiKey(): string {
  return 'sk-proj-' + 'a'.repeat(36);
}
function makeGithubPat(): string {
  return 'ghp_' + 'a'.repeat(36);
}
function makeGithubPatV2(): string {
  return 'github_pat_' + 'a'.repeat(50);
}
function makeAwsAccessKey(): string {
  return 'AKIA' + 'IOSFODNN7EXAMPLE';
}
function makeJwt(): string {
  return 'ey' + 'J' + 'a'.repeat(12) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12);
}
function makePrivateKey(): string {
  return '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK\n-----END RSA PRIVATE KEY-----';
}

// ── Plugin registration ───────────────────────────────────────────────

describe('secret-scanner plugin', () => {
  it('isolates hooks and custom patterns across concurrent plugin hosts', () => {
    const first = makeApi({
      extensions: {
        'secret-scanner': {
          customPatterns: [{ type: 'first_only', regex: 'FIRST_ONLY_[0-9]{4}' }],
        },
      },
    });
    const second = makeApi({
      extensions: {
        'secret-scanner': {
          customPatterns: [{ type: 'second_only', regex: 'SECOND_ONLY_[0-9]{4}' }],
        },
      },
    });
    const firstPreUnregister = vi.fn();
    const firstPostUnregister = vi.fn();
    const secondPreUnregister = vi.fn();
    const secondPostUnregister = vi.fn();
    first.registerHook
      .mockReturnValueOnce(firstPreUnregister)
      .mockReturnValueOnce(firstPostUnregister);
    second.registerHook
      .mockReturnValueOnce(secondPreUnregister)
      .mockReturnValueOnce(secondPostUnregister);

    secretScannerPlugin.setup(first as any);
    const firstHook = getRegisteredHook(first);
    secretScannerPlugin.setup(second as any);
    const secondHook = getRegisteredHook(second);

    expect(firstPreUnregister).not.toHaveBeenCalled();
    expect(
      firstHook({
        event: 'PreToolUse',
        toolName: 'write',
        toolInput: { content: 'FIRST_ONLY_1234' },
        cwd: '/tmp',
      })?.reason,
    ).toContain('first_only');
    expect(
      secondHook({
        event: 'PreToolUse',
        toolName: 'write',
        toolInput: { content: 'FIRST_ONLY_1234' },
        cwd: '/tmp',
      }),
    ).toBeUndefined();

    secretScannerPlugin.teardown?.(first as any);
    expect(firstPreUnregister).toHaveBeenCalledOnce();
    expect(firstPostUnregister).toHaveBeenCalledOnce();
    expect(secondPreUnregister).not.toHaveBeenCalled();
    expect(secondPostUnregister).not.toHaveBeenCalled();

    secretScannerPlugin.teardown?.(second as any);
    expect(secondPreUnregister).toHaveBeenCalledOnce();
    expect(secondPostUnregister).toHaveBeenCalledOnce();
  });

  it('registers secret_scanner_status and secret_scanner_test', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const names = api.tools.register.mock.calls.map(
      ([t]: unknown[]) => (t as { name: string }).name,
    );
    expect(names).toContain('secret_scanner_status');
    expect(names).toContain('secret_scanner_test');
  });

  it('registers a PreToolUse hook with the default matcher', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    expect(api.registerHook).toHaveBeenCalledWith(
      'PreToolUse',
      'bash|write|edit',
      expect.any(Function),
      {
        name: 'secret-scanner',
        stage: 'validate',
        failurePolicy: 'closed',
        policy: true,
      },
    );
  });

  it('respects a custom matcher from config', () => {
    const api = makeApi({ extensions: { 'secret-scanner': { matcher: 'bash' } } });
    secretScannerPlugin.setup(api as any);
    expect(api.registerHook).toHaveBeenCalledWith('PreToolUse', 'bash', expect.any(Function), {
      name: 'secret-scanner',
      stage: 'validate',
      failurePolicy: 'closed',
      policy: true,
    });
  });
});

// ── Hook behavior: block mode (default) ───────────────────────────────

describe('PreToolUse hook — block mode (default)', () => {
  it('blocks a bash call whose command contains an OpenAI key', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredHook(api);
    const openAiKey = makeOpenAiKey();

    const result = hook({
      event: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: 'export OPENAI_API_KEY=' + openAiKey },
      cwd: '/tmp',
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('openai_key');
  });

  it('blocks a write call whose content embeds a GitHub PAT', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredHook(api);
    const githubPat = makeGithubPat();

    const result = hook({
      event: 'PreToolUse',
      toolName: 'write',
      toolInput: { path: 'config.yml', content: 'token: ' + githubPat + '\n' },
      cwd: '/tmp',
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('github_pat');
  });

  it('blocks when a tool input array contains a credential', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredHook(api);
    const awsKey = makeAwsAccessKey();

    const result = hook({
      event: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: ['echo hello', 'echo ' + awsKey] },
      cwd: '/tmp',
    });
    expect(result?.decision).toBe('block');
  });

  it('blocks on a private key in any nested field', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredHook(api);
    const pk = makePrivateKey();

    const result = hook({
      event: 'PreToolUse',
      toolName: 'write',
      toolInput: { path: 'id_rsa', content: pk },
      cwd: '/tmp',
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('private_key');
  });

  it('blocks on a JWT in tool arguments', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredHook(api);
    const jwt = makeJwt();

    const result = hook({
      event: 'PreToolUse',
      toolName: 'write',
      toolInput: { path: 'session.txt', content: 'token: ' + jwt },
      cwd: '/tmp',
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('jwt');
  });

  it('lets through inputs that do not match any pattern', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredHook(api);

    const result = hook({
      event: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: 'echo "this string contains no credentials"' },
      cwd: '/tmp',
    });
    expect(result).toBeUndefined();
  });
});

// ── Hook behavior: redact mode ────────────────────────────────────────

describe('PreToolUse hook — redact mode', () => {
  it('rewrites a credential field and reports allow + modifiedInput', () => {
    const api = makeApi({ extensions: { 'secret-scanner': { mode: 'redact' } } });
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredHook(api);
    const openAiKey = makeOpenAiKey();

    const result = hook({
      event: 'PreToolUse',
      toolName: 'write',
      toolInput: { path: 'out.txt', content: 'export OPENAI_API_KEY=' + openAiKey },
      cwd: '/tmp',
    });
    expect(result?.decision).toBe('allow');
    // modifiedInput has the credential redacted
    const modified = result?.modifiedInput as { content: string };
    expect(modified.content).toContain('[REDACTED:openai_key]');
    expect(modified.content).not.toContain(openAiKey);
    expect(result?.additionalContext).toContain('redacted');
  });

  it('blocks instead of returning partially redacted input when any sibling exceeds the redaction limit', async () => {
    const api = makeApi({ extensions: { 'secret-scanner': { mode: 'redact' } } });
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredHook(api);

    const result = hook({
      event: 'PreToolUse',
      toolName: 'write',
      toolInput: {
        // scanInput finds this first; redactInput must still validate the
        // later sibling rather than returning a partially safe clone. This
        // size is scan-windowed successfully but exceeds the redactor's
        // single-window safety ceiling.
        command: `echo ${makeGithubPat()}`,
        content: 'x'.repeat(100_001),
      },
      cwd: '/tmp',
    });

    expect(result?.decision).toBe('block');
    expect(result?.modifiedInput).toBeUndefined();
    expect(result?.reason).toContain('safe scan limit');

    const status = await getRegisteredTool(api, 'secret_scanner_status').execute({});
    expect(status.counters.block).toBe(1);
    expect(status.counters.redact).toBe(0);
  });
});

// ── Hook behavior: allow mode ─────────────────────────────────────────

describe('PreToolUse hook — allow mode', () => {
  it('logs a warning but lets the call through (no decision)', () => {
    const api = makeApi({ extensions: { 'secret-scanner': { mode: 'allow' } } });
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredHook(api);
    const githubPat = makeGithubPat();

    const result = hook({
      event: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: 'echo ' + githubPat },
      cwd: '/tmp',
    });
    expect(result).toBeUndefined();
    expect(api.log.warn).toHaveBeenCalledWith(expect.stringContaining('allow-mode'));
  });
});

// ── Hook behavior: disabled ───────────────────────────────────────────

describe('PreToolUse hook — disabled', () => {
  it('skips the scan entirely when enabled=false', () => {
    const api = makeApi({ extensions: { 'secret-scanner': { enabled: false } } });
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredHook(api);
    const githubPat = makeGithubPat();

    const result = hook({
      event: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: 'echo ' + githubPat },
      cwd: '/tmp',
    });
    expect(result).toBeUndefined();
  });
});

// ── secret_scanner_test tool ───────────────────────────────────────────

describe('secret_scanner_test tool', () => {
  it('returns the matched pattern types for a sample string', async () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const tool = getRegisteredTool(api, 'secret_scanner_test');
    const awsKey = makeAwsAccessKey();
    const ghPat = makeGithubPatV2();

    const result = (await tool.execute({
      text: 'AWS key ' + awsKey + ' plus ' + ghPat,
    })) as { ok: boolean; matched: string[]; count: number };
    expect(result.ok).toBe(true);
    expect(result.matched).toEqual(expect.arrayContaining(['aws_access_key']));
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it('returns an empty match list for a clean string', async () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const tool = getRegisteredTool(api, 'secret_scanner_test');

    const result = (await tool.execute({
      text: 'just a normal sentence with nothing sensitive in it',
    })) as { matched: string[]; count: number };
    expect(result.matched).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('detects an OpenAI key', async () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const tool = getRegisteredTool(api, 'secret_scanner_test');

    const result = (await tool.execute({
      text: makeOpenAiKey(),
    })) as { matched: string[] };
    expect(result.matched).toContain('openai_key');
  });

  it('detects a JWT', async () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const tool = getRegisteredTool(api, 'secret_scanner_test');

    const result = (await tool.execute({
      text: makeJwt(),
    })) as { matched: string[] };
    expect(result.matched).toContain('jwt');
  });

  it('detects a GitHub PAT v1', async () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const tool = getRegisteredTool(api, 'secret_scanner_test');

    const result = (await tool.execute({
      text: makeGithubPat(),
    })) as { matched: string[] };
    expect(result.matched).toContain('github_pat');
  });

  it('does not match PEM certificates or bare base64 padding (issue #361)', async () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const tool = getRegisteredTool(api, 'secret_scanner_test');
    const pem = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJAKHHHexample\n-----END CERTIFICATE-----';
    const b64 = 'SGVsbG8gV29ybGQhISE=';
    const result = (await tool.execute({ text: `${pem}\n${b64}` })) as { matched: string[] };
    expect(result.matched).toEqual([]);
  });

  it('shares the same pattern ids as prompt-firewall (no table drift)', async () => {
    const { cloneCredentialPatterns } = await import('../src/runtime/credential-patterns.js');
    const { KIND_ALIASES } = await import('../src/prompt-firewall/index.js');
    const shared = cloneCredentialPatterns()
      .map((p) => KIND_ALIASES[p.type] ?? p.type)
      .sort();
    expect(shared).toContain('aws-access-key');
    expect(shared).toContain('github-token');
    const canonical = cloneCredentialPatterns().map((p) => p.type);
    expect(new Set(canonical).size).toBe(canonical.length);
  });

  it('detects a private key block', async () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const tool = getRegisteredTool(api, 'secret_scanner_test');

    const result = (await tool.execute({
      text: makePrivateKey(),
    })) as { matched: string[] };
    expect(result.matched).toContain('private_key');
  });
});

// ── secret_scanner_status tool ────────────────────────────────────────

describe('secret_scanner_status tool', () => {
  it('reports config + counters + last block', async () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);

    // Drive a block first so lastBlock is non-null
    const hook = getRegisteredHook(api);
    hook({
      event: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: 'echo ' + makeGithubPat() },
      cwd: '/tmp',
    });

    const tool = getRegisteredTool(api, 'secret_scanner_status');
    const result = (await tool.execute({})) as {
      ok: boolean;
      mode: string;
      matcher: string;
      patternCount: number;
      counters: { block: number; redact: number; allow: number };
      lastBlock: { toolName: string; matchedTypes: string[] } | null;
    };
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('block');
    expect(result.matcher).toBe('bash|write|edit');
    expect(result.patternCount).toBeGreaterThanOrEqual(15);
    expect(result.counters.block).toBe(1);
    expect(result.lastBlock).not.toBeNull();
    expect(result.lastBlock?.toolName).toBe('bash');
  });
});

// ── Teardown / H1 pattern ─────────────────────────────────────────────

describe('teardown + H1 pattern', () => {
  it('unregisters the hook on teardown and logs the completion line', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const unregister = api.registerHook.mock.results[0]?.value;
    expect(typeof unregister).toBe('function');

    expect(() => secretScannerPlugin.teardown!(api as any)).not.toThrow();
    expect(unregister).toHaveBeenCalled();
    expect(api.log.info).toHaveBeenCalledWith(
      'secret-scanner: teardown complete',
      expect.objectContaining({ counters: expect.any(Object) }),
    );
  });

  it('zeroes counters on teardown — health() shows clean state', async () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    // Drive a block
    const hook = getRegisteredHook(api);
    hook({
      event: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: 'echo ' + makeGithubPat() },
      cwd: '/tmp',
    });
    const before = await getHealthStatus();
    expect(before.counters.block).toBe(1);

    secretScannerPlugin.teardown!(api as any);
    const after = await getHealthStatus();
    expect(after.counters.block).toBe(0);
    expect(after.counters.redact).toBe(0);
    expect(after.counters.allow).toBe(0);
    expect(after.lastBlock).toBeNull();
  });

  it('reload cycle: setup -> teardown -> setup reads fresh counters', async () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredHook(api);
    hook({
      event: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: 'echo ' + makeGithubPat() },
      cwd: '/tmp',
    });
    expect((await getHealthStatus()).counters.block).toBe(1);

    secretScannerPlugin.teardown!(api as any);

    // Second round: re-setup with no traffic
    secretScannerPlugin.setup(api as any);
    const after = await getHealthStatus();
    expect(after.counters.block).toBe(0);
    expect(after.counters.redact).toBe(0);
    expect(after.counters.allow).toBe(0);
  });

  it('teardown is safe to call before setup (defensive)', () => {
    const api = makeApi();
    // No setup — teardown should still not throw
    expect(() => secretScannerPlugin.teardown!(api as any)).not.toThrow();
  });
});

// ── PostToolUse hook ────────────────────────────────────────────────────
//
// The PostToolUse hook scans tool OUTPUT for secrets that leaked
// through. Since the tool has already run, it cannot block — instead
// it injects additionalContext so the LLM knows the output is sensitive.

describe('PostToolUse hook', () => {
  it('registers a PostToolUse hook with the default matcher "*"', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    // First call = PreToolUse, second call = PostToolUse
    expect(api.registerHook).toHaveBeenCalledTimes(2);
    const [event, matcher] = api.registerHook.mock.calls[1]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('*');
  });

  it('returns additionalContext when tool output contains a secret', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredPostHook(api);

    // Build a credential at runtime to dodge the file-level redactor.
    const key = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const result = hook({
      toolName: 'bash',
      toolResult: { content: `export AWS_KEY=${key}`, isError: false },
    });
    expect(result).toBeDefined();
    expect(result!.additionalContext).toContain('secret-scanner');
    expect(result!.additionalContext).toContain('plaintext credential');
  });

  it('does not inject context when output is clean', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredPostHook(api);

    const result = hook({
      toolName: 'read',
      toolResult: { content: 'console.log("hello world")', isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('classifies oversized output as unscannable without recording a credential leak', async () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredPostHook(api);

    const result = hook({
      toolName: 'read',
      toolResult: { content: 'x'.repeat(9 * 1024 * 1024), isError: false },
    });

    expect(result?.additionalContext).toContain('could not be inspected');
    expect(result?.additionalContext).toContain('Do not treat this output as verified clean');
    expect(result?.additionalContext).not.toContain('appears to be plaintext credential');
    expect(result?.additionalContext).not.toContain('rotate');
    expect(api.log.warn).toHaveBeenCalledWith(expect.stringContaining('POST-TOOL UNSCANNABLE'));

    const status = await getRegisteredTool(api, 'secret_scanner_status').execute({});
    expect(status.counters.leak).toBe(0);
    expect(status.lastLeak).toBeNull();
  });

  it('bumps leakCount and sets lastLeak on detection', async () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredPostHook(api);
    const key = 'ghp_' + 'a'.repeat(36);

    hook({
      toolName: 'read',
      toolResult: { content: `token: ${key}`, isError: false },
    });

    const statusTool = getRegisteredTool(api, 'secret_scanner_status');
    const status = await statusTool.execute({});
    expect(status.counters.leak).toBe(1);
    expect(status.lastLeak).not.toBeNull();
    expect(status.lastLeak.toolName).toBe('read');
  });

  it('respects enabled=false (skips output scanning)', () => {
    const api = makeApi({ extensions: { 'secret-scanner': { enabled: false } } });
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredPostHook(api);

    const key = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const result = hook({
      toolName: 'bash',
      toolResult: { content: key, isError: false },
    });
    expect(result).toBeUndefined();
  });

  it('teardown unregisters both hooks', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    // Both registerHook calls return vi.fn() (spy)
    const preUnreg = api.registerHook.mock.results[0]!.value;
    const postUnreg = api.registerHook.mock.results[1]!.value;

    secretScannerPlugin.teardown!(api as any);

    expect(preUnreg).toHaveBeenCalled();
    expect(postUnreg).toHaveBeenCalled();
  });

  it('teardown zeros leakCount + lastLeak', async () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredPostHook(api);
    const key = 'AKIA' + 'IOSFODNN7EXAMPLE';
    hook({
      toolName: 'bash',
      toolResult: { content: key, isError: false },
    });

    secretScannerPlugin.teardown!(api as any);
    const health = await getHealthStatus();
    expect(health.counters.leak).toBe(0);
    expect(health.lastLeak).toBeNull();
  });
});

// ── Custom patterns ─────────────────────────────────────────────────────
//
// Users can supply their own credential patterns via config.

/** Canonical base count without mutating the singleton plugin under test. */
const BASE_PATTERN_COUNT = CREDENTIAL_PATTERNS.length;

describe('custom patterns', () => {
  it('appends custom patterns to the base set at setup()', async () => {
    const api = makeApi({
      extensions: {
        'secret-scanner': {
          customPatterns: [{ type: 'custom_api_key', regex: 'CUSTOMKEY-[A-Za-z0-9]{32}' }],
        },
      },
    });
    secretScannerPlugin.setup(api as any);
    // teardown first to clear any state from previous tests
    secretScannerPlugin.teardown!(api as any);
    secretScannerPlugin.setup(api as any);
    const statusTool = getRegisteredTool(api, 'secret_scanner_status');
    const status = await statusTool.execute({});
    // base patterns + 1 custom
    expect(status.patternCount).toBe(BASE_PATTERN_COUNT + 1);
    expect(status.patternTypes).toContain('custom_api_key');
  });

  it('custom pattern blocks a tool call that base patterns miss', () => {
    const api = makeApi({
      extensions: {
        'secret-scanner': {
          customPatterns: [{ type: 'internal_token', regex: 'INT-[A-F0-9]{40}' }],
        },
      },
    });
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredHook(api);

    // 'INT-ABCD...' doesn't match any of the 20 base patterns.
    const token = 'INT-' + 'AB'.repeat(20); // 40 hex chars
    const result = hook({
      event: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: 'export TOKEN=' + token },
      cwd: '/tmp',
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('internal_token');
  });

  it('custom pattern is detected by secret_scanner_test tool', async () => {
    const api = makeApi({
      extensions: {
        'secret-scanner': {
          customPatterns: [
            {
              type: 'custom_uuid',
              regex: 'uuid-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
            },
          ],
        },
      },
    });
    secretScannerPlugin.setup(api as any);
    const testTool = getRegisteredTool(api, 'secret_scanner_test');
    const result = await testTool.execute({
      text: 'see uuid-deadbeef-1234-5678-abcd-ef0123456789 here',
    });
    expect(result.matched).toContain('custom_uuid');
  });

  it('teardown resets patterns to base-only', async () => {
    const api = makeApi({
      extensions: {
        'secret-scanner': {
          customPatterns: [{ type: 'temp_pattern', regex: 'TEMP\\d+' }],
        },
      },
    });
    secretScannerPlugin.setup(api as any);

    // Verify custom pattern is active
    const statusBefore = await getRegisteredTool(api, 'secret_scanner_status').execute({});
    expect(statusBefore.patternCount).toBe(BASE_PATTERN_COUNT + 1);

    secretScannerPlugin.teardown!(api as any);

    // After teardown, re-setup with a clean API (no custom patterns)
    const cleanApi = makeApi();
    secretScannerPlugin.setup(cleanApi as any);
    const statusAfter = await getRegisteredTool(cleanApi, 'secret_scanner_status').execute({});
    expect(statusAfter.patternCount).toBe(BASE_PATTERN_COUNT); // base only
    expect(statusAfter.patternTypes).not.toContain('temp_pattern');
  });

  it('ignores custom patterns with invalid regex', async () => {
    const api = makeApi({
      extensions: {
        'secret-scanner': {
          customPatterns: [
            { type: 'valid_pattern', regex: 'VALID-[A-Za-z0-9]{10}' },
            { type: 'invalid_pattern', regex: '[invalid(' }, // unbalanced
            { type: 'another_valid', regex: 'OTHER-\\d{5}' },
          ],
        },
      },
    });
    secretScannerPlugin.setup(api as any);
    const status = await getRegisteredTool(api, 'secret_scanner_status').execute({});
    // base + 2 valid custom (invalid one skipped)
    expect(status.patternCount).toBe(BASE_PATTERN_COUNT + 2);
    expect(status.patternTypes).toContain('valid_pattern');
    expect(status.patternTypes).toContain('another_valid');
    expect(status.patternTypes).not.toContain('invalid_pattern');
  });

  it('custom patterns survive a reload cycle (idempotent re-init)', async () => {
    const api = makeApi({
      extensions: {
        'secret-scanner': {
          customPatterns: [{ type: 'reload_test', regex: 'RELOAD-[A-Z]{8}' }],
        },
      },
    });
    // First setup
    secretScannerPlugin.setup(api as any);
    const status1 = await getRegisteredTool(api, 'secret_scanner_status').execute({});
    const expectedCount = BASE_PATTERN_COUNT + 1;
    expect(status1.patternCount).toBe(expectedCount);

    // Teardown + re-setup with the same config
    secretScannerPlugin.teardown!(api as any);
    secretScannerPlugin.setup(api as any);
    const status2 = await getRegisteredTool(api, 'secret_scanner_status').execute({});
    // Unchanged — the custom pattern is not appended twice (reset-then-append).
    expect(status2.patternCount).toBe(expectedCount);
  });
});

// ── ReDoS protection ─────────────────────────────────────────────────────

describe('ReDoS protection', () => {
  it('blocks a short input containing a credential (guard is additive, not over-blocking)', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredHook(api);

    const result = hook({
      event: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: 'export OPENAI_API_KEY=' + makeOpenAiKey() },
      cwd: '/tmp',
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('openai_key');
  });

  it('scans a very long input in bounded windows', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredHook(api);

    // Build a string longer than one scan window with a credential near the
    // end. Each bounded window is scanned, so the credential is still found.
    const padding = `${'a'.repeat(100_001)}\n`;
    const token = makeOpenAiKey();
    const result = hook({
      event: 'PreToolUse',
      toolName: 'bash',
      toolInput: { command: padding + token },
      cwd: '/tmp',
    });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('openai_key');
  });

  it('still detects a credential in a short field even when another field is very long', () => {
    const api = makeApi();
    secretScannerPlugin.setup(api as any);
    const hook = getRegisteredHook(api);

    const token = makeGithubPat();
    const result = hook({
      event: 'PreToolUse',
      toolName: 'write',
      toolInput: {
        path: 'config.yml',
        content: 'a'.repeat(100_001), // long content — skipped
        data: 'token: ' + token, // short field — scanned
      },
      cwd: '/tmp',
    });
    // The scanner should find the GitHub PAT in the short `data` field.
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('github_pat');
  });
});

// Audit T-03 (2026-08-22): pin the full no-leak hook-lifecycle contract.
// secret-scanner registers TWO hooks per setup() (PreToolUse + PostToolUse),
// so re-setup must release both of the previous registration's handles, and
// teardown must free the CURRENT pair — never a stale one.
describe('hook lifecycle: re-setup releases handles, hosts are isolated (audit T-03)', () => {
  interface RegisteredOff {
    pre: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
  }

  function setupOnce(off: RegisteredOff): MockApi {
    const api = makeApi();
    api.registerHook.mockImplementationOnce(() => off.pre).mockImplementationOnce(() => off.post);
    secretScannerPlugin.setup(api as any);
    return api;
  }

  it('setup() twice releases BOTH previous handles exactly once', () => {
    const first: RegisteredOff = { pre: vi.fn(), post: vi.fn() };
    const second: RegisteredOff = { pre: vi.fn(), post: vi.fn() };
    const api = makeApi();
    api.registerHook
      .mockImplementationOnce(() => first.pre)
      .mockImplementationOnce(() => first.post)
      .mockImplementationOnce(() => second.pre)
      .mockImplementationOnce(() => second.post);

    secretScannerPlugin.setup(api as any);
    secretScannerPlugin.setup(api as any);

    expect(first.pre).toHaveBeenCalledTimes(1);
    expect(first.post).toHaveBeenCalledTimes(1);
    expect(second.pre).not.toHaveBeenCalled();
    expect(second.post).not.toHaveBeenCalled();
  });

  it('teardown after re-setup releases the CURRENT pair; other hosts are isolated', () => {
    const first: RegisteredOff = { pre: vi.fn(), post: vi.fn() };
    const second: RegisteredOff = { pre: vi.fn(), post: vi.fn() };
    const api = makeApi();
    api.registerHook
      .mockImplementationOnce(() => first.pre)
      .mockImplementationOnce(() => first.post)
      .mockImplementationOnce(() => second.pre)
      .mockImplementationOnce(() => second.post);
    secretScannerPlugin.setup(api as any);
    secretScannerPlugin.setup(api as any);

    // A second host's setup must not disturb the first host's handles.
    const otherOff: RegisteredOff = { pre: vi.fn(), post: vi.fn() };
    const other = setupOnce(otherOff);
    expect(otherOff.pre).not.toHaveBeenCalled();
    expect(first.pre).toHaveBeenCalledTimes(1); // only its own re-setup fired

    // Teardown frees the live (second) pair exactly once.
    secretScannerPlugin.teardown(api as any);
    expect(second.pre).toHaveBeenCalledTimes(1);
    expect(second.post).toHaveBeenCalledTimes(1);
    expect(first.pre).toHaveBeenCalledTimes(1);
    expect(first.post).toHaveBeenCalledTimes(1);

    // The other host's pair is freed by its own teardown.
    secretScannerPlugin.teardown(other as any);
    expect(otherOff.pre).toHaveBeenCalledTimes(1);
    expect(otherOff.post).toHaveBeenCalledTimes(1);

    // Repeat teardown after state deletion is a safe no-op.
    expect(() => secretScannerPlugin.teardown(api as any)).not.toThrow();
  });
});
