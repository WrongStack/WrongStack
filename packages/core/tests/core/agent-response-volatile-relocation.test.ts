/**
 * A request middleware that appends a per-request block to `request.system`
 * (SAGE turn-context, `@file` mentions, skill suggestions) runs AFTER the base
 * request is composed. On a wire with explicit breakpoints the cache order is
 * tools → system → messages, so a changing byte at the end of `system` is
 * placed before every message and invalidates the whole cached conversation.
 *
 * Automatic-cache providers already had those blocks replayed into the message
 * tail; the explicit-breakpoint (native) path must do the same: the block still
 * reaches the model, but after the deepest cache boundary and without a
 * breakpoint marker of its own.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentInternals } from '../../src/core/agent-internals.js';
import { createAgentResponseHandler } from '../../src/core/agent-response.js';
import type { Context } from '../../src/core/context.js';
import { markVolatileSystemBlock, type TextBlock } from '../../src/types/blocks.js';
import type { Message } from '../../src/types/messages.js';
import type { Request } from '../../src/types/provider.js';
import { createContextEvidenceState } from '../../src/utils/context-evidence.js';

const MARK = 'churning-recall';

function harness(opts: { withHistory: boolean; cacheControl?: 'auto' | 'native' | 'none' }) {
  const ctx = {
    agentId: 'leader',
    todos: [],
    tools: [],
    systemPrompt: [{ type: 'text', text: 'stable identity prompt' }],
    memoryEvidence: [],
    messages: opts.withHistory
      ? ([{ role: 'user', content: [{ type: 'text', text: 'start' }] }] as Message[])
      : ([] as Message[]),
    contextEvidence: createContextEvidenceState(),
    toolAdjacencyDirty: false,
    readFiles: new Set(),
    fileMtimes: new Map(),
    meta: {} as Record<string, unknown>,
    provider: { id: 'test', capabilities: { cacheControl: opts.cacheControl } },
    model: 'test-model',
    clearFileTracking: () => {},
    waitForModelTransition: vi.fn(async () => {}),
  } as never as Context;

  let n = 0;
  const a = {
    ctx,
    tools: { listForProvider: () => [], list: () => [] },
    pipelines: {
      request: {
        // What every volatile-block middleware does, changing on EVERY request.
        run: async (request: Request): Promise<Request> => ({
          ...request,
          system: [
            ...(request.system ?? []),
            markVolatileSystemBlock({
              type: 'text',
              text: `<memory_evidence>${MARK} #${++n}</memory_evidence>`,
              cache_control: { type: 'ephemeral' },
            }),
          ],
        }),
      },
    },
    events: { emit: vi.fn() },
    logger: { warn: vi.fn() },
  } as never as AgentInternals;
  return { ctx, handler: createAgentResponseHandler(a) };
}

/** What the wire hashes: breakpoint markers and estimator memos are not content. */
const wireVisible = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value), (key, v) =>
    key === 'cache_control' || key === '_estTokens' ? undefined : v,
  );

function pushToolTurn(ctx: Context, i: number): void {
  ctx.messages.push(
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `step ${i}` },
        { type: 'tool_use', id: `t${i}`, name: 'grep', input: { path: `src/${i}.ts` } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `t${i}`, name: 'grep', content: `out ${i}` }],
    },
  );
}

describe('volatile middleware blocks on the explicit-breakpoint (native) wire', () => {
  it('keeps the churning block out of system and after the cache boundary', async () => {
    const { ctx, handler } = harness({ withHistory: true, cacheControl: 'native' });
    const systems: string[] = [];
    let previousPrefix: string | undefined;

    for (let i = 0; i < 4; i++) {
      const { request } = await handler.buildAndRunRequestPipeline({});
      const system = (request.system ?? []) as TextBlock[];
      systems.push(JSON.stringify(system));

      // Never inside `system`, which precedes the whole conversation on the wire.
      expect(system.some((b) => b.text.includes(MARK))).toBe(false);

      // ... but it still reaches the model, in the last message.
      const last = request.messages[request.messages.length - 1] as Message;
      expect(JSON.stringify(last)).toContain(MARK);
      // It carries no breakpoint of its own: that would become the deepest one.
      const tail = (Array.isArray(last.content) ? last.content : []) as {
        text?: string;
        cache_control?: unknown;
      }[];
      const churn = tail.find((b) => b.text?.includes(MARK));
      expect(churn?.cache_control).toBeUndefined();

      // Every message before the last is append-only across requests.
      const prefix = JSON.stringify(wireVisible(request.messages.slice(0, -1)));
      if (previousPrefix !== undefined) {
        expect(prefix.startsWith(previousPrefix.slice(0, -1))).toBe(true);
      }
      previousPrefix = prefix;

      pushToolTurn(ctx, i);
    }
    expect(new Set(systems).size).toBe(1);
  });

  it('still carries the block when there is no history to attach it to', async () => {
    // Degenerate embedder flow: nothing to hang a tail on, so the legacy
    // placement (the block stays in `system`) is the only way it can arrive.
    const { handler } = harness({ withHistory: false, cacheControl: 'native' });
    const { request } = await handler.buildAndRunRequestPipeline({});
    const text = JSON.stringify([request.system, request.messages]);
    expect(text).toContain(MARK);
  });

  it('leaves automatic-cache providers on their existing replay path', async () => {
    const { ctx, handler } = harness({ withHistory: true, cacheControl: 'auto' });
    for (let i = 0; i < 3; i++) {
      const { request } = await handler.buildAndRunRequestPipeline({});
      expect(((request.system ?? []) as TextBlock[]).some((b) => b.text.includes(MARK))).toBe(
        false,
      );
      expect(JSON.stringify(request.messages)).toContain(MARK);
      pushToolTurn(ctx, i);
    }
  });
});
