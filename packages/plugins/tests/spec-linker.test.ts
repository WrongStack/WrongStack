/**
 * @wrongstack/plugins — spec-linker plugin tests
 *
 * Covers the PostToolUse (read-only) hook's:
 *  - Markdown glob filtering
 *  - Unlinked reference detection (bare plugin name in prose)
 *  - Wrapped-as-link-or-code exclusion
 *  - additionalContext surfacing with maxReferences cap
 *  - Word-boundary matching (no false-positive on substrings)
 *  - H1 audit pattern (teardown + health + idempotent re-init)
 *
 * And the PreToolUse (autoFix) hook's:
 *  - enabled=false / autoFix=false → no Pre hook
 *  - autoFix=true → wraps unlinked refs in `[name](path)` via
 *    modifiedInput.content
 *  - Skips when content is already clean
 *  - Skips non-markdown files
 *  - Decision is always 'allow' (we don't block; we just rewrite)
 *  - Original casing preserved
 *  - markdown-link / inline-code detection still works
 *  - `edit` is NOT auto-fixed (only `write` is)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import specLinkerPlugin from '../src/spec-linker/index.js';
import { PLUGIN_NAMES } from '../src/catalog.js';

// ---------------------------------------------------------------------------
// Types + helpers
// ---------------------------------------------------------------------------

interface PluginAPI {
  tools: { register: ReturnType<typeof vi.fn> };
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
    tools: { register: vi.fn() },
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

/** Find a hook by event name (PostToolUse / PreToolUse). */
function getHook(api: PluginAPI, eventName: string) {
  const call = vi.mocked(api.registerHook).mock.calls.find((c) => c?.[0] === eventName);
  if (!call?.[2]) throw new Error(`hook not registered for event ${eventName}`);
  return call[2] as (input: unknown) => Promise<unknown>;
}

