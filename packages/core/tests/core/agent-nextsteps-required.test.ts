/**
 * End-to-end: `autonomy.nextSteps: 'required'` through the real agent loop.
 *
 * The unit layer (`next-steps-required.test.ts`) pins the side request in
 * isolation. This file pins the CHAIN — provider response → side request →
 * appended block → the `provider.response` event, the conversation history
 * and `finalText` — because those are what every suggestion surface reads.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Container } from '@wrongstack/contracts/kernel/container';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { TOKENS } from '@wrongstack/contracts/kernel/tokens';
import type { ContentBlock } from '@wrongstack/contracts/types/blocks';
import type { Config } from '@wrongstack/contracts/types/config';
import { afterEach, describe, expect, it } from 'vitest';
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
import { DefaultConfigStore } from '../../src/storage/config-store.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import { parseNextSteps } from '../../src/utils/next-steps.js';
import { MockProvider } from '../helpers/mock-provider.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

/** `nextSteps: undefined` binds a store without the key (→ default); `null` binds no store. */
async function buildAgent(
  provider: MockProvider,
  nextSteps: 'optional' | 'required' | undefined | null,
) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-nextsteps-required-'));
  dirs.push(tmp);
  const container = new Container();
  container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error' }));
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.TokenCounter, () => new DefaultTokenCounter());
  container.bind(
    TOKENS.PermissionPolicy,
    () => new DefaultPermissionPolicy({ trustFile: path.join(tmp, 'trust.json'), yolo: true }),
  );
  if (nextSteps !== null) {
    const autonomy = nextSteps === undefined ? {} : { nextSteps };
    const store = new DefaultConfigStore({ autonomy, features: {} } as unknown as Config);
    container.bind(TOKENS.ConfigStore, () => store);
  }

  const tools = new ToolRegistry();
  const events = new EventBus();
  const responses: ContentBlock[][] = [];
  events.on('provider.response', (e) => responses.push(e.content as ContentBlock[]));
  const sessionStore = new DefaultSessionStore({ dir: path.join(tmp, 'sessions') });
  const session = await sessionStore.create({ id: '', model: 'test-model', provider: 'mock' });
  const ctx = new Context({
    systemPrompt: [{ type: 'text', text: 'test agent' }],
    provider,
    session,
    signal: new AbortController().signal,
    tokenCounter: container.resolve(TOKENS.TokenCounter),
    cwd: tmp,
    projectRoot: tmp,
    model: 'test-model',
    agentId: 'leader',
  });
  const agent = new Agent({
    container,
    tools,
    providers: new ProviderRegistry(),
    events,
    pipelines: createDefaultPipelines(),
    context: ctx,
    maxIterations: 10,
    toolExecutor: new ToolExecutor(tools, {
      permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
      secretScrubber: container.resolve(TOKENS.SecretScrubber),
      events,
      confirmAwaiter: undefined,
      iterationTimeoutMs: 300_000,
      perIterationOutputCapBytes: 100_000,
      tracer: undefined,
    }),
  });
  return { agent, ctx, responses };
}

const say = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  stopReason: 'end_turn' as const,
});

const lastAssistantText = (ctx: Context): string => {
  const msg = [...ctx.messages].reverse().find((m) => m.role === 'assistant');
  const content = msg?.content;
  return Array.isArray(content)
    ? content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('')
    : String(content ?? '');
};

describe('required next steps (E2E through the agent loop)', () => {
  it('fills a missing block before the response is emitted, persisted, or returned', async () => {
    const provider = new MockProvider([
      say('Fixed the parser and its tests pass.'),
      say('<nextsteps>\n1. Add a fuzz test for the parser auto="true"\n</nextsteps>'),
    ]);
    const { agent, ctx, responses } = await buildAgent(provider, 'required');

    const result = await agent.run('fix the parser');

    expect(result.status).toBe('done');
    expect(result.finalText).toBeDefined();

    expect(provider.calls).toBe(2);
    const side = provider.receivedRequests[1]!;
    expect(JSON.stringify(side.messages.at(-1))).toContain('[nextsteps_required]');
    // The side exchange itself never enters history.
    expect(JSON.stringify(ctx.messages)).not.toContain('[nextsteps_required]');

    for (const text of [
      result.finalText!,
      lastAssistantText(ctx),
      responses
        .at(-1)!
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join(''),
    ]) {
      expect(text).toContain('Fixed the parser and its tests pass.');
      expect(parseNextSteps(text).texts).toEqual(['Add a fuzz test for the parser']);
      expect(parseNextSteps(text).autoTexts).toEqual(['Add a fuzz test for the parser']);
    }
  });

  it('is the default for a configured host whose config omits the key', async () => {
    const provider = new MockProvider([say('Done.'), say('<nextsteps-complete/>')]);
    const { agent } = await buildAgent(provider, undefined);
    await agent.run('do it');
    expect(provider.calls).toBe(2);
  });

  it('ends the run when the side request declares the work complete', async () => {
    const provider = new MockProvider([say('All done, verified.'), say('<nextsteps-complete/>')]);
    const { agent } = await buildAgent(provider, 'required');
    const result = await agent.run('finish');
    expect(provider.calls).toBe(2);
    expect(result.status).toBe('done');
    expect(result.finalText).toBeDefined();
    expect(parseNextSteps(result.finalText!).texts).toEqual([]);
    expect(result.finalText).toContain('All done, verified.');
  });

  it('makes no side request when the model already wrote the marker', async () => {
    const provider = new MockProvider([say('All done.\n<nextsteps-complete/>')]);
    const { agent } = await buildAgent(provider, 'required');
    const result = await agent.run('finish');
    expect(provider.calls).toBe(1);
    expect(result.status).toBe('done');
    expect(result.finalText).toBeDefined();
    expect(parseNextSteps(result.finalText!).stripped).toBe('All done.');
  });

  it('asks for the required gate in the live request', async () => {
    const provider = new MockProvider([say('Done.\n<nextsteps-complete/>')]);
    const { agent } = await buildAgent(provider, 'required');
    await agent.run('go');
    expect(JSON.stringify(provider.receivedRequests[0]!.messages)).toContain(
      'Next-steps mode = required',
    );
  });

  it.each([
    ['optional mode', 'optional' as const],
    ['a bare kernel with no config store', null],
  ])('makes no side request for %s', async (_name, mode) => {
    const provider = new MockProvider([say('Done.')]);
    const { agent } = await buildAgent(provider, mode);
    const result = await agent.run('go');
    expect(provider.calls).toBe(1);
    expect(result.finalText).toBe('Done.');
  });
});
