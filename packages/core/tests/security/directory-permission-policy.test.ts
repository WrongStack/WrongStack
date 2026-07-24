import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DirectoryPermissionPolicy,
  matchRule,
  resolveTargetPath,
} from '../../src/security/directory-permission-policy.js';
import { validateDirectoryPolicy } from '../../src/security/directory-policy-schema.js';
import type { Context } from '../../src/core/context.js';
import type {
  DirectoryPolicy,
  PermissionDecision,
  PermissionPolicy,
} from '../../src/types/permission.js';
import type { Tool } from '../../src/types/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTool(name: string, options: { pathSubject?: boolean } = {}): Tool {
  return {
    name,
    description: name,
    inputSchema: {
      type: 'object',
      properties: options.pathSubject ? { path: { type: 'string' } } : {},
    },
    permission: 'auto',
    mutating: false,
    async execute() {
      return 'ok';
    },
  };
}

const bashTool: Tool = makeTool('bash');
const writeTool: Tool = makeTool('write', { pathSubject: true });
const readTool: Tool = makeTool('read', { pathSubject: true });
const editTool: Tool = makeTool('edit', { pathSubject: true });
const mcpTool: Tool = makeTool('mcp__github__create_issue');
const execTool: Tool = makeTool('exec');

function makeProvider(id: string): { id: string } {
  return { id };
}

interface MakeCtxOptions {
  workingDir?: string;
  providerId?: string;
  directoryRulesDisabled?: boolean;
}

function makeCtx(projectRoot: string, options: MakeCtxOptions = {}): Context {
  return {
    meta: {
      ...(options.directoryRulesDisabled ? { directoryRules: false } : {}),
    },
    projectRoot,
    provider: makeProvider(options.providerId ?? 'anthropic') as never,
    model: 'test-model',
    messages: [],
    todos: [],
    readFiles: new Set(),
    writtenFiles: [],
    workingDir: options.workingDir ?? projectRoot,
    cwd: options.workingDir ?? projectRoot,
    agentId: 'test-agent',
  } as unknown as Context;
}

function allowInner(decision: Partial<PermissionDecision> = {}): PermissionPolicy {
  return {
    evaluate: async () =>
      ({
        permission: 'auto',
        source: 'trust',
        ...decision,
      }) as PermissionDecision,
    trust: async () => {},
    deny: async () => {},
    denyOnce: () => {},
    allowOnce: () => {},
    reload: async () => {},
  };
}

function denyInner(reason = 'inner deny'): PermissionPolicy {
  return {
    evaluate: async () =>
      ({
        permission: 'deny',
        source: 'trust',
        reason,
      }) as PermissionDecision,
    trust: async () => {},
    deny: async () => {},
    denyOnce: () => {},
    allowOnce: () => {},
    reload: async () => {},
  };
}

function policy(rules: DirectoryPolicy['rules']): DirectoryPolicy {
  return { schemaVersion: 1, rules };
}

// ── resolveTargetPath ────────────────────────────────────────────────────────

