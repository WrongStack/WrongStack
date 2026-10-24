import type { PermissionRequest } from '@wrongstack/acp';
import type { PermissionDecision, Tool } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import { wrongstackAcpPermissionPolicy } from '../src/fleet/acp-permission-bridge.js';

const ROOT = 'D:/proj';

function request(
  kind: string,
  rawInput: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  signal = new AbortController().signal,
): PermissionRequest {
  return {
    toolCall: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', kind, rawInput, ...extra },
    options: [
      { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'allow-with-updates', name: 'Always', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    signal,
  } as unknown as PermissionRequest;
}

/** The WrongStack call the policy is asked about for `req`, or undefined when none is. */
async function wrongstackCallFor(req: PermissionRequest) {
  let seen: { tool: string; input: unknown } | undefined;
  const policy = wrongstackAcpPermissionPolicy({
    evaluate: async (tool, input) => {
      seen = { tool: tool.name, input };
      return { permission: 'auto', source: 'default' };
    },
    getTool: (name) => ({ name }) as Tool,
    projectRoot: ROOT,
  });
  await policy(req);
  return seen;
}

describe('request translation', () => {
  it("maps Claude's requests to the WrongStack call with the same effect", async () => {
    expect(
      await wrongstackCallFor(request('execute', { command: 'bun test', description: 'x' })),
    ).toEqual({
      tool: 'bash',
      input: { command: 'bun test' },
    });
    expect(
      await wrongstackCallFor(request('edit', { file_path: `${ROOT}/a.ts`, content: 'x' })),
    ).toEqual({ tool: 'write', input: { path: `${ROOT}/a.ts`, content: 'x' } });
    expect(
      await wrongstackCallFor(
        request('edit', { file_path: `${ROOT}/a.ts`, old_string: 'a', new_string: 'b' }),
      ),
    ).toEqual({ tool: 'edit', input: { path: `${ROOT}/a.ts`, old_string: 'a', new_string: 'b' } });
    expect(
      await wrongstackCallFor(request('fetch', { url: 'https://x.dev', prompt: 'p' })),
    ).toEqual({
      tool: 'fetch',
      input: { url: 'https://x.dev' },
    });
    expect(
      await wrongstackCallFor(request('delete', {}, { locations: [{ path: `${ROOT}/old.ts` }] })),
    ).toEqual({ tool: 'bash', input: { command: `rm "${ROOT}/old.ts"` } });
    expect(await wrongstackCallFor(request('read', { file_path: '~/.aws/credentials' }))).toEqual({
      tool: 'read',
      input: { path: '~/.aws/credentials' },
    });
  });

  it('checks MCP tools, web searches and sandbox network requests as what they are', async () => {
    expect(
      await wrongstackCallFor(
        request('other', { query: 'x' }, { title: 'mcp__wrongstack-index__codebase_search' }),
      ),
    ).toEqual({ tool: 'mcp__wrongstack-index__codebase_search', input: { query: 'x' } });
    // Claude names the tool in `_meta` when the title is a display name.
    expect(
      await wrongstackCallFor(
        request(
          'other',
          { a: 1 },
          { title: 'Search docs', _meta: { claudeCode: { toolName: 'mcp__docs__search' } } },
        ),
      ),
    ).toEqual({ tool: 'mcp__docs__search', input: { a: 1 } });
    expect(await wrongstackCallFor(request('fetch', { query: 'ACP spec' }))).toEqual({
      tool: 'fetch',
      input: { query: 'ACP spec' },
    });
    expect(await wrongstackCallFor(request('fetch', { host: 'registry.npmjs.org' }))).toEqual({
      tool: 'fetch',
      input: { url: 'https://registry.npmjs.org' },
    });
  });
});

describe('wrongstackAcpPermissionPolicy', () => {
  const tools: Record<string, Tool> = {
    bash: { name: 'bash' } as Tool,
    fetch: { name: 'fetch' } as Tool,
  };
  const decide = (permission: PermissionDecision['permission'], reason?: string) =>
    vi.fn(
      async (): Promise<PermissionDecision> => ({ permission, source: 'subagent_guard', reason }),
    );

  it('answers allow-once when WrongStack approves, never a standing allow', async () => {
    const evaluate = decide('auto');
    const policy = wrongstackAcpPermissionPolicy({
      evaluate,
      getTool: (n) => tools[n],
      projectRoot: ROOT,
    });
    await expect(policy(request('execute', { command: 'bun test' }))).resolves.toEqual({
      outcome: 'selected',
      optionId: 'allow-once',
    });
    expect(evaluate).toHaveBeenCalledWith(
      tools.bash,
      { command: 'bun test' },
      {
        projectRoot: ROOT,
        cwd: ROOT,
      },
    );
  });

  it('rejects what WrongStack refuses or would ask about, and says why', async () => {
    const refused = vi.fn();
    for (const permission of ['deny', 'confirm'] as const) {
      const policy = wrongstackAcpPermissionPolicy({
        evaluate: decide(permission, 'git-history commands are gated'),
        getTool: (n) => tools[n],
        projectRoot: ROOT,
        onRefused: refused,
      });
      await expect(policy(request('execute', { command: 'git push --force' }))).resolves.toEqual({
        outcome: 'selected',
        optionId: 'reject',
      });
    }
    expect(refused).toHaveBeenCalledWith(
      { tool: 'bash', input: { command: 'git push --force' } },
      'git-history commands are gated',
    );
  });

  it('fails closed when the policy throws, and cancels an aborted request', async () => {
    const policy = wrongstackAcpPermissionPolicy({
      evaluate: vi.fn(async () => {
        throw new Error('trust file unreadable');
      }),
      getTool: (n) => tools[n],
      projectRoot: ROOT,
    });
    await expect(policy(request('fetch', { url: 'https://x.dev' }))).resolves.toEqual({
      outcome: 'selected',
      optionId: 'reject',
    });
    const ac = new AbortController();
    ac.abort();
    await expect(
      policy(request('fetch', { url: 'https://x.dev' }, {}, ac.signal)),
    ).resolves.toEqual({ outcome: 'cancelled' });
  });

  it('refuses what it cannot check: unknown kinds, calls naming no target, missing tools', async () => {
    const evaluate = decide('auto');
    const refused = vi.fn();
    const policy = wrongstackAcpPermissionPolicy({
      evaluate,
      getTool: (n) => tools[n],
      projectRoot: ROOT,
      onRefused: refused,
    });
    const rejected = { outcome: 'selected', optionId: 'reject' };
    await expect(policy(request('other', { server: 'x' }, { title: 'Mystery' }))).resolves.toEqual(
      rejected,
    );
    await expect(policy(request('execute', {}))).resolves.toEqual(rejected);
    await expect(policy(request('edit', { content: 'x' }))).resolves.toEqual(rejected);
    await expect(policy(request('fetch', {}))).resolves.toEqual(rejected);
    // `write` is not in this registry: a run that lost a tool (`--restricted`,
    // a launch allowlist) must not get it back through a worker.
    await expect(
      policy(request('edit', { file_path: `${ROOT}/a.ts`, content: '' })),
    ).resolves.toEqual(rejected);
    expect(evaluate).not.toHaveBeenCalled();
    expect(refused).toHaveBeenCalledWith(
      { tool: 'write', input: { path: `${ROOT}/a.ts`, content: '' } },
      'write is not available in this run',
    );
    expect(refused).toHaveBeenCalledWith(
      { tool: 'Mystery', input: { server: 'x' } },
      'no WrongStack counterpart to check it against',
    );
  });

  it("puts MCP tools under the user's rules, and refuses them all when MCP is off", async () => {
    const evaluate = vi.fn(
      async (tool: Tool): Promise<PermissionDecision> =>
        tool.name.startsWith('mcp__github__')
          ? { permission: 'deny', source: 'trust', reason: 'denied by rule mcp__github__*' }
          : { permission: 'auto', source: 'default' },
    );
    const mcp = (title: string) => request('other', {}, { title });
    const policy = wrongstackAcpPermissionPolicy({
      evaluate,
      getTool: (n) => tools[n],
      projectRoot: ROOT,
    });
    await expect(policy(mcp('mcp__wrongstack-sage__sage_search'))).resolves.toEqual({
      outcome: 'selected',
      optionId: 'allow-once',
    });
    await expect(policy(mcp('mcp__github__delete_repo'))).resolves.toEqual({
      outcome: 'selected',
      optionId: 'reject',
    });
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({
      name: 'mcp__wrongstack-sage__sage_search',
      capabilities: ['mcp.proxy'],
    });

    const restricted = wrongstackAcpPermissionPolicy({
      evaluate,
      getTool: (n) => tools[n],
      projectRoot: ROOT,
      allowMcp: false,
    });
    await expect(restricted(mcp('mcp__wrongstack-sage__sage_search'))).resolves.toEqual({
      outcome: 'selected',
      optionId: 'reject',
    });
  });

  it('lets thinking, path-less searches and mode switches through without asking', async () => {
    const evaluate = decide('deny');
    const policy = wrongstackAcpPermissionPolicy({
      evaluate,
      getTool: (n) => tools[n],
      projectRoot: ROOT,
    });
    for (const kind of ['think', 'search', 'switch_mode']) {
      await expect(policy(request(kind, { pattern: 'x' }))).resolves.toEqual({
        outcome: 'selected',
        optionId: 'allow-once',
      });
    }
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("asks the user through the leader's prompt when the policy wants a question", async () => {
    const confirm = vi.fn(async (_tool: Tool, call: { tool: string }) => call.tool === 'bash');
    const refused = vi.fn();
    const policy = wrongstackAcpPermissionPolicy({
      evaluate: decide('confirm'),
      getTool: (n) => tools[n],
      projectRoot: ROOT,
      confirm,
      onRefused: refused,
    });
    await expect(policy(request('execute', { command: 'bun test' }))).resolves.toEqual({
      outcome: 'selected',
      optionId: 'allow-once',
    });
    await expect(policy(request('fetch', { url: 'https://x.dev' }))).resolves.toEqual({
      outcome: 'selected',
      optionId: 'reject',
    });
    expect(refused).toHaveBeenCalledWith(
      { tool: 'fetch', input: { url: 'https://x.dev' } },
      'declined by the user',
    );
    // A prompt that fails is a no, never a yes.
    const broken = wrongstackAcpPermissionPolicy({
      evaluate: decide('confirm'),
      getTool: (n) => tools[n],
      projectRoot: ROOT,
      confirm: async () => {
        throw new Error('prompt closed');
      },
    });
    await expect(policy(request('execute', { command: 'bun test' }))).resolves.toMatchObject({
      optionId: 'allow-once',
    });
    await expect(broken(request('execute', { command: 'bun test' }))).resolves.toMatchObject({
      optionId: 'reject',
    });
    // Deny stays deny: the prompt is only for questions.
    const denied = wrongstackAcpPermissionPolicy({
      evaluate: decide('deny'),
      getTool: (n) => tools[n],
      projectRoot: ROOT,
      confirm,
    });
    confirm.mockClear();
    await expect(denied(request('execute', { command: 'rm -rf /' }))).resolves.toMatchObject({
      optionId: 'reject',
    });
    expect(confirm).not.toHaveBeenCalled();
  });
});
