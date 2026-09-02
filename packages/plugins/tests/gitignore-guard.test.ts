import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory virtual FS for .gitignore reads/append writes.
// ---------------------------------------------------------------------------
const { virtualFs, existsSet, mockAccess, mockReadFile, mockWriteFile } = vi.hoisted(() => {
  const virtualFs = new Map<string, string>();
  const existsSet = new Set<string>();
  return {
    virtualFs,
    existsSet,
    mockAccess: vi.fn(async (p: string) => {
      if (!existsSet.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
    mockReadFile: vi.fn(async (p: string, _enc?: unknown) => {
      if (!existsSet.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return virtualFs.get(p) ?? '';
    }),
    mockWriteFile: vi.fn(async (p: string, content: string) => {
      virtualFs.set(p, content);
      existsSet.add(p);
    }),
  };
});

vi.mock('node:fs/promises', () => ({
  access: mockAccess,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

// ---------------------------------------------------------------------------
// Plugin under test (imported after mocks are installed).
// ---------------------------------------------------------------------------
const plugin = (await import('../src/gitignore-guard/index.js')).default;
const { DEFAULT_ARTIFACT_PATTERNS, classifyArtifact, matchGitignorePattern, readConfig } =
  await import('../src/gitignore-guard/index.js');

const ROOT = process.cwd();
const rootGitignore = join(ROOT, '.gitignore');

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
  registerHook: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  onPattern: ReturnType<typeof vi.fn>;
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
    onPattern: vi.fn(() => () => {}),
    emitCustom: vi.fn(),
    session: { append: vi.fn().mockResolvedValue(undefined) },
  };
}

type HookFn = (input: unknown) => Promise<{ additionalContext?: string } | void>;

function getHook(api: MockApi): HookFn {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as HookFn;
}

function getTool(
  api: MockApi,
  name: string,
): { execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>> } {
  const call = api.tools.register.mock.calls.find(
    ([t]: unknown[]) => (t as { name?: string }).name === name,
  );
  if (!call) throw new Error(`tool not registered: ${name}`);
  return (call as unknown[])[0] as {
    execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
}

function seedGitignore(path: string, content: string): void {
  virtualFs.set(path, content);
  existsSet.add(path);
}

function writeInput(path: string): Record<string, unknown> {
  return {
    toolName: 'write',
    toolInput: { path },
    cwd: ROOT,
    toolResult: { content: '', isError: false },
  };
}

beforeEach(() => {
  virtualFs.clear();
  existsSet.clear();
  mockAccess.mockClear();
  mockReadFile.mockClear();
  mockWriteFile.mockClear();
});

// ---------------------------------------------------------------------------
// Pure matching engine
// ---------------------------------------------------------------------------

describe('matchGitignorePattern', () => {
  it('matches trailing-slash directory patterns at any depth', () => {
    expect(matchGitignorePattern('dist/foo.js', 'dist/')).toBe(true);
    expect(matchGitignorePattern('apps/web/dist/x.js', 'dist/')).toBe(true);
    expect(matchGitignorePattern('src/index.ts', 'dist/')).toBe(false);
    expect(matchGitignorePattern('src/dist', 'dist/')).toBe(true);
  });

  it('matches basename globs at any depth', () => {
    expect(matchGitignorePattern('.env', '*.env')).toBe(true);
    expect(matchGitignorePattern('config/.env', '*.env')).toBe(true);
    expect(matchGitignorePattern('.env.local', '*.env.*')).toBe(true);
    expect(matchGitignorePattern('config/.env.production', '*.env.*')).toBe(true);
    expect(matchGitignorePattern('src/foo.ts', '*.env')).toBe(false);
  });

  it('matches anchored globs against the project-relative path', () => {
    expect(matchGitignorePattern('docs/generated/x.md', 'docs/generated/')).toBe(true);
    expect(matchGitignorePattern('other/docs/generated/x.md', 'docs/generated/')).toBe(false);
  });

  it('handles Windows-style separators and ignores comments/blank patterns', () => {
    expect(matchGitignorePattern('dist\\foo.js', 'dist/')).toBe(true);
    expect(matchGitignorePattern('dist/foo.js', '# comment')).toBe(false);
    expect(matchGitignorePattern('dist/foo.js', '  ')).toBe(false);
  });
});

describe('classifyArtifact', () => {
  it('returns the first matching pattern or null', () => {
    expect(classifyArtifact('coverage/lcov.info', DEFAULT_ARTIFACT_PATTERNS)).toBe('coverage/');
    expect(classifyArtifact('node_modules/a/index.js', DEFAULT_ARTIFACT_PATTERNS)).toBe(
      'node_modules/',
    );
    expect(classifyArtifact('src/index.ts', DEFAULT_ARTIFACT_PATTERNS)).toBeNull();
  });

  it('exposes the user-requested defaults', () => {
    for (const p of ['dist/', 'coverage/', 'node_modules/', '*.env']) {
      expect(DEFAULT_ARTIFACT_PATTERNS).toContain(p);
    }
    expect(Object.isFrozen(DEFAULT_ARTIFACT_PATTERNS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe('readConfig', () => {
  it('applies defaults when nothing is configured', () => {
    const cfg = readConfig(undefined);
    expect(cfg.enabled).toBe(true);
    expect(cfg.mode).toBe('suggest');
    expect(cfg.artifactPatterns).toEqual([...DEFAULT_ARTIFACT_PATTERNS]);
    expect(cfg.ignorePatterns).toEqual([]);
    expect(cfg.maxAppendPerCall).toBe(5);
  });

  it('honors mode, pattern lists, and caps from config', () => {
    const cfg = readConfig({
      enabled: false,
      mode: 'append',
      artifactPatterns: ['build/', '*.tmp'],
      ignorePatterns: ['dist/'],
      maxAppendPerCall: 2,
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.mode).toBe('append');
    expect(cfg.artifactPatterns).toEqual(['build/', '*.tmp']);
    expect(cfg.ignorePatterns).toEqual(['dist/']);
    expect(cfg.maxAppendPerCall).toBe(2);
  });

  it('falls back to defaults on invalid values', () => {
    const cfg = readConfig({
      mode: 'delete-everything',
      artifactPatterns: [],
      maxAppendPerCall: 0,
    });
    expect(cfg.mode).toBe('suggest');
    expect(cfg.artifactPatterns).toEqual([...DEFAULT_ARTIFACT_PATTERNS]);
    expect(cfg.maxAppendPerCall).toBe(5);
  });

  it('strips blank lines and comments from pattern lists', () => {
    const cfg = readConfig({ artifactPatterns: ['  dist/  ', '', '# note', '*.env'] });
    expect(cfg.artifactPatterns).toEqual(['dist/', '*.env']);
  });
});

// ---------------------------------------------------------------------------
// Hook behavior
// ---------------------------------------------------------------------------

describe('gitignore-guard PostToolUse hook', () => {
  it('suggests an entry in suggest mode without touching .gitignore', async () => {
    const api = makeApi();
    await plugin.setup(api as never);
    const hook = getHook(api);

    const out = await hook(writeInput('dist/bundle.js'));
    expect(out).toBeTruthy();
    const ctx = (out as { additionalContext: string }).additionalContext;
    expect(ctx).toContain("'dist/'");
    expect(ctx).toContain('gitignore_guard_append');
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(api.metrics.counter).toHaveBeenCalledWith('suggest');
  });

  it('does nothing for non-artifact writes', async () => {
    const api = makeApi();
    await plugin.setup(api as never);
    const hook = getHook(api);

    expect(await hook(writeInput('src/index.ts'))).toBeUndefined();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('skips errored tool results, missing paths, and .gitignore writes', async () => {
    const api = makeApi();
    await plugin.setup(api as never);
    const hook = getHook(api);

    expect(
      await hook({
        toolName: 'write',
        toolInput: { path: 'dist/x.js' },
        cwd: ROOT,
        toolResult: { content: 'err', isError: true },
      }),
    ).toBeUndefined();
    expect(await hook({ toolName: 'write', toolInput: {}, cwd: ROOT })).toBeUndefined();
    expect(await hook(writeInput('.gitignore'))).toBeUndefined();
    expect(await hook(writeInput('nested/.gitignore'))).toBeUndefined();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('skips paths outside the project root', async () => {
    const api = makeApi();
    await plugin.setup(api as never);
    const hook = getHook(api);

    const outside = join(ROOT, '..', 'elsewhere', 'dist', 'x.js');
    expect(await hook(writeInput(outside))).toBeUndefined();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('skips when an existing .gitignore line already covers the path', async () => {
    seedGitignore(rootGitignore, 'node_modules/\ndist/\n');
    const api = makeApi();
    await plugin.setup(api as never);
    const hook = getHook(api);

    expect(await hook(writeInput('dist/bundle.js'))).toBeUndefined();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('respects ignorePatterns opt-outs', async () => {
    const api = makeApi({
      extensions: {
        'gitignore-guard': { mode: 'suggest', ignorePatterns: ['dist/'] },
      },
    });
    await plugin.setup(api as never);
    const hook = getHook(api);

    expect(await hook(writeInput('dist/bundle.js'))).toBeUndefined();
  });

  it('appends a missing entry in append mode and dedupes on repeat', async () => {
    const api = makeApi({
      extensions: { 'gitignore-guard': { mode: 'append' } },
    });
    await plugin.setup(api as never);
    const hook = getHook(api);

    const first = await hook(writeInput('dist/bundle.js'));
    expect(first).toBeTruthy();
    expect((first as { additionalContext: string }).additionalContext).toContain('Appended');
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    expect(virtualFs.get(rootGitignore)).toContain('dist/\n');

    // Second write of the same artifact is now covered — no second append.
    expect(await hook(writeInput('dist/other.js'))).toBeUndefined();
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it('appends to the nearest existing .gitignore (root-first), creating root when absent', async () => {
    // No root .gitignore; nested one exists under apps/web.
    const nested = join(ROOT, 'apps', 'web', '.gitignore');
    seedGitignore(nested, '# app ignores\n');
    const api = makeApi({ extensions: { 'gitignore-guard': { mode: 'append' } } });
    await plugin.setup(api as never);
    const hook = getHook(api);

    const out = await hook(writeInput('apps/web/dist/x.js'));
    expect(out).toBeTruthy();
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const [, content] = mockWriteFile.mock.calls[0] as [string, string];
    expect(content).toBe('# app ignores\ndist/\n');
    expect(virtualFs.get(nested)).toContain('dist/');
  });

  it('re-reads config hot — mode switch applies without re-setup', async () => {
    const api = makeApi({ extensions: { 'gitignore-guard': { mode: 'suggest' } } });
    await plugin.setup(api as never);
    const hook = getHook(api);

    await hook(writeInput('coverage/lcov.info'));
    expect(mockWriteFile).not.toHaveBeenCalled();

    api.config.extensions['gitignore-guard'] = { mode: 'append' };
    await hook(writeInput('coverage/lcov.info'));
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

describe('gitignore_guard_append tool', () => {
  it('appends an explicit pattern and reports alreadyCovered on repeat', async () => {
    const api = makeApi();
    await plugin.setup(api as never);
    const tool = getTool(api, 'gitignore_guard_append');

    const first = await tool.execute({ path: 'dist/bundle.js', pattern: 'dist/' });
    expect(first.ok).toBe(true);
    expect(first.alreadyCovered).toBe(false);
    expect(first.appended).toEqual(['dist/']);
    expect(virtualFs.get(rootGitignore)).toContain('dist/\n');

    const second = await tool.execute({ path: 'dist/other.js', pattern: 'dist/' });
    expect(second.ok).toBe(true);
    expect(second.alreadyCovered).toBe(true);
    expect(second.appended).toEqual([]);
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it('derives the pattern from the path when none is given', async () => {
    const api = makeApi();
    await plugin.setup(api as never);
    const tool = getTool(api, 'gitignore_guard_append');

    const out = await tool.execute({ path: 'node_modules/pkg/index.js' });
    expect(out.ok).toBe(true);
    expect(out.appended).toEqual(['node_modules/']);
  });

  it('rejects paths outside the project root', async () => {
    const api = makeApi();
    await plugin.setup(api as never);
    const tool = getTool(api, 'gitignore_guard_append');

    const out = await tool.execute({ path: join(ROOT, '..', 'secret.txt') });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('outside project root');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('rejects paths that match no pattern when no explicit pattern is given', async () => {
    const api = makeApi();
    await plugin.setup(api as never);
    const tool = getTool(api, 'gitignore_guard_append');

    const out = await tool.execute({ path: 'src/index.ts' });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('does not match any configured artifact pattern');
  });
});

describe('gitignore_guard_status tool', () => {
  it('reports config and per-session counters', async () => {
    const api = makeApi({ extensions: { 'gitignore-guard': { mode: 'append' } } });
    await plugin.setup(api as never);
    const hook = getHook(api);
    await hook(writeInput('dist/bundle.js'));

    const status = getTool(api, 'gitignore_guard_status');
    const out = await status.execute({});
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('append');
    expect((out.counters as { appends: number }).appends).toBe(1);
    expect((out.lastResult as { path: string }).path).toBe('dist/bundle.js');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('does not stack hooks on re-setup (unregisters the previous hook)', async () => {
    const api = makeApi();
    await plugin.setup(api as never);
    const firstUnregister = api.registerHook.mock.results[0]?.value as ReturnType<typeof vi.fn>;
    expect(firstUnregister).toBeDefined();

    await plugin.setup(api as never);
    expect(api.registerHook).toHaveBeenCalledTimes(2);
    expect(firstUnregister).toHaveBeenCalledTimes(1);
  });

  it('health() reports counters', async () => {
    const api = makeApi();
    await plugin.setup(api as never);
    const health = await plugin.health!();
    expect(health.ok).toBe(true);
    expect(typeof health.message).toBe('string');
  });

  it('teardown unregisters the hook', async () => {
    const api = makeApi();
    await plugin.setup(api as never);
    const unregister = api.registerHook.mock.results[0]?.value as ReturnType<typeof vi.fn>;
    await plugin.teardown!(api as never);
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});
