import { markVolatileSystemBlock, type TextBlock } from '@wrongstack/contracts/types/blocks';
import type { Message } from '@wrongstack/contracts/types/messages';
import type { Provider, Request } from '@wrongstack/contracts/types/provider';
import { describe, expect, it } from 'vitest';
import type { AgentInternals } from '../../src/core/agent-internals.js';
import { createAgentResponseHandler } from '../../src/core/agent-response.js';
import { publishRequestResidency } from '../../src/core/request-layout-capture.js';
import { SYSTEM_BLOCK_SOURCE } from '../../src/core/system-prompt-blocks.js';
import { createContextEvidenceState } from '../../src/utils/context-evidence.js';
import {
  commitRequestLayout,
  getRequestResidency,
  recordRequestLayoutUsage,
} from '../../src/utils/request-layout.js';

const user = (text: string): Message => ({ role: 'user', content: text });

function harness(cacheControl: 'native' | 'auto') {
  const provider = { id: `p-${cacheControl}`, capabilities: { cacheControl } } as Provider;
  const identity: TextBlock = { type: 'text', text: 'identity '.repeat(50) };
  const plan: TextBlock = { type: 'text', text: 'PLAN: step 1 of 3' };
  SYSTEM_BLOCK_SOURCE.set(identity, 'identity');
  SYSTEM_BLOCK_SOURCE.set(plan, 'plan');
  const ctx = {
    agentId: 'leader',
    todos: [],
    tools: [],
    catalogTools: [],
    systemPrompt: [identity, plan],
    memoryEvidence: [{ source: 'sage', text: 'remembered fact' }],
    messages: [user('inspect the repo')],
    contextEvidence: createContextEvidenceState(),
    toolAdjacencyDirty: false,
    provider,
    model: 'm1',
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
            markVolatileSystemBlock({ type: 'text', text: '<turn_memory>\nrecall</turn_memory>' }),
          ],
        }),
      },
    },
    events: { emit: () => {} },
    logger: { warn: () => {} },
  } as unknown as AgentInternals;
  return { ctx, handler: createAgentResponseHandler(a) };
}

describe('request layout recording at the request chokepoint', () => {
  it('explicit cache: epoch-volatile, memory and middleware blocks are live, not cached prefix', async () => {
    const { ctx, handler } = harness('native');
    const first = (await handler.buildAndRunRequestPipeline({})).request;
    // Built but not yet sent: no residency.
    expect(getRequestResidency(ctx)).toBeUndefined();
    commitRequestLayout(ctx, first, 1_000);

    const r = getRequestResidency(ctx);
    const live = r?.segments.find((s) => s.kind === 'live-tail');
    expect(live?.lane).toBe('uncached');
    const sources = live?.parts?.map((p) => p.source).sort();
    expect(sources).toEqual(['memory-evidence', 'nextsteps', 'plan', 'turn_memory']);
    // The re-homed plan block is NOT counted in the cached system prefix.
    const system = r?.segments.find((s) => s.kind === 'system');
    expect(system?.count).toBe(first.system?.length);
    expect(JSON.stringify(first.system)).not.toContain('PLAN: step 1 of 3');

    ctx.messages.push({ role: 'assistant', content: 'looked' }, user('continue'));
    const second = (await handler.buildAndRunRequestPipeline({})).request;
    commitRequestLayout(ctx, second, 2_000);
    recordRequestLayoutUsage(second, { input: 50, output: 5, cacheRead: 400, cacheWrite: 20 });
    const r2 = getRequestResidency(ctx);
    expect(r2?.breakers).toEqual([]);
    expect(r2?.segments.find((s) => s.kind === 'system')?.lane).toBe('cached');
    expect(r2?.segments.find((s) => s.kind === 'history-prior')).toMatchObject({
      lane: 'cached',
      count: 1,
    });
    expect(r2?.actual?.cacheRead).toBe(400);
  });

  it('automatic cache: the replayed snapshot of an earlier request stays in the cached prefix', async () => {
    const { ctx, handler } = harness('auto');
    const first = (await handler.buildAndRunRequestPipeline({})).request;
    commitRequestLayout(ctx, first, 1_000);
    ctx.messages.push({ role: 'assistant', content: 'looked' }, user('continue'));
    const second = (await handler.buildAndRunRequestPipeline({})).request;
    commitRequestLayout(ctx, second, 2_000);

    const r = getRequestResidency(ctx);
    expect(r?.mechanism).toBe('automatic');
    expect(r?.segments.find((s) => s.kind === 'live-snapshots')?.lane).toBe('cached');
  });
});

describe('publishRequestResidency', () => {
  it('emits one numeric context.residency point once usage landed, never before', async () => {
    const { ctx, handler } = harness('native');
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const events = {
      emit: (type: 'context.residency', payload: unknown) =>
        emitted.push({ type, payload: payload as Record<string, unknown> }),
    };
    const req = (await handler.buildAndRunRequestPipeline({})).request;
    commitRequestLayout(ctx, req, 1_000);
    publishRequestResidency(events, ctx, 'sess');
    expect(emitted).toEqual([]);

    recordRequestLayoutUsage(req, { input: 300, output: 5, cacheRead: 0, cacheWrite: 200 });
    publishRequestResidency(events, ctx, 'sess');
    expect(emitted).toHaveLength(1);
    const p = emitted[0]?.payload;
    expect(p).toMatchObject({
      sessionId: 'sess',
      provider: 'p-native',
      mechanism: 'explicit',
      verdict: 'cold',
      usageCacheWrite: 200,
      historyMessages: 1,
    });
    expect(p?.live).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'memory-evidence' })]),
    );
  });

  it('swallows a broken context instead of throwing into the loop', () => {
    const events = { emit: () => {} };
    expect(() =>
      publishRequestResidency(events, { messages: null } as never, undefined),
    ).not.toThrow();
  });
});
