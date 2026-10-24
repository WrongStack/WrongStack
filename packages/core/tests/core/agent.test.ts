import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Container } from '@wrongstack/contracts/kernel/container';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import { type AgentError, isAgentError } from '@wrongstack/contracts/types/errors';
import type {
  Capabilities,
  Provider,
  Request,
  Response,
  StreamEvent,
} from '@wrongstack/contracts/types/provider';
import { ProviderError } from '@wrongstack/contracts/types/provider';
import type { BuildContext } from '@wrongstack/contracts/types/system-prompt';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toolSearchTool } from '../../../tools/src/tool-search.js';
import { toolUseTool } from '../../../tools/src/tool-use.js';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { Context } from '../../src/core/context.js';
import { DefaultErrorHandler } from '../../src/execution/error-handler.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { ExtensionRegistry } from '../../src/extension/registry.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import { MockProvider, StreamingMockProvider } from '../helpers/mock-provider.js';

import { removeProjectFixtureDirectory } from '../helpers/project-server-harness.js';

// Every session writer holds a JSONL FileHandle. Tests that never close their
// session leave it for GC, which Node now reports as an uncaught
// ERR_INVALID_STATE attributed to whichever test happens to be running.
const openSessions = new Set<{ close(): Promise<void> }>();

async function closeOpenSessions(): Promise<void> {
  const sessions = [...openSessions];
  openSessions.clear();
  await Promise.allSettled(sessions.map((s) => s.close()));
}

async function cleanupTestDirs(dirs: readonly string[]): Promise<void> {
  await closeOpenSessions();
  for (const d of dirs) {
    await removeProjectFixtureDirectory(d, { maxRetries: 10, retryDelay: 50 });
  }
}

async function buildAgent(
  provider: MockProvider,
  extraTools: Tool[] = [],
  extensions?: ExtensionRegistry,
  options?: {
    refreshSystemPrompt?: boolean;
    systemPromptBuild?: (
      ctx: import('@wrongstack/contracts/types/system-prompt').BuildContext,
    ) => Promise<import('@wrongstack/contracts/types/blocks').TextBlock[]>;
  },
) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-ag-'));
  const trustFile = path.join(tmp, 'trust.json');
  const sessionDir = path.join(tmp, 'sessions');

  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error', stderr: false }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
  container.bind(
    TOKENS.PermissionPolicy,
    () => new DefaultPermissionPolicy({ trustFile, yolo: true }),
  );
  if (options?.systemPromptBuild) {
    container.bind(TOKENS.SystemPromptBuilder, () => ({ build: options.systemPromptBuild! }));
  }

  const tools = new ToolRegistry();
  for (const t of extraTools) tools.register(t);
  const providers = new ProviderRegistry();
  const events = new EventBus();
  const pipelines = createDefaultPipelines();

  const sessionStore = new DefaultSessionStore({ dir: sessionDir });
  const create = sessionStore.create.bind(sessionStore);
  sessionStore.create = async (...args) => {
    const created = await create(...args);
    openSessions.add(created);
    return created;
  };
  const session = await sessionStore.create({ id: '', model: 'test', provider: 'mock' });

  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'You are a test agent.' }],
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter: container.resolve(TOKENS.TokenCounter),
    cwd: tmp,
    projectRoot: tmp,
    model: 'test-model',
  });

  const secretScrubber = container.resolve(TOKENS.SecretScrubber);
  const toolExecutor = new ToolExecutor(tools, {
    permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
    secretScrubber,
    events,
    confirmAwaiter: undefined,
    iterationTimeoutMs: 300_000,
    perIterationOutputCapBytes: 100_000,
    tracer: undefined,
  });

  const agent = new Agent({
    container,
    tools,
    providers,
    events,
    pipelines,
    context: ctx,
    maxIterations: 10,
    toolExecutor,
    extensions,
    refreshSystemPrompt: options?.refreshSystemPrompt,
  });
  return { agent, ctx, tools, tmp, sessionStore };
}

