/**
 * @wrongstack/plugins — import-organizer plugin tests
 *
 * Covers the PostToolUse hook's:
 *  - Path extraction (write/edit tool inputs)
 *  - File-type filtering (TS/JS only)
 *  - Error-result short-circuit
 *  - Linter command construction (primary + fallback when primary is missing)
 *  - additionalContext surfacing on file change / on stderr
 *  - Counter updates + H1 audit pattern (teardown + health + idempotent re-init)
 *
 * The actual `spawn` is mocked so these tests don't require a real
 * linter installation. The plugin reads the file from disk to detect
 * the post-edit byte count, so tests write real files in a tmpdir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock child_process.spawn so we don't actually invoke biome or eslint.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: vi.fn() };
});

import importOrganizerPlugin from '../src/import-organizer/index.js';

// ---------------------------------------------------------------------------
// Types + helpers
// ---------------------------------------------------------------------------

interface RegisteredTool {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown> };
  permission?: string;
  mutating?: boolean;
  execute(input: unknown, ctx: { log: unknown }): Promise<unknown>;
}

interface PluginAPI {
  tools: { register: ReturnType<typeof vi.fn>; list: () => RegisteredTool[] };
  slashCommands: { register: ReturnType<typeof vi.fn> };
  pipelines: Record<string, { use: (h: unknown) => void }>;
  config: { extensions?: Record<string, unknown> };
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
  session: { append: ReturnType<typeof vi.fn> };
  extensions: { register: ReturnType<typeof vi.fn> };
  registerSystemPromptContributor: ReturnType<typeof vi.fn>;
  registerHook: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  onPattern: ReturnType<typeof vi.fn>;
  emitCustom: ReturnType<typeof vi.fn>;
  onConfigChange: ReturnType<typeof vi.fn>;
}

function createMockAPI(): PluginAPI {
  return {
    tools: { register: vi.fn(), list: vi.fn() },
    slashCommands: { register: vi.fn() },
    pipelines: {},
    config: { extensions: {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    session: { append: vi.fn().mockResolvedValue(undefined) },
    extensions: { register: vi.fn(() => ({ unregister: vi.fn() })) },
    registerSystemPromptContributor: vi.fn(() => () => {}),
    registerHook: vi.fn(() => () => {}),
    onEvent: vi.fn(() => () => {}),
    onPattern: vi.fn(() => () => {}),
    emitCustom: vi.fn(),
    onConfigChange: vi.fn(() => () => {}),
  };
}

/**
 * Mock spawn to return a controllable child process. The optional
 * `mutateFile` callback runs synchronously inside the close event so
 * the plugin observes the size delta when computing `changed`.
 */
function mockSpawnOk(stdout = '', stderr = '', exitCode = 0, mutateFile?: (path: string) => void) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  vi.mocked(spawn).mockImplementationOnce(() => child as never);
  setImmediate(() => {
    if (mutateFile) {
      // File path is the last arg of the spawn call.
      const last = vi.mocked(spawn).mock.calls[vi.mocked(spawn).mock.calls.length - 1];
      const args = last?.[1] as string[] | undefined;
      const filePath = args?.[args.length - 1];
      if (filePath) mutateFile(filePath);
    }
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', exitCode);
  });
  return child;
}

