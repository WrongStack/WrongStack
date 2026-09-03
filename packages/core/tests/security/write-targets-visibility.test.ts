import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { fsWriteTargetPaths } from '../../src/security/permission-helpers.js';
import type { Tool } from '../../src/types/tool.js';
import type { ToolUseBlock } from '../../src/types/blocks.js';
import { wstackGlobalRoot } from '../../src/utils/wstack-paths.js';

/**
 * VULN-001 Phase 2 / VULN-006 blind-spot class: a mutating tool whose real
 * filesystem destinations live inside a payload body (patch.patch,
 * provider_manage config payloads, …) were invisible to both permission
 * layers — `fsWriteTargetPaths` reads a fixed input-key list, so the
 * agent-state write gate and the confirm prompt saw only innocuous keys like
 * `directory: "."`.
 *
 * The `Tool.writeTargets(input): string[]` hook lets a tool declare its
 * destinations; the gate unions them with the key list (never narrows) and
 * the confirm prompt prefers them for display. These tests were written
 * against the unwired code and failed there (red-first).
 */

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-targets-'));
});

/** A write-capable tool whose destinations are only reachable via the hook. */
function hookTool(targets: string[], throwOnCall = false): Tool {
  return {
    name: 'payload-writer',
    description: 'writes files named inside a payload body',
    inputSchema: { type: 'object', properties: { payload: { type: 'string' } } },
    permission: 'confirm',
    mutating: true,
    capabilities: ['fs.write'],
    ...(throwOnCall
      ? {
          writeTargets: (() => {
            throw new Error('hook exploded');
          }) as Tool['writeTargets'],
        }
      : { writeTargets: () => targets }),
    async execute() {
      return 'ok';
    },
  } as Tool;
}

function plainTool(): Tool {
  return {
    name: 'write',
    description: 'write',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    permission: 'confirm',
    mutating: true,
    capabilities: ['fs.write'],
    async execute() {
      return 'ok';
    },
  };
}

describe('fsWriteTargetPaths — Tool.writeTargets union (VULN-001 Phase 2)', () => {
  it('unions the hook destinations with the fixed key list', () => {
    const tool = hookTool(['from-hook/a.txt', 'from-hook/b.txt']);
    const input = { payload: 'ignored-by-key-list', path: 'from-key.txt' };
    const targets = fsWriteTargetPaths(tool, input);
    // The hook paths must be visible to the agent-state gate…
    expect(targets).toContain('from-hook/a.txt');
    expect(targets).toContain('from-hook/b.txt');
    // …and the key-list paths must survive (union, never a replacement).
    expect(targets).toContain('from-key.txt');
  });

  it('keeps the fixed key list for tools without the hook (no regression)', () => {
    const targets = fsWriteTargetPaths(plainTool(), { path: 'plain.txt' });
    expect(targets).toEqual(['plain.txt']);
  });

  it('falls back to the key list when the hook throws', () => {
    // A security gate must degrade to the previous behaviour, never crash
    // permission evaluation because a tool's hook is buggy.
    const tool = hookTool(['never-returned'], true);
    const targets = fsWriteTargetPaths(tool, { path: 'fallback.txt' });
    expect(targets).toContain('fallback.txt');
    expect(targets).not.toContain('never-returned');
  });
});

describe('describeWriteTargets — confirm-prompt display contract', () => {
  it('prefers the hook output when the tool declares one', async () => {
    const { describeWriteTargets } = (await import('../../src/security/permission-helpers.js')) as {
      describeWriteTargets: (tool: Tool | undefined, input: unknown) => string[];
    };
    const tool = hookTool(['real/dest.txt']);
    // Display shows exactly the tool's declaration — no `directory: "."` noise.
    expect(describeWriteTargets(tool, { directory: '.' })).toEqual(['real/dest.txt']);
  });

  it('falls back to the key list when no hook is declared', async () => {
    const { describeWriteTargets } = (await import('../../src/security/permission-helpers.js')) as {
      describeWriteTargets: (tool: Tool | undefined, input: unknown) => string[];
    };
    expect(describeWriteTargets(plainTool(), { path: 'dest.txt' })).toEqual(['dest.txt']);
  });
});

describe('agent-state write gate sees hook destinations (leader policy)', () => {
  it('forces confirm in YOLO when writeTargets names an agent-state path', async () => {
    // The attack shape from VULN-001: destinations hidden in a payload body,
    // input keys clean. Before the wiring, the gate was structurally blind
    // and YOLO auto-approved this call.
    const agentStateTarget = path.join(wstackGlobalRoot(), 'config.json');
    const tool = hookTool([agentStateTarget]);
    const policy = new DefaultPermissionPolicy({
      trustFile: path.join(tmpDir, 'trust.json'),
      yolo: true,
    });
    const ctx = {
      cwd: tmpDir,
      workingDir: tmpDir,
      projectRoot: tmpDir,
      meta: {},
    } as unknown as Context;
    const decision = await policy.evaluate(tool, { payload: 'innocuous' }, ctx);
    expect(decision.permission).toBe('confirm');
  });
});

describe('confirm payload carries writeTargets (ToolConfirmPendingResult)', () => {
  it('surfaces the hook destinations on the pending-confirm result', async () => {
    const tool = hookTool(['visible/destination.txt']);
    const confirmPolicy = {
      evaluate: vi.fn().mockResolvedValue({ permission: 'confirm', source: 'default' }),
    };
    const registry = { get: (n: string) => (n === tool.name ? tool : undefined), list: () => [tool] };
    const executor = new ToolExecutor(registry, {
      permissionPolicy: confirmPolicy as never,
      secretScrubber: { scrub: (s: string) => s } as never,
    });
    const use: ToolUseBlock = { type: 'tool_use', id: 'id_1', name: tool.name, input: {} };
    const out = await executor.executeBatch([use], { cwd: tmpDir, meta: {} } as never, 'sequential');
    const result = (out.outputs[0]?.result ?? {}) as {
      type?: string;
      writeTargets?: string[];
    };
    expect(result.type).toBe('tool_confirm_pending');
    expect(result.writeTargets).toContain('visible/destination.txt');
  });
});
