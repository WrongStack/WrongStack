import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadOnlyPermissionPolicy } from '../../src/security/readonly-permission-policy.js';
import { ToolCapabilities } from '../../src/security/capabilities.js';
import type { Context } from '../../src/core/context.js';
import type { Tool } from '../../src/types/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function tool(
  name: string,
  permission: 'auto' | 'confirm' | 'deny' = 'auto',
  capabilities?: readonly string[],
): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    permission,
    mutating: capabilities?.includes(ToolCapabilities.FS_WRITE) ?? false,
    capabilities,
    async execute() {
      return 'ok';
    },
  };
}

function readTool(): Tool {
  return tool('read', 'auto', [ToolCapabilities.FS_READ]);
}

function writeTool(): Tool {
  return tool('write', 'auto', [ToolCapabilities.FS_WRITE]);
}

function shellTool(): Tool {
  return tool('bash', 'auto', [ToolCapabilities.SHELL_ARBITRARY]);
}

function memoryReadTool(): Tool {
  return tool('search_memory', 'auto', [ToolCapabilities.MEMORY_READ]);
}

function makeCtx(readOnly?: boolean): Context {
  return {
    meta: { ...(readOnly !== undefined ? { readOnly } : {}) },
    projectRoot: projectRoot,
    provider: null as never,
    model: 'test',
    messages: [],
    todos: [],
    readFiles: new Set(),
    writtenFiles: [],
    workingDir: projectRoot,
    cwd: projectRoot,
    agentId: 'test-agent',
  } as unknown as Context;
}

// The inner policy auto-approves every tool (permission: 'auto').
const ALLOW_INNER = {
  evaluate: async () => ({ permission: 'auto' as const, source: 'trust' as const }),
  trust: async () => {},
  deny: async () => {},
  denyOnce: () => {},
  allowOnce: () => {},
  reload: async () => {},
};

let projectRoot: string;

