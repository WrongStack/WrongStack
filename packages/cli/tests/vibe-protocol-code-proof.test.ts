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
import { afterEach, describe, expect, it } from 'vitest';
import { installVibeProtocol, VIBE_PROTOCOL_META_KEY } from '../src/vibe-protocol-wiring.js';
import { setupPipelines } from '../src/wiring/pipeline.js';

class CaptureProvider implements Provider {
  readonly id = 'vibe-proof';
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
  readonly received: Request[] = [];
  private i = 0;
  constructor(private readonly replies: Response[]) {}
  async complete(request: Request): Promise<Response> {
    this.received.push({
      ...request,
      system: request.system ? structuredClone(request.system) : undefined,
      messages: structuredClone(request.messages),
      tools: request.tools,
    });
    const next = this.replies[this.i++];
    if (!next) throw new Error('CaptureProvider exhausted');
    return next;
  }
  async *stream(): AsyncIterable<never> {
    // This provider is never streamed in these tests; the yield keeps the
    // generator syntax honest (lint/correctness/useYield) instead of a
    // plain throw, which cannot appear in a generator without a yield.
    yield* [] as never[];
    throw new Error('no stream');
  }
}

function reply(content: Response['content'], stopReason: Response['stopReason']): Response {
  return { content, stopReason, usage: { input: 8, output: 4 }, model: 'vibe-proof-model' };
}

function requestText(request: Request): string {
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

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('[VIBE] code proof — real Agent.run', () => {
  it('proves tagged prompt injects spec+contract and audits the final answer', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-proof-'));
    temps.push(projectRoot);
    const provider = new CaptureProvider([
      reply([{ type: 'tool_use', id: 't1', name: 'noop', input: {} }], 'tool_use'),
      reply(
        [{ type: 'text', text: 'Implemented cart increment for the button click.' }],
        'end_turn',
      ),
      reply(
        [{ type: 'text', text: '<nextsteps>\n1. Try again with [VIBE]\n</nextsteps>' }],
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

    const tool: Tool = {
      name: 'noop',
      description: 'noop',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      mutating: false,
      execute: async () => 'ok',
    };
    const tools = new ToolRegistry();
    tools.register(tool);
    const sessionStore = new DefaultSessionStore({
      dir: path.join(projectRoot, 'sessions'),
      projectRoot,
    });
    const session = await sessionStore.create({
      id: '',
      model: 'vibe-proof-model',
      provider: provider.id,
    });
    const context = new Context({
      systemPrompt: [{ type: 'text', text: 'proof agent' }],
      provider,
      session,
      signal: new AbortController().signal,
      tokenCounter: container.resolve(TOKENS.TokenCounter),
      cwd: projectRoot,
      projectRoot,
      model: 'vibe-proof-model',
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
        iterationTimeoutMs: 30_000,
        perIterationOutputCapBytes: 100_000,
      }),
    });

    const tagged = '[vIbE] butona basınca sepet artsın';
    const vibe = await agent.run(tagged);
    const modelSaw = requestText(provider.received[0]!);
    const metaAfterVibe = structuredClone(context.meta[VIBE_PROTOCOL_META_KEY]);

    const ordinary = await agent.run('Show the follow-up suggestion');
    const ordinarySaw = requestText(provider.received[2]!);
    const metaAfterOrdinary = context.meta[VIBE_PROTOCOL_META_KEY];

    const proof = {
      input: tagged,
      modelFacingPrompt: modelSaw,
      finalText: vibe.finalText,
      metaAfterVibe,
      ordinaryInput: 'Show the follow-up suggestion',
      ordinaryFinalText: ordinary.finalText,
      ordinaryModelFacingPrompt: ordinarySaw,
      metaAfterOrdinary: metaAfterOrdinary ?? null,
    };
    const outDir = path.resolve(process.cwd(), 'docs/reports');
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(
      path.join(outDir, 'vibe-protocol-code-proof.json'),
      `${JSON.stringify(proof, null, 2)}\n`,
      'utf8',
    );

    // eslint-disable-next-line no-console
    console.log('\n===== VIBE CODE PROOF =====');
    // eslint-disable-next-line no-console
    console.log('INPUT:', tagged);
    // eslint-disable-next-line no-console
    console.log('\n--- MODEL SAW (first request) ---\n', modelSaw);
    // eslint-disable-next-line no-console
    console.log('\n--- FINAL TEXT ---\n', vibe.finalText);
    // eslint-disable-next-line no-console
    console.log('\n--- META AFTER VIBE ---\n', JSON.stringify(metaAfterVibe, null, 2));
    // eslint-disable-next-line no-console
    console.log(
      '\n--- ORDINARY FINAL (must keep [VIBE] mention, no auditor) ---\n',
      ordinary.finalText,
    );
    // eslint-disable-next-line no-console
    console.log('===== END PROOF =====\n');

    expect(modelSaw).toContain('[vibe_protocol]');
    expect(modelSaw).toContain('## 🌊 VIBE Synthesized Specification');
    expect(modelSaw).toContain('Implement core intent: butona basınca sepet artsın');
    expect(vibe.status).toBe('done');
    expect(vibe.finalText).toContain('Implemented cart increment');
    expect(vibe.finalText).toContain('### 🌊 [VIBE Protocol: Spec-Synthesizer]');
    expect(vibe.finalText).toContain('### 🛡️ [Auditor Verdict]');
    expect(vibe.finalText).toContain('✅ PASS');
    expect(metaAfterVibe).toMatchObject({
      isVibeMode: true,
      stage: 'passed',
      audit: { verdict: 'PASS' },
    });
    expect(ordinary.finalText).toContain('[VIBE]');
    expect(ordinary.finalText).not.toContain('Auditor Verdict');
    const lastUser = [...(provider.received[2]?.messages ?? [])]
      .reverse()
      .find((message) => message.role === 'user');
    const lastUserText =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser.content
              .filter((block: { type: string; text?: string }) => block.type === 'text')
              .map((block: { type: string; text?: string }) => block.text ?? '')
              .join('\n')
          : '';
    expect(lastUserText.startsWith('Show the follow-up suggestion')).toBe(true);
    expect(lastUserText).not.toMatch(/^Show the follow-up suggestion\n\n\[vibe_protocol\]/);
    expect(metaAfterOrdinary).toBeUndefined();

    await agent.teardown();
    await session.close();
  });
});
