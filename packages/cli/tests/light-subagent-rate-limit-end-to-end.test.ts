/**
 * End-to-end regression test: a 429 from a webui-server SDD parallel-run
 * subagent (produced via `makeLightSubagentFactory`) flows through to
 * the shared `ProviderModelStatusTracker` and the `/provider-status`
 * slash command shows the quarantined pair.
 *
 * Closes the contract gap recorded in SAGE memory `01KYSCC8A49TS9ENCVCS2J3WJ8`:
 * the runtime container binds a default `ProviderModelStatusTracker`,
 * `makeLightSubagentFactory` accepts and threads `statusTracker`, and the
 * webui-server call site in `backend-services.ts` resolves the token and
 * forwards it. Without all three links, a 429 from a subagent silently
 * no-ops the waiting-room trigger.
 *
 * This test exercises the production factory end-to-end:
 *  1. Build a real `ProviderModelStatusTracker` and pass it to
 *     `makeLightSubagentFactory` (matching the webui-server call shape).
 *  2. Drive the agent loop's composed provider runner via
 *     `agent.extensions.wrapProviderRunner(inner)` with a 429 inner.
 *  3. Build the `/provider-status` slash command against the same
 *     tracker and assert the `waiting` view lists the pair.
 *
 * Earlier unit tests in `packages/runtime/tests/light-subagent-factory-status-tracker.test.ts`
 * and `packages/core/tests/core/fallback-model-status-tracker.test.ts`
 * prove the wiring at the dep level. This test proves the wiring at the
 * end-user-visible surface (the slash command render).
 */
