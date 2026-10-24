import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { scopedApprovalPattern } from '../../src/security/scoped-approval.js';

const exec: Tool = {
  name: 'exec',
  description: '',
  inputSchema: { type: 'object' },
  permission: 'confirm',
  subjectKey: 'command',
  mutating: true,
  async execute() {
    return '';
  },
};

describe('explicit approval scopes', () => {
  let root: string;
  let ctx: Context;
  let policy: DefaultPermissionPolicy;
  const input = { command: 'uv', args: ['run', 'pytest'] };
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'scoped-approval-'));
    ctx = { projectRoot: root, cwd: root } as Context;
    policy = new DefaultPermissionPolicy({ trustFile: path.join(root, 'trust.json') });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const grant = async (decision: string) =>
    policy.trust({
      tool: exec.name,
      pattern: scopedApprovalPattern(decision, exec, input, ctx, 'uv run pytest'),
    });

  it('exact approval persists only identical input, argv boundaries and cwd', async () => {
    await grant('always-exact');
    expect(
      (await policy.evaluate(exec, { args: ['run', 'pytest'], command: 'uv' }, ctx)).permission,
    ).toBe('auto');
    expect(
      (await policy.evaluate(exec, { command: 'uv', args: ['run pytest'] }, ctx)).permission,
    ).toBe('confirm');
    expect((await policy.evaluate(exec, { ...input, args: ['run', 'ruff'] }, ctx)).permission).toBe(
      'confirm',
    );
    expect(
      (
        await policy.evaluate(exec, input, {
          ...ctx,
          workingDir: path.join(root, 'other'),
        } as Context)
      ).permission,
    ).toBe('confirm');
    expect((await policy.evaluate({ ...exec, name: 'another-tool' }, input, ctx)).permission).toBe(
      'confirm',
    );
    await policy.reload();
    expect((await policy.evaluate(exec, input, ctx)).permission).toBe('auto');
  });

  it('command approval accepts different args but not a different executable or tool', async () => {
    await grant('always-command');
    expect((await policy.evaluate(exec, { ...input, args: ['sync'] }, ctx)).permission).toBe(
      'auto',
    );
    expect(
      (await policy.evaluate(exec, { command: 'python', args: ['--version'] }, ctx)).permission,
    ).toBe('confirm');
    expect((await policy.evaluate({ ...exec, name: 'bash' }, input, ctx)).permission).toBe(
      'confirm',
    );
  });

  it('tool approval accepts other commands but still prompts for destructive calls', async () => {
    await grant('always-tool');
    expect(
      (await policy.evaluate(exec, { command: 'git', args: ['status'] }, ctx)).permission,
    ).toBe('auto');
    const dangerous = { command: 'git', args: ['reset', '--hard'] };
    expect(await policy.evaluate(exec, dangerous, ctx)).toMatchObject({
      permission: 'confirm',
      riskTier: 'destructive',
    });
    expect((await policy.explain(exec, dangerous, ctx)).decision.permission).toBe('confirm');
  });

  it('tool approval does not cover sensitive reads outside YOLO; exact approval does', async () => {
    const read: Tool = {
      name: 'read',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      capabilities: ['fs.read'],
      mutating: false,
      async execute() {
        return '';
      },
    };
    const sensitive = { path: '.env' };
    await policy.trust({
      tool: 'read',
      pattern: scopedApprovalPattern('always-tool', read, { path: 'README.md' }, ctx, ''),
    });
    expect((await policy.evaluate(read, { path: 'src/a.ts' }, ctx)).permission).toBe('auto');
    expect(await policy.evaluate(read, sensitive, ctx)).toMatchObject({
      permission: 'confirm',
      reason: expect.stringContaining('sensitive file read'),
    });
    expect((await policy.explain(read, sensitive, ctx)).decision.permission).toBe('confirm');
    await policy.trust({
      tool: 'read',
      pattern: scopedApprovalPattern('always-exact', read, sensitive, ctx, '.env'),
    });
    expect((await policy.evaluate(read, sensitive, ctx)).permission).toBe('auto');
  });

  it('command approval cannot silently authorize a destructive subcommand', async () => {
    const git = { command: 'git', args: ['status'] };
    await policy.trust({
      tool: 'exec',
      pattern: scopedApprovalPattern('always-command', exec, git, ctx, ''),
    });
    expect(
      (await policy.evaluate(exec, { command: 'git', args: ['reset', '--hard'] }, ctx)).permission,
    ).toBe('confirm');
  });

  it('explicit deny wins over all three approval scopes', async () => {
    for (const scope of ['always-exact', 'always-command', 'always-tool']) await grant(scope);
    await policy.deny({ tool: 'exec', pattern: 'uv *' });
    expect((await policy.evaluate(exec, input, ctx)).permission).toBe('deny');
  });

  it('explains inherited denies after adding a tool-specific scope', async () => {
    await policy.deny({ tool: '*', pattern: 'uv *' });
    await grant('always-tool');
    expect((await policy.evaluate(exec, input, ctx)).permission).toBe('deny');
    expect((await policy.explain(exec, input, ctx)).decision.permission).toBe('deny');
  });

  it('explains that an explicit deny beats a pending one-shot grant', async () => {
    await policy.reload();
    policy.allowOnce({ tool: 'exec', pattern: 'uv run pytest' });
    await policy.deny({ tool: 'exec', pattern: 'uv *' });
    expect((await policy.explain(exec, input, ctx)).decision.permission).toBe('deny');
    expect((await policy.evaluate(exec, input, ctx)).permission).toBe('deny');
  });

  it('keeps an existing deny active if re-saving the rule fails', async () => {
    await policy.deny({ tool: 'exec', pattern: 'uv *' });
    const trustFile = path.join(root, 'trust.json');
    const saved = await fs.readFile(trustFile, 'utf8');
    await fs.rm(trustFile);
    await fs.mkdir(trustFile);
    await expect(policy.deny({ tool: 'exec', pattern: 'uv *' })).rejects.toThrow();
    expect((await policy.evaluate(exec, input, ctx)).permission).toBe('deny');
    // The operator repairs trust.json; persisting builds on what is on disk.
    await fs.rmdir(trustFile);
    await fs.writeFile(trustFile, saved);
    await grant('always-tool');
    expect((await policy.evaluate(exec, input, ctx)).permission).toBe('deny');
    expect(JSON.parse(await fs.readFile(trustFile, 'utf8')).exec.deny).toEqual(['uv *']);
  });

  it('persists concurrent approvals without dropping either scope', async () => {
    await Promise.all([grant('always-exact'), grant('always-command')]);
    await policy.reload();
    const saved = JSON.parse(await fs.readFile(path.join(root, 'trust.json'), 'utf8'));
    expect(saved.exec.allow).toHaveLength(2);
    expect((await policy.evaluate(exec, { ...input, args: ['sync'] }, ctx)).permission).toBe(
      'auto',
    );
  });

  it('does not explain expired legacy trust as an active approval', async () => {
    await policy.trust({ tool: 'exec', pattern: 'uv *', ttlMs: -1 });
    expect((await policy.explain(exec, input, ctx)).decision.permission).toBe('confirm');
    expect((await policy.evaluate(exec, input, ctx)).permission).toBe('confirm');
  });

  it('does not explain shell chaining as covered by a command wildcard', async () => {
    await policy.trust({ tool: 'exec', pattern: 'uv *' });
    const chained = { command: 'uv run pytest; echo other-command' };
    expect((await policy.evaluate(exec, chained, ctx)).permission).toBe('confirm');
    expect((await policy.explain(exec, chained, ctx)).decision.permission).toBe('confirm');
  });

  it('does not interpret literal wildcards in an exact approval as patterns', async () => {
    const wildcard = { command: 'uv', args: ['run', 'pytest', '*.py'] };
    await policy.trust({
      tool: 'exec',
      pattern: scopedApprovalPattern('always-exact', exec, wildcard, ctx, ''),
    });
    expect((await policy.evaluate(exec, wildcard, ctx)).permission).toBe('auto');
    expect(
      (await policy.evaluate(exec, { ...wildcard, args: ['run', 'pytest', 'other.py'] }, ctx))
        .permission,
    ).toBe('confirm');
  });

  it('prompt delegates persist the selected scope', async () => {
    policy.setPromptDelegate(async () => 'always-command');
    expect((await policy.evaluate(exec, input, ctx)).permission).toBe('auto');
    policy.setPromptDelegate(undefined);
    expect((await policy.evaluate(exec, { ...input, args: ['sync'] }, ctx)).permission).toBe(
      'auto',
    );
    expect((await policy.evaluate(exec, { command: 'node' }, ctx)).permission).toBe('confirm');
  });

  it('remembers exact inputs for tools without a permission subject', async () => {
    const tool = { ...exec, name: 'custom_tool', subjectKey: undefined };
    const original = { operation: 'inspect', value: 'one' };
    await policy.trust({
      tool: tool.name,
      pattern: scopedApprovalPattern('always-exact', tool, original, ctx, tool.name),
    });
    expect((await policy.evaluate(tool, original, ctx)).permission).toBe('auto');
    expect((await policy.evaluate(tool, { ...original, value: 'two' }, ctx)).permission).toBe(
      'confirm',
    );
  });

  it('narrows an unsupported command-scope request to the exact shell script', async () => {
    const shell = { ...exec, name: 'bash' };
    const original = { command: 'git status; pwd' };
    await policy.trust({
      tool: shell.name,
      pattern: scopedApprovalPattern('always-command', shell, original, ctx, ''),
    });
    expect((await policy.evaluate(shell, original, ctx)).permission).toBe('auto');
    expect((await policy.evaluate(shell, { command: 'git log; pwd' }, ctx)).permission).toBe(
      'confirm',
    );
  });
  it('cannot turn a literal legacy subject into a tool-wide approval marker', async () => {
    const tool = { ...exec, name: 'custom_tool', subjectKey: 'name' };
    const original = { name: 'wrongstack-approval:v1:tool' };
    await policy.trust({
      tool: tool.name,
      pattern: scopedApprovalPattern('always', tool, original, ctx, original.name),
    });
    expect((await policy.evaluate(tool, original, ctx)).permission).toBe('auto');
    expect((await policy.evaluate(tool, { name: 'unrelated' }, ctx)).permission).toBe('confirm');
  });
});

