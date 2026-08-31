import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const { existsSync, readFileSync } = await import('node:fs');
const migrationPlannerPlugin = (await import('../src/migration-planner')).default;

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
  };
  registerHook: ReturnType<typeof vi.fn>;
  llm?: {
    complete: ReturnType<typeof vi.fn>;
    council?: ReturnType<typeof vi.fn>;
  };
}

function makeApi(
  overrides: {
    extensions?: Record<string, unknown>;
    llm?: {
      complete: ReturnType<typeof vi.fn>;
      council?: ReturnType<typeof vi.fn>;
    };
  } = {},
): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    llm: overrides.llm,
  };
}

function getTool(api: MockApi, name: string): (input: unknown) => Promise<unknown> {
  const call = api.tools.register.mock.calls.find((c) => (c[0] as { name: string }).name === name);
  if (!call) throw new Error(`tool ${name} not registered`);
  return (call[0] as { execute: (input: unknown) => Promise<unknown> }).execute;
}

function getHook(api: MockApi): (input: unknown) => unknown {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as (input: unknown) => unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(existsSync).mockReset();
  vi.mocked(readFileSync).mockReset();
});

afterEach(async () => {
  const api = makeApi();
  await migrationPlannerPlugin.teardown?.(api as never);
});

describe('migration-planner plugin', () => {
  it('declares optional LLM support in its plugin contract', () => {
    expect(migrationPlannerPlugin.version).toBe('0.2.0');
    expect(migrationPlannerPlugin.capabilities?.llm).toBe(true);
  });

  it('registers migration_plan, migration_status, and a PostToolUse hook', () => {
    const api = makeApi();
    migrationPlannerPlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(2);
    const names = api.tools.register.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names).toContain('migration_plan');
    expect(names).toContain('migration_status');
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
  });

  it('parses a changelog and extracts breaking changes between versions', async () => {
    vi.mocked(existsSync).mockImplementation(
      (p) => String(p) === 'node_modules/my-pkg/CHANGELOG.md',
    );
    vi.mocked(readFileSync).mockReturnValue(`
# Changelog

## [2.0.0] - 2024-01-01

### BREAKING CHANGES
- Removed legacy API \`foo()\`
- Dropped Node 16 support

### Migration
- Replace \`foo()\` with \`bar()\`
- Upgrade to Node 18

## [1.5.0] - 2023-06-01

### Added
- New helper \`baz()\`

## [1.0.0] - 2023-01-01

### BREAKING CHANGES
- Initial stable release
`);

    const api = makeApi();
    migrationPlannerPlugin.setup(api as never);
    const plan = getTool(api, 'migration_plan');
    const result = (await plan({
      packageName: 'my-pkg',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
    })) as {
      ok: boolean;
      fallback: boolean;
      breakingChanges: string[];
      recommendedSteps: string[];
      changelogSource: string | null;
    };

    expect(result.ok).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.changelogSource).toBe('node_modules/my-pkg/CHANGELOG.md');
    expect(result.breakingChanges).toContain('Removed legacy API `foo()`');
    expect(result.breakingChanges).toContain('Dropped Node 16 support');
    expect(result.recommendedSteps).toContain('Replace `foo()` with `bar()`');
    expect(result.recommendedSteps).toContain('Upgrade to Node 18');
  });

  it('returns a generic guide when no changelog exists', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const api = makeApi();
    migrationPlannerPlugin.setup(api as never);
    const plan = getTool(api, 'migration_plan');
    const result = (await plan({
      packageName: 'unknown-pkg',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
    })) as {
      ok: boolean;
      fallback: boolean;
      breakingChanges: string[];
      recommendedSteps: string[];
      changelogSource: string | null;
    };

    expect(result.ok).toBe(true);
    expect(result.fallback).toBe(true);
    expect(result.changelogSource).toBeNull();
    expect(result.breakingChanges.some((b) => b.includes('No changelog found'))).toBe(true);
    expect(result.recommendedSteps.length).toBeGreaterThan(0);
  });

  it('adds a separate evidence-bounded LLM analysis without replacing deterministic facts', async () => {
    vi.mocked(existsSync).mockImplementation(
      (p) => String(p) === 'node_modules/my-pkg/CHANGELOG.md',
    );
    vi.mocked(readFileSync).mockReturnValue(`
## 2.0.0
### BREAKING CHANGES
- Removed foo()
### Migration
- Replace foo() with bar()
## 1.0.0
`);
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        summary: 'The local changelog documents one breaking API removal.',
        riskLevel: 'high',
        risks: ['Call sites may still use foo().'],
        additionalSteps: ['Search the scoped package for foo().'],
        verificationSteps: ['Run the focused test suite.'],
      }),
    });
    const api = makeApi({ llm: { complete } });
    migrationPlannerPlugin.setup(api as never);

    const result = (await getTool(
      api,
      'migration_plan',
    )({
      packageName: 'my-pkg',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      use_llm: true,
    })) as {
      breakingChanges: string[];
      aiAnalysis: { summary: string; riskLevel: string; verificationSteps: string[] };
      llm: { requested: boolean; used: boolean; fallbackReason: string | null };
    };

    expect(result.breakingChanges).toContain('Removed foo()');
    expect(result.aiAnalysis.riskLevel).toBe('high');
    expect(result.aiAnalysis.verificationSteps).toEqual(['Run the focused test suite.']);
    expect(result.llm).toEqual({ requested: true, used: true, fallbackReason: null });
    expect(complete).toHaveBeenCalledWith(
      expect.stringContaining('<evidence>'),
      expect.objectContaining({ responseFormat: 'json', temperature: 0.1 }),
    );
  });

  it('prefers the risk-review Council when the host exposes it', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const complete = vi.fn();
    const council = vi.fn().mockResolvedValue({
      status: 'decided',
      answer: JSON.stringify({
        summary: 'Evidence is incomplete; verify before upgrading.',
        riskLevel: 'unknown',
        risks: ['No local changelog was found.'],
        additionalSteps: [],
        verificationSteps: ['Check the upstream release notes.'],
      }),
      resolution: 'judge',
    });
    const api = makeApi({ llm: { complete, council } });
    migrationPlannerPlugin.setup(api as never);

    const result = (await getTool(
      api,
      'migration_plan',
    )({
      packageName: 'unknown',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      use_llm: true,
    })) as { aiAnalysis: { riskLevel: string }; llm: { used: boolean } };

    expect(result.aiAnalysis.riskLevel).toBe('unknown');
    expect(result.llm.used).toBe(true);
    expect(council).toHaveBeenCalledWith(
      expect.stringContaining('Assess the migration'),
      expect.objectContaining({ profile: 'risk-review' }),
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it('keeps the deterministic plan when optional LLM JSON is invalid', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const api = makeApi({
      llm: { complete: vi.fn().mockResolvedValue({ text: '{"riskLevel":"high"}' }) },
    });
    migrationPlannerPlugin.setup(api as never);

    const result = (await getTool(
      api,
      'migration_plan',
    )({
      packageName: 'unknown',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      use_llm: true,
    })) as {
      recommendedSteps: string[];
      aiAnalysis: null;
      llm: { used: boolean; fallbackReason: string };
    };

    expect(result.aiAnalysis).toBeNull();
    expect(result.recommendedSteps.length).toBeGreaterThan(0);
    expect(result.llm.fallbackReason).toBe('invalid-response');
  });

  it('migration_status reports counters', async () => {
    const api = makeApi();
    migrationPlannerPlugin.setup(api as never);
    const plan = getTool(api, 'migration_plan');
    const status = getTool(api, 'migration_status');

    await plan({ packageName: 'x', fromVersion: '1.0.0', toVersion: '2.0.0' });
    const result = (await status({})) as { ok: boolean; counters: Record<string, number> };

    expect(result.ok).toBe(true);
    expect(result.counters.plansGenerated).toBe(1);
    expect(result.counters.statusQueries).toBe(1);
  });

  it('enabled:false disables migration_plan', async () => {
    const api = makeApi({ extensions: { 'migration-planner': { enabled: false } } });
    migrationPlannerPlugin.setup(api as never);
    const plan = getTool(api, 'migration_plan');
    const result = (await plan({
      packageName: 'x',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
    })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
  });

  it('PostToolUse hook reminds about migration planning on package.json edits', async () => {
    const api = makeApi();
    migrationPlannerPlugin.setup(api as never);
    const hook = getHook(api);
    const result = (await hook({
      toolName: 'write',
      toolInput: { path: 'package.json' },
      toolResult: { content: '', isError: false },
    })) as { additionalContext?: string } | undefined;
    expect(result?.additionalContext).toContain('migration_plan');
  });

  it('teardown zeros state and logs', async () => {
    const api = makeApi();
    migrationPlannerPlugin.setup(api as never);
    migrationPlannerPlugin.teardown!(api as never);
    const health = (await migrationPlannerPlugin.health!()) as {
      counters: Record<string, number>;
    };
    expect(health.counters.plansGenerated).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'migration-planner: teardown complete',
      expect.any(Object),
    );
  });

  it('does not treat a level-1 title with an embedded version as a release section', async () => {
    // Regression: widening the heading regex to `#{1,3}` let document titles
    // like `# v1.5.0 — historical archive` become release sections whose body
    // leaked into the migration plan. `#` stays the title level; `##`/`###`
    // start release sections.
    vi.mocked(existsSync).mockImplementation(
      (p) => String(p) === 'node_modules/my-pkg/CHANGELOG.md',
    );
    vi.mocked(readFileSync).mockReturnValue(`
# Changelog

## [2.0.0] - 2024-01-01

### BREAKING CHANGES
- Removed legacy API \`bar()\`

# v1.5.0 — historical archive

Archived note: Removed legacy API \`foo()\`

## [1.0.0] - 2023-01-01

### BREAKING CHANGES
- Initial stable release
`);

    const api = makeApi();
    migrationPlannerPlugin.setup(api as never);
    const plan = getTool(api, 'migration_plan');
    const result = (await plan({
      packageName: 'my-pkg',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
    })) as {
      ok: boolean;
      fallback: boolean;
      breakingChanges: string[];
      changelogSource: string | null;
    };

    expect(result.ok).toBe(true);
    expect(result.fallback).toBe(false);
    expect(result.breakingChanges).toContain('Removed legacy API `bar()`');
    // The archived 1.5.0 note sits between from and to — it must NOT be
    // attributed to the plan now that level-1 headings are excluded.
    expect(result.breakingChanges).not.toContain('Removed legacy API `foo()`');
  });
});