describe('resolveTargetPath', () => {
  it('resolves relative paths against ctx.workingDir and strips projectRoot', () => {
    const projectRoot = path.resolve(os.tmpdir(), 'wstack-dir-test');
    const ctx = makeCtx(projectRoot, { workingDir: path.join(projectRoot, 'src') });
    const resolved = resolveTargetPath({ path: 'foo.ts' }, ctx);
    expect(resolved).toBe('src/foo.ts');
  });

  it('returns the absolute path (forward-slash normalized) when target escapes projectRoot', () => {
    const projectRoot = path.resolve(os.tmpdir(), 'wstack-dir-escape');
    // Target lives outside the project root → result should start with ..
    const outside = path.resolve(os.tmpdir(), 'wstack-dir-escape-OTHER', 'secrets', '.env');
    const ctx = makeCtx(projectRoot, { workingDir: projectRoot });
    const resolved = resolveTargetPath({ path: outside }, ctx);
    expect(resolved?.replace(/\\/g, '/')).toMatch(/\.\.\/wstack-dir-escape-OTHER\/secrets\/\.env$/);
  });

  it('returns undefined when input has no filesystem path subject', () => {
    const projectRoot = path.resolve(os.tmpdir(), 'wstack-dir-empty');
    const ctx = makeCtx(projectRoot);
    expect(resolveTargetPath({ query: 'no path here' }, ctx)).toBeUndefined();
    expect(resolveTargetPath({ url: 'https://example.com/src/file.ts' }, ctx)).toBeUndefined();
    expect(resolveTargetPath({ name: 'src/file.ts' }, ctx)).toBeUndefined();
    expect(resolveTargetPath({}, ctx)).toBeUndefined();
    expect(resolveTargetPath(null, ctx)).toBeUndefined();
  });

  it('extracts path from common path keys', () => {
    const projectRoot = path.resolve(os.tmpdir(), 'wstack-dir-keys');
    const ctx = makeCtx(projectRoot, { workingDir: projectRoot });
    expect(resolveTargetPath({ file: 'a.ts' }, ctx)).toBe('a.ts');
    expect(resolveTargetPath({ file_path: 'b.ts' }, ctx)).toBe('b.ts');
    expect(resolveTargetPath({ filePath: 'c.ts' }, ctx)).toBe('c.ts');
    expect(resolveTargetPath({ target: 'd.ts' }, ctx)).toBe('d.ts');
    expect(resolveTargetPath({ directory: 'src' }, ctx)).toBe('src');
    expect(resolveTargetPath({ outputPath: 'dist/report.json' }, ctx)).toBe('dist/report.json');
    expect(resolveTargetPath({ worktreePath: '../worktree' }, ctx)).toBe('../worktree');
  });

  it('extracts the first string path from plural path keys', () => {
    const projectRoot = path.resolve(os.tmpdir(), 'wstack-dir-arrays');
    const ctx = makeCtx(projectRoot, { workingDir: projectRoot });
    expect(resolveTargetPath({ paths: ['', 'src/a.ts', 42] }, ctx)).toBe('src/a.ts');
    expect(resolveTargetPath({ files: ['src/b.ts', 'src/c.ts'] }, ctx)).toBe('src/b.ts');
  });

  it('preserves literal glob metacharacters in real filesystem paths', () => {
    const projectRoot = path.resolve(os.tmpdir(), 'wstack-dir-literal-glob');
    const ctx = makeCtx(projectRoot, { workingDir: projectRoot });
    expect(resolveTargetPath({ path: 'clients/[acme]/secret.txt' }, ctx)).toBe(
      'clients/[acme]/secret.txt',
    );
  });
});

// ── matchRule (precedence by specificity) ───────────────────────────────────

describe('matchRule', () => {
  const pol = policy([
    { directory: 'infra/**', denyTools: ['bash'] },
    { directory: 'infra/terraform/**', denyTools: ['exec'] },
    { directory: 'clients/acme/**', denyProviders: ['openai'] },
  ]);

  it('matches the most-specific pattern when multiple rules match', () => {
    const rule = matchRule(pol, 'infra/terraform/main.tf');
    expect(rule?.directory).toBe('infra/terraform/**');
  });

  it('matches the broader pattern when only it matches', () => {
    const rule = matchRule(pol, 'infra/ansible/playbook.yml');
    expect(rule?.directory).toBe('infra/**');
  });

  it('returns undefined when no rule matches', () => {
    expect(matchRule(pol, 'notes/todo.md')).toBeUndefined();
  });
});

// ── validateDirectoryPolicy (schema surface) ────────────────────────────────