describe('Agent', () => {
  let cleanupDirs: string[] = [];
  beforeEach(() => {
    cleanupDirs = [];
  });
  afterEach(async () => {
    await cleanupTestDirs(cleanupDirs);
  });

  it('legacy contract: returns done on plain end_turn response', async () => {
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'hi' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider);
    cleanupDirs.push(tmp);
    const result = await agent.run('hello');
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('hi');
    expect(provider.calls).toBe(1);
  });

  it('refreshes the host prompt from direct and catalog tool surfaces before a run', async () => {
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const build = vi.fn(async () => [{ type: 'text' as const, text: 'refreshed' }]);
    const { agent, tools, ctx, tmp } = await buildAgent(
      provider,
      [
        {
          name: 'read',
          description: 'read',
          inputSchema: { type: 'object', properties: {} },
          permission: 'auto',
          mutating: false,
          async execute() {
            return 'ok';
          },
        },
        {
          name: 'rare',
          description: 'rare',
          inputSchema: { type: 'object', properties: {} },
          permission: 'auto',
          mutating: false,
          async execute() {
            return 'ok';
          },
        },
      ],
      undefined,
      { refreshSystemPrompt: true, systemPromptBuild: build },
    );
    cleanupDirs.push(tmp);
    tools.setProviderToolNames(['read']);

    await agent.run('hello');

    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [expect.objectContaining({ name: 'read' })],
        catalogTools: [
          expect.objectContaining({ name: 'read' }),
          expect.objectContaining({ name: 'rare' }),
        ],
      }),
    );
    expect(ctx.systemPrompt).toEqual([{ type: 'text', text: 'refreshed' }]);
  });

  it('sends a Scout conversation its own small surface, not the tier surface', async () => {
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const build = vi.fn(async () => [{ type: 'text' as const, text: 'refreshed' }]);
    const tool = (name: string): Tool => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'ok';
      },
    });
    const { agent, tools, ctx, tmp } = await buildAgent(
      provider,
      ['read', 'bash', 'codebase-search', 'tool_search', 'tool_use'].map(tool),
      undefined,
      { refreshSystemPrompt: true, systemPromptBuild: build },
    );
    cleanupDirs.push(tmp);
    // A tier surface that withholds the shell — Scout must not depend on it.
    tools.setProviderToolNames(['read', 'codebase-search', 'tool_search', 'tool_use']);
    ctx.meta['systemPromptVariant'] = 'scout';

    await agent.run('hello');

    const scoutSurface = ['read', 'bash', 'tool_search', 'tool_use'];
    expect(provider.receivedRequests[0]?.tools?.map((t) => t.name)).toEqual(scoutSurface);
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        systemVariant: 'scout',
        tools: scoutSurface.map((name) => expect.objectContaining({ name })),
      }),
    );
    // The withheld catalog stays reachable through the lazy gateways.
    expect(ctx.catalogTools.map((t) => t.name)).toContain('codebase-search');
  });

  it('keeps delegation off a solo Scout conversation request', async () => {
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const tool = (name: string): Tool => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'ok';
      },
    });
    const { agent, ctx, tmp } = await buildAgent(provider, ['read', 'delegate'].map(tool));
    cleanupDirs.push(tmp);
    ctx.meta['systemPromptVariant'] = 'scout';
    ctx.meta['subagentsAllowed'] = false;

    await agent.run('hello');

    expect(provider.receivedRequests[0]?.tools?.map((t) => t.name)).toEqual(['read']);
    expect(ctx.tools.map((t) => t.name)).toEqual(['read']);
  });

  it('renders the provider-selected surface and refreshes it after a cap change', async () => {
    let capped = true;
    const limited: Tool[] = [];
    const provider = Object.assign(
      new MockProvider([
        {
          content: [{ type: 'tool_use', id: 'uncap', name: 'uncap', input: {} }],
          stopReason: 'tool_use',
        },
        { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
      ]),
      { selectToolsForRequest: (tools: Tool[]) => (capped ? limited : tools) },
    );
    const make = (name: string): Tool => ({
      name,
      description: name,
      permission: 'auto',
      mutating: false,
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        capped = false;
        return 'uncapped';
      },
    });
    const uncap = make('uncap');
    const hidden = make('hidden');
    limited.push(uncap);
    const build = vi.fn(async (input: BuildContext) => [
      {
        type: 'text' as const,
        text: `DIRECT:${input.tools.map((t) => t.name).join(',')}`,
      },
    ]);
    const { agent, tmp, ctx } = await buildAgent(provider, [uncap, hidden], undefined, {
      refreshSystemPrompt: true,
      systemPromptBuild: build,
    });
    cleanupDirs.push(tmp);
    expect((await agent.run('uncap')).status).toBe('done');
    const [before, after] = provider.receivedRequests;
    expect(before?.tools?.map((t) => t.name)).toEqual(['uncap']);
    expect(before?.system?.map((b) => b.text).join('\n')).toContain('DIRECT:uncap');
    expect(before?.system?.map((b) => b.text).join('\n')).not.toContain('hidden');
    expect(after?.tools?.map((t) => t.name)).toEqual(['uncap', 'hidden']);
    expect(after?.system?.map((b) => b.text).join('\n')).toContain('DIRECT:uncap,hidden');
    expect(build).toHaveBeenCalledTimes(2);
    expect(ctx.catalogTools.map((t) => t.name)).toContain('hidden');
  });

  it('discovers and invokes an MCP-style tool registered during the same run', async () => {
    let registerLate = () => {};
    const late: Tool = {
      name: 'mcp__regression__late',
      description: 'late',
      permission: 'auto',
      mutating: false,
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return 'LATE_RESULT';
      },
    };
    const connect: Tool = {
      ...late,
      name: 'connect',
      async execute() {
        registerLate();
        return 'connected';
      },
    };
    const provider = new MockProvider([
      {
        content: [
          { type: 'tool_use', id: 'connect', name: 'connect', input: {} },
          { type: 'tool_use', id: 'search', name: 'tool_search', input: { query: late.name } },
        ],
        stopReason: 'tool_use',
      },
      {
        content: [
          { type: 'tool_use', id: 'use', name: 'tool_use', input: { tool: late.name, input: {} } },
        ],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const { agent, tools, ctx, tmp } = await buildAgent(provider, [
      connect,
      toolSearchTool,
      toolUseTool,
    ]);
    cleanupDirs.push(tmp);
    tools.setProviderToolNames(['connect', 'tool_search', 'tool_use']);
    registerLate = () => tools.register(late);
    expect((await agent.run('connect and use', { executionStrategy: 'sequential' })).status).toBe(
      'done',
    );
    const results = ctx.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === 'tool_result');
    expect(results.find((b) => b.tool_use_id === 'search')?.content).toContain(late.name);
    expect(results.find((b) => b.tool_use_id === 'use')?.is_error).toBe(false);
    expect(results.find((b) => b.tool_use_id === 'use')?.content).toContain('LATE_RESULT');
  });

  it('pins the starting session before asynchronous beforeRun hooks', async () => {
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const extensions = new ExtensionRegistry();
    let observedSessionId: string | undefined;
    extensions.register({
      name: 'observe-pinned-session',
      beforeRun: async (ctx) => {
        await Promise.resolve();
        observedSessionId = ctx.eventSessionId();
      },
    });
    const { agent, ctx, tmp } = await buildAgent(provider, [], extensions);
    cleanupDirs.push(tmp);
    const startingSessionId = ctx.session.id;

    await agent.run('observe pin');

    expect(observedSessionId).toBe(startingSessionId);
    expect(ctx.activeRunSessionId).toBeUndefined();
    expect(ctx.activeRunSessionWriter).toBeUndefined();
  });

  it('keeps the run guard and session pins through asynchronous cleanup', async () => {
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, ctx, tmp } = await buildAgent(provider);
    cleanupDirs.push(tmp);
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupStarted!: () => void;
    const cleanupStartedGate = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const pinnedWriter = ctx.session;
    ctx.registerAbortHook(async () => {
      cleanupStarted();
      await cleanupGate;
    });

    const running = agent.run('cleanup pin');
    await cleanupStartedGate;

    expect(ctx.activeRunSessionId).toBe(pinnedWriter.id);
    expect(ctx.activeRunSessionWriter).toBe(pinnedWriter);
    await expect(agent.run('must stay guarded')).rejects.toThrow(/already in progress/);

    releaseCleanup();
    await running;
    expect(ctx.activeRunSessionId).toBeUndefined();
    expect(ctx.activeRunSessionWriter).toBeUndefined();
  });

  it.each(['before-run', 'response', 'abort'] as const)(
    'keeps journal writes and recovery markers on the starting session after a %s switch',
    async (phase) => {
      const provider = new MockProvider([
        { content: [{ type: 'text', text: 'original reply' }], stopReason: 'end_turn' },
      ]);
      const extensions = new ExtensionRegistry();
      const { agent, ctx, tmp, sessionStore } = await buildAgent(provider, [], extensions);
      cleanupDirs.push(tmp);
      const starting = ctx.session;
      const replacement = await sessionStore.create({ id: '', model: 'test', provider: 'mock' });
      const startingAppend = vi.spyOn(starting, 'append');
      const startingCheckpoint = vi.spyOn(starting, 'writeCheckpoint');
      const startingMarker = vi.spyOn(starting, 'writeInFlightMarker');
      const startingClear = vi.spyOn(starting, 'clearInFlightMarker');
      const replacementWrites = [
        vi.spyOn(replacement, 'append'),
        vi.spyOn(replacement, 'writeCheckpoint'),
        vi.spyOn(replacement, 'writeInFlightMarker'),
        vi.spyOn(replacement, 'clearInFlightMarker'),
        vi.spyOn(replacement, 'flush'),
      ];
      const controller = new AbortController();
      const switchSession = async () => {
        await Promise.resolve();
        ctx.session = replacement;
      };
      if (phase === 'before-run') {
        extensions.register({ name: 'switch-session', beforeRun: switchSession });
      } else if (phase === 'response') {
        agent.pipelines.response.use({
          name: 'switch-session',
          async handler(response: Response) {
            await switchSession();
            return response;
          },
        });
      } else {
        vi.spyOn(provider, 'complete').mockImplementationOnce(async () => {
          await switchSession();
          controller.abort('session switched');
          throw new DOMException('session switched', 'AbortError');
        });
      }
      try {
        const result = await agent.run('original input', { signal: controller.signal });
        expect(result.status).toBe(phase === 'abort' ? 'aborted' : 'done');
        for (const write of replacementWrites) expect.soft(write).not.toHaveBeenCalled();
        expect(startingAppend).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'user_input' }),
        );
        expect(startingAppend).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'llm_request' }),
        );
        if (phase !== 'abort') {
          expect(startingAppend).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'llm_response' }),
          );
        }
        expect(startingCheckpoint).toHaveBeenCalledWith(0, 'original input');
        expect(startingMarker).toHaveBeenCalled();
        expect(startingClear).toHaveBeenCalledWith(phase === 'abort' ? 'aborted' : 'clean');
        expect(ctx.session).toBe(replacement);
        expect(ctx.activeRunSessionWriter).toBeUndefined();
        // Once the run ends, ordinary state changes belong to the new session.
        ctx.state.appendMessage({
          role: 'user',
          content: [{ type: 'text', text: 'next session' }],
        });
        await ctx.flushConversationJournal();
        expect(replacementWrites[0]).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'message_appended',
            message: expect.objectContaining({ content: [{ type: 'text', text: 'next session' }] }),
          }),
        );
      } finally {
        await Promise.all([starting.close(), replacement.close()]);
      }
    },
  );

  it('starts an automatic follow-up on the model transition that was already requested', async () => {
    const previousProvider = new MockProvider([
      { content: [{ type: 'text', text: 'old' }], stopReason: 'end_turn' },
    ]);
    const nextProvider = new MockProvider([
      { content: [{ type: 'text', text: 'new' }], stopReason: 'end_turn' },
    ]);
    const { agent, ctx, tmp } = await buildAgent(previousProvider);
    cleanupDirs.push(tmp);
    let releaseSwitch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSwitch = resolve;
    });
    const switching = ctx.runModelTransition(async () => {
      await gate;
      ctx.provider = nextProvider;
      ctx.model = 'new-model';
    });

    const running = agent.run('automatic follow-up');
    await Promise.resolve();
    expect(previousProvider.calls).toBe(0);
    expect(nextProvider.calls).toBe(0);

    releaseSwitch();
    await switching;
    const result = await running;

    expect(result.finalText).toBe('new');
    expect(previousProvider.calls).toBe(0);
    expect(nextProvider.calls).toBe(1);
  });

  it('flushes reconstruct and lifecycle boundaries before run resolves', async () => {
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'durable reply' }], stopReason: 'end_turn' },
    ]);
    const { agent, ctx, tmp, sessionStore } = await buildAgent(provider);
    cleanupDirs.push(tmp);

    await agent.run('durable prompt');

    // The writer remains open (matching the REPL between turns), so this read
    // proves the agent awaited boundary flushes rather than relying on close().
    const data = await sessionStore.load(ctx.session.id);
    expect(data.events.map((event) => event.type)).toEqual([
      'session_start',
      'user_input',
      'message_appended',
      'checkpoint',
      'in_flight_start',
      'llm_request',
      'llm_response',
      'message_appended',
      'in_flight_end',
    ]);
    await ctx.session.close();
  });

  it('syncs ctx.tools from the registry on run (tool_search sees the catalog)', async () => {
    const echo: Tool = {
      name: 'echo',
      description: 'echo input',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    };
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, ctx, tools, tmp } = await buildAgent(provider, [echo]);
    cleanupDirs.push(tmp);
    // The Context is constructed without a tools list (mirrors setupSession),
    // so the convenience mirror tool_search reads starts empty.
    expect(ctx.tools).toEqual([]);
    // A tool registered after Context construction but before the run — the
    // MCP / plugin / fleet timing that left ctx.tools empty in the field.
    const late: Tool = {
      name: 'late',
      description: 'registered after context build',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    };
    tools.register(late);
    await agent.run('hi');
    // run() refreshes the mirror from the agent's own registry, so both the
    // boot-time and the late-registered tool are now discoverable.
    expect(ctx.tools.map((t) => t.name).sort()).toEqual(['echo', 'late']);
  });

  it('repairs broken tool-call adjacency before provider requests', async () => {
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'recovered' }], stopReason: 'end_turn' },
    ]);
    const requestSnapshots: Request['messages'][] = [];
    const complete = provider.complete.bind(provider);
    provider.complete = async (req, opts) => {
      requestSnapshots.push(JSON.parse(JSON.stringify(req.messages)));
      return complete(req, opts);
    };
    const { agent, ctx, tmp } = await buildAgent(provider);
    cleanupDirs.push(tmp);
    ctx.state.replaceMessages([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'dangling', name: 'read', input: {} }],
      },
      { role: 'assistant', content: 'still useful' },
    ]);

    const repairs: Array<{ removedToolUses: string[]; removedMessages: number }> = [];
    (agent as never as { events: EventBus }).events.on('context.repaired', (e) => {
      repairs.push({
        removedToolUses: e.removedToolUses,
        removedMessages: e.removedMessages,
      });
    });

    const result = await agent.run('continue');

    expect(result.status).toBe('done');
    expect(repairs).toEqual([{ removedToolUses: ['dangling'], removedMessages: 1 }]);
    expect(JSON.stringify(requestSnapshots[0])).not.toContain('tool_use');
    // Messages carry the internal `_estTokens` annotation (stripped by the
    // provider adapters' normalizeMessage before hitting the wire) — match
    // the semantic shape, not exact object identity. The trailing user
    // message additionally carries the appended live-context tail and the
    // deep cache boundary on its first (durable) block.
    expect(requestSnapshots[0]).toHaveLength(2);
    expect(requestSnapshots[0]![0]).toEqual(
      expect.objectContaining({ role: 'assistant', content: 'still useful' }),
    );
    const lastSent = requestSnapshots[0]![1] as {
      role: string;
      content: Array<{ type: string; text?: string }>;
    };
    expect(lastSent.role).toBe('user');
    expect(lastSent.content[0]).toMatchObject({ type: 'text', text: 'continue' });
  });

  it('executes tool use and continues', async () => {
    const echo: Tool = {
      name: 'echo',
      description: 'echo input',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        return (input as { text: string }).text;
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'echo', input: { text: 'pong' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [echo]);
    cleanupDirs.push(tmp);
    const result = await agent.run('ping');
    expect(result.status).toBe('done');
    expect(provider.calls).toBe(2);
  });

  it('reconciles an open todo before accepting a turn-ending response', async () => {
    let ctxRef: Context | undefined;
    const todo: Tool = {
      name: 'todo',
      description: 'replace todos',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        const todos = (input as { todos: Context['todos'] }).todos;
        ctxRef?.state.replaceTodos(todos);
        return { count: todos.length };
      },
    };
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'The work is complete.' }], stopReason: 'end_turn' },
      {
        content: [
          {
            type: 'tool_use',
            id: 'todo-1',
            name: 'todo',
            input: {
              todos: [{ id: 'fix', content: 'Fix lifecycle', status: 'completed' }],
            },
          },
        ],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'Done and reconciled.' }], stopReason: 'end_turn' },
    ]);
    const { agent, ctx, tmp } = await buildAgent(provider, [todo]);
    ctxRef = ctx;
    ctx.agentId = 'leader';
    cleanupDirs.push(tmp);
    ctx.state.replaceTodos([{ id: 'fix', content: 'Fix lifecycle', status: 'in_progress' }]);

    const result = await agent.run('finish the tracked work');

    expect(result.status).toBe('done');
    expect(result.finalText).toBe('Done and reconciled.');
    expect(provider.calls).toBe(3);
    expect(ctx.todos).toEqual([]);
    const secondRequest = provider.receivedRequests[1];
    expect(JSON.stringify(secondRequest?.messages)).toContain('[todo-reconciliation]');
  });

  it('never sends a tool_confirm_pending block to the provider after a confirm', async () => {
    // Regression: a confirmed tool returns `tool_confirm_pending` from the
    // executor (no confirmAwaiter). The agent resolves it via the
    // `tool.confirm_needed` event and re-runs the tool — but the message
    // appended to context must carry the RESOLVED tool_result, never the
    // pending sentinel (which the Anthropic API rejects with a 400:
    // "unsupported content type 'tool_confirm_pending'").
    const danger: Tool = {
      name: 'danger',
      description: 'a destructive op that must be confirmed',
      inputSchema: { type: 'object' },
      permission: 'confirm',
      // Destructive → still confirms under regular --yolo, which is exactly
      // the path that produces a pending result.
      riskTier: 'destructive',
      mutating: true,
      async execute() {
        return 'did the thing';
      },
    } as Tool;
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'danger', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const requestSnapshots: Request['messages'][] = [];
    const complete = provider.complete.bind(provider);
    provider.complete = async (req, opts) => {
      requestSnapshots.push(JSON.parse(JSON.stringify(req.messages)));
      return complete(req, opts);
    };
    const { agent, tmp } = await buildAgent(provider, [danger]);
    cleanupDirs.push(tmp);
    const mutationFlags: boolean[] = [];
    (agent as never as { events: EventBus }).events.on('tool.executed', (event) => {
      mutationFlags.push(event.mutating === true);
    });
    // Approve the confirmation the moment the agent asks.
    (agent as never as { events: EventBus }).events.on(
      'tool.confirm_needed',
      (e: { resolve: (d: 'yes' | 'no' | 'always' | 'deny') => void }) => e.resolve('yes'),
    );

    const result = await agent.run('do it');
    expect(result.status).toBe('done');
    expect(provider.calls).toBe(2);
    // The pending sentinel must never reach the wire.
    expect(JSON.stringify(requestSnapshots)).not.toContain('tool_confirm_pending');
    // The resolved tool_result must be present in the follow-up request.
    expect(JSON.stringify(requestSnapshots[1])).toContain('did the thing');
    expect(mutationFlags).toEqual([true]);
  });

  it('handles unknown tool with error result', async () => {
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'nope', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'recovered' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider);
    cleanupDirs.push(tmp);
    const result = await agent.run('try');
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('recovered');
  });

  it('respects max iterations', async () => {
    const script = Array.from({ length: 20 }, () => ({
      content: [{ type: 'tool_use' as const, id: 'u', name: 'echo', input: {} }],
      stopReason: 'tool_use' as const,
    }));
    const echo: Tool = {
      name: 'echo',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    };
    const provider = new MockProvider(script);
    const { agent, tmp } = await buildAgent(provider, [echo]);
    cleanupDirs.push(tmp);
    // Deny any limit extension so the test ends promptly.
    agent.events.on('iteration.limit_reached', ({ deny }) => deny());
    const result = await agent.run('loop', { maxIterations: 3 });
    expect(result.status).toBe('max_iterations');
  });

  it('does not auto-extend an iteration cap without an explicit host policy', async () => {
    const echo: Tool = {
      name: 'echo',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    };
    const provider = new MockProvider(
      Array.from({ length: 4 }, (_, i) => ({
        content: [{ type: 'tool_use' as const, id: `u-${i}`, name: 'echo', input: {} }],
        stopReason: 'tool_use' as const,
      })),
    );
    const { agent, tmp } = await buildAgent(provider, [echo]);
    cleanupDirs.push(tmp);

    const result = await agent.run('loop', { maxIterations: 2 });

    expect(result.status).toBe('max_iterations');
    expect(provider.calls).toBe(2);
  });

  it('aborts cleanly on signal', async () => {
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider);
    cleanupDirs.push(tmp);
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await agent.run('hi', { signal: ctrl.signal });
    expect(result.status).toBe('aborted');
  });

  it('aborts cleanly when signal is triggered during tool execution and attaches error', async () => {
    const ctrl = new AbortController();
    const abortingTool: Tool = {
      name: 'long_task',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute(_input, _ctx, _options) {
        ctrl.abort(new Error('user interrupted tool'));
        // If tool throws when aborted or signal triggers abort
        const err = new Error('tool aborted by signal');
        (err as unknown as { code: string }).code = 'AGENT_ABORTED';
        throw err;
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u-abort', name: 'long_task', input: {} }],
        stopReason: 'tool_use',
      },
    ]);
    const { agent, tmp } = await buildAgent(provider, [abortingTool]);
    cleanupDirs.push(tmp);

    const errorEvents: Array<{ phase: string; err: Error }> = [];
    agent.events.on('error', (e) => errorEvents.push(e as { phase: string; err: Error }));

    const result = await agent.run('start', { signal: ctrl.signal });
    expect(result.status).toBe('aborted');
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('AGENT_ABORTED');
    expect(errorEvents.some((e) => e.phase === 'tool')).toBe(true);
  });

  it('captures tool errors as error tool_result and continues', async () => {
    const exploding: Tool = {
      name: 'boom',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        throw new Error('tool exploded');
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'boom', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'after error' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [exploding]);
    cleanupDirs.push(tmp);
    const result = await agent.run('go');
    expect(result.status).toBe('done');
    expect(provider.calls).toBe(2);
  });

  // ── sizeSignals coverage — read vs bash/grep/logs vs other tools ──────────

  it('sizeSignals returns outputLines for read tool (line prefix format)', async () => {
    const readTool: Tool = {
      name: 'read',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '   1→line one\n   2→line two\n   3→line three\n';
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'read', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [readTool]);
    cleanupDirs.push(tmp);
    const executed: Array<{ name: string; outputLines?: number }> = [];
    (agent as never as { events: EventBus }).events.on('tool.executed', (e) => {
      executed.push({
        name: e.name,
        outputLines: (e as never as { outputLines?: number }).outputLines,
      });
    });
    await agent.run('go');
    expect(executed).toHaveLength(1);
    // outputLines is computed by sizeSignals based on line prefix pattern
    expect(executed[0]?.name).toBe('read');
  });

  it('sizeSignals counts newlines for bash/grep/shell/logs tools', async () => {
    const bashTool: Tool = {
      name: 'bash',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'line1\nline2\nline3';
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'bash', input: { command: 'echo build' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [bashTool]);
    cleanupDirs.push(tmp);
    const executed: Array<{ name: string; outputLines?: number }> = [];
    (agent as never as { events: EventBus }).events.on('tool.executed', (e) => {
      executed.push({
        name: e.name,
        outputLines: (e as never as { outputLines?: number }).outputLines,
      });
    });
    await agent.run('go');
    expect(executed).toHaveLength(1);
    expect(executed[0]?.name).toBe('bash');
    // bash with 2 newlines in content without trailing newline → 3 lines
    expect(executed[0]?.outputLines).toBe(3);
  });

  it('sizeSignals returns undefined lines for non-line-based tools', async () => {
    const customTool: Tool = {
      name: 'custom',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return { key: 'value' };
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'custom', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [customTool]);
    cleanupDirs.push(tmp);
    const executed: Array<{ name: string; outputLines?: number }> = [];
    (agent as never as { events: EventBus }).events.on('tool.executed', (e) => {
      executed.push({
        name: e.name,
        outputLines: (e as never as { outputLines?: number }).outputLines,
      });
    });
    await agent.run('go');
    expect(executed).toHaveLength(1);
    expect(executed[0]?.outputLines).toBeUndefined();
  });

  // ── streaming tool_use_start/stop events ────────────────────────────────────
  // (canonical tests are in the 'streaming provider tool_use events' describe below)

  // ── max iterations extension denial ────────────────────────────────────────
  // (canonical test is in the 'iteration limit extension denial' describe below)
});

