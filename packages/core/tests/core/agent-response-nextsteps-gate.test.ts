import { describe, expect, it, vi } from 'vitest';
import type { AgentInternals } from '../../src/core/agent-internals.js';
import {
  buildLiveNextStepsGateBlock,
  createAgentResponseHandler,
} from '../../src/core/agent-response.js';
import type { TodoItem } from '../../src/core/context.js';
import { conversationBoundToRequest } from '../../src/core/request-conversation-binding.js';
import { tagBlock } from '../../src/core/system-prompt-blocks.js';
import type { Request } from '../../src/types/provider.js';
import {
  createContextEvidenceState,
  recordUserIntentEvidence,
} from '../../src/utils/context-evidence.js';

const todo = (id: string, status: TodoItem['status'], content = `todo ${id}`): TodoItem => ({
  id,
  status,
  content,
});

describe('buildLiveNextStepsGateBlock', () => {
  it('requires nextsteps or an explicit no-further-steps explanation when no todos are open', () => {
    const block = buildLiveNextStepsGateBlock({
      agentId: 'leader',
      todos: [todo('done', 'completed')],
    });

    // Marker-free by design: rides the live-context tail after the deep cache
    // boundary, so a cache_control marker would re-create per-request churn.
    expect(block?.cache_control).toBeUndefined();
    expect(block?.text).toContain('open todos = 0');
    expect(block?.text).toContain('MUST take exactly one branch');
    expect(block?.text).toContain('include a balanced <nextsteps> block');
    expect(block?.text).toContain('submitted back to you through the current TUI or WebUI input');
    expect(block?.text).toContain('Never put a human-only chore');
    expect(block?.text).toContain('need not be shell commands');
    expect(block?.text).toContain('explicitly tell the user');
    expect(block?.text).toContain('Silently omitting both is invalid');
  });

  it('requires omission and exposes the current open todo snapshot', () => {
    const block = buildLiveNextStepsGateBlock({
      agentId: 'leader',
      todos: [
        todo('a', 'pending', 'write focused tests'),
        todo('b', 'completed', 'old work'),
        todo('c', 'in_progress', 'verify the implementation'),
      ],
    });

    expect(block?.text).toContain('open todos = 2');
    expect(block?.text).toContain('MUST omit <nextsteps> entirely');
    expect(block?.text).toContain('- [pending] write focused tests');
    expect(block?.text).toContain('- [in_progress] verify the implementation');
    expect(block?.text).not.toContain('old work');
  });

  it('does not inject the leader contract into subagents', () => {
    expect(
      buildLiveNextStepsGateBlock({
        agentId: 'researcher',
        todos: [],
      }),
    ).toBeUndefined();
  });

  it('switches branches from the mutated live todo state on the next request', () => {
    const context = {
      agentId: 'leader',
      todos: [todo('a', 'in_progress', 'finish current work')],
    };

    expect(buildLiveNextStepsGateBlock(context)?.text).toContain('open todos = 1');
    context.todos[0]!.status = 'completed';
    expect(buildLiveNextStepsGateBlock(context)?.text).toContain('open todos = 0');
  });

  it('bounds and normalizes the todo snapshot without changing the live count', () => {
    const todos = Array.from({ length: 12 }, (_, index) =>
      todo(String(index), 'pending', `todo   ${index}\nwith spacing`),
    );
    const block = buildLiveNextStepsGateBlock({ agentId: 'leader', todos });

    expect(block?.text).toContain('open todos = 12');
    expect(block?.text).toContain('- [pending] todo 0 with spacing');
    expect(block?.text).toContain('…and 2 more open todo(s)');
  });
});

