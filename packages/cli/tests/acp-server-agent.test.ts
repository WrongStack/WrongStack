/**
 * Tests for the ACP server → real Agent factory.
 *
 * Covers the two paths that matter for `wstack acp`:
 *  1. No provider configured → AcpServerConfigError with an actionable message.
 *  2. Provider configured → agentFor() builds a real, isolated Agent per session.
 *
 * setupProvider is mocked so the happy path doesn't hit models.dev or need a
 * live API key; the provider it returns is a stub whose `complete`/`stream`
 * throw if actually called — the factory only needs the Provider type slot
 * filled to construct Context + Agent.
 */

import { Agent } from '@wrongstack/core/agent';
import type { ProviderRegistry } from '@wrongstack/core/registry';
import { ToolRegistry as RealToolRegistry } from '@wrongstack/core/registry';
import type { Config, Provider, ResolvedProvider } from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';
import { builtinToolsPack } from '@wrongstack/tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock setupProvider so we control provider/registry construction without
// touching models.dev or network.
const mockSetupProvider = vi.fn();
vi.mock('../src/wiring/provider.js', () => ({
  setupProvider: (...args: unknown[]) => mockSetupProvider(...args),
}));

// createDefaultContainer binds a lot of stateful services; mock it so the test
// stays fast and hermetic. The factory resolves TOKENS.Logger (needs .child)
// and TOKENS.SecretScrubber from it during Agent construction.
vi.mock('@wrongstack/runtime', () => ({
  wireKanbanPorts: vi.fn(),
  createDefaultContainer: () => ({
    resolve: () => ({
      initialize: async () => {},
      child: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      scrub: (s: string) => s,
    }),
  }),
}));

import type { RunTurnApi } from '@wrongstack/acp/agent';
import { ToolCapabilities } from '@wrongstack/core/security';
import type { Tool } from '@wrongstack/core/types';
import {
  ACPClientPermissionPolicy,
  AcpServerConfigError,
  buildAcpServerAgentFactory,
} from '../src/acp-server-agent.js';
import type { SubcommandDeps } from '../src/subcommands/index.js';

function makeStubProvider(): Provider {
  return {
    id: 'test',
    capabilities: { maxContext: 0 },
    complete: async () => {
      throw new Error('stub provider: complete not implemented');
    },
    stream: () => {
      throw new Error('stub provider: stream not implemented');
    },
  } as never as Provider;
}

function makeDeps(overrides: Partial<SubcommandDeps> = {}): SubcommandDeps {
  const tools = new RealToolRegistry();
  tools.registerAllOrThrow([...(builtinToolsPack.tools ?? [])], builtinToolsPack.name);
  return {
    config: {
      provider: 'test-provider',
      model: 'test-model',
      features: {},
      tools: {},
    } as never as Config,
    renderer: {
      write: vi.fn(),
      writeError: vi.fn(),
      writeWarning: vi.fn(),
      writeInfo: vi.fn(),
      projectRoot: '/tmp',
    } as never,
    reader: { readLine: vi.fn(), readKey: vi.fn(), readSecret: vi.fn(), close: vi.fn() } as never,
    paths: {} as WstackPaths,
    vault: { encrypt: vi.fn((s: string) => s), decrypt: vi.fn((s: string) => s) } as never,
    modelsRegistry: {} as never,
    cwd: '/tmp',
    projectRoot: '/tmp',
    userHome: '/tmp',
    toolRegistry: tools,
    flags: {},
    ...overrides,
  };
}