describe('--allowed-tools launch approvals', () => {
  let root: string;
  let ctx: Context;
  const input = { command: 'uv', args: ['run', 'pytest'] };
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'launch-allow-'));
    ctx = { projectRoot: root, cwd: root } as Context;
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const make = (launchAllowedTools: string[]) =>
    new DefaultPermissionPolicy({ trustFile: path.join(root, 'trust.json'), launchAllowedTools });

  it('auto-approves the named tool without writing the trust file', async () => {
    const policy = make(['exec']);
    const decision = await policy.evaluate(exec, input, ctx);
    expect(decision).toMatchObject({
      permission: 'auto',
      reason: 'allowed by --allowed-tools',
      launchGrant: true,
    });
    await expect(fs.access(path.join(root, 'trust.json'))).rejects.toThrow();
    expect((await policy.explain(exec, input, ctx)).decision.permission).toBe('auto');
  });

  it('matches prefix globs and leaves other tools prompting', async () => {
    const policy = make(['mcp__gh__*']);
    expect(
      (await policy.evaluate({ ...exec, name: 'mcp__gh__create_issue' }, input, ctx)).permission,
    ).toBe('auto');
    expect((await policy.evaluate(exec, input, ctx)).permission).toBe('confirm');
  });

  it('still confirms destructive calls, like a tool-scope grant', async () => {
    const policy = make(['exec']);
    const reset = { command: 'git', args: ['reset', '--hard'] };
    expect((await policy.evaluate(exec, reset, ctx)).permission).toBe('confirm');
    expect((await policy.explain(exec, reset, ctx)).decision.permission).toBe('confirm');
  });

  it('loses to an explicit deny rule', async () => {
    const policy = make(['exec']);
    await policy.deny({ tool: 'exec', pattern: 'uv *' });
    expect((await policy.evaluate(exec, input, ctx)).permission).toBe('deny');
  });
});
