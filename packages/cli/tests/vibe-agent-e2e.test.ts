import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent, Context } from '@wrongstack/core/agent';
import { DefaultErrorHandler, DefaultRetryPolicy, ToolExecutor } from '@wrongstack/core/execution';
import { DefaultLogger, DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { Container, EventBus, TOKENS } from '@wrongstack/core/kernel';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { DefaultPermissionPolicy, DefaultSecretScrubber } from '@wrongstack/core/security';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import type { Provider, Request, Response, Tool } from '@wrongstack/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installVibeProtocol, VIBE_PROTOCOL_META_KEY } from '../src/vibe-protocol-wiring.js';
import { setupPipelines } from '../src/wiring/pipeline.js';

class ScriptedProvider implements Provider {
  readonly id = 'vibe-e2e';
  readonly capabilities = {
    tools: true,
    parallelTools: true,
    vision: false,
    streaming: false,
    promptCache: false,
    systemPrompt: true,
    jsonMode: false,
    reasoning: false,
    maxContext: 200_000,
    cacheControl: 'none' as const,
  };
  readonly receivedRequests: Request[] = [];
  private callIndex = 0;

  constructor(private readonly responses: Response[]) {}

  async complete(request: Request): Promise<Response> {
    this.receivedRequests.push({
      ...request,
      system: request.system ? structuredClone(request.system) : undefined,
      messages: structuredClone(request.messages),
      tools: request.tools,
    });
    const response = this.responses[this.callIndex++];
    if (!response) throw new Error('ScriptedProvider response queue exhausted');
    return response;
  }

  // biome-ignore lint/correctness/useYield: the non-streaming provider must expose the interface method
  async *stream(): AsyncIterable<never> {
    throw new Error('Streaming is disabled for this E2E provider');
  }
}

function response(content: Response['content'], stopReason: Response['stopReason']): Response {
  return {
    content,
    stopReason,
    usage: { input: 20, output: 10 },
    model: 'vibe-e2e-model',
  };
}

function messageText(request: Request): string {
  return request.messages
    .flatMap((message) =>
      typeof message.content === 'string'
        ? [message.content]
        : Array.isArray(message.content)
          ? message.content
              .filter((block: { type: string; text?: string }) => block.type === 'text')
              .map((block: { type: string; text?: string }) => block.text ?? '')
          : [],
    )
    .join('\n');
}

function toolResultText(request: Request): string {
  return request.messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => (block as { type?: string }).type === 'tool_result')
    .map((block) => {
      const rawContent: unknown = (block as { content?: unknown }).content;
      if (typeof rawContent === 'string') return rawContent;
      if (Array.isArray(rawContent)) {
        return rawContent
          .filter((item: unknown): item is { type: string; text?: string } =>
            Boolean(
              item &&
                typeof item === 'object' &&
                'type' in item &&
                (item as { type: string }).type === 'text',
            ),
          )
          .map((item) => item.text ?? '')
          .join('\n');
      }
      return '';
    })
    .join('\n');
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('[VIBE] real Agent.run production flow', () => {
  it('executes synthesizer → coder/tool loop → auditor and does not retrigger from nextsteps output', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-vibe-e2e-'));
    temporaryDirectories.push(projectRoot);
    const provider = new ScriptedProvider([
      response(
        [{ type: 'tool_use', id: 'evidence-1', name: 'record-evidence', input: {} }],
        'tool_use',
      ),
      response(
        [
          {
            type: 'text',
            text: 'Implemented the cart increment and verified the focused scenario.',
          },
        ],
        'end_turn',
      ),
      response(
        [
          {
            type: 'text',
            text: '<nextsteps>\n1. Run another task with [VIBE]\n</nextsteps>',
          },
        ],
        'end_turn',
      ),
    ]);
    const events = new EventBus();
    const logger = new DefaultLogger({ level: 'error' });
    const container = new Container();
    container.bind(TOKENS.Logger, () => logger);
    container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
    container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
    container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
    container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
    container.bind(
      TOKENS.PermissionPolicy,
      () =>
        new DefaultPermissionPolicy({
          trustFile: path.join(projectRoot, 'trust.json'),
          yolo: true,
        }),
    );

    const executeEvidence = vi.fn(async () => 'focused scenario evidence recorded');
    const evidenceTool: Tool = {
      name: 'record-evidence',
      description: 'Records deterministic E2E evidence.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      mutating: false,
      execute: executeEvidence,
    };
    const tools = new ToolRegistry();
    tools.register(evidenceTool);
    const sessionStore = new DefaultSessionStore({
      dir: path.join(projectRoot, 'sessions'),
      projectRoot,
    });
    const session = await sessionStore.create({
      id: '',
      model: 'vibe-e2e-model',
      provider: provider.id,
    });
    const context = new Context({
      systemPrompt: [{ type: 'text', text: 'You are the real VIBE E2E agent.' }],
      provider,
      session,
      signal: new AbortController().signal,
      tokenCounter: container.resolve(TOKENS.TokenCounter),
      cwd: projectRoot,
      projectRoot,
      model: 'vibe-e2e-model',
    });
    const pipelines = setupPipelines({ events, logger });
    installVibeProtocol(pipelines);
    const agent = new Agent({
      container,
      tools,
      providers: new ProviderRegistry(),
      events,
      pipelines,
      context,
      maxIterations: 5,
      toolExecutor: new ToolExecutor(tools, {
        permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
        secretScrubber: container.resolve(TOKENS.SecretScrubber),
        events,
        confirmAwaiter: undefined,
        iterationTimeoutMs: 30_000,
        perIterationOutputCapBytes: 100_000,
        tracer: undefined,
      }),
    });

    const vibeResult = await agent.run('[vIbE] butona basınca sepet artsın');

    expect(vibeResult.status).toBe('done');
    expect(vibeResult.iterations).toBe(2);
    expect(provider.receivedRequests).toHaveLength(2);
    expect(executeEvidence).toHaveBeenCalledTimes(1);
    expect(messageText(provider.receivedRequests[0]!)).toContain(
      '## 🌊 VIBE Synthesized Specification',
    );
    expect(messageText(provider.receivedRequests[0]!)).toContain('## Coder Contract');
    expect(messageText(provider.receivedRequests[0]!)).toContain(
      'Implement core intent: butona basınca sepet artsın',
    );
    expect(toolResultText(provider.receivedRequests[1]!)).toContain(
      'focused scenario evidence recorded',
    );
    expect(vibeResult.finalText).toContain('Implemented the cart increment');
    expect(vibeResult.finalText).toContain('### 🌊 [VIBE Protocol: Spec-Synthesizer]');
    expect(vibeResult.finalText).toContain('### 💻 [Coder Contract]');
    expect(vibeResult.finalText).toContain('### 🛡️ [Auditor Verdict]');
    expect(vibeResult.finalText).toContain('✅ PASS');
    expect(context.meta[VIBE_PROTOCOL_META_KEY]).toMatchObject({
      isVibeMode: true,
      stage: 'passed',
      audit: { verdict: 'PASS' },
    });

    await session.flush();
    const persisted = await sessionStore.load(session.id);
    const persistedText = persisted.messages
      .flatMap((message) =>
        typeof message.content === 'string'
          ? [message.content]
          : message.content.filter((block) => block.type === 'text').map((block) => block.text),
      )
      .join('\n');
    expect(persistedText).toContain('### 🛡️ [Auditor Verdict]');
    expect(persistedText).toContain('✅ PASS');

    const ordinaryResult = await agent.run('Show the available follow-up suggestion');
    expect(ordinaryResult.status).toBe('done');
    expect(provider.receivedRequests).toHaveLength(3);
    expect(ordinaryResult.finalText).toContain('<nextsteps>');
    expect(ordinaryResult.finalText).toContain('[VIBE]');
    expect(ordinaryResult.finalText).not.toContain('Auditor Verdict');
    expect(context.meta).not.toHaveProperty(VIBE_PROTOCOL_META_KEY);

    await agent.teardown();
    await session.close();
  });
});