function getMatcher(api: PluginAPI, eventName: string): string {
  const call = vi.mocked(api.registerHook).mock.calls.find((c) => c?.[0] === eventName);
  if (!call?.[1]) throw new Error(`hook matcher not registered for event ${eventName}`);
  return call[1] as string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('spec-linker plugin', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-linker-test-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe('plugin contract', () => {
    it('has name, apiVersion, and setup function', () => {
      expect(specLinkerPlugin.name).toBe('spec-linker');
      expect(typeof specLinkerPlugin.apiVersion).toBe('string');
      expect(typeof specLinkerPlugin.setup).toBe('function');
    });

    it('registers one tool and one PostToolUse hook by default (autoFix off)', () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      expect(api.tools.register).toHaveBeenCalledTimes(1);
      const tool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as { name: string };
      expect(tool.name).toBe('spec_linker_status');
      expect(api.registerHook).toHaveBeenCalledTimes(1);
      expect(getMatcher(api, 'PostToolUse')).toBe('write|edit');
    });

    it('registers a PreToolUse hook when autoFix=true', () => {
      const api = createMockAPI();
      api.config.extensions = { 'spec-linker': { autoFix: true } };
      specLinkerPlugin.setup(api as never);
      expect(api.registerHook).toHaveBeenCalledTimes(2);
      expect(getMatcher(api, 'PreToolUse')).toBe('write');
      expect(getMatcher(api, 'PostToolUse')).toBe('write|edit');
    });

    it('configSchema defines enabled, fileGlobs, maxReferences, autoFix', () => {
      const schema = specLinkerPlugin.configSchema as Record<
        string,
        { properties?: Record<string, unknown> }
      >;
      const props = schema.properties;
      expect(props?.enabled).toBeDefined();
      expect(props?.fileGlobs).toBeDefined();
      expect(props?.maxReferences).toBeDefined();
      expect(props?.autoFix).toBeDefined();
    });

    it('defaultConfig has safe defaults (markdown-only, cap=8, autoFix off)', () => {
      const defaults = specLinkerPlugin.defaultConfig as Record<string, unknown>;
      expect(defaults.enabled).toBe(true);
      expect(defaults.fileGlobs).toEqual(['**/*.md', '**/*.mdx']);
      expect(defaults.maxReferences).toBe(8);
      expect(defaults.autoFix).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('H1 audit pattern', () => {
    it('teardown clears state and logs the unload line', () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      specLinkerPlugin.teardown!(api as never);
      expect(api.log.info).toHaveBeenCalledWith(
        expect.stringContaining('spec-linker: teardown complete'),
        expect.anything(),
      );
    });

    it('health() returns ok with counter info', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const health = await specLinkerPlugin.health!();
      expect(health.ok).toBe(true);
      expect(health.message).toContain('post=0');
      expect(health.message).toContain('pre=0');
    });

    it('setup is idempotent: counters reset on re-init', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      specLinkerPlugin.teardown!(api as never);
      specLinkerPlugin.setup(api as never);
      const health = await specLinkerPlugin.health!();
      expect(health.message).toContain('post=0');
    });

    it('teardown unregisters both hooks when autoFix was enabled', () => {
      const api = createMockAPI();
      api.config.extensions = { 'spec-linker': { autoFix: true } };
      const unregisters: number[] = [];
      api.registerHook = vi.fn((...args: unknown[]) => {
        // api.registerHook signature: (event, matcher, hook) => () => void
        void args;
        const fn = () => {
          unregisters.push(1);
        };
        return fn;
      }) as never;
      specLinkerPlugin.setup(api as never);
      specLinkerPlugin.teardown!(api as never);
      // Post + Pre = 2 unregisters
      expect(unregisters.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('PostToolUse hook (read-only)', () => {
    it('skips when toolName is not write/edit', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PostToolUse');
      const result = await hook({
        toolName: 'bash',
        toolInput: { path: '/tmp/x.md' },
        toolResult: { content: 'ok', isError: false },
      });
      expect(result).toBeUndefined();
    });

    it('skips when tool result indicates an error', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PostToolUse');
      const filePath = path.join(tmpDir, 'err.md');
      await fs.writeFile(filePath, 'see secret-scanner', 'utf-8');
      const result = await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'permission denied', isError: true },
      });
      expect(result).toBeUndefined();
    });

    it('skips non-markdown files by default', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PostToolUse');
      const tsPath = path.join(tmpDir, 'src.ts');
      await fs.writeFile(tsPath, 'see secret-scanner', 'utf-8');
      const result = await hook({
        toolName: 'write',
        toolInput: { path: tsPath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });
      expect(result).toBeUndefined();
      const tool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as {
        execute: () => Promise<unknown>;
      };
      const status = (await tool.execute()) as {
        counters: { skippedNonMd: number; postInvocations: number };
      };
      expect(status.counters.skippedNonMd).toBe(1);
      expect(status.counters.postInvocations).toBe(0);
    });

    it('does not fire when enabled=false', async () => {
      const api = createMockAPI();
      api.config.extensions = { 'spec-linker': { enabled: false } };
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PostToolUse');
      const filePath = path.join(tmpDir, 'off.md');
      await fs.writeFile(filePath, 'see secret-scanner', 'utf-8');
      await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });
      const tool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as {
        execute: () => Promise<unknown>;
      };
      const status = (await tool.execute()) as { counters: { postInvocations: number } };
      expect(status.counters.postInvocations).toBe(0);
    });

    it('detects an unlinked plugin reference in prose', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PostToolUse');
      const filePath = path.join(tmpDir, 'one.md');
      await fs.writeFile(
        filePath,
        'The secret-scanner plugin blocks credentials. See token-budget for the budget side.\n',
        'utf-8',
      );
      const result = await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });
      expect(result).toBeDefined();
      const ctx = (result as { additionalContext?: string }).additionalContext ?? '';
      expect(ctx).toContain('secret-scanner');
      expect(ctx).toContain('token-budget');
      expect(ctx).toContain('./src/secret-scanner');
      expect(ctx).toContain('./src/token-budget');
    });

    it('still detects a bare reference on a line with a stray dangling ](', async () => {
      // Regression: the link-URL heuristic treated ANY `](` earlier on the
      // line plus any later `)` as "the name is inside a link", so a bare
      // mention near a stray bracket was silently not reported. The `](` must
      // have a plausible label bracket before it to count as a link.
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PostToolUse');
      const filePath = path.join(tmpDir, 'dangling.md');
      await fs.writeFile(
        filePath,
        'Prefix ]( dangling and secret-scanner continues here) with prose.\n',
        'utf-8',
      );
      const result = await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });
      const ctx = (result as { additionalContext?: string } | undefined)?.additionalContext ?? '';
      expect(ctx).toContain('secret-scanner');
    });

    it('detects a bare reference when the name repeats on the line', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PostToolUse');
      const filePath = path.join(tmpDir, 'repeat.md');
      await fs.writeFile(
        filePath,
        'secret-scanner first, then secret-scanner again, and secret-scanner once more.\n',
        'utf-8',
      );
      const result = await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });
      const ctx = (result as { additionalContext?: string } | undefined)?.additionalContext ?? '';
      expect(ctx).toContain('secret-scanner');
    });

    it('skips references already wrapped in markdown links', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PostToolUse');
      const filePath = path.join(tmpDir, 'linked.md');
      await fs.writeFile(
        filePath,
        'The [secret-scanner](./src/secret-scanner) plugin blocks credentials.\n',
        'utf-8',
      );
      const result = await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });
      expect(result).toBeUndefined();
      const statusTool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as {
        execute: () => Promise<unknown>;
      };
      const status = (await statusTool.execute()) as {
        counters: { clean: number; unlinked: number };
      };
      expect(status.counters.clean).toBe(1);
      expect(status.counters.unlinked).toBe(0);
    });

    it('skips references wrapped in inline code', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PostToolUse');
      const filePath = path.join(tmpDir, 'code.md');
      await fs.writeFile(filePath, 'Run `secret-scanner` to block credentials.\n', 'utf-8');
      const result = await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });
      expect(result).toBeUndefined();
    });

    it('skips references inside fenced code blocks', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PostToolUse');
      const filePath = path.join(tmpDir, 'fenced.md');
      await fs.writeFile(
        filePath,
        ['```jsonc', '{ "plugins": { "secret-scanner": { "mode": "block" } } }', '```'].join('\n'),
        'utf-8',
      );
      const result = await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });
      expect(result).toBeUndefined();
    });

    it('respects word boundaries (no false-positive on substrings)', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PostToolUse');
      const filePath = path.join(tmpDir, 'substring.md');
      await fs.writeFile(
        filePath,
        'The "secret-scanner-config.json" file is in the repo. Cron-job is a script. No actual plugin name here.\n',
        'utf-8',
      );
      const result = await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });
      expect(result).toBeUndefined();
    });

    it('caps the additionalContext at maxReferences', async () => {
      const api = createMockAPI();
      api.config.extensions = { 'spec-linker': { maxReferences: 2 } };
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PostToolUse');
      const filePath = path.join(tmpDir, 'many.md');
      await fs.writeFile(
        filePath,
        [
          'First reference: secret-scanner.',
          'Second reference: token-budget.',
          'Third reference: lint-gate.',
          'Fourth reference: branch-guard.',
          'Fifth reference: todo-tracker.',
        ].join('\n'),
        'utf-8',
      );
      const result = await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });
      const ctx = (result as { additionalContext?: string }).additionalContext ?? '';
      expect(ctx).toContain('and 3 more');
      const lines = ctx.split('\n').filter((l) => l.startsWith('- `'));
      expect(lines.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('PreToolUse hook (autoFix)', () => {
    it('is not registered when autoFix is false (default)', () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const preCall = vi.mocked(api.registerHook).mock.calls.find((c) => c?.[0] === 'PreToolUse');
      expect(preCall).toBeUndefined();
    });

    it('is registered when autoFix=true', () => {
      const api = createMockAPI();
      api.config.extensions = { 'spec-linker': { autoFix: true } };
      specLinkerPlugin.setup(api as never);
      const preCall = vi.mocked(api.registerHook).mock.calls.find((c) => c?.[0] === 'PreToolUse');
      expect(preCall).toBeDefined();
    });

    it('patches the text alias when the write executor consumes it', async () => {
      // Regression: rawContent reads `content ?? CodeContent ?? text` but the
      // modifiedInput only patched content/CodeContent — a write executor on
      // the `text` alias silently dropped the fix.
      const api = createMockAPI();
      api.config.extensions = { 'spec-linker': { autoFix: true } };
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PreToolUse');
      const result = (await hook({
        toolName: 'write',
        toolInput: {
          path: '/tmp/alias.md',
          text: 'See secret-scanner for the details.',
        },
      })) as { decision?: 'allow' | 'block'; modifiedInput?: Record<string, unknown> } | undefined;
      expect(result?.decision).toBe('allow');
      const text = result?.modifiedInput?.['text'];
      expect(typeof text).toBe('string');
      expect(text as string).toContain('[secret-scanner](./src/secret-scanner)');
    });

    it('skips when content is already clean', async () => {
      const api = createMockAPI();
      api.config.extensions = { 'spec-linker': { autoFix: true } };
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PreToolUse');
      const result = await hook({
        toolName: 'write',
        toolInput: {
          path: '/tmp/clean.md',
          content: 'See [secret-scanner](./src/secret-scanner).',
        },
      });
      expect(result).toBeUndefined();
      const tool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as {
        execute: () => Promise<unknown>;
      };
      const status = (await tool.execute()) as {
        counters: { preInvocations: number; autoFixApplied: number };
      };
      // preInvocations was incremented, autoFixApplied was not.
      expect(status.counters.preInvocations).toBe(1);
      expect(status.counters.autoFixApplied).toBe(0);
    });

    it('wraps unlinked references in modifiedInput.content and returns decision=allow', async () => {
      const api = createMockAPI();
      api.config.extensions = { 'spec-linker': { autoFix: true } };
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PreToolUse');
      const result = (await hook({
        toolName: 'write',
        toolInput: {
          path: '/tmp/x.md',
          content: 'The secret-scanner plugin blocks credentials. See token-budget.\n',
        },
      })) as {
        decision: 'allow' | 'block';
        modifiedInput: { content: string; path: string };
        additionalContext: string;
      };

      expect(result.decision).toBe('allow');
      expect(result.modifiedInput.path).toBe('/tmp/x.md');
      expect(result.modifiedInput.content).toContain('[secret-scanner](./src/secret-scanner)');
      expect(result.modifiedInput.content).toContain('[token-budget](./src/token-budget)');
      // original bare reference should be gone
      expect(result.modifiedInput.content).not.toContain(' See secret-scanner plugin');
      expect(result.additionalContext).toContain('autoFix');
    });

    it('preserves the original casing of each plugin name', async () => {
      const api = createMockAPI();
      api.config.extensions = { 'spec-linker': { autoFix: true } };
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PreToolUse');
      const result = (await hook({
        toolName: 'write',
        toolInput: {
          path: '/tmp/x.md',
          content: 'Use Secret-Scanner and Token-Budget together.\n',
        },
      })) as { modifiedInput: { content: string } };
      expect(result.modifiedInput.content).toContain('[Secret-Scanner]');
      expect(result.modifiedInput.content).toContain('[Token-Budget]');
    });

    it('does not auto-fix `edit` (only `write`)', async () => {
      const api = createMockAPI();
      api.config.extensions = { 'spec-linker': { autoFix: true } };
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PreToolUse');
      const result = await hook({
        toolName: 'edit',
        toolInput: {
          path: '/tmp/x.md',
          old_string: 'secret-scanner',
          new_string: 'secret-scanner',
        },
      });
      expect(result).toBeUndefined();
    });

    it('skips non-markdown files', async () => {
      const api = createMockAPI();
      api.config.extensions = { 'spec-linker': { autoFix: true } };
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PreToolUse');
      const result = await hook({
        toolName: 'write',
        toolInput: {
          path: '/tmp/x.ts',
          content: 'see secret-scanner',
        },
      });
      expect(result).toBeUndefined();
    });

    it('leaves markdown-link and inline-code references alone', async () => {
      const api = createMockAPI();
      api.config.extensions = { 'spec-linker': { autoFix: true } };
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PreToolUse');
      const result = (await hook({
        toolName: 'write',
        toolInput: {
          path: '/tmp/x.md',
          content: [
            'See [secret-scanner](./src/secret-scanner) for the configured linter.',
            'And run `lint-gate` to enforce it.',
            'But token-budget is bare.',
          ].join('\n'),
        },
      })) as { modifiedInput: { content: string } };

      // secret-scanner (linked) and lint-gate (code-wrapped) are
      // untouched; only token-budget is wrapped.
      expect(result.modifiedInput.content).toContain('[secret-scanner](./src/secret-scanner)');
      expect(result.modifiedInput.content).toContain('`lint-gate`');
      expect(result.modifiedInput.content).toContain('[token-budget](./src/token-budget)');
      // Make sure the original "lint-gate" wasn't double-wrapped.
      expect(result.modifiedInput.content).not.toContain('`[lint-gate]');
    });

    it('does not auto-fix references inside fenced code blocks', async () => {
      const api = createMockAPI();
      api.config.extensions = { 'spec-linker': { autoFix: true } };
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PreToolUse');
      const content = [
        'Before secret-scanner.',
        '```jsonc',
        '{ "plugins": { "token-budget": {} } }',
        '```',
      ].join('\n');
      const result = (await hook({
        toolName: 'write',
        toolInput: { path: '/tmp/x.md', content },
      })) as { modifiedInput: { content: string } };

      expect(result.modifiedInput.content).toContain('[secret-scanner](./src/secret-scanner)');
      expect(result.modifiedInput.content).toContain('"token-budget": {}');
      expect(result.modifiedInput.content).not.toContain('"[token-budget]');
    });

    it('respects word boundaries in autoFix mode', async () => {
      const api = createMockAPI();
      api.config.extensions = { 'spec-linker': { autoFix: true } };
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PreToolUse');
      const result = (await hook({
        toolName: 'write',
        toolInput: {
          path: '/tmp/x.md',
          content: 'secret-scanner-config.json is a config. real-plugin token-budget is real.\n',
        },
      })) as { modifiedInput: { content: string } };
      // secret-scanner-config: substring of longer token → must NOT
      // match secret-scanner.
      expect(result.modifiedInput.content).toContain('secret-scanner-config.json');
      expect(result.modifiedInput.content).not.toContain('[secret-scanner]');
      // token-budget: standalone token → MUST match.
      expect(result.modifiedInput.content).toContain('[token-budget](./src/token-budget)');
    });

    it('updates autoFixApplied counter when at least one reference is wrapped', async () => {
      const api = createMockAPI();
      api.config.extensions = { 'spec-linker': { autoFix: true } };
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api, 'PreToolUse');
      await hook({
        toolName: 'write',
        toolInput: { path: '/tmp/x.md', content: 'see secret-scanner' },
      });
      await hook({
        toolName: 'write',
        toolInput: { path: '/tmp/y.md', content: 'all clean' },
      });
      const tool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as {
        execute: () => Promise<unknown>;
      };
      const status = (await tool.execute()) as {
        counters: { preInvocations: number; autoFixApplied: number };
      };
      expect(status.counters.preInvocations).toBe(2);
      expect(status.counters.autoFixApplied).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('status tool', () => {
    function getStatusTool(api: PluginAPI): { execute: () => Promise<unknown> } {
      const call = vi.mocked(api.tools.register).mock.calls[0];
      if (!call?.[0]) throw new Error('status tool not registered');
      return call[0] as { execute: () => Promise<unknown> };
    }

    it('reports config + counters + catalog size (default config)', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const tool = getStatusTool(api);
      const status = (await tool.execute()) as {
        enabled: boolean;
        fileGlobs: string[];
        maxReferences: number;
        autoFix: boolean;
        catalogSize: number;
        counters: {
          postInvocations: number;
          preInvocations: number;
          unlinked: number;
          clean: number;
          autoFixApplied: number;
        };
      };
      expect(status.enabled).toBe(true);
      expect(status.fileGlobs).toEqual(['**/*.md', '**/*.mdx']);
      expect(status.maxReferences).toBe(8);
      expect(status.autoFix).toBe(false);
      // Stays in sync with the plugin catalog — adding a plugin must not
      // break this test, only catalog/spec-linker drift should.
      expect(status.catalogSize).toBe(PLUGIN_NAMES.length);
      expect(status.counters.postInvocations).toBe(0);
      expect(status.counters.preInvocations).toBe(0);
      expect(status.counters.unlinked).toBe(0);
      expect(status.counters.clean).toBe(0);
      expect(status.counters.autoFixApplied).toBe(0);
    });

    it('reports autoFix=true when enabled', async () => {
      const api = createMockAPI();
      api.config.extensions = { 'spec-linker': { autoFix: true } };
      specLinkerPlugin.setup(api as never);
      const tool = getStatusTool(api);
      const status = (await tool.execute()) as { autoFix: boolean };
      expect(status.autoFix).toBe(true);
    });
  });
});
