/**
 * End-to-end: the `nextsteps` tool's items reach the assistant's final text.
 *
 * The unit layer (`tests/next-steps-slot.test.ts`) pins the slot and the
 * renderer. This file pins the CHAIN — tool call → agent loop iteration →
 * turn-ending response → `finalText` — because that is what every suggestion
 * surface reads. It also pins the per-prompt reset, which cannot be observed
 * from the slot module alone.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, createDefaultPipelines } from '../../src/core/agent.js';
import { Context } from '../../src/core/context.js';
import { readPendingNextSteps, writePendingNextSteps } from '../../src/core/next-steps-slot.js';
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
import type { Tool } from '../../src/types/tool.js';
import { MockProvider } from '../helpers/mock-provider.js';

/**
 * Stand-in for `@wrongstack/tools`' `nextStepsTool`, which `core` cannot import
 * (package DAG). It calls the same slot writer, so the wiring under test — slot
 * → response append — is the real one.
 */
const nextStepsStub: Tool = {
  name: 'nextsteps',
  description: 'Record after-task suggestions.',
  inputSchema: {
    type: 'object',
    properties: { steps: { type: 'array', items: { type: 'object' } } },
    required: ['steps'],
  },
  permission: 'auto',
  mutating: false,
  async execute(input, ctx) {
    const steps = (input as { steps: Array<{ text: string; auto?: boolean }> }).steps;
    writePendingNextSteps(ctx, steps);
    return { accepted: steps.length };
  },
};

async function buildAgent(provider: MockProvider) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-nextsteps-'));
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

  const tools = new ToolRegistry();
  tools.register(nextStepsStub);
  const events = new EventBus();
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
    // The append is leader-only; the default agentId is 'unknown'.
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
  return { agent, ctx, tmp };
}

/** One turn: the model calls `nextsteps`, then writes its answer. */
function toolThenAnswer(answer: string, steps: Array<{ text: string; auto?: boolean }>) {
  return [
    {
      content: [{ type: 'tool_use' as const, id: 'ns1', name: 'nextsteps', input: { steps } }],
      stopReason: 'tool_use' as const,
    },
    { content: [{ type: 'text' as const, text: answer }], stopReason: 'end_turn' as const },
  ];
}

describe('nextsteps tool → final assistant text (E2E)', () => {
  let dirs: string[] = [];
  beforeEach(() => {
    dirs = [];
  });
  afterEach(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('appends the recorded steps to the turn-ending message', async () => {
    const provider = new MockProvider(
      toolThenAnswer('Parser fixed.', [
        { text: 'Run the parser tests', auto: true },
        { text: 'Update the docs' },
      ]),
    );
    const { agent, ctx, tmp } = await buildAgent(provider);
    dirs.push(tmp);

    const result = await agent.run('fix the parser');

    expect(result.finalText).toContain('Parser fixed.');
    expect(result.finalText).toContain('<nextsteps>');
    expect(result.finalText).toContain('1. Run the parser tests auto="true"');
    expect(result.finalText).toContain('2. Update the docs');
    // Consumed by the append — it must not repeat on a later response.
    expect(readPendingNextSteps(ctx)).toBeUndefined();
  });

  it('leaves the mid-turn message clean — only the final one carries the block', async () => {
    const provider = new MockProvider([
      {
        content: [
          { type: 'text', text: 'Recording the follow-ups.' },
          {
            type: 'tool_use',
            id: 'ns1',
            name: 'nextsteps',
            input: { steps: [{ text: 'Ship it' }] },
          },
        ],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'All done.' }], stopReason: 'end_turn' },
    ]);
    const { agent, ctx, tmp } = await buildAgent(provider);
    dirs.push(tmp);

    await agent.run('do the thing');

    const assistantTexts = ctx.messages
      .filter((m) => m.role === 'assistant')
      .map((m) =>
        (Array.isArray(m.content) ? m.content : [])
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join(''),
      );

    // Two assistant messages land in history: the prose the model wrote on its
    // way to the tool call, and the answer. Exactly one carries the block, and
    // it is the last — a block on the mid-turn message would offer suggestions
    // while the work was still in flight.
    expect(assistantTexts).toHaveLength(2);
    expect(assistantTexts[0]).toBe('Recording the follow-ups.');
    expect(assistantTexts.filter((t) => t.includes('<nextsteps>'))).toHaveLength(1);
    expect(assistantTexts.at(-1)).toContain('<nextsteps>');
  });

  it('clears steps left over from the previous prompt', async () => {
    const provider = new MockProvider([
      { content: [{ type: 'text', text: 'First answer.' }], stopReason: 'end_turn' },
      { content: [{ type: 'text', text: 'Second answer.' }], stopReason: 'end_turn' },
    ]);
    const { agent, ctx, tmp } = await buildAgent(provider);
    dirs.push(tmp);

    // Park steps the way a tool call would, but never let a turn consume them:
    // the first run appends and empties the slot, so re-park before the second.
    await agent.run('first prompt');
    writePendingNextSteps(ctx, [{ text: 'Stale suggestion' }]);

    const second = await agent.run('second prompt');

    // A new prompt resets the slot, so last turn's suggestion cannot attach
    // itself to this turn's answer.
    expect(second.finalText).toBe('Second answer.');
    expect(readPendingNextSteps(ctx)).toBeUndefined();
  });

  it('suppresses the block while a todo is still open', async () => {
    const provider = new MockProvider(
      toolThenAnswer('Made progress.', [{ text: 'Unrelated follow-up' }]),
    );
    const { agent, ctx, tmp } = await buildAgent(provider);
    dirs.push(tmp);

    ctx.state.replaceTodos([{ id: '1', content: 'Finish the migration', status: 'in_progress' }]);

    const result = await agent.run('keep going');

    expect(result.finalText).toBe('Made progress.');
    expect(readPendingNextSteps(ctx)).toBeUndefined();
  });
});