describe('buildAcpServerAgentFactory', () => {
  beforeEach(() => {
    mockSetupProvider.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws AcpServerConfigError when no provider is configured', () => {
    const deps = makeDeps({
      config: { provider: undefined, model: undefined } as never as Config,
    });
    expect(() => buildAcpServerAgentFactory(deps)).toThrow(AcpServerConfigError);
    expect(() => buildAcpServerAgentFactory(deps)).toThrow(/wstack auth/);
  });

  it('throws AcpServerConfigError when provider is set but model is missing', () => {
    const deps = makeDeps({
      config: { provider: 'anthropic', model: undefined } as never as Config,
    });
    expect(() => buildAcpServerAgentFactory(deps)).toThrow(AcpServerConfigError);
  });

  it('builds a real, isolated Agent per session when a provider is configured', async () => {
    const provider = makeStubProvider();
    const providerRegistry = { has: () => true } as never as ProviderRegistry;
    mockSetupProvider.mockResolvedValue({
      provider,
      providerRegistry,
      resolvedProvider: {} as ResolvedProvider,
    });

    const deps = makeDeps();
    const agentFor = buildAcpServerAgentFactory(deps);

    const a1 = await agentFor('sess-1', '/tmp');
    const a2 = await agentFor('sess-2', '/tmp');

    expect(a1).toBeInstanceOf(Agent);
    expect(a2).toBeInstanceOf(Agent);
    // Sessions are isolated: each gets its own event bus / context.
    expect(a1).not.toBe(a2);
    expect(a1.events).not.toBe(a2.events);
    expect(a1.ctx).not.toBe(a2.ctx);
    // The configured model flows through to the context.
    expect(a1.ctx.model).toBe('test-model');
  });

  it('wires ACP-backed fs/terminal tools when the client advertises capabilities', async () => {
    const provider = makeStubProvider();
    const providerRegistry = { has: () => true } as never as ProviderRegistry;
    mockSetupProvider.mockResolvedValue({
      provider,
      providerRegistry,
      resolvedProvider: {} as ResolvedProvider,
    });

    const reads: Array<{ path: string }> = [];
    const writes: Array<{ path: string; content: string }> = [];
    const terminals: Array<{ command: string; args?: string[] }> = [];
    const api: RunTurnApi = {
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      requestPermission: async () => ({ outcome: 'selected', optionId: 'allow_once' }),
      readTextFile: async (p) => {
        reads.push({ path: p.path });
        return 'line one\nline two';
      },
      writeTextFile: async (p) => {
        writes.push(p);
      },
      runTerminal: async (p) => {
        terminals.push({ command: p.command, ...(p.args ? { args: p.args } : {}) });
        return { output: 'terminal output', exitCode: 0 };
      },
    };

    const agentFor = buildAcpServerAgentFactory(makeDeps());
    const agent = await agentFor('sess-acp', '/tmp', api);

    const readTool = agent.tools.get('read');
    const readOut = (await readTool!.execute({ path: 'a.ts' }, agent.ctx, {} as never)) as {
      text: string;
    };
    expect(reads[0]).toMatchObject({ path: 'a.ts' });
    expect(readOut.text).toContain('line one');

    const writeTool = agent.tools.get('write');
    await writeTool!.execute({ path: 'b.ts', content: 'hello' }, agent.ctx, {} as never);
    expect(writes[0]).toMatchObject({ path: 'b.ts', content: 'hello' });

    const bashTool = agent.tools.get('bash');
    const bashOut = (await bashTool!.execute({ command: 'echo hi' }, agent.ctx, {} as never)) as {
      stdout: string;
      exit_code: number | null;
    };
    expect(terminals[0]?.command).toBe('sh');
    expect(bashOut.stdout).toBe('terminal output');
    expect(bashOut.exit_code).toBe(0);
  });

  it('keeps local builtin tools when the client advertises no fs/terminal', async () => {
    const provider = makeStubProvider();
    mockSetupProvider.mockResolvedValue({
      provider,
      providerRegistry: { has: () => true } as never as ProviderRegistry,
      resolvedProvider: {} as ResolvedProvider,
    });
    const api: RunTurnApi = {
      clientCapabilities: {},
      requestPermission: async () => ({ outcome: 'cancelled' }),
      readTextFile: async () => '',
      writeTextFile: async () => {},
      runTerminal: async () => ({ output: '', exitCode: 0 }),
    };
    const agent = await buildAcpServerAgentFactory(makeDeps())('s', '/tmp', api);
    // The builtin read tool is still the local one (its capabilities include fs.read).
    expect(agent.tools.get('read')?.capabilities).toContain('fs.read');
  });

  it('memoizes the provider boot so repeated sessions reuse one setup call', async () => {
    const provider = makeStubProvider();
    const providerRegistry = { has: () => true } as never as ProviderRegistry;
    mockSetupProvider.mockResolvedValue({
      provider,
      providerRegistry,
      resolvedProvider: {} as ResolvedProvider,
    });

    const agentFor = buildAcpServerAgentFactory(makeDeps());
    await agentFor('sess-a', '/tmp');
    await agentFor('sess-b', '/tmp');
    await agentFor('sess-c', '/tmp');

    expect(mockSetupProvider).toHaveBeenCalledTimes(1);
  });
});

