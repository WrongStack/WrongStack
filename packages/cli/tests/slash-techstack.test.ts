import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/core/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildTechStackCommand } from '../src/slash-commands/techstack.js';

const techstackMocks = vi.hoisted(() => ({ close: vi.fn() }));
vi.mock('@wrongstack/techstack', () => {
  const snapshot = {
    id: 'snapshot-1',
    projectId: 'project',
    targetRoot: '/project',
    fingerprint: 'fingerprint',
    createdAt: '2026-07-21T00:00:00.000Z',
    adapterVersion: 'test',
    coverage: 'full',
    workspaces: [{ id: 'workspace-1', relativeRoot: '.', ecosystem: 'npm' }],
    dependencies: [
      {
        id: 'dependency-1',
        workspaceId: 'workspace-1',
        ecosystem: 'npm',
        name: 'react',
        locked: '18.0.0',
        latestStable: '19.0.0',
      },
    ],
    findings: [
      {
        dependencyId: 'dependency-1',
        action: 'upgrade_major',
        severity: 'medium',
        rationale: 'upgrade',
      },
    ],
  };
  return {
    TechStackStore: class {
      close = techstackMocks.close;
    },
    TechStackEngine: class {
      async analyze() {
        return { snapshot };
      }
      async inventory() {
        return snapshot;
      }
    },
    generateUpgradePlan: () => ({
      snapshotId: 'snapshot-1',
      generatedAt: '2026-07-21T00:00:00.000Z',
      warning: 'review',
      summary: { total: 1, patch: 0, minor: 0, major: 1, replace: 0, remove: 0, investigate: 0 },
      items: [
        {
          dependencyName: 'react',
          ecosystem: 'npm',
          workspaceId: 'workspace-1',
          currentVersion: '18.0.0',
          targetVersion: '19.0.0',
          action: 'upgrade_major',
          severity: 'medium',
          rationale: 'upgrade',
        },
      ],
    }),
    renderPlanMarkdown: () => '# TechStack Remediation Plan\nreact 18 → 19',
    toLanguagePackageInput: () => ({
      operation: 'add',
      workspace: '.',
      names: ['react@19.0.0'],
      allowScripts: false,
    }),
    applyPlan: async (
      plan: { items: Array<Record<string, unknown>> },
      options: {
        approve: (item: Record<string, unknown>) => boolean;
        execute: (operation: Record<string, unknown>) => Promise<unknown>;
      },
    ) => ({
      dryRun: false,
      items: await Promise.all(
        plan.items.map(async (item) => {
          if (!options.approve(item))
            return { dependencyName: item.dependencyName, status: 'skipped' };
          await options.execute(item);
          return { dependencyName: item.dependencyName, status: 'applied' };
        }),
      ),
    }),
  };
});

