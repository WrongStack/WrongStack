import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { Context } from '../../src/core/context.js';
import { DefaultErrorHandler } from '../../src/execution/error-handler.js';
import { DefaultRetryPolicy } from '../../src/execution/retry-policy.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { DefaultLogger } from '../../src/infrastructure/logger.js';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { Container } from '../../src/kernel/container.js';
import { EventBus } from '../../src/kernel/events.js';
import { TOKENS } from '../../src/kernel/tokens.js';
import { ProviderRegistry } from '../../src/registry/provider-registry.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import type { Span, Tracer } from '../../src/types/observability.js';
import type { Tool } from '../../src/types/tool.js';
import { MockProvider } from '../helpers/mock-provider.js';

interface SpanRecord {
  name: string;
  attrs: Record<string, string | number | boolean>;
  errors: Error[];
  ended: boolean;
}

function makeRecordingTracer(): { tracer: Tracer; spans: SpanRecord[] } {
  const spans: SpanRecord[] = [];
  const tracer: Tracer = {
    startSpan(name, attrs) {
      const rec: SpanRecord = { name, attrs: { ...(attrs ?? {}) }, errors: [], ended: false };
      spans.push(rec);
      const span: Span = {
        setAttribute(k, v) {
          rec.attrs[k] = v;
        },
        recordError(err) {
          rec.errors.push(err);
        },
        end() {
          rec.ended = true;
        },
      };
      return span;
    },
  };
  return { tracer, spans };
}

async function buildAgent(provider: MockProvider, tracer: Tracer, extraTools: Tool[] = []) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-tr-'));
  const trustFile = path.join(tmp, 'trust.json');
  const sessionDir = path.join(tmp, 'sessions');

  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error' }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
  container.bind(
    TOKENS.PermissionPolicy,
    () => new DefaultPermissionPolicy({ trustFile, yolo: true }),
  );

  const tools = new ToolRegistry();
  for (const t of extraTools) tools.register(t);
  const providers = new ProviderRegistry();
  const events = new EventBus();
  const pipelines = createDefaultPipelines();

  const sessionStore = new DefaultSessionStore({ dir: sessionDir });
  const session = await sessionStore.create({ id: '', model: 'test', provider: 'mock' });

  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'sys' }],
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
    tracer,
  });

  const agent = new Agent({
    container,
    tools,
    providers,
    events,
    pipelines,
    context: ctx,
    maxIterations: 10,
    tracer,
    toolExecutor,
  });
  return { agent, tmp };
}

describe('Agent + ToolExecutor tracing (L1-C)', () => {
  let cleanupDirs: string[] = [];
  beforeEach(() => {
    cleanupDirs = [];
  });
  afterEach(async () => {
    for (const d of cleanupDirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('opens agent.run and provider.complete spans on a successful run', async () => {
    const { tracer, spans } = makeRecordingTracer();
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'hi' }], stopReason: 'end_turn' },
    ]);
    const { agent, tmp } = await buildAgent(provider, tracer);
    cleanupDirs.push(tmp);

    const result = await agent.run('hello');
    expect(result.status).toBe('done');

    const names = spans.map((s) => s.name);
    expect(names).toContain('agent.run');
    expect(names).toContain('provider.complete');

    const agentSpan = spans.find((s) => s.name === 'agent.run')!;
    expect(agentSpan.ended).toBe(true);
    expect(agentSpan.attrs['agent.status']).toBe('done');
    expect(agentSpan.attrs['agent.iterations']).toBe(1);

    const provSpan = spans.find((s) => s.name === 'provider.complete')!;
    expect(provSpan.ended).toBe(true);
    expect(provSpan.attrs['provider.id']).toBe(provider.id);
    expect(provSpan.attrs['provider.stopReason']).toBe('end_turn');
  });

  it('opens a tool.<name> span around each tool execution', async () => {
    const { tracer, spans } = makeRecordingTracer();
    const echo: Tool = {
      name: 'echo',
      description: 'echo',
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
    const { agent, tmp } = await buildAgent(provider, tracer, [echo]);
    cleanupDirs.push(tmp);

    const result = await agent.run('ping');
    expect(result.status).toBe('done');

    const toolSpan = spans.find((s) => s.name === 'tool.echo');
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.ended).toBe(true);
    expect(toolSpan!.attrs['tool.name']).toBe('echo');
    expect(toolSpan!.attrs['tool.is_error']).toBe(false);
  });
});