describe('Agent — sizeSignals coverage', () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    await cleanupTestDirs(cleanupDirs);
  });

  it('sizeSignals counts newlines for bash tool without trailing newline', async () => {
    const bashTool: Tool = {
      name: 'bash',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'line1\nline2\nline3'; // 2 newlines, 3 lines total
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'bash', input: { command: 'echo build' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [bashTool]);
    cleanupDirs.push(tmp);
    const executed: Array<{ name: string; outputLines?: number }> = [];
    (agent as never as { events: EventBus }).events.on('tool.executed', (e) => {
      executed.push({
        name: e.name,
        outputLines: (e as never as { outputLines?: number }).outputLines,
      });
    });
    await agent.run('go');
    expect(executed).toHaveLength(1);
    expect(executed[0]?.name).toBe('bash');
    expect(executed[0]?.outputLines).toBe(3);
  });

  it('sizeSignals returns undefined outputLines for object-returning tool', async () => {
    const customTool: Tool = {
      name: 'custom',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return { key: 'value' };
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'custom', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [customTool]);
    cleanupDirs.push(tmp);
    const executed: Array<{ name: string; outputLines?: number }> = [];
    (agent as never as { events: EventBus }).events.on('tool.executed', (e) => {
      executed.push({
        name: e.name,
        outputLines: (e as never as { outputLines?: number }).outputLines,
      });
    });
    await agent.run('go');
    expect(executed).toHaveLength(1);
    expect(executed[0]?.outputLines).toBeUndefined();
  });

  it('sizeSignals counts lines for grep tool output', async () => {
    const grepTool: Tool = {
      name: 'grep',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'file1.ts:10:match\nfile2.ts:20:match'; // 1 newline, 2 lines
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'grep', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [grepTool]);
    cleanupDirs.push(tmp);
    const executed: Array<{ name: string; outputLines?: number }> = [];
    (agent as never as { events: EventBus }).events.on('tool.executed', (e) => {
      executed.push({
        name: e.name,
        outputLines: (e as never as { outputLines?: number }).outputLines,
      });
    });
    await agent.run('go');
    expect(executed).toHaveLength(1);
    expect(executed[0]?.outputLines).toBe(2);
  });
});