import { describe, expect, it } from 'vitest';
import { Container, TOKENS } from '@wrongstack/core/kernel';
import { FallbackProfileManager } from '@wrongstack/core/agent';
import { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { DefaultSecretScrubber } from '@wrongstack/core/security';
import { DefaultConfigStore } from '@wrongstack/core/storage';
import { makeLightSubagentFactory } from '@wrongstack/runtime';
import type {
  Config,
  ModelsRegistry,
  Provider,
  ProviderErrorBody,
  Request,
  Response,
  SessionWriter,
  Tool,
} from '@wrongstack/core/types';
import { ProviderError } from '@wrongstack/core/types';
import { buildProviderStatusCommand } from '../src/slash-commands/provider-status.js';

const reasoningCaps = {
  default: 'enabled',
  disableSupported: true,
  effortSupported: true,
  effortLevels: ['low', 'medium', 'high'],
  preserveThinking: 'optional',
} as const;

const okResponse: Response = {
  content: [{ type: 'text', text: 'ok' }],
  stopReason: 'end_turn',
  usage: { input: 0, output: 0 },
  model: 'backup-model',
};

function rateLimitProvider(id: string): Provider {
  let firstCall = true;
  return {
    id,
    capabilities: {
      streaming: false,
      tools: true,
      vision: false,
      reasoning: false,
      parallelTools: false,
      promptCache: false,
      systemPrompt: true,
      jsonMode: false,
      cacheControl: 'none',
      maxContext: 0,
      maxOutput: 0,
    },
    async complete(_req: Request, _opts: { signal: AbortSignal }): Promise<Response> {
      if (firstCall) {
        firstCall = false;
        const body: ProviderErrorBody = { type: 'error', message: 'rate limited' };
        throw new ProviderError('rate limited', 429, true, id, {
          kind: 'rate_limit',
          body,
        });
      }
      return { ...okResponse, model: id };
    },
    async *stream(_req: Request, _opts: { signal: AbortSignal }) {
      yield { type: 'message_stop', stopReason: 'end_turn', usage: { input: 0, output: 0 } };
    },
  };
}

function okProvider(id: string): Provider {
  return {
    id,
    capabilities: {
      streaming: false,
      tools: true,
      vision: false,
      reasoning: false,
      parallelTools: false,
      promptCache: false,
      systemPrompt: true,
      jsonMode: false,
      cacheControl: 'none',
      maxContext: 0,
      maxOutput: 0,
    },
    async complete(_req: Request, _opts: { signal: AbortSignal }): Promise<Response> {
      return { ...okResponse, model: id };
    },
    async *stream(_req: Request, _opts: { signal: AbortSignal }) {
      yield { type: 'message_stop', stopReason: 'end_turn', usage: { input: 0, output: 0 } };
    },
  };
}

const readTool: Tool = {
  name: 'read',
  description: 'read',
  inputSchema: { type: 'object', properties: {} },
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  async execute() {
    return 'ok';
  },
};

function sessionShim(): SessionWriter {
  return {
    id: 'parent',
    transcriptPath: '/tmp/parent.jsonl',
    traceId: 'parent-trace',
    get pendingToolUses() {
      return [];
    },
    append: async () => {},
    appendBatch: async () => {},
    flush: async () => {},
    close: async () => {},
    recordFileChange: () => {},
    recordSideEffect: () => {},
    writeCheckpoint: async () => {},
    writeFileSnapshot: async () => {},
    truncateToCheckpoint: async () => 0,
    clearSession: async () => {},
    writeInFlightMarker: async () => {},
    clearInFlightMarker: async () => {},
  } satisfies SessionWriter;
}

interface Deps {
  container: Container;
  providerRegistry: ProviderRegistry;
  toolRegistry: ToolRegistry;
  session: SessionWriter;
  projectRoot: string;
  modelsRegistry: ModelsRegistry;
}

function makeDeps(statusTracker: ProviderModelStatusTracker): Deps {
  const config = {
    version: 1,
    provider: 'primary',
    model: 'primary-model',
    fallbackModels: ['backup/backup-model'],
    providers: {
      primary: { type: 'primary' },
      backup: { type: 'backup' },
    },
    features: {},
    tools: {},
  } as never as Config;

  const container = new Container();
  container.bind(TOKENS.Logger, () => stubLogger());
  container.bind(TOKENS.ConfigStore, () => new DefaultConfigStore(config));
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => ({
    account: () => undefined,
    currentRequestTokens: () => ({ input: 0, cacheRead: 0, cacheWrite: 0 }),
    setCurrentRequestTokens: () => {},
    count: () => 0,
    countMessages: () => 0,
    add: () => {},
    total: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    estimateCost: () => ({ input: 0, output: 0, total: 0, currency: 'USD' }),
    cacheStats: () => ({ readTokens: 0, writeTokens: 0, hitRatio: 0, savedUsd: 0 }),
    reset: () => {},
  }));
  container.bind(TOKENS.SystemPromptBuilder, () => ({
    build: async () => [{ type: 'text', text: 'system' }],
  }));
  container.bind(TOKENS.FallbackProfileManager, () => new FallbackProfileManager(config));
  // The webui-server call site uses `container.safeResolve(TOKENS.ProviderModelStatusTracker)`;
  // mirror the same shape here so the test exercises the contract.
  container.bind(TOKENS.ProviderModelStatusTracker, () => statusTracker);

  const providerRegistry = new ProviderRegistry();
  for (const id of ['primary', 'backup']) {
    providerRegistry.register({
      type: id,
      family: 'unsupported',
      create: () => (id === 'primary' ? rateLimitProvider(id) : okProvider(id)),
    });
  }

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(readTool);

  return {
    container,
    providerRegistry,
    toolRegistry,
    session: sessionShim(),
    projectRoot: '/proj',
    modelsRegistry: {
      load: async () => ({}),
      refresh: async () => ({}),
      listProviders: async () => [],
      getProvider: async () => undefined,
      getModel: async () => ({
        capabilities: { reasoningConfig: reasoningCaps, tools: true, vision: false, reasoning: false, maxContext: 0 },
      }),
      suggestModel: async () => undefined,
      ageSeconds: async () => Infinity,
    } as unknown as ModelsRegistry,
  };
}

function stubLogger(): unknown {
  const l: Record<string, unknown> = {};
  for (const m of ['debug', 'info', 'warn', 'error', 'trace', 'fatal']) l[m] = () => {};
  l.child = () => l;
  return l;
}

