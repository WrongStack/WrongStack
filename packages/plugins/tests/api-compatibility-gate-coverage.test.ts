/**
 * Coverage tests for api-compatibility-gate/index.ts — targeting uncovered branches.
 * Tests: withinProject, patternToRegex, matchesAnyPattern, normalizePath,
 * extractExports (various patterns), compareExports, isEntryPoint,
 * isPackageEntryPoint, resolveToProjectRoot, readGitVersion, readCurrentFile,
 * hook with breaking changes, hook with block severity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const { execFile } = await import('node:child_process');
const { existsSync } = await import('node:fs');
const { readFile } = await import('node:fs/promises');
const plugin = (await import('../src/api-compatibility-gate/index.js')).default;

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: { counter: ReturnType<typeof vi.fn> };
  registerHook: ReturnType<typeof vi.fn>;
}

function makeApi(extensions: Record<string, unknown> = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: {
      extensions: {
        'api-compatibility-gate': { enabled: true },
        ...extensions,
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
  };
}

function getHook(
  api: MockApi,
): (input: Record<string, unknown>) => Promise<Record<string, unknown> | undefined> {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as ReturnType<typeof getHook>;
}

function getStatusTool(api: MockApi): { execute: (input: unknown) => Promise<unknown> } {
  const call = api.tools.register.mock.calls.find(
    ([t]: unknown[]) => (t as { name: string }).name === 'api_compat_status',
  );
  if (!call) throw new Error('api_compat_status not registered');
  return call[0] as { execute: (input: unknown) => Promise<unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api-compatibility-gate coverage', () => {
  describe('hook with breaking changes found', () => {
    it('returns additionalContext when exports are removed', async () => {
      vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: unknown) => {
        const callback = cb as (err: Error | null, stdout: string) => void;
        // Return the 'before' version with an extra export
        callback(null, 'export const a = 1;\nexport const b = 2;\n');
        return { unref: vi.fn() } as never;
      });
      vi.mocked(readFile).mockResolvedValue('export const a = 1;\n');
      vi.mocked(existsSync).mockReturnValue(false); // Not a package entry point

      const api = makeApi({
        'api-compatibility-gate': { enabled: true, entryPointPatterns: ['**/*.ts'] },
      });
      plugin.setup(api as never);
      const hook = getHook(api);

      const result = await hook({
        toolName: 'write',
        toolInput: { path: 'src/index.ts' },
        toolResult: { content: '', isError: false },
      });

      expect(result).toBeDefined();
      expect((result as Record<string, unknown>).additionalContext).toContain('breaking');
    });

    it('returns decision: block when severity is block and exports removed', async () => {
      vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: unknown) => {
        const callback = cb as (err: Error | null, stdout: string) => void;
        callback(null, 'export const a = 1;\nexport const b = 2;\n');
        return { unref: vi.fn() } as never;
      });
      vi.mocked(readFile).mockResolvedValue('export const a = 1;\n');
      vi.mocked(existsSync).mockReturnValue(false);

      const api = makeApi({
        'api-compatibility-gate': {
          enabled: true,
          severity: 'block',
          entryPointPatterns: ['**/*.ts'],
        },
      });
      plugin.setup(api as never);
      const hook = getHook(api);

      const result = (await hook({
        toolName: 'write',
        toolInput: { path: 'src/index.ts' },
        toolResult: { content: '', isError: false },
      })) as Record<string, unknown>;

      expect(result.decision).toBe('block');
      expect(result.reason).toContain('breaking');
    });
  });

  describe('hook with no breaking changes', () => {
    it('returns undefined when exports are unchanged', async () => {
      vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: unknown) => {
        const callback = cb as (err: Error | null, stdout: string) => void;
        callback(null, 'export const a = 1;\n');
        return { unref: vi.fn() } as never;
      });
      vi.mocked(readFile).mockResolvedValue('export const a = 1;\n');
      vi.mocked(existsSync).mockReturnValue(false);

      const api = makeApi({
        'api-compatibility-gate': { enabled: true, entryPointPatterns: ['**/*.ts'] },
      });
      plugin.setup(api as never);
      const hook = getHook(api);

      const result = await hook({
        toolName: 'write',
        toolInput: { path: 'src/index.ts' },
        toolResult: { content: '', isError: false },
      });

      expect(result).toBeUndefined();
    });
  });

  describe('hook skipped when git version is null', () => {
    it('increments skippedCount when readGitVersion returns null', async () => {
      vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: unknown) => {
        const callback = cb as (err: Error | null, stdout: string) => void;
        callback(new Error('not a git repo'), '');
        return { unref: vi.fn() } as never;
      });
      vi.mocked(existsSync).mockReturnValue(false);

      const api = makeApi({
        'api-compatibility-gate': { enabled: true, entryPointPatterns: ['**/*.ts'] },
      });
      plugin.setup(api as never);
      const hook = getHook(api);

      await hook({
        toolName: 'write',
        toolInput: { path: 'src/index.ts' },
        toolResult: { content: '', isError: false },
      });

      const status = (await getStatusTool(api).execute({})) as Record<string, unknown>;
      expect((status.counters as Record<string, number>).skipped).toBe(1);
    });
  });

  describe('hook increments errorCount when current file cannot be read', () => {
    it('increments errorCount when readCurrentFile returns null', async () => {
      vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: unknown) => {
        const callback = cb as (err: Error | null, stdout: string) => void;
        callback(null, 'export const a = 1;\n');
        return { unref: vi.fn() } as never;
      });
      vi.mocked(readFile).mockRejectedValue(new Error('file not found'));
      vi.mocked(existsSync).mockReturnValue(false);

      const api = makeApi({
        'api-compatibility-gate': { enabled: true, entryPointPatterns: ['**/*.ts'] },
      });
      plugin.setup(api as never);
      const hook = getHook(api);

      await hook({
        toolName: 'write',
        toolInput: { path: 'src/index.ts' },
        toolResult: { content: '', isError: false },
      });

      const status = (await getStatusTool(api).execute({})) as Record<string, unknown>;
      expect((status.counters as Record<string, number>).errors).toBe(1);
    });
  });

  describe('status tool returns all fields', () => {
    it('returns expected fields', async () => {
      const api = makeApi({});
      plugin.setup(api as never);
      const status = (await getStatusTool(api).execute({})) as Record<string, unknown>;
      expect(status).toHaveProperty('ok');
      expect(status).toHaveProperty('enabled');
      expect(status).toHaveProperty('severity');
      expect(status).toHaveProperty('entryPointPatterns');
      expect(status).toHaveProperty('trackGitHistory');
      expect(status).toHaveProperty('counters');
    });
  });

  describe('health with breaking change recorded', () => {
    it('returns a message mentioning BREAKING when breakingCount > 0', async () => {
      vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, cb: unknown) => {
        const callback = cb as (err: Error | null, stdout: string) => void;
        callback(null, 'export const a = 1;\nexport const b = 2;\n');
        return { unref: vi.fn() } as never;
      });
      vi.mocked(readFile).mockResolvedValue('export const a = 1;\n');
      vi.mocked(existsSync).mockReturnValue(false);

      const api = makeApi({
        'api-compatibility-gate': { enabled: true, entryPointPatterns: ['**/*.ts'] },
      });
      plugin.setup(api as never);
      const hook = getHook(api);

      await hook({
        toolName: 'write',
        toolInput: { path: 'src/index.ts' },
        toolResult: { content: '', isError: false },
      });

      const h = (await plugin.health!()) as { ok: boolean; message: string };
      expect(h.message).toContain('BREAKING');
    });
  });
});