/**
 * Direct unit tests for ACPClientPermissionPolicy.
 *
 * Regression coverage for the malformed-response bug at acp-server-agent.ts:94.
 * Pre-fix, a client response shaped like the `'selected'` variant of
 * `RequestPermissionOutcome` (`{ outcome: 'selected'; optionId: string }`) but
 * missing the typed `optionId` field would dereference
 * `outcome.optionId.startsWith('allow')` and throw a TypeError; the
 * surrounding try/catch swallowed the throw and returned a misleading
 * `{ permission: 'deny', source: 'deny', reason: 'no permission channel' }`,
 * hiding a protocol violation as a transport failure. The fix narrows the
 * permission decision to `typeof optionId === 'string'` so a missing
 * `optionId` falls through to the user-deny branch with the correct reason.
 *
 * The earlier `describe('buildAcpServerAgentFactory')` block tests through
 * the factory + Agent + ToolRegistry — fine for the happy paths but heavy
 * enough that exercising the policy directly is much cleaner for the
 * malformed-response corner case.
 */
describe('ACPClientPermissionPolicy', () => {
  // A minimal tool stub whose capabilities are NOT in the safe set, so the
  // policy doesn't short-circuit on the `isSafe` early return and actually
  // reaches `requestPermission`. Mirrors the builtin's bash tool — its
  // SHELL_ARBITRARY capability is what causes the production policy to
  // route the call through the ACP client for approval.
  const sideEffectingTool: Tool = {
    name: 'bash',
    description: 'stub',
    inputSchema: { type: 'object' },
    permission: 'confirm',
    mutating: true,
    capabilities: [ToolCapabilities.SHELL_ARBITRARY],
    execute: async () => ({}),
  };

  it('denies (with "rejected by ACP client" reason) when a malformed "selected" response omits optionId', async () => {
    // Regression: pre-fix, a client response shaped like the `'selected'`
    // variant of RequestPermissionOutcome but missing the typed `optionId`
    // field used to throw a TypeError at `outcome.optionId.startsWith(...)`.
    // The fix narrows the access so the permission decision is
    // `{ permission: 'deny', source: 'user' }` — NOT the catch-all
    // `{ source: 'deny', reason: 'no permission channel' }` path, which
    // would hide a real protocol violation as a transport failure.
    //
    // We cast through `never` because the malformed shape does not match
    // either variant of the union — that mismatch is exactly what the bug
    // is about. The runtime check is what defends against it.
    const requestPermission = vi.fn(
      async () =>
        ({
          outcome: 'selected',
        }) as never,
    );
    const policy = new ACPClientPermissionPolicy(requestPermission as never);

    const decision = await policy.evaluate(sideEffectingTool, { path: 'a.ts' });

    expect(decision).toEqual({
      permission: 'deny',
      source: 'user',
      reason: 'rejected by ACP client',
    });
    // Make sure the test double was actually invoked — without this, the
    // test could pass for the wrong reason if `isSafe` ever started
    // short-circuiting for our stub.
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('approves with source "user" when the response carries a valid allow_* optionId', async () => {
    // Locks in the happy-path contract on the post-fix side, so a future
    // change to the typeof guard (e.g. reverting to a non-narrowed check)
    // can't silently break legitimate approvals.
    const requestPermission = vi.fn(async () => ({
      outcome: 'selected',
      optionId: 'allow_once',
    }));
    const policy = new ACPClientPermissionPolicy(requestPermission as never);

    const decision = await policy.evaluate(sideEffectingTool, { path: 'a.ts' });

    expect(decision).toEqual({ permission: 'auto', source: 'user' });
  });

  it('approves with source "user" when the client selects allow_always', async () => {
    // Same shape as the above, but with allow_always — confirms the
    // `startsWith('allow')` check accepts both allow_once and allow_always.
    const requestPermission = vi.fn(async () => ({
      outcome: 'selected',
      optionId: 'allow_always',
    }));
    const policy = new ACPClientPermissionPolicy(requestPermission as never);

    const decision = await policy.evaluate(sideEffectingTool, { path: 'a.ts' });

    expect(decision).toEqual({ permission: 'auto', source: 'user' });
  });

  it('denies (with "rejected by ACP client" reason) when the user picks reject_once', async () => {
    // Confirm that an explicit user-rejection is still attributed to the
    // user, not to "no permission channel". A regression in the optionId
    // extraction could otherwise conflate these two deny paths.
    const requestPermission = vi.fn(async () => ({
      outcome: 'selected',
      optionId: 'reject_once',
    }));
    const policy = new ACPClientPermissionPolicy(requestPermission as never);

    const decision = await policy.evaluate(sideEffectingTool, { path: 'a.ts' });

    expect(decision).toEqual({
      permission: 'deny',
      source: 'user',
      reason: 'rejected by ACP client',
    });
  });

  it('denies (with "rejected by ACP client" reason) when the client cancels the prompt', async () => {
    // Cancelled outcome carries no optionId; the narrowed access still
    // denies with the user-rejection reason rather than the catch-all path.
    const requestPermission = vi.fn(async () => ({
      outcome: 'cancelled',
    }));
    const policy = new ACPClientPermissionPolicy(requestPermission as never);

    const decision = await policy.evaluate(sideEffectingTool, { path: 'a.ts' });

    expect(decision).toEqual({
      permission: 'deny',
      source: 'user',
      reason: 'rejected by ACP client',
    });
  });

  it('returns the catch-all "no permission channel" deny when requestPermission throws', async () => {
    // Distinct from the malformed-response path: a thrown promise lands in
    // the `catch` block (e.g. client disconnected, RPC timeout). We want
    // this to keep its existing distinct reason so operators can tell the
    // two failure modes apart in logs.
    const requestPermission = vi.fn(async () => {
      throw new Error('client disconnected');
    });
    const policy = new ACPClientPermissionPolicy(requestPermission as never);

    const decision = await policy.evaluate(sideEffectingTool, { path: 'a.ts' });

    expect(decision).toEqual({
      permission: 'deny',
      source: 'deny',
      reason: 'no permission channel',
    });
  });

  it('auto-approves safe tools without consulting the client', async () => {
    // Tools whose capabilities are all in the safe set bypass the channel
    // entirely. Locking this in keeps the regression coverage honest: if the
    // policy ever changed to consult the client for safe tools, that change
    // would need a deliberate test update rather than silently sliding in.
    const requestPermission = vi.fn();
    const policy = new ACPClientPermissionPolicy(requestPermission as never);
    const safeTool: Tool = {
      ...sideEffectingTool,
      capabilities: [ToolCapabilities.FS_READ],
    };

    const decision = await policy.evaluate(safeTool, { path: 'a.ts' });

    expect(decision).toEqual({ permission: 'auto', source: 'default' });
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
