import { markVolatileSystemBlock, type TextBlock } from '@wrongstack/contracts/types/blocks';
import type { Message } from '@wrongstack/contracts/types/messages';
import type { Provider, Request } from '@wrongstack/contracts/types/provider';
import { describe, expect, it } from 'vitest';
import type { AgentInternals } from '../../src/core/agent-internals.js';
import { createAgentResponseHandler } from '../../src/core/agent-response.js';
import { RequestContextReplay } from '../../src/core/request-context-replay.js';
import { createContextEvidenceState } from '../../src/utils/context-evidence.js';

const provider = { id: 'account-alias', capabilities: { cacheControl: 'auto' } } as Provider;
const live = (text: string): TextBlock[] => [{ type: 'text', text }];
const user = (text: string): Message => ({ role: 'user', content: text });

describe('automatic-cache live context replay', () => {
  it('retains previous snapshots and appends changed state without mutating history', () => {
    const replay = new RequestContextReplay();
    const history = [user('inspect')];
    const first = replay.compose(history, live('plan A'), provider, 'thread');
    history.push({ role: 'assistant', content: 'done' }, user('continue'));
    const second = replay.compose(history, live('plan B'), provider, 'thread');
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second.at(-1)?.content).toEqual([
      { type: 'text', text: '[live_context]' },
      ...live('plan B'),
    ]);
    expect(JSON.stringify(history)).not.toContain('[live_context]');
  });

  it('deduplicates unchanged context across new durable messages and retries', () => {
    const replay = new RequestContextReplay();
    const history = [user('inspect')];
    const first = replay.compose(history, live('fixed state'), provider, 'thread');
    expect(replay.compose(history, live('fixed state'), provider, 'thread')).toEqual(first);
    history.push({ role: 'assistant', content: 'done' });
    const second = replay.compose(history, live('fixed state'), provider, 'thread');
    expect(second).toEqual([...first, history[1]]);
    expect(JSON.stringify(second).match(/fixed state/g)).toHaveLength(1);
  });

  it('appends an update at the same history position rather than replacing the old snapshot', () => {
    const replay = new RequestContextReplay();
    const history = [user('inspect')];
    const first = replay.compose(history, live('A'), provider, 'thread');
    const second = replay.compose(history, live('B'), provider, 'thread');
    const third = replay.compose(history, live('A'), provider, 'thread');
    expect(second.slice(0, first.length)).toEqual(first);
    expect(third.slice(0, second.length)).toEqual(second);
    expect(third).toHaveLength(4);
  });

  it.each(['thread', 'provider', 'rewrite', 'mutation', 'clear'])(
    'drops stale snapshots on %s changes',
    (change) => {
      const replay = new RequestContextReplay();
      const history = [user('inspect')];
      replay.compose(history, live('old secret state'), provider, 'thread');
      const current = change === 'clear' ? [] : change === 'rewrite' ? [user('digest')] : history;
      if (change === 'mutation') history[0]!.content = 'compacted in place';
      const next = replay.compose(
        current,
        live('current'),
        change === 'provider' ? { ...provider } : provider,
        change === 'thread' ? 'other-thread' : 'thread',
      );
      expect(JSON.stringify(next)).not.toContain('old secret state');
      expect(JSON.stringify(next)).toContain('current');
    },
  );

  it('clears live state with an empty snapshot, but sends no snapshot for an initially empty context', () => {
    const replay = new RequestContextReplay();
    const history = [user('inspect')];
    expect(replay.compose(history, [], provider, 'thread')).toEqual(history);
    const first = replay.compose(history, live('A'), provider, 'thread');
    const second = replay.compose(history, [], provider, 'thread');
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second.at(-1)?.content).toEqual([{ type: 'text', text: '[live_context]' }]);
  });

  it('owns snapshot text instead of retaining mutable blocks or cache markers', () => {
    const replay = new RequestContextReplay();
    const context = [
      { type: 'text', text: 'A', cache_control: { type: 'ephemeral' } },
    ] as TextBlock[];
    const first = replay.compose([user('inspect')], context, provider, 'thread');
    context[0]!.text = 'changed';
    expect(JSON.stringify(first)).toContain('"A"');
    expect(JSON.stringify(first)).not.toContain('cache_control');
  });

  it('includes volatile middleware in replay for an aliased provider', async () => {
    let memory = 'memory A';
    const ctx = {
      agentId: 'worker',
      todos: [],
      tools: [],
      catalogTools: [],
      systemPrompt: [],
      memoryEvidence: [],
      messages: [user('inspect')],
      contextEvidence: createContextEvidenceState(),
      toolAdjacencyDirty: false,
      provider,
      model: 'gpt-6.1-sol',
      session: { id: 'thread' },
      meta: {},
      waitForModelTransition: async () => {},
    } as unknown as AgentInternals['ctx'];
    const a = {
      ctx,
      tools: { listForProvider: () => [], list: () => [] },
      pipelines: {
        request: {
          run: async (request: Request) => ({
            ...request,
            system: [
              ...(request.system ?? []),
              markVolatileSystemBlock({ type: 'text', text: memory }),
            ],
          }),
        },
      },
      events: { emit: () => {} },
      logger: { warn: () => {} },
    } as unknown as AgentInternals;
    const handler = createAgentResponseHandler(a);
    const first = (await handler.buildAndRunRequestPipeline({})).request;
    memory = 'memory B';
    ctx.messages.push({ role: 'assistant', content: 'done' }, user('continue'));
    const second = (await handler.buildAndRunRequestPipeline({})).request;
    expect(first.system).toEqual(second.system);
    expect(JSON.stringify(second.system)).not.toContain('memory A');
    expect(JSON.stringify(second.system)).not.toContain('memory B');
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(JSON.stringify(second.messages.at(-1))).toContain('memory B');
    expect(JSON.stringify(ctx.messages)).not.toContain('memory A');
    expect(JSON.stringify(ctx.messages)).not.toContain('memory B');
  });
});