type SlashResult = {
  exit?: boolean | undefined;
  message?: string | undefined;
  runText?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

function expectSlashResult(value: void | SlashResult): SlashResult {
  expect(value).toBeTruthy();
  return value as SlashResult;
}

class FakeRenderer {
  output = '';
  warnings: string[] = [];
  write(s: unknown): void {
    this.output += typeof s === 'string' ? s : '';
  }
  writeLine(s = ''): void {
    this.output += `${s}\n`;
  }
  writeBlock(): void {}
  writeToolCall(): void {}
  writeToolResult(): void {}
  writeDiff(): void {}
  writeWarning(s: string): void {
    this.warnings.push(s);
  }
  writeError(): void {}
  writeInfo(): void {}
  clear(): void {
    this.output = '';
  }
}

function fetchToolStub(): Tool {
  return {
    name: 'fetch',
    description: 'stub fetch',
    inputSchema: { type: 'object' },
    permission: 'confirm',
    mutating: false,
    capabilities: ['net.outbound'],
    async execute() {
      return '';
    },
  } as Tool;
}

describe('/techstack', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-techstack-'));
    await fs.writeFile(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { left: '1.0.0' } }),
    );
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  function rig(opts: {
    withFetch: boolean;
    onSpawnAndWait?: SlashCommandContext['onSpawnAndWait'];
    executeTool?: SlashCommandContext['executeTool'];
  }) {
    const renderer = new FakeRenderer();
    const toolRegistry = new ToolRegistry();
    if (opts.withFetch) toolRegistry.register(fetchToolStub());
    const ctx = {
      toolRegistry,
      renderer: renderer as never as SlashCommandContext['renderer'],
      cwd: projectRoot,
      projectRoot,
      ...(opts.onSpawnAndWait ? { onSpawnAndWait: opts.onSpawnAndWait } : {}),
      ...(opts.executeTool ? { executeTool: opts.executeTool } : {}),
    } satisfies Pick<SlashCommandContext, 'toolRegistry' | 'renderer' | 'cwd' | 'projectRoot'> &
      Partial<Pick<SlashCommandContext, 'onSpawnAndWait' | 'executeTool'>>;
    return { renderer, command: buildTechStackCommand(ctx as SlashCommandContext) };
  }

  it('aborts with a tier hint when the fetch tool is not registered', async () => {
    const spawn = vi.fn(async () => 'summary');
    const { renderer, command } = rig({ withFetch: false, onSpawnAndWait: spawn });
    const res = expectSlashResult(await command.run('', {} as never));
    expect(spawn).not.toHaveBeenCalled();
    expect(res.message).toMatch(/fetch.*unavailable|token-saving/i);
    expect(renderer.warnings.join('\n')).toMatch(/fetch/i);
  });

  it('spawns with a scoped tool allowlist and fs.write capability when fetch is available', async () => {
    const spawn = vi.fn(async () => 'done');
    const { command } = rig({ withFetch: true, onSpawnAndWait: spawn });
    const res = expectSlashResult(await command.run('', {} as never));
    expect(spawn).toHaveBeenCalledTimes(1);
    const passedOpts = spawn.mock.calls[0]?.[1] as { tools?: string[]; allowedCapabilities?: string[] } | undefined;
    expect(passedOpts).toBeDefined();
    expect(passedOpts.tools).toEqual(expect.arrayContaining(['read', 'fetch', 'write']));
    // Shell tools must NOT be granted.
    expect(passedOpts.tools).not.toContain('bash');
    expect(passedOpts.tools).not.toContain('exec');
    expect(passedOpts.allowedCapabilities).toEqual(
      expect.arrayContaining(['fs.read', 'net.outbound', 'fs.write']),
    );
    expect(passedOpts.allowedCapabilities).not.toContain('shell.arbitrary');
    expect(res.message).toBe('done');
  });

  it('reports when multi-agent is disabled (no onSpawnAndWait)', async () => {
    const { command } = rig({ withFetch: true });
    const res = expectSlashResult(await command.run('', {} as never));
    expect(res.message).toMatch(/multi-agent is not enabled/i);
  });

  it('renders a structured remediation plan without spawning a subagent', async () => {
    const spawn = vi.fn(async () => 'unused');
    const { command } = rig({ withFetch: false, onSpawnAndWait: spawn });
    const result = expectSlashResult(
      await command.run('--plan', { signal: new AbortController().signal } as never),
    );
    expect(result.message).toContain('TechStack Remediation Plan');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('applies through the governed language_package bridge', async () => {
    const executeTool = vi.fn(async () => ({ detail: 'updated' }));
    const { command } = rig({ withFetch: false, executeTool });
    const result = expectSlashResult(
      await command.run('--apply', { signal: new AbortController().signal } as never),
    );
    expect(executeTool).toHaveBeenCalledWith(
      'language_package',
      expect.objectContaining({ operation: 'add', names: ['react@19.0.0'], allowScripts: false }),
      expect.anything(),
    );
    expect(result.message).toMatch(/1 applied, 0 failed/);
  });
});
