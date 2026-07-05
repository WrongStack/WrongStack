import { describe, expect, it, vi, beforeEach } from 'vitest';
import commitValidatorPlugin from '../src/commit-validator';

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  metrics: { counter: ReturnType<typeof vi.fn>; histogram: ReturnType<typeof vi.fn>; gauge: ReturnType<typeof vi.fn> };
  registerHook: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  emitCustom: ReturnType<typeof vi.fn>;
  session: { append: ReturnType<typeof vi.fn> };
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    onEvent: vi.fn(),
    emitCustom: vi.fn(),
    session: { append: vi.fn().mockResolvedValue(undefined) },
  };
}

function getHook(api: MockApi): (input: unknown) => Promise<{ decision?: string; reason?: string; additionalContext?: string } | void> {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as ReturnType<typeof getHook>;
}

function getStatusTool(api: MockApi): { execute: (input: unknown) => Promise<unknown> } {
  const call = api.tools.register.mock.calls.find(([t]: unknown[]) => (t as { name: string }).name === 'commit_validator_status');
  if (!call) throw new Error('commit_validator_status not registered');
  return (call[0] as { execute: (input: unknown) => Promise<unknown> });
}

beforeEach(() => vi.clearAllMocks());

describe('commit-validator plugin', () => {
  it('registers commit_validator_status tool and a PreToolUse hook', async () => {
    const api = makeApi();
    commitValidatorPlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    expect(api.registerHook).toHaveBeenCalledTimes(1);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PreToolUse');
    expect(matcher).toBe('bash|git_autocommit');
  });
});

describe('valid commit messages', () => {
  it('passes through a valid feat commit via bash', async () => {
    const api = makeApi();
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'bash', toolInput: { command: 'git commit -m "feat: add new feature"' } });
    expect(result).toBeUndefined();
  });

  it('passes through a valid scoped commit', async () => {
    const api = makeApi();
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'bash', toolInput: { command: "git commit -m 'fix(auth): correct login'" } });
    expect(result).toBeUndefined();
  });

  it('passes through a breaking-change marker', async () => {
    const api = makeApi();
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'bash', toolInput: { command: 'git commit -m "feat!: redesign API"' } });
    expect(result).toBeUndefined();
  });

  it('passes through a scoped breaking-change', async () => {
    const api = makeApi();
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'bash', toolInput: { command: 'git commit -m "refactor(core)!: rename exports"' } });
    expect(result).toBeUndefined();
  });
});

describe('invalid commit messages', () => {
  it('blocks a commit without a type', async () => {
    const api = makeApi();
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'bash', toolInput: { command: 'git commit -m "just a message"' } });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('conventional-commit');
  });

  it('blocks a commit without a colon', async () => {
    const api = makeApi();
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'bash', toolInput: { command: 'git commit -m "feat add feature"' } });
    expect(result?.decision).toBe('block');
  });

  it('blocks a commit with a period at the end', async () => {
    const api = makeApi();
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'bash', toolInput: { command: 'git commit -m "feat: add feature."' } });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('period');
  });

  it('blocks a commit exceeding maxSubjectLength', async () => {
    const api = makeApi({ extensions: { 'commit-validator': { maxSubjectLength: 10 } } });
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const longSubject = 'a'.repeat(50);
    const result = await hook({ toolName: 'bash', toolInput: { command: `git commit -m "feat: ${longSubject}"` } });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('exceeds');
  });

  it('blocks when type is not in allowedTypes', async () => {
    const api = makeApi({ extensions: { 'commit-validator': { allowedTypes: ['feat', 'fix'] } } });
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'bash', toolInput: { command: 'git commit -m "wip: work in progress"' } });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('not in allowedTypes');
  });

  it('blocks when requireScope is true and no scope', async () => {
    const api = makeApi({ extensions: { 'commit-validator': { requireScope: true } } });
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'bash', toolInput: { command: 'git commit -m "feat: add feature"' } });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('scope');
  });
});

