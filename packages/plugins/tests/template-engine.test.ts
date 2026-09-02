import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import templateEnginePlugin from '../src/template-engine';

const mockApi = {
  tools: {
    register: vi.fn(),
  },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  config: { extensions: {} },
  metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
  registerSystemPromptContributor: vi.fn(() => () => {}),
};

describe('template-engine plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export a Plugin object', () => {
    expect(templateEnginePlugin).toBeDefined();
    expect(templateEnginePlugin.name).toBe('template-engine');
    expect(templateEnginePlugin.apiVersion).toBe('^0.1.10');
  });

  it('should register four tools in setup', () => {
    templateEnginePlugin.setup(mockApi as any);
    expect(mockApi.tools.register).toHaveBeenCalledTimes(4);
  });

  it('should have template_expand tool registered', () => {
    templateEnginePlugin.setup(mockApi as any);
    const registeredTools = mockApi.tools.register.mock.calls.map(([tool]: any[]) => tool.name);
    expect(registeredTools).toContain('template_expand');
  });

  it('should have template_render tool registered', () => {
    templateEnginePlugin.setup(mockApi as any);
    const registeredTools = mockApi.tools.register.mock.calls.map(([tool]: any[]) => tool.name);
    expect(registeredTools).toContain('template_render');
  });

  it('should have template_create tool registered', () => {
    templateEnginePlugin.setup(mockApi as any);
    const registeredTools = mockApi.tools.register.mock.calls.map(([tool]: any[]) => tool.name);
    expect(registeredTools).toContain('template_create');
  });

  it('template_expand should have correct properties', () => {
    templateEnginePlugin.setup(mockApi as any);
    const tool = mockApi.tools.register.mock.calls.find(
      ([tool]: any[]) => tool.name === 'template_expand',
    )?.[0];

    expect(tool.description).toBe(
      'Expand a template string with variable substitution. Supports {{variable}}, {{#if var}}...{{/if}} conditionals, and {{#each items}}...{{/each}} loops.',
    );
    // Writes caller-supplied content to a caller-supplied path. `auto` with no
    // declared capability meant no prompt, no read-only-mode block (that
    // policy keys on `capabilities`, not `mutating`) and no PreToolUse hook.
    expect(tool.permission).toBe('confirm');
    expect(tool.mutating).toBe(true);
    expect(tool.capabilities).toContain('fs.write');
    expect(tool.riskTier).toBe('destructive');
  });

  it('template_render should have correct properties', () => {
    templateEnginePlugin.setup(mockApi as any);
    const tool = mockApi.tools.register.mock.calls.find(
      ([tool]: any[]) => tool.name === 'template_render',
    )?.[0];

    expect(tool.description).toBe(
      'Read a template file from disk and expand it with the given variables.',
    );
    expect(tool.permission).toBe('confirm');
    expect(tool.mutating).toBe(true);
    expect(tool.capabilities).toContain('fs.write');
    expect(tool.riskTier).toBe('destructive');
  });

  describe('protected write targets', () => {
    // `template_expand` calls `writeFile(output_path, …)` with a RELATIVE path
    // and no project root, so it writes under `process.cwd()`. When this suite
    // ran from the repo root while the guard was temporarily absent from the
    // working tree, the payload below landed in the repository's real
    // `package.json` and `.env` — 20 bytes of `#!/bin/sh` + `echo pwned`,
    // executable bit and all.
    //
    // A security test must not be able to damage the tree it is testing. The
    // cwd swap is the containment: the assertions prove the guard refuses, and
    // the temp directory means a REGRESSION in the guard fails this test
    // instead of overwriting the developer's manifest.
    let previousCwd: string;
    let sandbox: string;

    beforeEach(() => {
      previousCwd = process.cwd();
      sandbox = mkdtempSync(path.join(os.tmpdir(), 'wstack-template-engine-'));
      process.chdir(sandbox);
    });

    afterEach(() => {
      process.chdir(previousCwd);
      rmSync(sandbox, { recursive: true, force: true });
    });

    it.each([
      '.git/hooks/pre-commit',
      '.husky/pre-commit',
      '.github/workflows/ci.yml',
      'package.json',
      '.env',
      '.wrongstack/config.json',
    ])('template_expand refuses to write the protected path %s', async (target) => {
      templateEnginePlugin.setup(mockApi as any);
      const tool = mockApi.tools.register.mock.calls.find(
        ([tool]: any[]) => tool.name === 'template_expand',
      )?.[0];

      // All of these are INSIDE the project, so "must resolve inside the
      // project directory" let them through — and they are code-execution or
      // credential sinks. path-guard could not cover them either: its matcher
      // keyed on the tool names write|edit|bash|exec, so it never saw a
      // plugin-registered tool.
      const res = await tool.execute({
        template: '#!/bin/sh\necho pwned',
        variables: {},
        raw: true,
        output_path: target,
      });
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain('protected path');
      // Belt and braces: nothing reached the filesystem either.
      expect(existsSync(path.join(sandbox, target))).toBe(false);
    });
  });

  it('template_create should have correct properties', () => {
    templateEnginePlugin.setup(mockApi as any);
    const tool = mockApi.tools.register.mock.calls.find(
      ([tool]: any[]) => tool.name === 'template_create',
    )?.[0];

    expect(tool.description).toBe(
      "Save a named template to the plugin's template store for later use.",
    );
    expect(tool.permission).toBe('auto');
    expect(tool.mutating).toBe(false);
  });

  describe('template_expand output_path validation', () => {
    it('rejects absolute output_path', async () => {
      templateEnginePlugin.setup(mockApi as any);
      const tool = mockApi.tools.register.mock.calls.find(
        ([t]: any[]) => t.name === 'template_expand',
      )?.[0];
      const result = await tool.execute({
        template: 'hello {{name}}',
        variables: { name: 'world' },
        output_path: '/etc/passwd',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('relative path');
    });

    it('rejects output_path with .. traversal', async () => {
      templateEnginePlugin.setup(mockApi as any);
      const tool = mockApi.tools.register.mock.calls.find(
        ([t]: any[]) => t.name === 'template_expand',
      )?.[0];
      const result = await tool.execute({
        template: 'hello {{name}}',
        variables: { name: 'world' },
        output_path: '../../../etc/passwd',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('relative path');
    });

    it('accepts relative output_path (no path validation error)', async () => {
      templateEnginePlugin.setup(mockApi as any);
      const tool = mockApi.tools.register.mock.calls.find(
        ([t]: any[]) => t.name === 'template_expand',
      )?.[0];
      // Use a temp file in cwd. The important thing is that the path
      // validation does NOT reject it (no "relative path" error).
      const tmpFile = `.test-output-${Date.now()}.txt`;
      try {
        const result = await tool.execute({
          template: 'hello {{name}}',
          variables: { name: 'world' },
          output_path: tmpFile,
        });
        expect(result.ok).toBe(true);
        expect(result.message).toContain('Wrote');
      } finally {
        const fs = await import('node:fs/promises');
        await fs.unlink(tmpFile).catch(() => {});
      }
    });
  });
});