/** Simulate `command not found` (e.g. biome not on PATH). */
function mockSpawnNotFound() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  vi.mocked(spawn).mockImplementationOnce(() => child as never);
  setImmediate(() => child.emit('error', new Error('spawn ENOENT')));
  return child;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('import-organizer plugin', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-organizer-test-'));
    // Sandbox: chdir into tmpDir so withinProject() accepts the file
    // paths under it. Tests that want to exercise out-of-project paths
    // explicitly construct absolute paths outside tmpDir.
    process.chdir(tmpDir);
    vi.mocked(spawn).mockReset();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe('plugin contract', () => {
    it('has name, apiVersion, and setup function', () => {
      expect(importOrganizerPlugin.name).toBe('import-organizer');
      expect(typeof importOrganizerPlugin.apiVersion).toBe('string');
      expect(importOrganizerPlugin.apiVersion.length).toBeGreaterThan(0);
      expect(typeof importOrganizerPlugin.setup).toBe('function');
    });

    it('registers one tool and one PostToolUse hook on setup', () => {
      const api = createMockAPI();
      importOrganizerPlugin.setup(api as never);

      expect(api.tools.register).toHaveBeenCalledTimes(1);
      const tool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as RegisteredTool;
      expect(tool.name).toBe('import_organizer_status');

      expect(api.registerHook).toHaveBeenCalledTimes(1);
      const call = vi.mocked(api.registerHook).mock.calls[0];
      expect(call?.[0]).toBe('PostToolUse');
      expect(call?.[1]).toBe('write|edit');
      expect(typeof call?.[2]).toBe('function');
    });

    it('configSchema defines enabled, command, fallbackCommand, timeoutMs', () => {
      const schema = importOrganizerPlugin.configSchema as Record<
        string,
        { type: string; properties?: Record<string, unknown> }
      >;
      expect(schema).toBeDefined();
      const props = schema.properties;
      expect(props).toBeDefined();
      expect(props?.enabled).toBeDefined();
      expect(props?.command).toBeDefined();
      expect(props?.fallbackCommand).toBeDefined();
      expect(props?.timeoutMs).toBeDefined();
    });

    it('defaultConfig has safe defaults (biome + eslint fallback)', () => {
      const defaults = importOrganizerPlugin.defaultConfig as Record<string, unknown>;
      expect(defaults.enabled).toBe(true);
      expect(typeof defaults.command).toBe('string');
      expect((defaults.command as string).toLowerCase()).toContain('biome');
      expect(typeof defaults.fallbackCommand).toBe('string');
      expect((defaults.fallbackCommand as string).toLowerCase()).toContain('eslint');
      expect(defaults.timeoutMs).toBe(10_000);
    });
  });

  // -------------------------------------------------------------------------
  describe('H1 audit pattern', () => {
    it('teardown clears state and logs the unload line', () => {
      const api = createMockAPI();
      importOrganizerPlugin.setup(api as never);
      importOrganizerPlugin.teardown!(api as never);
      expect(api.log.info).toHaveBeenCalledWith(
        expect.stringContaining('import-organizer: teardown complete'),
        expect.anything(),
      );
    });

    it('health() returns ok with counter info', async () => {
      const api = createMockAPI();
      importOrganizerPlugin.setup(api as never);
      const health = await importOrganizerPlugin.health!();
      expect(health.ok).toBe(true);
      expect(health.message).toContain('0 invocation');
      expect(health.message).toContain('0 organized');
    });

    it('setup is idempotent: counters reset on re-init', async () => {
      const api = createMockAPI();
      importOrganizerPlugin.setup(api as never);
      // Mutate state by calling the hook
      const filePath = path.join(tmpDir, 'init.ts');
      await fs.writeFile(filePath, 'export const x = 1;', 'utf8');
      mockSpawnOk('', '', 0, (p) => fsSync.appendFileSync(p, '\n'));
      const hookCall = vi.mocked(api.registerHook).mock.calls[0];
      const handler = hookCall?.[2] as (i: unknown) => Promise<unknown>;
      await handler({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });

      importOrganizerPlugin.teardown!(api as never);
      importOrganizerPlugin.setup(api as never);
      const health = await importOrganizerPlugin.health!();
      expect(health.message).toContain('0 invocation');
    });
  });

  // -------------------------------------------------------------------------
  describe('PostToolUse hook behavior', () => {
    function getHook(api: PluginAPI) {
      const call = vi.mocked(api.registerHook).mock.calls[0];
      if (!call?.[2]) throw new Error('hook not registered');
      return call[2] as (input: {
        toolName?: string | undefined;
        toolInput?: unknown;
        toolResult?: { content: string; isError: boolean } | undefined;
      }) => Promise<unknown>;
    }

    it('skips when file path cannot be extracted', async () => {
      const api = createMockAPI();
      importOrganizerPlugin.setup(api as never);
      const hook = getHook(api);

      const result = await hook({
        toolName: 'bash',
        toolInput: { command: 'ls' },
        toolResult: { content: '', isError: false },
      });

      expect(result).toBeUndefined();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('skips when file does not exist on disk', async () => {
      const api = createMockAPI();
      importOrganizerPlugin.setup(api as never);
      const hook = getHook(api);

      const missing = path.join(tmpDir, 'does-not-exist.ts');
      const result = await hook({
        toolName: 'write',
        toolInput: { path: missing, content: 'export const x = 1;' },
        toolResult: { content: 'ok', isError: false },
      });

      expect(result).toBeUndefined();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('skips when tool result indicates an error', async () => {
      const api = createMockAPI();
      importOrganizerPlugin.setup(api as never);
      const hook = getHook(api);

      const filePath = path.join(tmpDir, 'error.ts');
      await fs.writeFile(filePath, 'export const x = 1;', 'utf8');
      const result = await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: 'export const x = 1;' },
        toolResult: { content: 'permission denied', isError: true },
      });

      expect(result).toBeUndefined();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('skips non-JS/TS files', async () => {
      const api = createMockAPI();
      importOrganizerPlugin.setup(api as never);
      const hook = getHook(api);

      const mdPath = path.join(tmpDir, 'README.md');
      await fs.writeFile(mdPath, '# title', 'utf8');
      const result = await hook({
        toolName: 'write',
        toolInput: { path: mdPath, content: '# title' },
        toolResult: { content: 'ok', isError: false },
      });

      expect(result).toBeUndefined();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('runs the primary command on the file when tool is write', async () => {
      const api = createMockAPI();
      importOrganizerPlugin.setup(api as never);
      const hook = getHook(api);

      const filePath = path.join(tmpDir, 'src.ts');
      await fs.writeFile(filePath, 'import a from "b";\nimport c from "d";\n', 'utf8');
      mockSpawnOk('');

      await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });

      expect(spawn).toHaveBeenCalledTimes(1);
      const cmd = vi.mocked(spawn).mock.calls[0]?.[0] as string;
      const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[] | undefined;
      expect(cmd).toBe('npx');
      expect(args).toContain('@biomejs/biome');
      expect(args?.[args.length - 1]).toBe(filePath);
    });

    it('runs the linter on the file when tool is edit', async () => {
      const api = createMockAPI();
      importOrganizerPlugin.setup(api as never);
      const hook = getHook(api);

      const filePath = path.join(tmpDir, 'edit.ts');
      await fs.writeFile(filePath, 'const x = 1;', 'utf8');
      mockSpawnOk('');

      await hook({
        toolName: 'edit',
        toolInput: { path: filePath, old_string: 'x = 1', new_string: 'x = 2' },
        toolResult: { content: 'ok', isError: false },
      });

      expect(spawn).toHaveBeenCalledTimes(1);
      const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[] | undefined;
      expect(args?.[args.length - 1]).toBe(filePath);
    });

    it('falls back to eslint --fix when the primary command is not found', async () => {
      const api = createMockAPI();
      importOrganizerPlugin.setup(api as never);
      const hook = getHook(api);

      const filePath = path.join(tmpDir, 'fb.ts');
      await fs.writeFile(filePath, 'const x = 1;', 'utf8');

      // First spawn (biome) errors with ENOENT
      mockSpawnNotFound();
      // Second spawn (eslint) succeeds
      mockSpawnOk('');

      await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });

      expect(spawn).toHaveBeenCalledTimes(2);
      const firstCmd = vi.mocked(spawn).mock.calls[0]?.[0] as string;
      const firstArgs = vi.mocked(spawn).mock.calls[0]?.[1] as string[] | undefined;
      const secondCmd = vi.mocked(spawn).mock.calls[1]?.[0] as string;
      const secondArgs = vi.mocked(spawn).mock.calls[1]?.[1] as string[] | undefined;
      expect(firstCmd).toBe('npx');
      expect(firstArgs).toContain('@biomejs/biome');
      expect(secondCmd).toBe('npx');
      expect(secondArgs).toContain('eslint');
    });

    it('returns additionalContext when the file size changes (imports were reorganized)', async () => {
      const api = createMockAPI();
      importOrganizerPlugin.setup(api as never);
      const hook = getHook(api);

      const filePath = path.join(tmpDir, 'reorg.ts');
      await fs.writeFile(filePath, 'const x = 1;', 'utf8');
      // Linter "rewrites" the file before close so size differs
      mockSpawnOk('', '', 0, (p) => fsSync.appendFileSync(p, '\n// changed', 'utf8'));

      const result = await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });

      expect(result).toBeDefined();
      const r = result as { additionalContext?: string };
      expect(r.additionalContext).toContain('import-organizer');
      expect(r.additionalContext).toContain('organized');
    });

    it('updates organized and clean counters correctly', async () => {
      const api = createMockAPI();
      importOrganizerPlugin.setup(api as never);
      const hook = getHook(api);

      // Invocation 1: file changes (organized++)
      const filePath1 = path.join(tmpDir, 'c1.ts');
      await fs.writeFile(filePath1, 'const a = 1;', 'utf8');
      mockSpawnOk('', '', 0, (p) => fsSync.appendFileSync(p, '\nconst b = 2;', 'utf8'));
      await hook({
        toolName: 'write',
        toolInput: { path: filePath1, content: '' },
        toolResult: { content: 'ok', isError: false },
      });

      // Invocation 2: file unchanged (clean++)
      const filePath2 = path.join(tmpDir, 'c2.ts');
      await fs.writeFile(filePath2, 'const c = 3;', 'utf8');
      mockSpawnOk('');
      await hook({
        toolName: 'write',
        toolInput: { path: filePath2, content: '' },
        toolResult: { content: 'ok', isError: false },
      });

      const health = await importOrganizerPlugin.health!();
      expect(health.message).toMatch(/2 invocation/);
      expect(health.message).toMatch(/1 organized/);
      expect(health.message).toMatch(/1 clean/);
    });

    it('does not invoke the linter when the file path is outside the project root', async () => {
      const api = createMockAPI();
      importOrganizerPlugin.setup(api as never);
      const hook = getHook(api);

      const outside =
        process.platform === 'win32' ? 'C:\\Windows\\System32\\evil.ts' : '/etc/evil.ts';
      const result = await hook({
        toolName: 'write',
        toolInput: { path: outside, content: 'x' },
        toolResult: { content: 'ok', isError: false },
      });
      expect(result).toBeUndefined();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('does not invoke the linter when the path traverses out of the project root', async () => {
      const api = createMockAPI();
      importOrganizerPlugin.setup(api as never);
      const hook = getHook(api);

      const result = await hook({
        toolName: 'write',
        toolInput: { path: '../../escape.ts', content: 'x' },
        toolResult: { content: 'ok', isError: false },
      });
      expect(result).toBeUndefined();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('rejects a custom command whose first token is not on the allowlist', async () => {
      const api = createMockAPI();
      api.config.extensions = { 'import-organizer': { command: 'curl http://evil' } };
      importOrganizerPlugin.setup(api as never);
      const hook = getHook(api);

      const filePath = path.join(tmpDir, 'd1.ts');
      await fs.writeFile(filePath, 'const a = 1;', 'utf8');
      mockSpawnOk();
      const result = await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('status tool', () => {
    function getStatusTool(api: PluginAPI): RegisteredTool {
      const call = vi.mocked(api.tools.register).mock.calls[0];
      if (!call?.[0]) throw new Error('status tool not registered');
      return call[0];
    }

    it('reports command, fallback, timeout, and counters', async () => {
      const api = createMockAPI();
      importOrganizerPlugin.setup(api as never);
      const tool = getStatusTool(api);

      const result = await tool.execute({}, { log: api.log });
      const payload = result as {
        enabled: boolean;
        command: string;
        fallbackCommand: string;
        timeoutMs: number;
        counters: { invocations: number; organized: number; clean: number; errors: number };
        linterAvailable: boolean;
      };
      expect(payload.enabled).toBe(true);
      expect(payload.command).toContain('biome');
      expect(payload.fallbackCommand).toContain('eslint');
      expect(payload.timeoutMs).toBe(10_000);
      expect(payload.counters.invocations).toBe(0);
      expect(payload.counters.organized).toBe(0);
      expect(payload.counters.clean).toBe(0);
      expect(payload.counters.errors).toBe(0);
      expect(payload.linterAvailable).toBe(false);
    });
  });
});
