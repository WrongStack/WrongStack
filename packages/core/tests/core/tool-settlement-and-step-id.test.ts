/**
 * Two attribution guarantees of the agent loop:
 *
 *  - every tool call leaves a typed `settlement` on `tool.executed` AND on the
 *    journaled `tool_result`, including calls that never ran;
 *  - one loop iteration is one logical request: provider retries and the
 *    fallback extension's hops share `logicalRequestId`, the next iteration
 *    gets a new one.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Container } from '@wrongstack/contracts/kernel/container';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { Context } from '../../src/core/context.js';
import { DefaultErrorHandler } from '../../src/execution/error-handler.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import { MockProvider } from '../helpers/mock-provider.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function tool(name: string, permission: Tool['permission'] = 'auto'): Tool {
  return {
    name,
    description: '',
    inputSchema: { type: 'object' },
    permission,
    mutating: false,
    async execute() {
      return `${name} ran`;
    },
  };
}

async function buildAgent(provider: MockProvider, tools: Tool[], opts: { yolo: boolean }) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-settle-'));
  dirs.push(tmp);
  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error' }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
  container.bind(
    TOKENS.PermissionPolicy,
    () => new DefaultPermissionPolicy({ trustFile: path.join(tmp, 'trust.json'), yolo: opts.yolo }),
  );
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  const events = new EventBus();
  const sessionStore = new DefaultSessionStore({ dir: path.join(tmp, 'sessions') });
  const session = await sessionStore.create({ id: '', model: 'test', provider: 'mock' });
  const appendBatch = vi.spyOn(session, 'appendBatch');
  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'test' }],
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter: container.resolve(TOKENS.TokenCounter),
    cwd: tmp,
    projectRoot: tmp,
    model: 'test-model',
  });
  const agent = new Agent({
    container,
    tools: registry,
    providers: new ProviderRegistry(),
    events,
    pipelines: createDefaultPipelines(),
    context: ctx,
    maxIterations: 10,
    toolExecutor: new ToolExecutor(registry, {
      permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
      secretScrubber: container.resolve(TOKENS.SecretScrubber),
      events,
      confirmAwaiter: undefined,
      iterationTimeoutMs: 300_000,
      perIterationOutputCapBytes: 100_000,
      tracer: undefined,
    }),
  });
  const journaled = () =>
    appendBatch.mock.calls
      .flatMap(([batch]) => batch)
      .filter((e) => e.type === 'tool_result')
      .map((e) => ({ id: e.id, settlement: (e as { settlement?: string }).settlement }));
  return { agent, events, ctx, journaled };
}

function toolTurn(...calls: Array<{ id: string; name: string }>) {
  return {
    content: calls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: {} })),
    stopReason: 'tool_use' as const,
  };
}
const done = { content: [{ type: 'text' as const, text: 'ok' }], stopReason: 'end_turn' as const };

describe('tool settlement on the event and in the journal', () => {
  it('records completed, unknown_tool and a declined confirmation', async () => {
    const provider = new MockProvider([
      toolTurn(
        { id: 'u-ok', name: 'echo' },
        { id: 'u-missing', name: 'no_such_tool' },
        { id: 'u-ask', name: 'risky' },
      ),
      done,
    ]);
    const { agent, events, journaled } = await buildAgent(
      provider,
      [tool('echo'), tool('risky', 'confirm')],
      { yolo: false },
    );
    events.on('tool.confirm_needed', (e) => e.resolve('no'));
    const executed: Array<{
      id?: string | undefined;
      ok: boolean;
      settlement?: string | undefined;
    }> = [];
    events.on('tool.executed', (e) =>
      executed.push({ id: e.id, ok: e.ok, settlement: e.settlement }),
    );

    await agent.run('go');

    expect(executed).toEqual(
      expect.arrayContaining([
        { id: 'u-ok', ok: true, settlement: 'completed' },
        { id: 'u-missing', ok: false, settlement: 'unknown_tool' },
        { id: 'u-ask', ok: false, settlement: 'declined' },
      ]),
    );
    expect(journaled()).toEqual(
      expect.arrayContaining([
        { id: 'u-ok', settlement: 'completed' },
        { id: 'u-missing', settlement: 'unknown_tool' },
        { id: 'u-ask', settlement: 'declined' },
      ]),
    );
  });

  it('records an approved confirmation by what the tool then did', async () => {
    const provider = new MockProvider([toolTurn({ id: 'u-ask', name: 'risky' }), done]);
    const { agent, events, journaled } = await buildAgent(provider, [tool('risky', 'confirm')], {
      yolo: false,
    });
    events.on('tool.confirm_needed', (e) => e.resolve('yes'));

    await agent.run('go');

    expect(journaled()).toEqual([{ id: 'u-ask', settlement: 'completed' }]);
  });
});

describe('logical request id per loop iteration', () => {
  it('is shared by every hop of one iteration and fresh for the next', async () => {
    const provider = new MockProvider([toolTurn({ id: 'u1', name: 'echo' }), done]);
    const { agent } = await buildAgent(provider, [tool('echo')], { yolo: true });
    const seen: Array<{ hop: number; id: string | undefined }> = [];
    agent.extensions.register({
      name: 'double-hop',
      // Stand-in for the fallback extension: every iteration makes a first
      // attempt (discarded) and a second hop, both through the same runner.
      wrapProviderRunner: async (ctx, request, inner) => {
        const probe = new MockProvider([{ ...done }]);
        const first = ctx.provider;
        ctx.provider = probe as never;
        await inner(ctx, request);
        seen.push({ hop: 1, id: ctx.activeLogicalRequestId });
        ctx.provider = first;
        const res = await inner(ctx, request);
        seen.push({ hop: 2, id: ctx.activeLogicalRequestId });
        return res;
      },
    });

    await agent.run('go');

    expect(seen).toHaveLength(4);
    const [a1, a2, b1, b2] = seen;
    expect(a1?.id).toBeDefined();
    expect(a2?.id).toBe(a1?.id);
    expect(b2?.id).toBe(b1?.id);
    expect(b1?.id).not.toBe(a1?.id);
  });
});
