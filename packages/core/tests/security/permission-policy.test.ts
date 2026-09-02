import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutoApprovePermissionPolicy,
  DefaultPermissionPolicy,
} from '../../src/security/permission-policy.js';
import type { Context } from '../../src/core/context.js';
import type { Tool } from '../../src/types/index.js';
import {
  hasCapability,
  hasDangerousCapabilityForSubagents,
  getDangerousCapabilities,
  ToolCapabilities,
  WIDE_SUBAGENT_CAPABILITIES,
} from '../../src/security/capabilities.js';
import { subjectForToolInput } from '../../src/utils/tool-subject.js';

function tool(
  name: string,
  permission: 'auto' | 'confirm' | 'deny' = 'confirm',
  riskTier?: 'safe' | 'standard' | 'destructive',
  mutating = true,
  capabilities?: readonly string[],
): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    permission,
    mutating,
    riskTier,
    capabilities,
    async execute() {
      return 'ok';
    },
  };
}

describe('DefaultPermissionPolicy', () => {
  let trustFile: string;
  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-perm-'));
    trustFile = path.join(dir, 'trust.json');
  });
  afterEach(async () => {
    await fs.rm(path.dirname(trustFile), { recursive: true, force: true });
  });

  it('defaults to confirm for confirm-permission tools', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(decision.permission).toBe('confirm');
  });

  it('passes through auto for auto-permission tools', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    // Read-only (non-mutating) auto tools short-circuit to auto; mutating auto
    // tools are gated to confirm (covered by the next test).
    const decision = await p.evaluate(
      tool('read', 'auto', undefined, false),
      { path: 'a.ts' },
      {} as Context,
    );
    expect(decision.permission).toBe('auto');
  });

  it('gates mutating auto-permission tools to confirm', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(tool('search', 'auto'), {}, {} as Context);
    expect(decision.permission).toBe('confirm');
  });

  it('deny is absolute even when allowed', async () => {
    await fs.writeFile(
      trustFile,
      JSON.stringify({ edit: { allow: ['**/*'], deny: ['**/.env*'] } }),
    );
    const p = new DefaultPermissionPolicy({ trustFile });
    const d = await p.evaluate(tool('edit'), { path: '.env.production' }, {} as Context);
    expect(d.permission).toBe('deny');
  });

  it('trust allow still auto-approves destructive-classified calls before YOLO source', async () => {
    await fs.writeFile(trustFile, JSON.stringify({ bash: { allow: ['rm -rf /'] } }));
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
    const d = await p.evaluate(
      tool('bash', 'confirm', 'destructive', true, ['shell.arbitrary']),
      { command: 'rm -rf /' },
      { projectRoot: process.cwd() } as Context,
    );
    expect(d.permission).toBe('auto');
    expect(d.source).toBe('trust');
  });

  it('allow matches glob', async () => {
    await fs.writeFile(trustFile, JSON.stringify({ edit: { allow: ['src/**'] } }));
    const p = new DefaultPermissionPolicy({ trustFile });
    const d = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(d.permission).toBe('auto');
  });

  it('yolo bypasses confirm but respects deny', async () => {
    await fs.writeFile(trustFile, JSON.stringify({ edit: { deny: ['**/.env*'] } }));
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
    const ok = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(ok.permission).toBe('auto');
    const denied = await p.evaluate(tool('edit'), { path: '.env' }, {} as Context);
    expect(denied.permission).toBe('deny');
  });

  it('trust() persists allow rules', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    await p.trust({ tool: 'edit', pattern: 'src/**' });
    const raw = await fs.readFile(trustFile, 'utf8');
    expect(JSON.parse(raw)).toEqual({ edit: { allow: ['src/**'] } });
  });

  it('an "always"-trusted bash command with glob metacharacters re-matches itself (#15)', async () => {
    // Subjects are glob-escaped (`[ ] * ?` → `\[ \] \* \?`). Before the fix,
    // `matchAny` re-parsed `\[`/`\]` as a character class, so a trusted command
    // containing brackets — the shell `[ -f x ]` test, `grep "[0-9]"`, … — never
    // matched its own stored pattern and re-prompted on every repeat.
    for (const command of ['[ -f x ]', 'grep "[0-9]" file.txt', 'echo a[b]c']) {
      const subject = subjectForToolInput('bash', { command })!;
      // Emulate the user choosing "always": the subject is stored as the pattern.
      const p = new DefaultPermissionPolicy({ trustFile });
      await p.trust({ tool: 'bash', pattern: subject });
      // A fresh policy (empty eval cache) re-evaluates the identical command —
      // the same flow as a later repeat in-session after the trust was written.
      const fresh = new DefaultPermissionPolicy({ trustFile });
      const d = await fresh.evaluate(tool('bash'), { command }, {} as Context);
      expect(d.permission, `repeat of ${command} should auto-approve`).toBe('auto');
    }
  });

  it('does not widen authorization — a different command is still gated (#15)', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    await p.trust({ tool: 'bash', pattern: subjectForToolInput('bash', { command: '[ -f a ]' })! });
    const fresh = new DefaultPermissionPolicy({ trustFile });
    const d = await fresh.evaluate(tool('bash'), { command: '[ -f b ]' }, {} as Context);
    expect(d.permission).toBe('confirm');
  });

  it('promptDelegate resolves inline when set', async () => {
    const p = new DefaultPermissionPolicy({
      trustFile,
      promptDelegate: async () => 'yes',
    });
    const decision = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(decision.permission).toBe('auto');
    expect(decision.source).toBe('user');
  });

  it('setPromptDelegate clears the delegate so evaluate returns confirm', async () => {
    const p = new DefaultPermissionPolicy({
      trustFile,
      promptDelegate: async () => 'yes',
    });
    // Initially resolves inline
    const d1 = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(d1.permission).toBe('auto');

    // Clear the delegate
    p.setPromptDelegate(undefined);
    const d2 = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(d2.permission).toBe('confirm');
    expect(d2.source).toBe('default');
  });

  it('setPromptDelegate can replace the delegate', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    // No delegate → confirm
    const d1 = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(d1.permission).toBe('confirm');

    // Set a delegate that always denies
    p.setPromptDelegate(async () => 'no');
    const d2 = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(d2.permission).toBe('deny');
    expect(d2.source).toBe('user');
  });

  describe('YOLO destructive gating', () => {
    it('yolo auto-approves non-destructive tools', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('read', 'confirm', 'safe'),
        { path: 'src/a.ts' },
        {} as Context,
      );
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    it('yolo auto-approves batch_tool_use instead of surfacing an approval modal', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('batch_tool_use', 'confirm', 'standard'),
        { calls: [{ tool: 'grep', input: { pattern: 'TODO', path: 'src' } }] },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    it('yolo auto-approves normal exec tools', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('exec', 'confirm', 'standard'),
        { command: 'pnpm', args: ['test'] },
        {} as Context,
      );
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    it('yolo auto-approves simple bash commands', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('bash', 'confirm', 'destructive'),
        { command: 'echo hello' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    it('yolo auto-approves in-project cleanup commands', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('bash', 'confirm', 'destructive'),
        { command: 'rm -rf .wrongstack/tmp' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    // WS-008: `isClearlyDestructiveBashCommand` was exported and heavily tested
    // but called from ZERO production modules, so YOLO returned `auto` for
    // everything. The 'yolo_destructive' decision source, the getter/setter on
    // PermissionPolicy and the TUI branch reading it all already existed — only
    // the gate was missing. Every test below previously asserted the ungated
    // behaviour; they now assert the gate this describe block is named after.

    it('yolo still confirms a root filesystem wipe', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(tool('bash', 'confirm', 'destructive'), { command: 'rm -rf /' }, {
        projectRoot: process.cwd(),
      } as Context);
      expect(d.permission).toBe('confirm');
      expect(d.source).toBe('yolo_destructive');
      expect(d.riskTier).toBe('destructive');
    });

    it('yolo still confirms a catastrophic system-directory wipe', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('bash', 'confirm', 'destructive'),
        { command: 'rm -rf /etc' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('confirm');
      expect(d.source).toBe('yolo_destructive');
    });

    it('yolo still confirms recursive force deletes of sibling directories', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('bash', 'confirm', 'destructive'),
        { command: 'rm -rf ../other-project' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('confirm');
      expect(d.source).toBe('yolo_destructive');
    });

    it('yoloDestructive opts back in to auto-approving destructive operations', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true, yoloDestructive: true });
      const d = await p.evaluate(tool('bash', 'confirm', 'destructive'), { command: 'rm -rf /' }, {
        projectRoot: process.cwd(),
      } as Context);
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    it('setYoloDestructive / getYoloDestructive toggle the gate at runtime', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      expect(p.getYoloDestructive()).toBe(false);
      const ctx = { projectRoot: process.cwd() } as Context;
      const input = { command: 'rm -rf /' };
      expect(
        (await p.evaluate(tool('bash', 'confirm', 'destructive'), input, ctx)).permission,
      ).toBe('confirm');
      p.setYoloDestructive(true);
      expect(p.getYoloDestructive()).toBe(true);
      expect(
        (await p.evaluate(tool('bash', 'confirm', 'destructive'), input, ctx)).permission,
      ).toBe('auto');
    });

    it('returns confirm for a destructive YOLO call even with a prompt delegate set', async () => {
      // Matches the sensitive-read gate above: the decision is returned as
      // `confirm` and the host surface (TUI event / REPL prompt) owns the ask.
      const delegate = vi.fn(async () => 'always' as const);
      const p = new DefaultPermissionPolicy({
        trustFile,
        yolo: true,
        promptDelegate: delegate,
      });
      const d = await p.evaluate(tool('bash', 'confirm', 'destructive'), { command: 'rm -rf /' }, {
        projectRoot: process.cwd(),
      } as Context);
      expect(d.permission).toBe('confirm');
      expect(d.source).toBe('yolo_destructive');
    });

    it('gates a shell.arbitrary tool running a catastrophic command', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const shellTool = {
        ...tool('custom-shell', 'confirm', 'destructive'),
        capabilities: ['shell.arbitrary'],
      } as unknown as Parameters<typeof p.evaluate>[0];
      const d = await p.evaluate(shellTool, { command: 'rm -rf /' }, {
        projectRoot: process.cwd(),
      } as Context);
      expect(d.permission).toBe('confirm');
      expect(d.source).toBe('yolo_destructive');
    });
  });

  it('setYolo / getYolo toggle YOLO at runtime', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    expect(p.getYolo()).toBe(false);
    p.setYolo(true);
    expect(p.getYolo()).toBe(true);
    p.setYolo(false);
    expect(p.getYolo()).toBe(false);
  });

  it('wildcard trust-file entries match tool names via glob', async () => {
    // A wildcard like "edit*" should match both "edit" and "edit_lines".
    await fs.writeFile(trustFile, JSON.stringify({ 'edit*': { allow: ['src/**'] } }));
    const p = new DefaultPermissionPolicy({ trustFile });
    const d1 = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(d1.permission).toBe('auto');
    const d2 = await p.evaluate(tool('edit_lines'), { path: 'src/b.ts' }, {} as Context);
    expect(d2.permission).toBe('auto');
  });

  describe('capability-based destructive gating', () => {
    it('yolo confirms a shell.arbitrary tool running a catastrophic command (WS-008)', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('bash', 'confirm', 'destructive', true, ['shell.arbitrary']),
        { command: 'rm -rf /' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('confirm');
      expect(d.source).toBe('yolo_destructive');
    });

    it('yolo + confirmDestructive auto-approves an fs.write tool targeting a path outside the project', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('write', 'confirm', 'destructive', true, ['fs.write']),
        { path: '../../../outside.ts' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    it('yolo + confirmDestructive allows an in-project fs.write even with the capability', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('write', 'confirm', 'destructive', true, ['fs.write']),
        { path: 'src/a.ts' },
        { projectRoot: process.cwd() } as Context,
      );
      // Inside project = not destructive → yolo auto-approves.
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    it('yolo can still auto-approve non-destructive shell tools with dangerous capabilities', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('bash', 'confirm', 'destructive', true, ['shell.arbitrary']),
        { command: 'echo hello' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    // H-1 (security report VF-03): these two tests previously PINNED the
    // vulnerable outcome — `getInputString(input, 'command') ?? …` classified
    // the bare program name, so YOLO auto-approved `rm -rf /` built from
    // command + args. The gate is restored; the assertions now pin the guard.
    it('yolo blocks a catastrophic exec command built from command plus args', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('exec', 'confirm', 'standard', true, ['shell.restricted']),
        { command: 'rm', args: ['-rf', '/'] },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('confirm');
      expect(d.source).toBe('yolo_destructive');
    });

    it('yolo blocks destructive git exec commands built from command plus args', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const reset = await p.evaluate(
        tool('exec', 'confirm', 'standard', true, ['shell.restricted']),
        { command: 'git', args: ['reset', '--hard'] },
        { projectRoot: process.cwd() } as Context,
      );
      expect(reset.permission).toBe('confirm');
      expect(reset.source).toBe('yolo_destructive');

      const forcePush = await p.evaluate(
        tool('exec', 'confirm', 'standard', true, ['shell.restricted']),
        { command: 'git', args: ['push', '--force-with-lease'] },
        { projectRoot: process.cwd() } as Context,
      );
      expect(forcePush.permission).toBe('confirm');
      expect(forcePush.source).toBe('yolo_destructive');
    });

    it.each([
      ['database_migrate', ToolCapabilities.SHELL_RESTRICTED],
      ['deployment_apply', ToolCapabilities.SHELL_ARBITRARY],
      ['api_contract_runner', ToolCapabilities.SHELL_EXEC],
    ])(
      'non-yolo confirms auto-permission domain wrapper %s by shell capability',
      async (name, capability) => {
        const p = new DefaultPermissionPolicy({ trustFile });
        const decision = await p.evaluate(
          tool(name, 'auto', 'standard', false, [capability]),
          { command: 'echo', args: ['safe-looking wrapper'] },
          { projectRoot: process.cwd() } as Context,
        );

        expect(decision.permission).toBe('confirm');
        expect(decision.source).toBe('default');
      },
    );

    it('gives raw exec and a domain wrapper the same non-yolo decision for an equivalent command', async () => {
      const p = new DefaultPermissionPolicy({ trustFile });
      const input = { command: 'psql', args: ['--file', 'migration.sql'] };

      const raw = await p.evaluate(
        tool('exec', 'confirm', 'standard', true, [ToolCapabilities.SHELL_RESTRICTED]),
        input,
        { projectRoot: process.cwd() } as Context,
      );
      const wrapped = await p.evaluate(
        tool('database_migrate', 'auto', 'standard', false, [ToolCapabilities.SHELL_RESTRICTED]),
        input,
        { projectRoot: process.cwd() } as Context,
      );

      expect(raw.permission).toBe('confirm');
      expect(wrapped.permission).toBe(raw.permission);
    });

    it('applies sensitive-read gating to a custom shell-capable wrapper', async () => {
      const p = new DefaultPermissionPolicy({ trustFile });
      const decision = await p.evaluate(
        tool('database_inspect', 'auto', 'safe', false, [ToolCapabilities.SHELL_RESTRICTED]),
        { command: 'cat', args: ['.env.database'] },
        { projectRoot: process.cwd() } as Context,
      );

      expect(decision.permission).toBe('confirm');
      expect(decision.reason).toContain('sensitive file read');
    });
  });

  describe('sensitive read gating', () => {
    it('yolo auto-approves sensitive reads; redaction handles the output path', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('read', 'auto', 'safe', false, ['fs.read']),
        { path: '.env' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    it('non-yolo confirms reads of .env files even when the read tool is otherwise auto', async () => {
      const p = new DefaultPermissionPolicy({ trustFile });
      const d = await p.evaluate(
        tool('read', 'auto', 'safe', false, ['fs.read']),
        { path: '.env' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('confirm');
      expect(d.reason).toContain('sensitive file read');
    });

    it('non-yolo confirms shell reads of sensitive files', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      p.setYolo(false);
      const d = await p.evaluate(
        tool('bash', 'confirm', 'destructive', true, ['shell.arbitrary']),
        { command: 'cat .env.local' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('confirm');
      expect(d.reason).toContain('sensitive file read');
    });

    it('allows a trusted sensitive read subject', async () => {
      await fs.writeFile(trustFile, JSON.stringify({ read: { allow: ['.env'] } }));
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('read', 'auto', 'safe', false, ['fs.read']),
        { path: '.env' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('trust');
    });
  });

  describe('DefaultPermissionPolicy explain()', () => {
    it('returns a trace with steps for a confirm tool', async () => {
      const p = new DefaultPermissionPolicy({ trustFile });
      const trace = await p.explain(tool('edit'), { path: 'src/a.ts' }, {} as Context);
      expect(trace.toolName).toBe('edit');
      expect(trace.steps.length).toBeGreaterThanOrEqual(5);
      const last = trace.steps[trace.winnerIndex]!;
      expect(last.rule).toBe('mutating default confirm');
      expect(last.decision).toBe('confirm');
      expect(trace.decision.permission).toBe('confirm');
      expect(trace.decision.source).toBe('default');
    });

    it('returns yolo as winner when YOLO is active', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const trace = await p.explain(
        tool('bash', 'confirm', 'destructive', true, ['shell.arbitrary']),
        { command: 'ls -la' },
        { projectRoot: process.cwd() } as Context,
      );
      const yoloStep = trace.steps.find((s) => s.rule === 'yolo');
      expect(yoloStep).toBeDefined();
      expect(yoloStep!.matched).toBe(true);
      expect(trace.steps[trace.winnerIndex]!.rule).toBe('yolo');
      expect(trace.decision.permission).toBe('auto');
      expect(trace.decision.source).toBe('yolo');
    });

    it('returns trust deny as winner when deny pattern matches', async () => {
      await fs.writeFile(trustFile, JSON.stringify({ edit: { deny: ['**/.env*'] } }));
      const p = new DefaultPermissionPolicy({ trustFile });
      const trace = await p.explain(tool('edit'), { path: '.env' }, {} as Context);
      const denyStep = trace.steps.find((s) => s.rule === 'trust deny');
      expect(denyStep).toBeDefined();
      expect(denyStep!.matched).toBe(true);
      expect(trace.decision.permission).toBe('deny');
      expect(trace.decision.source).toBe('deny');
    });

    it('returns trust allow as winner when allow pattern matches', async () => {
      await fs.writeFile(trustFile, JSON.stringify({ edit: { allow: ['src/**'] } }));
      const p = new DefaultPermissionPolicy({ trustFile });
      const trace = await p.explain(tool('edit'), { path: 'src/a.ts' }, {} as Context);
      const allowStep = trace.steps.find((s) => s.rule === 'trust allow');
      expect(allowStep).toBeDefined();
      expect(allowStep!.matched).toBe(true);
      expect(trace.decision.permission).toBe('auto');
      expect(trace.decision.source).toBe('trust');
    });

    it('returns trust auto as winner when auto flag is set', async () => {
      await fs.writeFile(trustFile, JSON.stringify({ edit: { auto: true } }));
      const p = new DefaultPermissionPolicy({ trustFile });
      const trace = await p.explain(tool('edit'), { path: 'ignored.ts' }, {} as Context);
      const autoStep = trace.steps.find((s) => s.rule === 'trust auto');
      expect(autoStep).toBeDefined();
      expect(autoStep!.matched).toBe(true);
      expect(trace.decision.permission).toBe('auto');
      expect(trace.decision.source).toBe('trust');
    });

    it('returns sensitive read as winner for sensitive files outside YOLO', async () => {
      const p = new DefaultPermissionPolicy({ trustFile });
      const trace = await p.explain(
        tool('read', 'auto', 'safe', false, ['fs.read']),
        { path: '.env' },
        { projectRoot: process.cwd() } as Context,
      );
      const sensStep = trace.steps.find((s) => s.rule === 'sensitive read');
      expect(sensStep).toBeDefined();
      expect(sensStep!.matched).toBe(true);
      expect(trace.decision.permission).toBe('confirm');
      expect(trace.decision.reason).toContain('sensitive file read');
    });

    it('returns safe default auto for non-mutating auto tools', async () => {
      const p = new DefaultPermissionPolicy({ trustFile });
      const trace = await p.explain(
        tool('read', 'auto', 'safe', false, ['fs.read']),
        { path: 'src/a.ts' },
        {} as Context,
      );
      const safeStep = trace.steps.find((s) => s.rule === 'safe default auto');
      expect(safeStep).toBeDefined();
      expect(safeStep!.matched).toBe(true);
      expect(trace.decision.permission).toBe('auto');
      expect(trace.decision.source).toBe('default');
    });

    it('returns mutating default confirm for mutating auto tools', async () => {
      const p = new DefaultPermissionPolicy({ trustFile });
      const trace = await p.explain(tool('search', 'auto', 'standard', true), {}, {} as Context);
      const confirmStep = trace.steps.find((s) => s.rule === 'mutating default confirm');
      expect(confirmStep).toBeDefined();
      expect(confirmStep!.matched).toBe(true);
      expect(trace.decision.permission).toBe('confirm');
      expect(trace.decision.source).toBe('default');
    });

    it('does not mutate sessionDenied, sessionAllowed, or evalCache', async () => {
      const p = new DefaultPermissionPolicy({ trustFile });
      const trace1 = await p.explain(tool('edit'), { path: 'src/a.ts' }, {} as Context);
      const trace2 = await p.explain(tool('edit'), { path: 'src/a.ts' }, {} as Context);
      expect(trace1.winnerIndex).toBe(trace2.winnerIndex);
      expect(trace1.decision.permission).toBe(trace2.decision.permission);
      let trustExists = true;
      try {
        await fs.access(trustFile);
      } catch {
        trustExists = false;
      }
      expect(trustExists).toBe(false);
    });

    it('does not invoke promptDelegate', async () => {
      const delegate = vi.fn(async () => 'always' as const);
      const p = new DefaultPermissionPolicy({
        trustFile,
        promptDelegate: delegate,
      });
      const trace = await p.explain(tool('edit'), { path: 'src/a.ts' }, {} as Context);
      expect(delegate).not.toHaveBeenCalled();
      expect(trace.decision.permission).toBe('confirm');
    });

    it('handles malformed trust policy gracefully', async () => {
      await fs.writeFile(trustFile, 'not valid json');
      const p = new DefaultPermissionPolicy({ trustFile });
      const trace = await p.explain(tool('edit'), { path: 'src/a.ts' }, {} as Context);
      expect(trace.decision.permission).toBe('deny');
      expect(trace.decision.source).toBe('deny');
      expect(trace.steps[0]!.rule).toBe('policy invalid');
    });
  });
});

describe('AutoApprovePermissionPolicy', () => {
  it('auto-approves tools with allowed capabilities (fs.read, net.outbound)', async () => {
    const p = new AutoApprovePermissionPolicy();
    const auto = await p.evaluate({
      name: 'read',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'confirm',
      mutating: false,
      capabilities: ['fs.read'],
      async execute() {
        return 'x';
      },
    } as Tool);
    expect(auto.permission).toBe('auto');
    expect(auto.source).toBe('yolo');
  });

  it('denies tools without any capabilities (allowlist-by-default)', async () => {
    const p = new AutoApprovePermissionPolicy();
    const d = await p.evaluate({
      name: 'unknown_tool',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'confirm',
      mutating: false,
      async execute() {
        return 'x';
      },
    } as Tool);
    expect(d.permission).toBe('deny');
    expect(d.source).toBe('subagent_guard');
    expect(d.reason).toContain('lacks allowed capability');
  });

  // C-1/C-2/H-3 (security report VF-01/VF-02/H-3): the input-based guards the
  // leader applies must bind delegated agents too — the less-supervised
  // principal may never have the weaker gate.
  describe('input-based guards and leader deny propagation', () => {
    let trustFile: string;
    let dir: string;
    let fakeHome: string;
    let prevHome: string | undefined;

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-perm-sub-'));
      trustFile = path.join(dir, 'trust.json');
      fakeHome = path.join(dir, 'dot-wrongstack');
      prevHome = process.env['WRONGSTACK_HOME'];
      process.env['WRONGSTACK_HOME'] = fakeHome;
    });
    afterEach(async () => {
      if (prevHome === undefined) delete process.env['WRONGSTACK_HOME'];
      else process.env['WRONGSTACK_HOME'] = prevHome;
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('denies clearly destructive shell even with shell.arbitrary granted (C-1)', async () => {
      const p = new AutoApprovePermissionPolicy(WIDE_SUBAGENT_CAPABILITIES);
      const d = await p.evaluate(tool('exec', 'confirm', 'standard', true, ['shell.arbitrary']), {
        command: 'rm',
        args: ['-rf', '/'],
      });
      expect(d.permission).toBe('deny');
      expect(d.source).toBe('subagent_guard');
      expect(d.reason).toContain('destructive');
    });

    it('still auto-approves non-destructive shell with the capability granted', async () => {
      const p = new AutoApprovePermissionPolicy(WIDE_SUBAGENT_CAPABILITIES);
      const d = await p.evaluate(tool('exec', 'confirm', 'standard', true, ['shell.arbitrary']), {
        command: 'echo',
        args: ['hello'],
      });
      expect(d.permission).toBe('auto');
    });

    it('denies binding well-known credentials to a provider endpoint', async () => {
      const p = new AutoApprovePermissionPolicy(WIDE_SUBAGENT_CAPABILITIES);
      const d = await p.evaluate(
        tool('provider_check', 'confirm', undefined, false, ['net.outbound']),
        { envVars: ['ANTHROPIC_API_KEY'] },
      );
      expect(d.permission).toBe('deny');
      expect(d.reason).toContain('credential');
    });

    it('denies writes into the agent state root even with fs.write granted (C-2)', async () => {
      const p = new AutoApprovePermissionPolicy(WIDE_SUBAGENT_CAPABILITIES);
      const d = await p.evaluate(tool('write', 'confirm', undefined, true, ['fs.write']), {
        path: path.join(fakeHome, 'trust.json'),
      });
      expect(d.permission).toBe('deny');
      expect(d.source).toBe('subagent_guard');
      expect(d.reason).toContain('agent state');
    });

    it('auto-approves ordinary writes with fs.write granted', async () => {
      const p = new AutoApprovePermissionPolicy(WIDE_SUBAGENT_CAPABILITIES);
      const d = await p.evaluate(tool('write', 'confirm', undefined, true, ['fs.write']), {
        path: path.join(dir, 'src', 'a.ts'),
      });
      expect(d.permission).toBe('auto');
    });

    it('propagates leader deny rules to subagents (H-3)', async () => {
      await fs.writeFile(trustFile, JSON.stringify({ bash: { deny: ['git status'] } }));
      const p = new AutoApprovePermissionPolicy(WIDE_SUBAGENT_CAPABILITIES, { trustFile });
      const d = await p.evaluate(tool('bash', 'confirm', 'standard', true, ['shell.arbitrary']), {
        command: 'git status',
      });
      expect(d.permission).toBe('deny');
      expect(d.source).toBe('subagent_guard');
      expect(d.reason).toContain('leader deny rule');
    });

    it('does not widen: leader allow/auto rules never auto-approve a subagent call', async () => {
      await fs.writeFile(trustFile, JSON.stringify({ edit: { auto: true, allow: ['**'] } }));
      const p = new AutoApprovePermissionPolicy(undefined, { trustFile });
      const d = await p.evaluate(tool('edit', 'confirm', undefined, true, ['fs.write']), {
        path: 'src/a.ts',
      });
      expect(d.permission).toBe('deny');
      expect(d.source).toBe('subagent_guard');
    });

    it('fails closed when the leader trust file is invalid JSON', async () => {
      await fs.writeFile(trustFile, '{not json');
      const p = new AutoApprovePermissionPolicy(undefined, { trustFile });
      const d = await p.evaluate(tool('read', 'auto', undefined, false, ['fs.read']), {
        path: 'a.ts',
      });
      expect(d.permission).toBe('deny');
      expect(d.reason).toContain('not valid JSON');
    });
  });

  // Subagent guard: tools with non-allowed capabilities are denied.
  it.each([
    { name: 'bash', caps: ['shell.arbitrary'] },
    { name: 'write', caps: ['fs.write'] },
    { name: 'edit', caps: ['fs.write'] },
    { name: 'replace', caps: ['fs.write'] },
    { name: 'scaffold', caps: ['fs.write.outside-project'] },
    { name: 'patch', caps: ['fs.write'] },
    { name: 'install', caps: ['package.install'] },
    { name: 'exec', caps: ['shell.restricted'] },
  ])('denies non-allowed builtin "%s" for subagents via capabilities', async ({ name, caps }) => {
    const p = new AutoApprovePermissionPolicy();
    const d = await p.evaluate({
      name,
      description: '',
      inputSchema: { type: 'object' },
      permission: 'confirm',
      mutating: true,
      capabilities: caps,
      async execute() {
        return 'x';
      },
    } as Tool);
    expect(d.permission).toBe('deny');
    expect(d.source).toBe('subagent_guard');
  });

  it('denies MCP tools (mcp__*) for subagents by default', async () => {
    const p = new AutoApprovePermissionPolicy();
    const d = await p.evaluate({
      name: 'mcp__some_server__run_shell',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'x';
      },
    } as Tool);
    expect(d.permission).toBe('deny');
    expect(d.source).toBe('subagent_guard');
  });

  it('respects tool-default deny', async () => {
    const p = new AutoApprovePermissionPolicy();
    const denied = await p.evaluate({
      name: 'danger',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'deny',
      mutating: true,
      async execute() {
        return 'x';
      },
    } as Tool);
    expect(denied.permission).toBe('deny');
    expect(denied.source).toBe('subagent_guard');
  });

  it('trust / deny / denyOnce / allowOnce / reload are all no-ops', async () => {
    const p = new AutoApprovePermissionPolicy();
    // These should resolve / return without throwing
    await p.trust();
    await p.deny();
    p.denyOnce();
    p.allowOnce();
    await p.reload();
    // No state change observable — the policy is stateless
    expect(true).toBe(true);
  });

  // --- 2026-06 Capability-based tests ---

  it('denies tools that declare non-allowed capabilities even if name is safe', async () => {
    const p = new AutoApprovePermissionPolicy();
    const d = await p.evaluate(
      tool('my-custom-shell', 'confirm', undefined, true, ['shell.arbitrary']),
    );
    expect(d.permission).toBe('deny');
    // shell.arbitrary is a dangerous capability not in the allowlist, so the
    // more specific dangerous-capability reason takes precedence.
    expect(d.reason).toContain('un-granted dangerous capability');
  });

  it('denies tools with fs.write.outside-project capability', async () => {
    const p = new AutoApprovePermissionPolicy();
    const d = await p.evaluate(
      tool('dangerous-scaffold', 'confirm', undefined, true, ['fs.write.outside-project']),
    );
    expect(d.permission).toBe('deny');
  });

  it('auto-approves tools with only safe capabilities', async () => {
    const p = new AutoApprovePermissionPolicy();
    const decision = await p.evaluate(tool('safe-read', 'confirm', undefined, false, ['fs.read']));
    expect(decision.permission).toBe('auto');
  });

  it('auto-approves tools with net.outbound capability', async () => {
    const p = new AutoApprovePermissionPolicy();
    const d = await p.evaluate(tool('fetch', 'confirm', undefined, false, ['net.outbound']));
    expect(d.permission).toBe('auto');
  });

  it('custom allowlist constructor overrides defaults', async () => {
    const p = new AutoApprovePermissionPolicy(['fs.write']);
    const d = await p.evaluate(tool('write', 'confirm', undefined, true, ['fs.write']));
    expect(d.permission).toBe('auto');
    // fs.read is no longer allowed with custom allowlist
    const d2 = await p.evaluate(tool('read', 'confirm', undefined, false, ['fs.read']));
    expect(d2.permission).toBe('deny');
  });

  it('denies tools without capabilities under allowlist-by-default', async () => {
    const p = new AutoApprovePermissionPolicy();
    const d = await p.evaluate(tool('bash')); // no capabilities declared
    expect(d.permission).toBe('deny');
    expect(d.source).toBe('subagent_guard');
    expect(d.reason).toContain('lacks allowed capability');
  });

  it('denies a multi-capability tool when a dangerous cap is not granted', async () => {
    // `install` bundles package.install + shell.restricted. Granting only
    // package.install must NOT let shell.restricted ride along: every
    // dangerous capability has to be explicitly in the allowlist.
    const p = new AutoApprovePermissionPolicy(['package.install']);
    const d = await p.evaluate(
      tool('install', 'confirm', undefined, true, ['package.install', 'shell.restricted']),
    );
    expect(d.permission).toBe('deny');
    expect(d.source).toBe('subagent_guard');
    expect(d.reason).toContain('un-granted dangerous capability');
    expect(d.reason).toContain('shell.restricted');
  });

  it('denies formatter-style shell execution when only fs.write is granted', async () => {
    const p = new AutoApprovePermissionPolicy(['fs.write']);
    const d = await p.evaluate(
      tool('format', 'confirm', undefined, true, ['fs.write', ToolCapabilities.SHELL_EXEC]),
    );
    expect(d.permission).toBe('deny');
    expect(d.reason).toContain('shell.exec');
  });

  it('denies meta tool dispatch unless tool.mutate.any is explicitly granted', async () => {
    const p = new AutoApprovePermissionPolicy(['fs.read', 'net.outbound']);
    const d = await p.evaluate(
      tool('tool_use', 'confirm', undefined, true, [ToolCapabilities.TOOL_MUTATE_ANY]),
    );
    expect(d.permission).toBe('deny');
    expect(d.reason).toContain('tool.mutate.any');
  });

  it('allows a multi-capability tool when every dangerous cap is granted', async () => {
    const p = new AutoApprovePermissionPolicy(['package.install', 'shell.restricted']);
    const d = await p.evaluate(
      tool('install', 'confirm', undefined, true, ['package.install', 'shell.restricted']),
    );
    expect(d.permission).toBe('auto');
    expect(d.source).toBe('yolo');
  });

  it('denies a benign+dangerous combo (fs.read + fs.write) under the read-only default', async () => {
    // A tool that can read AND write must not slip through on the strength of
    // its fs.read capability alone — fs.write is dangerous and ungranted.
    const p = new AutoApprovePermissionPolicy();
    const d = await p.evaluate(
      tool('read_write', 'confirm', undefined, true, ['fs.read', 'fs.write']),
    );
    expect(d.permission).toBe('deny');
    expect(d.reason).toContain('un-granted dangerous capability');
  });

  it('allows fs.write when the leader widens the allowlist (e.g. /techstack report)', async () => {
    const p = new AutoApprovePermissionPolicy(['fs.read', 'net.outbound', 'fs.write']);
    const write = await p.evaluate(tool('write', 'confirm', undefined, true, ['fs.write']));
    expect(write.permission).toBe('auto');
    const fetch = await p.evaluate(tool('fetch', 'confirm', undefined, false, ['net.outbound']));
    expect(fetch.permission).toBe('auto');
    // Shell still denied — widening fs.write does not grant arbitrary command exec.
    const bash = await p.evaluate(tool('bash', 'auto', undefined, true, ['shell.arbitrary']));
    expect(bash.permission).toBe('deny');
  });

  it('wide subagent capabilities include low-risk session, metadata, and shell exec tools', async () => {
    const p = new AutoApprovePermissionPolicy(WIDE_SUBAGENT_CAPABILITIES);
    const todo = await p.evaluate(
      tool('todo', 'auto', undefined, false, [ToolCapabilities.SESSION_TODO]),
    );
    const help = await p.evaluate(
      tool('tool_help', 'auto', undefined, false, [ToolCapabilities.TOOL_META]),
    );
    const memoryRead = await p.evaluate(
      tool('search_memory', 'auto', undefined, false, [ToolCapabilities.MEMORY_READ]),
    );
    const shellExec = await p.evaluate(
      tool('custom_formatter', 'confirm', undefined, true, [ToolCapabilities.SHELL_EXEC]),
    );

    expect(todo.permission).toBe('auto');
    expect(help.permission).toBe('auto');
    expect(memoryRead.permission).toBe('auto');
    expect(shellExec.permission).toBe('auto');
  });

  it('MCP tools are denied unless mcp.proxy is explicitly granted', async () => {
    const p = new AutoApprovePermissionPolicy();
    const d = await p.evaluate(
      tool('mcp__evil__do_stuff', 'auto', undefined, false, [ToolCapabilities.MCP_PROXY]),
    );
    expect(d.permission).toBe('deny');
    expect(d.reason).toContain('allow mcp.proxy explicitly');
  });

  it('allows MCP tools when the scoped subagent tool slice grants mcp.proxy', async () => {
    const p = new AutoApprovePermissionPolicy([ToolCapabilities.MCP_PROXY]);
    const d = await p.evaluate(
      tool('mcp__ssh__ssh_health_check', 'confirm', undefined, false, [ToolCapabilities.MCP_PROXY]),
    );
    expect(d.permission).toBe('auto');
    expect(d.source).toBe('yolo');
  });
});

describe('Capability helpers', () => {
  it('hasDangerousCapabilityForSubagents detects dangerous caps', () => {
    expect(hasDangerousCapabilityForSubagents(['shell.arbitrary'])).toBe(true);
    expect(hasDangerousCapabilityForSubagents(['shell.exec'])).toBe(true);
    expect(hasDangerousCapabilityForSubagents(['tool.mutate.any'])).toBe(true);
    expect(hasDangerousCapabilityForSubagents(['fs.read'])).toBe(false);
    expect(hasDangerousCapabilityForSubagents({ capabilities: ['fs.write.outside-project'] })).toBe(
      true,
    );
  });

  it('hasCapability works with single and multiple', () => {
    expect(hasCapability(['fs.read', 'net.outbound'], ToolCapabilities.FS_READ)).toBe(true);
    expect(
      hasCapability(['fs.read'], [ToolCapabilities.FS_WRITE, ToolCapabilities.NET_OUTBOUND]),
    ).toBe(false);
  });

  it('getDangerousCapabilities extracts correctly', () => {
    const result = getDangerousCapabilities([
      'fs.read',
      'shell.arbitrary',
      'tool.mutate.any',
      'mcp.proxy',
    ]);
    expect(result).toContain(ToolCapabilities.SHELL_ARBITRARY);
    expect(result).toContain(ToolCapabilities.TOOL_MUTATE_ANY);
    expect(result).toContain(ToolCapabilities.MCP_PROXY);
    expect(result).not.toContain(ToolCapabilities.FS_READ);
  });
});
