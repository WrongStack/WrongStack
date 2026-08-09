import { describe, expect, it, vi } from 'vitest';
import {
  buildLiveNextStepsGateBlock,
  createAgentResponseHandler,
} from '../../src/core/agent-response.js';
import type { AgentInternals } from '../../src/core/agent-internals.js';
import type { TodoItem } from '../../src/core/context.js';
import type { Request } from '../../src/types/provider.js';
import { createContextEvidenceState, recordUserIntentEvidence } from '../../src/utils/context-evidence.js';

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

    expect(block?.cache_control).toEqual({ type: 'ephemeral' });
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

describe('provider request continuity evidence', () => {
  it('injects the bounded human-turn tail into every request system suffix', async () => {
    const contextEvidence = createContextEvidenceState();
    const ctx = {
      agentId: 'leader',
      todos: [],
      tools: [],
      systemPrompt: [],
      memoryEvidence: [],
      messages: [],
      contextEvidence,
      toolAdjacencyDirty: false,
      provider: { id: 'test', capabilities: {} },
      model: 'test-model',
      waitForModelTransition: vi.fn(async () => {}),
    } as never as AgentInternals['ctx'];
    recordUserIntentEvidence(ctx, 'Fix the context-loss bug');
    recordUserIntentEvidence(ctx, 'Continue without spending excessive tokens');

    const a = {
      ctx,
      tools: { listForProvider: () => [] },
      pipelines: { request: { run: async (request: Request) => request } },
      events: { emit: vi.fn() },
      logger: { warn: vi.fn() },
    } as never as AgentInternals;

    const request = await createAgentResponseHandler(a).buildAndRunRequestPipeline({});
    const systemText = request.request.system?.map((block) => block.text).join('\n') ?? '';
    expect(systemText).toContain('[conversation_continuity]');
    expect(systemText).toContain('Fix the context-loss bug');
    expect(systemText).toContain('Continue without spending excessive tokens');
  });
});