describe('Agent — streaming provider tool_use events', () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    await cleanupTestDirs(cleanupDirs);
  });

  it('streaming provider emits tool_use_start and tool_use_stop', async () => {
    const provider = new StreamingMockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'grep', input: { pattern: 'x' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    const toolStarts: Array<{ id: string; name: string }> = [];
    const toolStops: Array<{ id: string; name: string }> = [];
    agent.events.on('provider.tool_use_start', (p) => toolStarts.push({ id: p.id, name: p.name }));
    agent.events.on('provider.tool_use_stop', (p) => toolStops.push({ id: p.id, name: p.name }));
    const result = await agent.run('go');
    expect(result.status).toBe('done');
    expect(toolStarts).toEqual([{ id: 'u1', name: 'grep' }]);
    expect(toolStops).toEqual([{ id: 'u1', name: 'grep' }]);
  });

  // text_delta coverage is in 'additional coverage' describe below — that
  // version also asserts finalText for a more complete contract check.
});

describe('Agent — iteration limit extension denial', () => {
  const cleanupDirs: string[] = [];
  afterEach(async () => {
    await cleanupTestDirs(cleanupDirs);
  });

  it('honors iteration limit extension denial and stops at max', async () => {
    const script = Array.from({ length: 5 }, () => ({
      content: [{ type: 'tool_use' as const, id: 'u', name: 'echo', input: {} }],
      stopReason: 'tool_use' as const,
    }));
    const echo: Tool = {
      name: 'echo',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return '';
      },
    };
    const provider = new MockProvider(script);
    const { agent, tmp } = await buildAgent(provider, [echo]);
    cleanupDirs.push(tmp);
    agent.events.on('iteration.limit_reached', ({ deny }) => deny());
    const result = await agent.run('loop', { maxIterations: 3 });
    expect(result.status).toBe('max_iterations');
  });
});