describe('provider request live-context tail', () => {
  /** Every content block carrying a cache_control marker, in wire order. */
  const markedBlocks = (
    messages: readonly { content: unknown }[],
  ): { type: string; content?: string; text?: string }[] =>
    messages.flatMap((message) =>
      Array.isArray(message.content)
        ? (message.content as { cache_control?: unknown }[]).filter((b) => b.cache_control)
        : [],
    ) as { type: string; content?: string; text?: string }[];

  const makeInternals = (
    overrides: Partial<Record<'messages' | 'systemPrompt' | 'todos', unknown>> = {},
  ) => {
    const contextEvidence = createContextEvidenceState();
    const ctx = {
      agentId: 'leader',
      todos: overrides.todos ?? [],
      tools: [],
      systemPrompt: overrides.systemPrompt ?? [],
      memoryEvidence: [],
      messages: overrides.messages ?? [],
      contextEvidence,
      toolAdjacencyDirty: false,
      provider: { id: 'test', capabilities: {} },
      model: 'test-model',
      waitForModelTransition: vi.fn(async () => {}),
    } as never as AgentInternals['ctx'];
    const a = {
      ctx,
      tools: { listForProvider: () => [] },
      pipelines: { request: { run: async (request: Request) => request } },
      events: { emit: vi.fn() },
      logger: { warn: vi.fn() },
    } as never as AgentInternals;
    return { ctx, a };
  };

  it('binds the owning conversation session to the provider request side-channel', async () => {
    const { ctx, a } = makeInternals();
    ctx.session = { id: 'conversation-alpha' };

    const built = await createAgentResponseHandler(a).buildAndRunRequestPipeline({});

    expect(conversationBoundToRequest(built.request)?.sessionId).toBe('conversation-alpha');
  });

  it('falls back to a system suffix only when there is no history to attach to', async () => {
    const { ctx, a } = makeInternals();
    recordUserIntentEvidence(ctx, 'Fix the context-loss bug');
    recordUserIntentEvidence(ctx, 'Continue without spending excessive tokens');

    const request = await createAgentResponseHandler(a).buildAndRunRequestPipeline({});
    const systemText = request.request.system?.map((block) => block.text).join('\n') ?? '';
    expect(systemText).toContain('[conversation_continuity]');
    expect(systemText).toContain('Fix the context-loss bug');
    expect(systemText).toContain('Continue without spending excessive tokens');
  });

  it('rides the trailing user message and never the system prompt when history exists', async () => {
    const history = [
      { role: 'user', content: 'do the work' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }],
      },
    ];
    const { ctx, a } = makeInternals({ messages: history });
    recordUserIntentEvidence(ctx, 'Fix the context-loss bug');

    const request = await createAgentResponseHandler(a).buildAndRunRequestPipeline({});
    const req = request.request;
    const systemText = req.system?.map((block) => block.text).join('\n') ?? '';
    expect(systemText).not.toContain('[conversation_continuity]');

    const last = req.messages.at(-1) as { role: string; content: unknown[] };
    expect(last.role).toBe('user');
    const texts = (last.content as { type: string; text?: string }[])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '');
    expect(texts.join('\n')).toContain('[live_context]');
    expect(texts.join('\n')).toContain('[conversation_continuity]');
    expect(texts.join('\n')).toContain('[nextsteps_gate]');
  });

  it('pins the cache boundary on the last durable block, before the tail', async () => {
    const history = [
      { role: 'user', content: 'do the work' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }],
      },
    ];
    const { a } = makeInternals({ messages: history });

    const request = await createAgentResponseHandler(a).buildAndRunRequestPipeline({});
    const last = request.request.messages.at(-1) as {
      content: { type: string; cache_control?: unknown; text?: string }[];
    };
    const marked = last.content.filter((b) => b.cache_control);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.type).toBe('tool_result');
    // Every tail block sits AFTER the boundary and is marker-free.
    const boundaryIdx = last.content.findIndex((b) => b.cache_control);
    for (const block of last.content.slice(boundaryIdx + 1)) {
      expect(block.cache_control).toBeUndefined();
    }
  });

  it('re-marks the previous request boundary so the provider looks that entry up', async () => {
    const history: unknown[] = [
      { role: 'user', content: 'do the work' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
    ];
    const { ctx, a } = makeInternals({ messages: history });
    const handler = createAgentResponseHandler(a);

    const first = await handler.buildAndRunRequestPipeline({});
    expect(markedBlocks(first.request.messages)).toHaveLength(1);

    // The turn advances: history is append-only, so the position that closed
    // the first request is still present and must be marked again.
    ctx.messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'more' }] },
    );

    const second = await handler.buildAndRunRequestPipeline({});
    const marked = markedBlocks(second.request.messages);
    expect(marked).toHaveLength(2);
    // Previous boundary first, current boundary last.
    expect(marked[0]?.content).toBe('file body');
    expect(marked[1]?.content).toBe('more');
    // The durable history stays clean — the marks live only in the request copy.
    expect(JSON.stringify(ctx.messages)).not.toContain('cache_control');
  });

  it('drops the stale previous boundary after a rewrite instead of misplacing it', async () => {
    const history: unknown[] = [
      { role: 'user', content: 'do the work' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
    ];
    const { ctx, a } = makeInternals({ messages: history });
    const handler = createAgentResponseHandler(a);
    await handler.buildAndRunRequestPipeline({});

    // Compaction replaces the array; the recorded index no longer identifies
    // the recorded message, so the second breakpoint is simply skipped.
    ctx.messages = [
      {
        role: 'system',
        content: '[tool_history_digest: 1 older acknowledged exchange(s) omitted]',
      },
      { role: 'user', content: [{ type: 'text', text: 'carry on' }] },
    ] as never;

    const second = await handler.buildAndRunRequestPipeline({});
    expect(markedBlocks(second.request.messages)).toHaveLength(1);
  });

  it('re-homes epoch-volatile prompt blocks (plan/contributor/glossary) to the tail', async () => {
    const systemPrompt = [
      tagBlock(
        { type: 'text', text: 'identity text', cache_control: { type: 'ephemeral' } },
        'identity',
      ),
      tagBlock(
        { type: 'text', text: 'active plan text', cache_control: { type: 'ephemeral' } },
        'plan',
      ),
      tagBlock({ type: 'text', text: 'glossary text' }, 'glossary'),
    ];
    const history = [{ role: 'user', content: 'do the work' }];
    const { a } = makeInternals({ messages: history, systemPrompt });

    const request = await createAgentResponseHandler(a).buildAndRunRequestPipeline({});
    const req = request.request;
    const systemText = req.system?.map((block) => block.text).join('\n') ?? '';
    expect(systemText).toContain('identity text');
    expect(systemText).not.toContain('active plan text');
    expect(systemText).not.toContain('glossary text');

    const last = req.messages.at(-1) as {
      content: { type: string; text?: string; cache_control?: unknown }[];
    };
    const tailBlocks = last.content.filter((b) => b.type === 'text');
    const tailText = tailBlocks.map((b) => b.text ?? '').join('\n');
    expect(tailText).toContain('active plan text');
    expect(tailText).toContain('glossary text');
    // Re-homed copies are marker-free — the plan's epoch marker must not travel.
    const planCopy = tailBlocks.find((b) => b.text === 'active plan text');
    expect(planCopy?.cache_control).toBeUndefined();
  });

  it('derives the cache-partition key from the stable prompt part only', async () => {
    const stable = tagBlock({ type: 'text', text: 'identity text' }, 'identity');
    const epochA = [stable, tagBlock({ type: 'text', text: 'glossary v1' }, 'glossary')];
    const epochB = [stable, tagBlock({ type: 'text', text: 'glossary v2' }, 'glossary')];
    const history = [{ role: 'user', content: 'do the work' }];

    const first = makeInternals({ messages: history, systemPrompt: epochA });
    const second = makeInternals({ messages: history, systemPrompt: epochB });
    const reqA = await createAgentResponseHandler(first.a).buildAndRunRequestPipeline({});
    const reqB = await createAgentResponseHandler(second.a).buildAndRunRequestPipeline({});
    expect(reqA.request.cache?.key).toBeDefined();
    // A glossary-only refresh must not re-route the provider cache partition.
    expect(reqA.request.cache?.key).toBe(reqB.request.cache?.key);
  });

  it('strips delivered <nextsteps> blocks from past assistant turns in the request copy', async () => {
    const assistant = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'All done.\n<nextsteps>\n- run the follow-up\n</nextsteps>' },
      ],
    };
    const history = [
      { role: 'user', content: 'first task' },
      assistant,
      { role: 'user', content: 'second task' },
    ];
    const { a } = makeInternals({ messages: history });

    const request = await createAgentResponseHandler(a).buildAndRunRequestPipeline({});
    const sentAssistant = request.request.messages[1] as {
      content: { type: string; text?: string }[];
    };
    expect(JSON.stringify(sentAssistant.content)).not.toContain('<nextsteps');
    expect(sentAssistant.content[0]?.text).toContain('All done.');
    // The durable history keeps the block for resume/rendering.
    expect((assistant.content[0] as { text: string }).text).toContain('<nextsteps>');
  });

  it('replaces a nextsteps-only assistant turn with a stable placeholder', async () => {
    const history = [
      { role: 'user', content: 'first task' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '<nextsteps>\n- only suggestions\n</nextsteps>' }],
      },
      { role: 'user', content: 'second task' },
    ];
    const { a } = makeInternals({ messages: history });

    const request = await createAgentResponseHandler(a).buildAndRunRequestPipeline({});
    const sentAssistant = request.request.messages[1] as {
      content: { type: string; text?: string }[];
    };
    // Empty text blocks are invalid on the wire — a placeholder keeps the turn.
    expect(sentAssistant.content).toHaveLength(1);
    expect(sentAssistant.content[0]?.text).toContain('delivered to the user');
  });

  it('never mutates the durable history or the frozen prompt epoch', async () => {
    const toolResult = { type: 'tool_result', tool_use_id: 't1', content: 'file body' };
    const lastMessage = { role: 'user', content: [toolResult] };
    const history = [
      { role: 'user', content: 'do the work' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      lastMessage,
    ];
    const { ctx, a } = makeInternals({ messages: history });
    recordUserIntentEvidence(ctx, 'Fix the context-loss bug');

    await createAgentResponseHandler(a).buildAndRunRequestPipeline({});
    expect(ctx.messages).toHaveLength(3);
    expect(lastMessage.content).toHaveLength(1);
    expect(toolResult).not.toHaveProperty('cache_control');
  });
});