describe('validateDirectoryPolicy', () => {
  it('accepts a well-formed policy', () => {
    const result = validateDirectoryPolicy({
      schemaVersion: 1,
      rules: [
        { directory: 'infra/**', denyTools: ['bash', 'exec'] },
        { directory: 'clients/acme/**', denyProviders: ['openai'] },
        { directory: 'docs/**', allowOnlyTools: ['read', 'grep'] },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.rules).toHaveLength(3);
    }
  });

  it('rejects a rule with no constraints', () => {
    const result = validateDirectoryPolicy({
      schemaVersion: 1,
      rules: [{ directory: 'src/**' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === 'empty_rule')).toBe(true);
    }
  });

  it('rejects an unknown schemaVersion', () => {
    const result = validateDirectoryPolicy({
      schemaVersion: 2,
      rules: [{ directory: 'a/**', denyTools: ['bash'] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.code).toBe('invalid_schema_version');
    }
  });

  it('deduplicates entries inside a single denyTools list', () => {
    const result = validateDirectoryPolicy({
      schemaVersion: 1,
      rules: [{ directory: 'a/**', denyTools: ['bash', 'bash', 'exec'] }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.rules[0]?.denyTools).toEqual(['bash', 'exec']);
    }
  });

  it('rejects unknown rule fields instead of silently ignoring policy typos', () => {
    const result = validateDirectoryPolicy({
      schemaVersion: 1,
      rules: [{ directory: 'a/**', denyTool: ['bash'] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.some((d) => d.code === 'unknown_field')).toBe(true);
    }
  });

  it('rejects empty deny lists but preserves an explicit empty allow-only whitelist', () => {
    const emptyDeny = validateDirectoryPolicy({
      schemaVersion: 1,
      rules: [{ directory: 'a/**', denyTools: [] }],
    });
    expect(emptyDeny.ok).toBe(false);
    if (!emptyDeny.ok) {
      expect(emptyDeny.diagnostics.some((d) => d.code === 'empty_rule')).toBe(true);
    }

    const emptyAllow = validateDirectoryPolicy({
      schemaVersion: 1,
      rules: [{ directory: 'a/**', allowOnlyTools: [] }],
    });
    expect(emptyAllow.ok).toBe(true);
    if (emptyAllow.ok) {
      expect(emptyAllow.policy.rules[0]?.allowOnlyTools).toEqual([]);
    }
  });
});

// ── DirectoryPermissionPolicy.evaluate ───────────────────────────────────────

describe('DirectoryPermissionPolicy', () => {
  const projectRoot = path.resolve(os.tmpdir(), 'wstack-dir-policy-test');

  it('passes through when no rules are configured', async () => {
    const inner = allowInner();
    const wrapper = new DirectoryPermissionPolicy(inner, { policy: policy([]) });
    const result = await wrapper.evaluate(writeTool, { path: 'src/foo.ts' }, makeCtx(projectRoot));
    expect(result.permission).toBe('auto');
    expect(result.source).toBe('trust');
  });

  it('passes through when the tool input has no path subject', async () => {
    const inner = allowInner();
    const wrapper = new DirectoryPermissionPolicy(inner, {
      policy: policy([{ directory: 'src/**', denyTools: ['bash'] }]),
    });
    const result = await wrapper.evaluate(bashTool, { command: 'ls' }, makeCtx(projectRoot));
    expect(result.permission).toBe('auto');
  });

  it('denies when the resolved path matches a denyTools rule', async () => {
    const inner = allowInner();
    const wrapper = new DirectoryPermissionPolicy(inner, {
      policy: policy([{ directory: 'infra/**', denyTools: ['bash', 'exec'] }]),
    });
    const result = await wrapper.evaluate(
      bashTool,
      { path: path.join(projectRoot, 'infra', 'deploy.sh') },
      makeCtx(projectRoot),
    );
    expect(result.permission).toBe('deny');
    expect(result.source).toBe('directory_rules');
    expect(result.reason).toContain('infra/**');
    expect(result.reason).toContain('bash');
  });

  it('does not deny a tool outside the denyTools list', async () => {
    const inner = allowInner();
    const wrapper = new DirectoryPermissionPolicy(inner, {
      policy: policy([{ directory: 'infra/**', denyTools: ['bash'] }]),
    });
    const result = await wrapper.evaluate(
      readTool,
      { path: path.join(projectRoot, 'infra', 'README.md') },
      makeCtx(projectRoot),
    );
    expect(result.permission).toBe('auto');
  });

  it('denies when ctx.provider.id matches denyProviders', async () => {
    const inner = allowInner();
    const wrapper = new DirectoryPermissionPolicy(inner, {
      policy: policy([{ directory: 'clients/acme/**', denyProviders: ['openai', 'deepseek'] }]),
    });
    const result = await wrapper.evaluate(
      writeTool,
      { path: path.join(projectRoot, 'clients', 'acme', 'config.json') },
      makeCtx(projectRoot, { providerId: 'openai' }),
    );
    expect(result.permission).toBe('deny');
    expect(result.source).toBe('directory_rules');
    expect(result.reason).toContain('openai');
  });

  it('does not deny when the active provider is not in denyProviders', async () => {
    const inner = allowInner();
    const wrapper = new DirectoryPermissionPolicy(inner, {
      policy: policy([{ directory: 'clients/acme/**', denyProviders: ['openai'] }]),
    });
    const result = await wrapper.evaluate(
      writeTool,
      { path: path.join(projectRoot, 'clients', 'acme', 'config.json') },
      makeCtx(projectRoot, { providerId: 'anthropic' }),
    );
    expect(result.permission).toBe('auto');
  });

  it('enforces allowOnlyTools as a strict whitelist (denies other tools)', async () => {
    const inner = allowInner();
    const wrapper = new DirectoryPermissionPolicy(inner, {
      policy: policy([{ directory: 'docs/**', allowOnlyTools: ['read', 'grep'] }]),
    });
    const denied = await wrapper.evaluate(
      writeTool,
      { path: path.join(projectRoot, 'docs', 'spec.md') },
      makeCtx(projectRoot),
    );
    expect(denied.permission).toBe('deny');
    expect(denied.reason).toContain('allowOnlyTools');

    const allowed = await wrapper.evaluate(
      readTool,
      { path: path.join(projectRoot, 'docs', 'spec.md') },
      makeCtx(projectRoot),
    );
    expect(allowed.permission).toBe('auto');
  });

  it('allowOnlyTools overrides an inner-policy allow (strict precedence)', async () => {
    const inner = allowInner();
    const wrapper = new DirectoryPermissionPolicy(inner, {
      policy: policy([{ directory: 'docs/**', allowOnlyTools: ['read'] }]),
    });
    const result = await wrapper.evaluate(
      writeTool,
      { path: path.join(projectRoot, 'docs', 'spec.md') },
      makeCtx(projectRoot),
    );
    expect(result.permission).toBe('deny');
  });

  it('treats an explicit empty allowOnlyTools list as deny-all', async () => {
    const inner = allowInner();
    const wrapper = new DirectoryPermissionPolicy(inner, {
      policy: policy([{ directory: 'docs/**', allowOnlyTools: [] }]),
    });
    const input = { path: path.join(projectRoot, 'docs', 'spec.md') };

    const result = await wrapper.evaluate(readTool, input, makeCtx(projectRoot));
    const trace = await wrapper.explain(readTool, input, makeCtx(projectRoot));

    expect(result.permission).toBe('deny');
    expect(result.reason).toContain('allowOnlyTools');
    expect(trace.decision.permission).toBe('deny');
    expect(trace.decision).toEqual(result);
  });

  it('enforces rules for every path in plural path keys', async () => {
    const inner = allowInner();
    const wrapper = new DirectoryPermissionPolicy(inner, {
      policy: policy([{ directory: 'infra/**', denyTools: ['write'] }]),
    });
    const ctx = makeCtx(projectRoot);

    const pathsResult = await wrapper.evaluate(
      writeTool,
      {
        paths: [
          path.join(projectRoot, 'docs', 'README.md'),
          path.join(projectRoot, 'infra', 'main.tf'),
        ],
      },
      ctx,
    );
    const filesResult = await wrapper.evaluate(
      writeTool,
      {
        files: [
          path.join(projectRoot, 'docs', 'README.md'),
          path.join(projectRoot, 'infra', 'main.tf'),
        ],
      },
      ctx,
    );

    const filesTrace = await wrapper.explain(
      writeTool,
      {
        files: [
          path.join(projectRoot, 'docs', 'README.md'),
          path.join(projectRoot, 'infra', 'main.tf'),
        ],
      },
      ctx,
    );

    expect(pathsResult.permission).toBe('deny');
    expect(filesResult.permission).toBe('deny');
    expect(filesTrace.decision).toEqual(filesResult);
    expect(filesTrace.subject).toBe('infra/main.tf');
    expect(filesTrace.steps.filter((step) => step.rule === 'target path')).toHaveLength(2);
  });

  it('enforces secondary scalar source and destination paths', async () => {
    const wrapper = new DirectoryPermissionPolicy(allowInner(), {
      policy: policy([{ directory: 'infra/**', denyTools: ['write'] }]),
    });
    const input = {
      sourcePath: path.join(projectRoot, 'docs', 'README.md'),
      destinationPath: path.join(projectRoot, 'infra', 'README.md'),
    };

    const result = await wrapper.evaluate(writeTool, input, makeCtx(projectRoot));
    const trace = await wrapper.explain(writeTool, input, makeCtx(projectRoot));

    expect(result.permission).toBe('deny');
    expect(trace.decision).toEqual(result);
    expect(trace.subject).toBe('infra/README.md');
  });

  it('chooses the most-specific rule when two rules both match', async () => {
    const inner = allowInner();
    const wrapper = new DirectoryPermissionPolicy(inner, {
      policy: policy([
        { directory: 'infra/**', denyTools: ['bash'] },
        { directory: 'infra/terraform/**', denyTools: ['exec'] },
      ]),
    });

    // terraform path → matches BOTH; terraform rule is more specific → bans exec, not bash
    const execResult = await wrapper.evaluate(
      execTool,
      { path: path.join(projectRoot, 'infra', 'terraform', 'main.tf') },
      makeCtx(projectRoot),
    );
    expect(execResult.permission).toBe('deny');
    expect(execResult.reason).toContain('infra/terraform/**');

    const bashResult = await wrapper.evaluate(
      bashTool,
      { path: path.join(projectRoot, 'infra', 'terraform', 'main.tf') },
      makeCtx(projectRoot),
    );
    expect(bashResult.permission).toBe('auto'); // bash is not in the terraform rule

    // broader infra path → only infra/** matches → bans bash
    const bashBroader = await wrapper.evaluate(
      bashTool,
      { path: path.join(projectRoot, 'infra', 'ansible', 'play.yml') },
      makeCtx(projectRoot),
    );
    expect(bashBroader.permission).toBe('deny');
    expect(bashBroader.reason).toContain('infra/**');
  });

  it('matches namespace wildcards in denyTools (mcp__github__*)', async () => {
    const inner = allowInner();
    const wrapper = new DirectoryPermissionPolicy(inner, {
      policy: policy([{ directory: 'infra/**', denyTools: ['mcp__github__*'] }]),
    });
    const result = await wrapper.evaluate(
      mcpTool,
      { path: path.join(projectRoot, 'infra', 'plan.tf') },
      makeCtx(projectRoot),
    );
    expect(result.permission).toBe('deny');
    expect(result.reason).toContain('mcp__github__create_issue');
  });

  it('honors ctx.meta.directoryRules === false as a kill switch', async () => {
    const inner = allowInner();
    const wrapper = new DirectoryPermissionPolicy(inner, {
      policy: policy([{ directory: 'infra/**', denyTools: ['bash'] }]),
    });
    const result = await wrapper.evaluate(
      bashTool,
      { path: path.join(projectRoot, 'infra', 'deploy.sh') },
      makeCtx(projectRoot, { directoryRulesDisabled: true }),
    );
    expect(result.permission).toBe('auto');
  });

  it('resolves paths against ctx.workingDir, not projectRoot', async () => {
    const inner = allowInner();
    const wrapper = new DirectoryPermissionPolicy(inner, {
      // Leading wildcard matches a secrets/ subtree at any depth.
      policy: policy([{ directory: '**/secrets/**', denyTools: ['bash'] }]),
    });
    const nested = path.join(projectRoot, 'packages', 'app');
    const result = await wrapper.evaluate(
      bashTool,
      { path: 'secrets/.env' },
      makeCtx(projectRoot, { workingDir: nested }),
    );
    expect(result.permission).toBe('deny');
    expect(result.reason).toContain('secrets');
  });

  it('defensively copies policies accepted and returned by the wrapper', () => {
    const supplied = policy([
      {
        directory: 'infra/**',
        denyTools: ['bash'],
        denyProviders: ['openai'],
        allowOnlyTools: ['read'],
      },
    ]);
    const wrapper = new DirectoryPermissionPolicy(allowInner(), { policy: supplied });

    supplied.rules[0]?.denyTools?.push('write');
    const diagnostic = wrapper.getPolicy();
    diagnostic.rules[0]?.denyTools?.push('edit');
    diagnostic.rules[0]?.denyProviders?.push('anthropic');
    diagnostic.rules[0]?.allowOnlyTools?.push('write');

    expect(wrapper.getPolicy().rules[0]).toEqual({
      directory: 'infra/**',
      denyTools: ['bash'],
      denyProviders: ['openai'],
      allowOnlyTools: ['read'],
    });

    const replacement = policy([{ directory: 'docs/**', denyTools: ['edit'] }]);
    wrapper.setPolicy(replacement);
    replacement.rules[0]?.denyTools?.push('write');
    expect(wrapper.getPolicy().rules[0]?.denyTools).toEqual(['edit']);
  });

  it('delegates side-effect-free explain calls to the inner explainer', async () => {
    const evaluate = vi.fn(async () => ({ permission: 'deny' as const, source: 'user' as const }));
    const explain = vi.fn(async () => ({
      toolName: 'read',
      subject: 'src/file.ts',
      steps: [],
      winnerIndex: -1,
      decision: { permission: 'auto' as const, source: 'trust' as const },
    }));
    const inner: PermissionPolicy = {
      evaluate,
      explain,
      trust: async () => {},
      deny: async () => {},
      denyOnce: () => {},
      allowOnce: () => {},
      reload: async () => {},
    };
    const wrapper = new DirectoryPermissionPolicy(inner, { policy: policy([]) });

    const trace = await wrapper.explain(readTool, { path: 'src/file.ts' }, makeCtx(projectRoot));

    expect(trace.decision.permission).toBe('auto');
    expect(explain).toHaveBeenCalledOnce();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('forwards optional runtime controls to the inner policy', () => {
    const inner: PermissionPolicy = {
      ...allowInner(),
      getYolo: vi.fn(() => true),
      setYolo: vi.fn(),
      getYoloDestructive: vi.fn(() => true),
      setYoloDestructive: vi.fn(),
      getConfirmDestructive: vi.fn(() => true),
      setConfirmDestructive: vi.fn(),
      setPromptDelegate: vi.fn(),
    };
    const wrapper = new DirectoryPermissionPolicy(inner, { policy: policy([]) });
    const delegate = vi.fn(async () => 'yes' as const);

    expect(wrapper.getYolo()).toBe(true);
    expect(wrapper.getYoloDestructive()).toBe(true);
    expect(wrapper.getConfirmDestructive()).toBe(true);
    wrapper.setYolo(false);
    wrapper.setYoloDestructive(false);
    wrapper.setConfirmDestructive(false);
    wrapper.setPromptDelegate(delegate);

    expect(inner.setYolo).toHaveBeenCalledWith(false);
    expect(inner.setYoloDestructive).toHaveBeenCalledWith(false);
    expect(inner.setConfirmDestructive).toHaveBeenCalledWith(false);
    expect(inner.setPromptDelegate).toHaveBeenCalledWith(delegate);
  });

  it('delegates trust / deny / denyOnce / allowOnce / reload to inner policy', async () => {
    const inner: PermissionPolicy = {
      evaluate: async () => ({ permission: 'auto' as const, source: 'trust' as const }),
      trust: vi.fn(async () => {}),
      deny: vi.fn(async () => {}),
      denyOnce: vi.fn(() => {}),
      allowOnce: vi.fn(() => {}),
      reload: vi.fn(async () => {}),
    };
    const wrapper = new DirectoryPermissionPolicy(inner, { policy: policy([]) });

    await wrapper.trust({ tool: 'read', pattern: '**/*' });
    await wrapper.deny({ tool: 'write', pattern: '**/*' });
    wrapper.denyOnce({ tool: 'bash', pattern: '**/*' });
    wrapper.allowOnce({ tool: 'edit', pattern: '.temp_files/*' });
    await wrapper.reload();

    expect(inner.trust).toHaveBeenCalledWith({ tool: 'read', pattern: '**/*' });
    expect(inner.deny).toHaveBeenCalledWith({ tool: 'write', pattern: '**/*' });
    expect(inner.denyOnce).toHaveBeenCalledWith({ tool: 'bash', pattern: '**/*' });
    expect(inner.allowOnce).toHaveBeenCalledWith({ tool: 'edit', pattern: '.temp_files/*' });
    expect(inner.reload).toHaveBeenCalledOnce();
  });

  it('inner-policy deny still wins for tools outside any directory rule', async () => {
    const wrapper = new DirectoryPermissionPolicy(denyInner('forbidden command'), {
      policy: policy([{ directory: 'infra/**', denyTools: ['bash'] }]),
    });
    const result = await wrapper.evaluate(
      editTool,
      { path: path.join(projectRoot, 'src', 'main.ts') },
      makeCtx(projectRoot),
    );
    expect(result.permission).toBe('deny');
    expect(result.reason).toBe('forbidden command');
  });

  it('explain emits trace steps for each rule constraint and the inner delegation', async () => {
    const wrapper = new DirectoryPermissionPolicy(allowInner(), {
      policy: policy([{ directory: 'infra/**', denyTools: ['bash'] }]),
    });
    const trace = await wrapper.explain(
      bashTool,
      { path: path.join(projectRoot, 'infra', 'deploy.sh') },
      makeCtx(projectRoot),
    );

    expect(trace.toolName).toBe('bash');
    expect(trace.winnerIndex).toBeGreaterThanOrEqual(0);
    expect(trace.steps.some((s) => s.rule === 'directory rule match')).toBe(true);
    expect(trace.steps.some((s) => s.rule === 'denyTools')).toBe(true);
    expect(trace.decision.permission).toBe('deny');
    expect(trace.decision.source).toBe('directory_rules');
  });
});
