import { markVolatileSystemBlock, type TextBlock } from '@wrongstack/contracts/types/blocks';
import type { Message } from '@wrongstack/contracts/types/messages';
import type { Provider, Request } from '@wrongstack/contracts/types/provider';
import { describe, expect, it } from 'vitest';
import type { AgentInternals } from '../../src/core/agent-internals.js';
import { recordAgentContext } from '../../src/core/agent-owned-context.js';
import { createAgentResponseHandler } from '../../src/core/agent-response.js';
import {
  publishRequestResidency,
  publishResidency,
} from '../../src/core/request-layout-capture.js';
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

describe('publishResidency on a route that keeps its own context', () => {
  // An ACP agent leading the session gets only the user's text and runs its
  // own system prompt and tools: the request composed here never went on the
  // wire, so its layout must not be charted as the agent's context.
  const agent = {
    id: 'acp',
    capabilities: { cacheControl: 'none', keepsOwnContext: true, maxContext: 0 },
  } as unknown as Provider;
  const collect = () => {
    const emitted: Array<Record<string, unknown>> = [];
    const events = {
      emit: (_type: 'context.residency', payload: unknown) =>
        emitted.push(payload as Record<string, unknown>),
    };
    return { emitted, events };
  };

  it('publishes the agent’s report, with no lanes or segments from the unsent request', async () => {
    const { ctx, handler } = harness('native');
    const req = (await handler.buildAndRunRequestPipeline({})).request;
    commitRequestLayout(ctx, req, 1_000);
    const { emitted, events } = collect();
    publishResidency(events, ctx, agent, { model: 'claude-code' }, {
      content: [],
      stopReason: 'end_turn',
      usage: { input: 1_200, output: 300, cacheRead: 40_000, cacheWrite: 2_000 },
      agentContext: { used: 52_000, size: 200_000 },
    } as never);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      sessionId: 'thread',
      provider: 'acp',
      model: 'claude-code',
      mechanism: 'agent',
      verdict: 'agent',
      maxContext: 200_000,
      total: 52_000,
      cached: 0,
      written: 0,
      uncached: 0,
      usageInput: 1_200,
      usageCacheRead: 40_000,
      usageCacheWrite: 2_000,
      segments: [],
      live: [],
      breakers: [],
      historyMessages: 0,
    });
  });

  it('falls back to the agent’s last report when a response carries none', () => {
    const ctx = {
      agentId: 'leader',
      messages: [],
      provider: agent,
      session: { id: 'thread' },
      tokenCounter: { setCurrentRequestTokens: () => {} },
    } as unknown as AgentInternals['ctx'];
    recordAgentContext(ctx, { used: 9_000, size: 1_000_000 });
    const { emitted, events } = collect();
    publishResidency(events, ctx, agent, { model: 'claude-code' }, {
      content: [],
      stopReason: 'end_turn',
      usage: { input: 10, output: 5 },
    } as never);
    expect(emitted[0]).toMatchObject({ total: 9_000, maxContext: 1_000_000, usageCacheRead: 0 });
  });

  it('keeps the measured request on every other route', async () => {
    const { ctx, handler } = harness('native');
    const req = (await handler.buildAndRunRequestPipeline({})).request;
    commitRequestLayout(ctx, req, 1_000);
    recordRequestLayoutUsage(req, { input: 300, output: 5, cacheRead: 0, cacheWrite: 200 });
    const { emitted, events } = collect();
    publishResidency(events, ctx, ctx.provider, req, {
      content: [],
      stopReason: 'end_turn',
      usage: { input: 300, output: 5 },
    } as never);
    expect(emitted[0]).toMatchObject({ mechanism: 'explicit', historyMessages: 1 });
  });
});