describe('ReadOnlyPermissionPolicy', () => {
  beforeEach(() => {
    projectRoot = path.resolve(os.tmpdir(), 'wstack-ro-test');
  });

  afterEach(() => {
    // no cleanup needed — no files are created by these tests
  });

  // ── Pass-through when readOnly is not set or false ────────────────────

  it('passes through when ctx.meta.readOnly is not set', async () => {
    const policy = new ReadOnlyPermissionPolicy(ALLOW_INNER, projectRoot);
    const ctx = makeCtx(); // no readOnly
    const result = await policy.evaluate(writeTool(), { path: 'src/main.ts' }, ctx);
    expect(result.permission).toBe('auto');
  });

  it('passes through when ctx.meta.readOnly is false', async () => {
    const policy = new ReadOnlyPermissionPolicy(ALLOW_INNER, projectRoot);
    const ctx = makeCtx(false);
    const result = await policy.evaluate(writeTool(), { path: 'src/main.ts' }, ctx);
    expect(result.permission).toBe('auto');
  });

  // ── Blocks mutation-capable tools when readOnly is true ──────────────

  it('blocks write tool when readOnly is true', async () => {
    const policy = new ReadOnlyPermissionPolicy(ALLOW_INNER, projectRoot);
    const ctx = makeCtx(true);
    const result = await policy.evaluate(writeTool(), { path: 'src/main.ts' }, ctx);
    expect(result.permission).toBe('deny');
    expect(result.source).toBe('readonly_mode');
    expect(result.reason).toContain('read-only mode');
  });

  it('blocks shell tool when readOnly is true', async () => {
    const policy = new ReadOnlyPermissionPolicy(ALLOW_INNER, projectRoot);
    const ctx = makeCtx(true);
    const result = await policy.evaluate(shellTool(), { command: 'rm -rf /' }, ctx);
    expect(result.permission).toBe('deny');
    expect(result.source).toBe('readonly_mode');
  });

  // ── Read-only tools pass through even when readOnly is true ──────────

  it('allows read tool when readOnly is true', async () => {
    const policy = new ReadOnlyPermissionPolicy(ALLOW_INNER, projectRoot);
    const ctx = makeCtx(true);
    const result = await policy.evaluate(readTool(), { path: 'src/main.ts' }, ctx);
    expect(result.permission).toBe('auto');
  });

  it('allows memory read tool when readOnly is true', async () => {
    const policy = new ReadOnlyPermissionPolicy(ALLOW_INNER, projectRoot);
    const ctx = makeCtx(true);
    const result = await policy.evaluate(memoryReadTool(), { query: 'foo' }, ctx);
    expect(result.permission).toBe('auto');
  });

  // ── .temp_files/*.md exception ───────────────────────────────────────

  it('allows writing .md to .temp_files/ when readOnly is true', async () => {
    const policy = new ReadOnlyPermissionPolicy(ALLOW_INNER, projectRoot);
    const ctx = makeCtx(true);
    const result = await policy.evaluate(writeTool(), { path: '.temp_files/report.md' }, ctx);
    expect(result.permission).toBe('auto');
  });

  it('blocks writing .ts to .temp_files/ when readOnly is true', async () => {
    const policy = new ReadOnlyPermissionPolicy(ALLOW_INNER, projectRoot);
    const ctx = makeCtx(true);
    const result = await policy.evaluate(writeTool(), { path: '.temp_files/report.ts' }, ctx);
    expect(result.permission).toBe('deny');
  });

  it('blocks writing .md outside .temp_files/ when readOnly is true', async () => {
    const policy = new ReadOnlyPermissionPolicy(ALLOW_INNER, projectRoot);
    const ctx = makeCtx(true);
    const result = await policy.evaluate(writeTool(), { path: 'docs/report.md' }, ctx);
    expect(result.permission).toBe('deny');
  });

  it('rejects path traversal escape from .temp_files/ when readOnly is true', async () => {
    const policy = new ReadOnlyPermissionPolicy(ALLOW_INNER, projectRoot);
    const ctx = makeCtx(true);
    const result = await policy.evaluate(
      writeTool(),
      { path: '.temp_files/../../etc/passwd.md' },
      ctx,
    );
    expect(result.permission).toBe('deny');
  });

  // ── Delegation ───────────────────────────────────────────────────────

  it('delegates trust/deny/denyOnce/allowOnce to inner policy', async () => {
    const inner = {
      evaluate: async () => ({ permission: 'auto' as const, source: 'trust' as const }),
      trust: vi.fn(async () => {}),
      deny: vi.fn(async () => {}),
      denyOnce: vi.fn(() => {}),
      allowOnce: vi.fn(() => {}),
      reload: async () => {},
    };
    const policy = new ReadOnlyPermissionPolicy(inner, projectRoot);

    await policy.trust({ tool: 'read', pattern: '**/*' });
    expect(inner.trust).toHaveBeenCalledWith({ tool: 'read', pattern: '**/*' });

    await policy.deny({ tool: 'write', pattern: '**/*' });
    expect(inner.deny).toHaveBeenCalledWith({ tool: 'write', pattern: '**/*' });

    policy.denyOnce({ tool: 'bash', pattern: '**/*' });
    expect(inner.denyOnce).toHaveBeenCalledWith({ tool: 'bash', pattern: '**/*' });

    policy.allowOnce({ tool: 'write', pattern: '.temp_files/*' });
    expect(inner.allowOnce).toHaveBeenCalledWith({ tool: 'write', pattern: '.temp_files/*' });
  });

  // ── Explain ──────────────────────────────────────────────────────────

  it('explain delegates to inner policy when readOnly is not set', async () => {
    const inner = {
      evaluate: async () => ({ permission: 'auto' as const, source: 'trust' as const }),
      explain: async () => ({
        toolName: 'read',
        subject: null,
        steps: [
          {
            rule: 'test',
            matched: true,
            decision: 'auto' as const,
            source: 'trust',
            detail: 'test',
          },
        ],
        winnerIndex: 0,
        decision: { permission: 'auto' as const, source: 'trust' as const },
      }),
      trust: async () => {},
      deny: async () => {},
      denyOnce: () => {},
      allowOnce: () => {},
      reload: async () => {},
    };
    const policy = new ReadOnlyPermissionPolicy(inner, projectRoot);
    const ctx = makeCtx(); // no readOnly
    const trace = await policy.explain(readTool(), {}, ctx);
    expect(trace.steps[0]!.rule).toBe('test');
  });
});