describe('makeLightSubagentFactory — end-to-end 429 → /provider-status waiting room', () => {
  it('a subagent 429 flows through the production factory into the shared tracker and shows in /provider-status waiting', async () => {
    // 1. Stand up the shared tracker and pass it to the factory, exactly
    //    as the webui-server call site does:
    //      statusTracker: container.safeResolve(TOKENS.ProviderModelStatusTracker)
    const tracker = new ProviderModelStatusTracker();
    const deps = makeDeps(tracker);
    // The webui-server call site forwards the resolved tracker via the
    // statusTracker dep, not via the container binding. The factory
    // accepts both: container.safeResolve is the shortcut, but the
    // dep is the explicit contract. Test the explicit path here.
    const factory = makeLightSubagentFactory({
      ...deps,
      statusTracker: tracker,
    });
    const result = await factory({ name: 'sdd-worker-1', id: 'sdd-worker-1', role: 'sdd' });
    expect(result.agent).toBeDefined();
    expect(result.agent.extensions.has('fallback-model')).toBe(true);

    // 2. Drive the production agent loop's provider runner chain via
    //    `agent.extensions.wrapProviderRunner(inner)`. This is the same
    //    hook the runtime agent loop calls per provider invocation — it
    //    composes the registered extension hooks (including
    //    `fallback-model`) into a middleware chain.
    const inner = async (c: unknown): Promise<Response> => {
      const innerCtx = c as { provider: { id: string } };
      // First call (primary): 429. Subsequent calls (backup): ok.
      if (innerCtx.provider.id === 'primary') {
        throw new ProviderError('rate limited', 429, true, 'primary', {
          kind: 'rate_limit',
        });
      }
      return { ...okResponse, model: innerCtx.provider.id };
    };
    const composed = result.agent.extensions.wrapProviderRunner(inner);

    const ctx = {
      provider: rateLimitProvider('primary'),
      model: 'primary-model',
      session: result.agent.ctx.session,
      agentId: result.agent.ctx.agentId,
    } as never;
    const request = {
      model: 'primary-model',
      messages: [],
      maxTokens: 100,
    } as never as Request;

    const response = await composed(ctx, request);
    expect(response).toBeDefined();

    // 3. The shared tracker MUST have observed the failure and quarantined
    //    the (provider, model) pair. This is the same singleton the leader
    //    reads from via `/provider-status`.
    const blocked = tracker.getBlocked();
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.providerId).toBe('primary');
    expect(blocked[0]?.model).toBe('primary-model');
    expect(blocked[0]?.lastErrorKind).toBe('rate_limit');

    // 4. Build the user-facing `/provider-status` slash command against
    //    the same tracker and run the `waiting` view. The blade is the
    //    same code the leader + webui-server execute when the user types
    //    `/provider-status waiting` — verifying it shows the pair closes
    //    the loop end-to-end.
    const cmd = buildProviderStatusCommand(tracker);
    const view = await cmd.run('waiting');
    if (!view) throw new Error('/provider-status waiting returned no view');
    expect(typeof view.message).toBe('string');
    expect(view.message).toContain('primary/primary-model');
    expect(view.message).toContain('blocked');
    expect(view.message).toContain('1 rate-limited');
  });

  it('omitting statusTracker keeps the factory working (backward compatibility)', async () => {
    // Defensive: the factory must still build when no tracker is provided.
    // The tracker-less path leaves the waiting-room trigger un-wired but
    // does not break the agent; this matches the CLI factory's
    // `...(host.opts.statusTracker ? { statusTracker } : {})` pattern.
    const deps = makeDeps(new ProviderModelStatusTracker());
    const factory = makeLightSubagentFactory(deps);
    const result = await factory({ name: 'sdd-worker-2', id: 'sdd-worker-2' });
    expect(result.agent).toBeDefined();
    expect(result.agent.extensions.has('fallback-model')).toBe(true);
  });

  it('container.safeResolve(TOKENS.ProviderModelStatusTracker) returns the same instance the factory sees', async () => {
    // Mirror the webui-server call shape exactly:
    //   subagentFactory: makeLightSubagentFactory({
    //     container, providerRegistry, toolRegistry, session, projectRoot,
    //     statusTracker: container.safeResolve(TOKENS.ProviderModelStatusTracker),
    //   })
    const tracker = new ProviderModelStatusTracker();
    const deps = makeDeps(tracker);
    const resolved = deps.container.safeResolve(TOKENS.ProviderModelStatusTracker);
    expect(resolved).toBe(tracker);

    const factory = makeLightSubagentFactory({
      ...deps,
      statusTracker: resolved,
    });
    const result = await factory({ name: 'sdd-worker-3', id: 'sdd-worker-3' });
    expect(result.agent).toBeDefined();
    expect(result.agent.extensions.has('fallback-model')).toBe(true);
  });
});