// Move the orphaned tests back inside the Agent describe block
describe('Agent — additional coverage', () => {
  let cleanupDirs: string[] = [];
  beforeEach(() => {
    cleanupDirs = [];
  });
  afterEach(async () => {
    await cleanupTestDirs(cleanupDirs);
  });

  it('accepts ContentBlock[] input including image blocks', async () => {
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'saw it' }], stopReason: 'end_turn' },
    ]);
    const { agent, ctx, tmp } = await buildAgent(provider);
    cleanupDirs.push(tmp);
    const result = await agent.run([
      { type: 'text', text: 'what is in this image?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
    expect(result.status).toBe('done');
    const firstUser = ctx.messages.find((m) => m.role === 'user');
    expect(firstUser).toBeDefined();
    expect(Array.isArray(firstUser!.content)).toBe(true);
    expect((firstUser!.content as unknown[]).length).toBe(2);
  });

  it('uses stream() path for streaming-capable providers and emits text_delta', async () => {
    const provider = new StreamingMockProvider([
      { content: [{ type: 'text', text: 'hello world' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    const deltas: string[] = [];
    agent.events.on('provider.text_delta', (p) => deltas.push(p.text));
    const result = await agent.run('hi');
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('hello world');
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(deltas.join('')).toBe('hello world');
  });

  it('streams tool_use blocks and emits tool_use_start/stop events', async () => {
    const provider = new StreamingMockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'echo', input: { text: 'pong' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const echo: Tool = {
      name: 'echo',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute(input) {
        return (input as { text: string }).text;
      },
    };
    const { agent, tmp } = await buildAgent(provider as never as MockProvider, [echo]);
    cleanupDirs.push(tmp);
    const toolStarts: { id: string; name: string }[] = [];
    agent.events.on('provider.tool_use_start', (p) => toolStarts.push({ id: p.id, name: p.name }));
    const result = await agent.run('go');
    expect(result.status).toBe('done');
    expect(toolStarts).toEqual([{ id: 'u1', name: 'echo' }]);
  });

  it('preserves partial assistant text when aborted mid-stream', async () => {
    // Custom streaming provider that yields a few text deltas, then waits
    // long enough for the abort to fire mid-stream.
    const ctrlBox: { current?: AbortController } = {};
    const provider = {
      id: 'partial-mock',
      capabilities: {
        tools: false,
        parallelTools: false,
        vision: false,
        streaming: true,
        promptCache: false,
        systemPrompt: true,
        jsonMode: false,
        maxContext: 200_000,
        cacheControl: 'none' as const,
      },
      async *stream(_req: { model: string }, opts: { signal: AbortSignal }) {
        yield { type: 'message_start', model: 'm' };
        yield { type: 'text_delta', text: 'partial ' };
        yield { type: 'text_delta', text: 'answer' };
        // Abort happens here
        ctrlBox.current?.abort();
        // Wait a tick so the abort propagates before the next yield
        await new Promise((r) => setImmediate(r));
        if (opts.signal.aborted) throw new DOMException('aborted', 'AbortError');
        yield { type: 'text_delta', text: ' that should not appear' };
        yield { type: 'message_stop', stopReason: 'end_turn', usage: { input: 5, output: 3 } };
      },
      async complete() {
        throw new Error('unused');
      },
    } as never as MockProvider;
    const { agent, ctx, tmp } = await buildAgent(provider);
    cleanupDirs.push(tmp);
    const ctrl = new AbortController();
    ctrlBox.current = ctrl;
    const deltas: string[] = [];
    agent.events.on('provider.text_delta', (p) => deltas.push(p.text));
    const result = await agent.run('hi', { signal: ctrl.signal });
    expect(result.status).toBe('aborted');
    expect(result.finalText).toBe('partial answer');
    expect(deltas.join('')).toBe('partial answer');
    // Partial assistant message must be in the transcript so the next turn
    // has the context.
    const last = ctx.messages[ctx.messages.length - 1];
    expect(last?.role).toBe('assistant');
    const firstBlock = Array.isArray(last?.content) ? last.content[0] : undefined;
    expect(firstBlock).toMatchObject({ type: 'text', text: 'partial answer' });
  });

  it('an abort that severs a provider request reports AGENT_ABORTED, not the provider error', async () => {
    // The severed request throws a recoverable provider error. Carried as the
    // run's error, surfaces read the stop as a transient provider failure (the
    // WebUI armed its auto-continue countdown on it).
    const ctrlBox: { current?: AbortController } = {};
    const provider = {
      id: 'severed-mock',
      capabilities: {
        tools: false,
        parallelTools: false,
        vision: false,
        streaming: false,
        promptCache: false,
        systemPrompt: true,
        jsonMode: false,
        maxContext: 200_000,
        cacheControl: 'none' as const,
      },
      async complete() {
        ctrlBox.current?.abort();
        await new Promise((r) => setImmediate(r));
        throw new ProviderError('request severed HTTP 503', 503, true, 'severed-mock');
      },
    } as never as MockProvider;
    const { agent, tmp } = await buildAgent(provider);
    cleanupDirs.push(tmp);
    const ctrl = new AbortController();
    ctrlBox.current = ctrl;
    const result = await agent.run('hi', { signal: ctrl.signal });
    expect(result.status).toBe('aborted');
    expect(result.error?.code).toBe('AGENT_ABORTED');
    expect(result.error?.recoverable).toBe(false);
    expect(ProviderError.isProviderError(result.error?.cause)).toBe(true);
  });

  it('drains context abort hooks on normal completion', async () => {
    const provider = new StreamingMockProvider([
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, ctx, tmp } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    let hookFired = false;
    ctx.registerAbortHook(() => {
      hookFired = true;
    });
    await agent.run('hi');
    expect(hookFired).toBe(true);
  });

  it('serialises object tool results as JSON', async () => {
    const objTool: Tool = {
      name: 'objres',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return { foo: 1, bar: ['a', 'b'] };
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'objres', input: {} }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'k' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [objTool]);
    cleanupDirs.push(tmp);
    const result = await agent.run('go');
    expect(result.status).toBe('done');
  });

  it('emits provider.retry on retryable ProviderError and recovers', async () => {
    class FlakyProvider implements Provider {
      readonly id = 'flaky';
      readonly capabilities: Capabilities = {
        tools: false,
        parallelTools: false,
        vision: false,
        streaming: false,
        promptCache: false,
        systemPrompt: true,
        jsonMode: false,
        maxContext: 100_000,
        cacheControl: 'none',
      };
      calls = 0;
      async complete(req: Request): Promise<Response> {
        this.calls++;
        if (this.calls === 1) {
          throw new ProviderError('flaky HTTP 529', 529, true, 'flaky', {
            body: {
              type: 'overloaded_error',
              message: 'High traffic detected. Upgrade for highspeed model.',
              requestId: '06534785201de9c0',
            },
          });
        }
        return {
          content: [{ type: 'text', text: 'recovered' }],
          stopReason: 'end_turn',
          usage: { input: 1, output: 1 },
          model: req.model,
        };
      }
      // biome-ignore lint/correctness/useYield: stub
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error('not used');
      }
    }
    const provider = new FlakyProvider();
    const { agent, tmp, ctx } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    // Override retry policy to a near-zero delay so the test runs fast.
    (agent as never as { container: Container }).container.override(TOKENS.RetryPolicy, () => ({
      shouldRetry: (err: Error | ProviderError, attempt: number) =>
        err instanceof ProviderError && err.retryable && attempt < 3,
      delayMs: () => 1,
      maxAttempts: () => 3,
    }));
    // Replace the context's provider with our flaky one.
    (ctx as never as { provider: Provider }).provider = provider;

    const retries: Array<{
      providerId: string;
      attempt: number;
      status: number;
      description: string;
    }> = [];
    const errors: Array<{ providerId: string; status: number; description: string }> = [];
    (agent as never as { events: EventBus }).events.on('provider.retry', (e) => retries.push(e));
    (agent as never as { events: EventBus }).events.on('provider.error', (e) => errors.push(e));

    const result = await agent.run('ping');
    expect(result.status).toBe('done');
    expect(provider.calls).toBe(2);
    expect(retries).toHaveLength(1);
    expect(retries[0]?.providerId).toBe('flaky');
    expect(retries[0]?.status).toBe(529);
    expect(retries[0]?.attempt).toBe(1);
    expect(retries[0]?.description).toContain('overloaded (529)');
    expect(retries[0]?.description).toContain('High traffic detected');
    expect(errors).toHaveLength(0);
  });

  it('emits tool.executed with truncated output preview', async () => {
    const longOutput = 'A'.repeat(2000);
    const echo: Tool = {
      name: 'echo',
      description: 'returns big string',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      permission: 'auto',
      mutating: false,
      async execute() {
        return longOutput;
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'echo', input: { text: 'big' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [echo]);
    cleanupDirs.push(tmp);

    const executed: Array<{
      name: string;
      output?: string | undefined;
      input?: unknown | undefined;
      ok: boolean;
      mutating?: boolean | undefined;
    }> = [];
    (agent as never as { events: EventBus }).events.on('tool.executed', (e) => {
      executed.push({
        name: e.name,
        output: e.output,
        input: e.input,
        ok: e.ok,
        mutating: e.mutating,
      });
    });

    const result = await agent.run('go');
    expect(result.status).toBe('done');
    expect(executed).toHaveLength(1);
    expect(executed[0]?.name).toBe('echo');
    expect(executed[0]?.input).toEqual({ text: 'big' });
    expect(executed[0]?.mutating).toBe(false);
    // Capped at 400 with trailing ellipsis.
    expect(executed[0]?.output?.length).toBe(400);
    expect(executed[0]?.output?.endsWith('…')).toBe(true);
  });

  it('gives diff-producing tools a larger event-preview cap (no mid-diff …)', async () => {
    // A file-mutating tool's output is a unified diff the UIs render as a
    // colored diff block. The default 400-char cap would slice the last
    // visible diff line mid-word; edit/write/replace/patch/diff get a much
    // larger budget so the shown hunk survives intact.
    // Kept under the serializer's 260-line compaction threshold so the full
    // body is emitted — ~50 lines × ~30 chars is well past the 400-char
    // default cap but nowhere near the raised diff cap.
    const bigDiff = ['--- a/foo.ts', '+++ b/foo.ts', '@@ -1,1 +1,50 @@']
      .concat(Array.from({ length: 50 }, (_, i) => `+line ${i} ${'x'.repeat(20)}`))
      .join('\n');
    const edit: Tool = {
      name: 'edit',
      description: 'returns a big diff',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      permission: 'auto',
      mutating: true,
      async execute() {
        return { path: 'foo.ts', replacements: 1, diff: bigDiff };
      },
    };
    const provider = new MockProvider([
      {
        content: [{ type: 'tool_use', id: 'u1', name: 'edit', input: { path: 'foo.ts' } }],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, [edit]);
    cleanupDirs.push(tmp);

    const executed: Array<{ name: string; output?: string }> = [];
    (agent as never as { events: EventBus }).events.on('tool.executed', (e) => {
      executed.push({ name: e.name, output: e.output });
    });

    const result = await agent.run('go');
    expect(result.status).toBe('done');
    expect(executed).toHaveLength(1);
    // Well beyond the 400-char default — the diff body is preserved.
    expect(executed[0]?.output?.length ?? 0).toBeGreaterThan(1000);
    expect(executed[0]?.output).toContain('line 0 ');
  });

  it('emits provider.error when retries are exhausted', async () => {
    class AlwaysFailProvider implements Provider {
      readonly id = 'doomed';
      readonly capabilities: Capabilities = {
        tools: false,
        parallelTools: false,
        vision: false,
        streaming: false,
        promptCache: false,
        systemPrompt: true,
        jsonMode: false,
        maxContext: 100_000,
        cacheControl: 'none',
      };
      async complete(): Promise<Response> {
        throw new ProviderError('doomed HTTP 400', 400, false, 'doomed', {
          body: { type: 'invalid_request_error', message: 'bad request' },
        });
      }
      // biome-ignore lint/correctness/useYield: stub
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error('not used');
      }
    }
    const provider = new AlwaysFailProvider();
    const { agent, tmp, ctx } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    (ctx as never as { provider: Provider }).provider = provider;

    const errors: Array<{ providerId: string; status: number; description: string }> = [];
    (agent as never as { events: EventBus }).events.on('provider.error', (e) => errors.push(e));

    const result = await agent.run('ping');
    expect(result.status).toBe('failed');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.providerId).toBe('doomed');
    expect(errors[0]?.status).toBe(400);
    expect(errors[0]?.description).toContain('invalid request (400)');
  });

  it('typed RunResult.error: provider error becomes WrongStackError', async () => {
    class FailProvider implements Provider {
      readonly id = 'fail-prov';
      readonly capabilities: Capabilities = {
        tools: false,
        parallelTools: false,
        vision: false,
        streaming: false,
        promptCache: false,
        systemPrompt: true,
        jsonMode: false,
        maxContext: 100_000,
        cacheControl: 'none',
      };
      async complete(): Promise<Response> {
        throw new ProviderError('bad request', 400, false, 'fail-prov');
      }
      // biome-ignore lint/correctness/useYield: stub
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error('not used');
      }
    }
    const provider = new FailProvider();
    const { agent, tmp, ctx } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    (ctx as never as { provider: Provider }).provider = provider;

    const result = await agent.run('ping');
    expect(result.status).toBe('failed');
    // result.error is typed as WrongStackError — ProviderError already extends it
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('PROVIDER_INVALID_REQUEST');
    expect(result.error?.subsystem).toBe('provider');
    expect(typeof result.error?.severity).toBe('string');
    expect(typeof result.error?.describe()).toBe('string');
  });

  it('honors ErrorHandler retry decisions instead of treating truthy recovery as a response', async () => {
    class FailsThenSucceedsProvider implements Provider {
      readonly id = 'recoverable';
      readonly capabilities: Capabilities = {
        tools: false,
        parallelTools: false,
        vision: false,
        streaming: false,
        promptCache: false,
        systemPrompt: true,
        jsonMode: false,
        maxContext: 100_000,
        cacheControl: 'none',
      };
      calls = 0;
      async complete(req: Request): Promise<Response> {
        this.calls++;
        if (this.calls === 1) {
          throw new ProviderError('context length exceeded', 413, false, 'recoverable');
        }
        return {
          content: [{ type: 'text', text: `ok:${req.model}` }],
          stopReason: 'end_turn',
          usage: { input: 1, output: 1 },
          model: req.model,
        };
      }
      // biome-ignore lint/correctness/useYield: stub
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error('not used');
      }
    }

    const provider = new FailsThenSucceedsProvider();
    const { agent, tmp, ctx } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    (ctx as never as { provider: Provider }).provider = provider;
    (agent as never as { container: Container }).container.override(TOKENS.ErrorHandler, () => ({
      recover: async () => ({
        action: 'retry' as const,
        reason: 'test_retry',
        model: 'fallback-model',
      }),
      classify: () => ({ kind: 'context_overflow' as const, retryable: false }),
    }));

    const result = await agent.run('ping');
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('ok:fallback-model');
    expect(provider.calls).toBe(2);
  });

  it('honors ErrorHandler continue decisions as provider responses', async () => {
    class RecoverViaContinueProvider implements Provider {
      readonly id = 'continue-provider';
      readonly capabilities: Capabilities = {
        tools: false,
        parallelTools: false,
        vision: false,
        streaming: false,
        promptCache: false,
        systemPrompt: true,
        jsonMode: false,
        maxContext: 100_000,
        cacheControl: 'none',
      };
      calls = 0;
      async complete(): Promise<Response> {
        this.calls++;
        throw new ProviderError('server failed', 500, false, 'continue-provider');
      }
      // biome-ignore lint/correctness/useYield: stub
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error('not used');
      }
    }

    const provider = new RecoverViaContinueProvider();
    const { agent, tmp, ctx } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    (ctx as never as { provider: Provider }).provider = provider;
    (agent as never as { container: Container }).container.override(TOKENS.ErrorHandler, () => ({
      recover: async () => ({
        action: 'continue' as const,
        response: {
          content: [{ type: 'text' as const, text: 'synthetic recovery' }],
          stopReason: 'end_turn' as const,
          usage: { input: 0, output: 0 },
          model: 'test-model',
        },
      }),
      classify: () => ({ kind: 'server' as const, retryable: true }),
    }));

    const result = await agent.run('ping');
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('synthetic recovery');
    expect(provider.calls).toBe(1);
  });

  it('honors ErrorHandler fail decisions as terminal failures', async () => {
    class RecoverViaFailProvider implements Provider {
      readonly id = 'fail-provider';
      readonly capabilities: Capabilities = {
        tools: false,
        parallelTools: false,
        vision: false,
        streaming: false,
        promptCache: false,
        systemPrompt: true,
        jsonMode: false,
        maxContext: 100_000,
        cacheControl: 'none',
      };
      async complete(): Promise<Response> {
        throw new ProviderError('server failed', 500, false, 'fail-provider');
      }
      // biome-ignore lint/correctness/useYield: stub
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error('not used');
      }
    }

    const provider = new RecoverViaFailProvider();
    const { agent, tmp, ctx } = await buildAgent(provider as never as MockProvider);
    cleanupDirs.push(tmp);
    (ctx as never as { provider: Provider }).provider = provider;
    const terminal = new Error('terminal recovery decision');
    (agent as never as { container: Container }).container.override(TOKENS.ErrorHandler, () => ({
      recover: async () => ({ action: 'fail' as const, reason: 'terminal', error: terminal }),
      classify: () => ({ kind: 'server' as const, retryable: false }),
    }));

    const result = await agent.run('ping');
    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('terminal recovery decision');
  });

  it.each([false, true])(
    'shares concurrent teardown without repeating plugin cleanup (failure=%s)',
    async (fail) => {
      const { agent, ctx, tmp } = await buildAgent(new MockProvider([]));
      cleanupDirs.push(tmp);
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const failure = new Error('cleanup failed');
      const cleanup = vi.fn(async () => {
        entered.resolve();
        await gate.promise;
        if (fail) throw failure;
      });
      const lifetimeCleanup = vi.fn();
      ctx.registerAgentHook(lifetimeCleanup);
      await agent.use(
        { name: 'slow-cleanup', apiVersion: '^0.1', setup() {}, teardown: cleanup } as never,
        {} as never,
      );
      try {
        const first = agent.teardown();
        await entered.promise;
        const second = agent.teardown();
        const results = Promise.allSettled([first, second]);
        expect(lifetimeCleanup).not.toHaveBeenCalled();
        gate.resolve();
        const settled = await results;
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(lifetimeCleanup).toHaveBeenCalledTimes(1);
        expect(settled.map((result) => result.status)).toEqual(
          fail ? ['rejected', 'rejected'] : ['fulfilled', 'fulfilled'],
        );
        if (settled[0]?.status === 'rejected' && settled[1]?.status === 'rejected') {
          expect(settled[0].reason).toBe(settled[1].reason);
          expect(settled[0].reason.cause).toBe(failure);
        }
        // A later cleanup cycle must still handle newly registered hooks.
        const laterCleanup = vi.fn();
        ctx.registerAgentHook(laterCleanup);
        await agent.teardown();
        expect(laterCleanup).toHaveBeenCalledTimes(1);
      } finally {
        gate.resolve();
        await ctx.session.close();
      }
    },
  );

  it('teardown throws a structured AgentError when a plugin teardown fails', async () => {
    const provider = new MockProvider([]);
    const { agent, tmp } = await buildAgent(provider);
    cleanupDirs.push(tmp);

    // Register two plugins: the second throws during teardown. Agent.teardown
    // must surface the failure as an AgentError(AGENT_RUN_FAILED) with the
    // first underlying error preserved as `cause`, not as a bare Error.
    const goodTeardown = vi.fn().mockResolvedValue(undefined);
    const badTeardown = vi.fn().mockRejectedValue(new Error('plugin cleanup blew up'));
    await agent.use(
      { name: 'good', apiVersion: '^0.1', setup: () => undefined, teardown: goodTeardown } as never,
      {} as never,
    );
    await agent.use(
      { name: 'bad', apiVersion: '^0.1', setup: () => undefined, teardown: badTeardown } as never,
      {} as never,
    );

    let caught: unknown;
    try {
      await agent.teardown();
    } catch (err) {
      caught = err;
    }
    // Both teardowns ran (bad plugin's error doesn't block good one's cleanup).
    expect(goodTeardown).toHaveBeenCalled();
    expect(badTeardown).toHaveBeenCalled();

    expect(caught).toBeDefined();
    expect(isAgentError(caught)).toBe(true);
    const ae = caught as AgentError;
    expect(ae.code).toBe('AGENT_RUN_FAILED');
    expect(ae.context?.phase).toBe('plugin-teardown');
    expect(ae.context?.failures).toBe(1);
    expect((ae.cause as Error)?.message).toBe('plugin cleanup blew up');
  });

  it('does not permanently wedge on the next run() when prompt refresh throws', async () => {
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'recovered' }], stopReason: 'end_turn' },
    ]);
    let calls = 0;
    const build = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('prompt builder exploded');
      return [{ type: 'text' as const, text: 'refreshed' }];
    });
    const { agent, tmp } = await buildAgent(provider, [], undefined, {
      refreshSystemPrompt: true,
      systemPromptBuild: build,
    });
    cleanupDirs.push(tmp);

    // First run() fails during prompt refresh — the agent's catch block
    // wraps the error in an AgentError and returns { status: 'failed' }.
    const first = await agent.run('hello');
    expect(first.status).toBe('failed');

    // Second run() must NOT be wedged by _runInProgress still being true.
    const result = await agent.run('hello again');
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('recovered');
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('passes opts.model to the prompt builder instead of ctx.model', async () => {
    // The prompt builder must receive the per-run model override, not the
    // stale ctx.model.  Before the fix, builder.build() was hardcoded to
    // this.ctx.model, so a `/model <x>` override would still build the
    // prompt for the old model.
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const receivedModels: (string | undefined)[] = [];
    const build = vi.fn(async (ctx: BuildContext) => {
      receivedModels.push(ctx.model);
      return [{ type: 'text' as const, text: 'refreshed' }];
    });
    const { agent, tmp } = await buildAgent(provider, [], undefined, {
      refreshSystemPrompt: true,
      systemPromptBuild: build,
    });
    cleanupDirs.push(tmp);

    // Run with an explicit model override. ctx.model is 'test-model'.
    const result = await agent.run('hello', { model: 'override-model' });
    expect(result.status).toBe('done');
    // The prompt builder must have received 'override-model', not 'test-model'.
    expect(receivedModels).toContain('override-model');
    expect(receivedModels).not.toContain('test-model');
  });
});
