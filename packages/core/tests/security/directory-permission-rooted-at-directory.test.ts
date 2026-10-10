import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import {
  DirectoryPermissionPolicy,
  matchRule,
} from '../../src/security/directory-permission-policy.js';
import type { Tool } from '../../src/types/index.js';
import type { DirectoryRule, PermissionPolicy } from '../../src/types/permission.js';

/**
 * A call ROOTED AT a denied directory (a shell cwd, a recursive grep/glob
 * path) reaches everything below it, but the canonical `dir/**` rule shape does
 * not match the bare `dir`, so such calls used to pass the rule that denied the
 * same tool on any file below it. pwsh names its working directory `workdir`,
 * which was not among the path keys directory rules read at all.
 */

const projectRoot = path.resolve('C:/proj-rooted-at-directory');

function makeTool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    permission: 'auto',
    mutating: false,
    async execute() {
      return 'ok';
    },
  };
}

function makeCtx(providerId = 'anthropic', workingDir = projectRoot): Context {
  return {
    meta: {},
    projectRoot,
    provider: { id: providerId },
    model: 'test-model',
    messages: [],
    todos: [],
    readFiles: new Set(),
    writtenFiles: [],
    workingDir,
    cwd: workingDir,
    agentId: 'test-agent',
  } as unknown as Context;
}

const inner: PermissionPolicy = {
  async evaluate() {
    return { permission: 'auto', source: 'trust' };
  },
} as unknown as PermissionPolicy;

function policyOf(...rules: DirectoryRule[]): DirectoryPermissionPolicy {
  return new DirectoryPermissionPolicy(inner, { policy: { schemaVersion: 1, rules } });
}

async function denied(
  policy: DirectoryPermissionPolicy,
  toolName: string,
  input: Record<string, unknown>,
  ctx: Context = makeCtx(),
): Promise<boolean> {
  const result = await policy.evaluate(makeTool(toolName), input, ctx);
  return result.permission === 'deny';
}

describe('directory rules and calls rooted at the denied directory', () => {
  const secrets = policyOf({ directory: 'secrets/**', denyTools: ['bash', 'grep', 'glob'] });

  it.each([
    ['a shell cwd', 'bash', { command: 'cat *', cwd: 'secrets' }],
    ['a recursive grep root', 'grep', { pattern: 'password', path: 'secrets' }],
    ['a glob root', 'glob', { pattern: '**/*', path: 'secrets' }],
    ['the trailing-slash spelling', 'grep', { pattern: 'p', path: 'secrets/' }],
    ['an absolute path', 'bash', { command: 'ls', cwd: path.join(projectRoot, 'secrets') }],
  ])('denies %s that is the directory itself', async (_label, tool, input) => {
    expect(await denied(secrets, tool, input)).toBe(true);
  });

  it('still denies the same tools below the directory (control)', async () => {
    expect(await denied(secrets, 'bash', { command: 'ls', cwd: 'secrets/sub' })).toBe(true);
    expect(await denied(secrets, 'grep', { pattern: 'p', path: 'secrets/key.pem' })).toBe(true);
  });

  it('covers a directory reached through a leading-wildcard rule', async () => {
    const anywhere = policyOf({ directory: '**/secrets/**', denyTools: ['bash'] });
    expect(await denied(anywhere, 'bash', { command: 'ls', cwd: 'a/secrets' })).toBe(true);
    expect(await denied(anywhere, 'bash', { command: 'ls', cwd: '../elsewhere/secrets' })).toBe(
      true,
    );
  });

  it('does not deny siblings, look-alike names, a parent or the project root', async () => {
    const nested = policyOf({ directory: 'infra/terraform/**', denyTools: ['bash'] });
    expect(await denied(nested, 'bash', { command: 'ls', cwd: 'infra' })).toBe(false);
    for (const cwd of ['secrets-old', 'secretsX', 'mysecrets', 'src', '.']) {
      expect(await denied(secrets, 'bash', { command: 'ls', cwd }), cwd).toBe(false);
    }
  });

  it('applies the same coverage to provider and allow-only rules', async () => {
    const byProvider = policyOf({ directory: 'clients/acme/**', denyProviders: ['openai'] });
    const input = { pattern: '*', path: 'clients/acme' };
    expect(await denied(byProvider, 'glob', input, makeCtx('openai'))).toBe(true);
    expect(await denied(byProvider, 'glob', input, makeCtx('anthropic'))).toBe(false);
    const docsOnly = policyOf({ directory: 'docs/**', allowOnlyTools: ['read'] });
    expect(await denied(docsOnly, 'bash', { command: 'ls', cwd: 'docs' })).toBe(true);
    expect(await denied(docsOnly, 'read', { path: 'docs' })).toBe(false);
  });

  it('matchRule treats the bare directory as covered but not the empty target', () => {
    const policy = {
      schemaVersion: 1,
      rules: [{ directory: 'secrets/**', denyTools: ['bash'] }],
    } as const;
    expect(matchRule(policy as never, 'secrets')?.directory).toBe('secrets/**');
    expect(matchRule(policy as never, '')).toBeUndefined();
    expect(matchRule(policy as never, 'secrets2')).toBeUndefined();
  });
});

describe('directory rules and pwsh workdir', () => {
  const infra = policyOf({ directory: 'infra/**', denyTools: ['bash', 'pwsh'] });

  it.each(['infra/sub', 'infra/a/b', path.join(projectRoot, 'infra', 'sub')])(
    'denies pwsh with workdir %s exactly as bash with cwd',
    async (dir) => {
      expect(await denied(infra, 'bash', { command: 'ls', cwd: dir })).toBe(true);
      expect(await denied(infra, 'pwsh', { command: 'ls', workdir: dir })).toBe(true);
    },
  );

  it('resolves a relative workdir against ctx.workingDir', async () => {
    const ctx = makeCtx('anthropic', path.join(projectRoot, 'infra'));
    expect(await denied(infra, 'pwsh', { command: 'ls', workdir: 'sub' }, ctx)).toBe(true);
  });

  it('passes a workdir outside the rule, an empty one and a missing one', async () => {
    expect(await denied(infra, 'pwsh', { command: 'ls', workdir: 'src' })).toBe(false);
    expect(await denied(infra, 'pwsh', { command: 'ls', workdir: '' })).toBe(false);
    expect(await denied(infra, 'pwsh', { command: 'ls' })).toBe(false);
  });
});