describe('warn mode', () => {
  it('injects context instead of blocking in warn mode', async () => {
    const api = makeApi({ extensions: { 'commit-validator': { mode: 'warn' } } });
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'bash', toolInput: { command: 'git commit -m "bad message"' } });
    expect(result?.decision).toBe('allow');
    expect(result?.additionalContext).toContain('commit-validator');
  });
});

describe('non-commit commands', () => {
  it('passes through bash commands that are not git commit', async () => {
    const api = makeApi();
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    expect(await hook({ toolName: 'bash', toolInput: { command: 'git push' } })).toBeUndefined();
    expect(await hook({ toolName: 'bash', toolInput: { command: 'ls -la' } })).toBeUndefined();
  });

  it('passes through non-bash non-git_autocommit tools', async () => {
    const api = makeApi();
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    expect(await hook({ toolName: 'read', toolInput: { path: '/tmp/x' } })).toBeUndefined();
  });
});

describe('commit_validator_status tool', () => {
  it('reports config + counters', async () => {
    const api = makeApi();
    commitValidatorPlugin.setup(api as never);
    const result = await getStatusTool(api).execute({});
    expect(result.mode).toBe('block');
    expect(result.counters.invocations).toBe(0);
    expect(result.standardTypes).toContain('feat');
  });
});

describe('teardown + H1 pattern', () => {
  it('logs completion line and does not throw', async () => {
    const api = makeApi();
    commitValidatorPlugin.setup(api as never);
    expect(() => commitValidatorPlugin.teardown!(api as never)).not.toThrow();
    expect(api.log.info).toHaveBeenCalledWith('commit-validator: teardown complete', expect.any(Object));
  });

  it('zeros counters on teardown', async () => {
    const api = makeApi();
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    hook({ toolName: 'bash', toolInput: { command: 'git commit -m "feat: x"' } });
    commitValidatorPlugin.teardown!(api as never);
    const health = await commitValidatorPlugin.health!();
    expect(health.counters.invocations).toBe(0);
  });

  it('teardown is safe before setup (defensive)', async () => {
    const api = makeApi();
    expect(() => commitValidatorPlugin.teardown!(api as never)).not.toThrow();
  });
});

describe('bodyRequired config', () => {
  it('blocks when bodyRequired=true and no body', async () => {
    const api = makeApi({ extensions: { 'commit-validator': { bodyRequired: true } } });
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'bash', toolInput: { command: 'git commit -m "feat: add feature"' } });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('body is required');
  });

  it('passes when bodyRequired=true and body is present', async () => {
    const api = makeApi({ extensions: { 'commit-validator': { bodyRequired: true, minBodyLength: 10 } } });
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const msg = 'feat: add feature\n\nThis adds a new authentication module with OAuth2 support.';
    const result = await hook({ toolName: 'bash', toolInput: { command: `git commit -m "${msg}"` } });
    expect(result).toBeUndefined();
  });

  it('blocks when body is shorter than minBodyLength', async () => {
    const api = makeApi({ extensions: { 'commit-validator': { bodyRequired: true, minBodyLength: 50 } } });
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const msg = 'feat: add feature\n\nShort body';
    const result = await hook({ toolName: 'bash', toolInput: { command: `git commit -m "${msg}"` } });
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('minimum');
  });

  it('does not require body when bodyRequired=false (default)', async () => {
    const api = makeApi();
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const result = await hook({ toolName: 'bash', toolInput: { command: 'git commit -m "feat: add feature"' } });
    expect(result).toBeUndefined();
  });

  it('handles multi-line body correctly', async () => {
    const api = makeApi({ extensions: { 'commit-validator': { bodyRequired: true, minBodyLength: 20 } } });
    commitValidatorPlugin.setup(api as never);
    const hook = getHook(api);
    const msg = 'feat: add feature\n\nLine 1 of body.\nLine 2 of body.';
    const result = await hook({ toolName: 'bash', toolInput: { command: `git commit -m "${msg}"` } });
    expect(result).toBeUndefined();
  });
});
