import { describe, expect, it, vi } from 'vitest';
import { createAgentResponseHandler } from '../../src/core/agent-response.js';
import type { AgentInternals } from '../../src/core/agent-internals.js';
import type { Message } from '../../src/types/messages.js';
import type { Request, Response } from '../../src/types/provider.js';

/**
 * Issue #271 — a stream interrupted before the first meaningful delta must
 * not be appended to the conversation context or persisted to the session
 * journal. Strict providers reject empty assistant turns on the next
 * request, and journaled empty turns survived every repair path.
 */

interface MockInternals {
  a: AgentInternals;
  messages: Message[];
  appendedEvents: Array<Record<string, unknown>>;
  flushJournal: ReturnType<typeof vi.fn>;
  sessionFlush: ReturnType<typeof vi.fn>;
}

function makeInternals(opts: { aborted?: boolean } = {}): MockInternals {
  const messages: Message[] = [];
  const appendedEvents: Array<Record<string, unknown>> = [];
  const flushJournal = vi.fn(async () => {});
  const sessionFlush = vi.fn(async () => {});
  const controller = new AbortController();
  if (opts.aborted) controller.abort();

  const ctx = {
    session: {
      id: 'sess-271',
      append: vi.fn(async (ev: Record<string, unknown>) => {
        appendedEvents.push(ev);
      }),
      flush: sessionFlush,
    },
    state: {
      appendMessage: vi.fn((msg: Message) => {
        messages.push(msg);
      }),
    },
    tokenCounter: { account: vi.fn() },
    signal: controller.signal,
    toolAdjacencyDirty: false,
    provider: { capabilities: { streaming: true } },
    flushConversationJournal: flushJournal,
  };

  const a = {
    ctx,
    events: { emit: vi.fn() },
    pipelines: {
      response: { run: vi.fn(async (res: Response) => res) },
      assistantOutput: { run: vi.fn(async (block: unknown) => block) },
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    renderer: undefined,
  } as unknown as AgentInternals;

  return { a, messages, appendedEvents, flushJournal, sessionFlush };
}

const req = { model: 'test-model' } as Request;

function res(content: Response['content']): Response {
  return { content, stopReason: 'end_turn', usage: { input: 0, output: 0 }, model: 'test-model' };
}

describe('processResponse — empty assistant turns (#271)', () => {
  it('does not append or persist an aborted stream with zero output', async () => {
    const { a, messages, appendedEvents, flushJournal, sessionFlush } = makeInternals({
      aborted: true,
    });
    const handler = createAgentResponseHandler(a);

    // The exact shape streaming-response-builder produces for an empty stream.
    const result = await handler.processResponse(res([{ type: 'text', text: '' }]), req);

    expect(result.aborted).toBe(true);
    expect(result.finalText).toBe('');
    expect(messages).toHaveLength(0);
    expect(appendedEvents).toHaveLength(0);
    expect(flushJournal).not.toHaveBeenCalled();
    expect(sessionFlush).not.toHaveBeenCalled();
  });

  it('does not append or persist a non-aborted empty response', async () => {
    const { a, messages, appendedEvents } = makeInternals();
    const handler = createAgentResponseHandler(a);

    const result = await handler.processResponse(res([{ type: 'text', text: '  \n' }]), req);

    expect(result.aborted).toBe(false);
    expect(result.finalText.trim()).toBe('');
    expect(messages).toHaveLength(0);
    expect(appendedEvents).toHaveLength(0);
  });

  it('preserves meaningful partial text streamed before an abort', async () => {
    const { a, messages, appendedEvents } = makeInternals({ aborted: true });
    const handler = createAgentResponseHandler(a);

    const result = await handler.processResponse(res([{ type: 'text', text: 'partial ans' }]), req);

    expect(result.aborted).toBe(true);
    expect(result.finalText).toBe('partial ans');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial ans' }],
    });
    expect(appendedEvents).toHaveLength(1);
    expect(appendedEvents[0]).toMatchObject({ type: 'llm_response' });
  });

  it('keeps tool-call-only assistant responses and marks adjacency dirty', async () => {
    const { a, messages, appendedEvents } = makeInternals();
    const handler = createAgentResponseHandler(a);

    const result = await handler.processResponse(
      res([{ type: 'tool_use', id: 'u1', name: 'read', input: {} }]),
      req,
    );

    expect(result.aborted).toBe(false);
    expect(messages).toHaveLength(1);
    expect(appendedEvents).toHaveLength(1);
    expect(a.ctx.toolAdjacencyDirty).toBe(true);
  });

  it('keeps thinking responses that carry a signature', async () => {
    const { a, messages, appendedEvents } = makeInternals({ aborted: true });
    const handler = createAgentResponseHandler(a);

    const result = await handler.processResponse(
      res([{ type: 'thinking', thinking: '', signature: 'sig-1' }]),
      req,
    );

    expect(result.aborted).toBe(true);
    expect(messages).toHaveLength(1);
    expect(appendedEvents).toHaveLength(1);
  });
});
