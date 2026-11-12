import type { Context } from '@wrongstack/core/agent';
import { priceCliffRouteKey, writePriceCliffMeta } from '@wrongstack/core/utils';
import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { createSessionHandlers } from '../src/server/session-handlers.js';

/**
 * The Context X-Ray payload.
 *
 * `context.debug` grew two display-only sections: `xray`, core's canonical
 * per-section accounting (the same numbers the CLI `/context` report and the
 * TUI bar use), and `cliff`, the long-context price boundary with the
 * `min(threshold x window, cliff)` trigger the compaction ladder actually
 * applies.
 *
 * These are additive and must never fail the reply they ride on, so the cases
 * here are the ones that could silently break a viewer: a context whose tool
 * definitions and tool_result blocks are real (the rows the user asked to see —
 * MCP schemas and file outputs), and a route whose cliff is published versus
 * one that is merely stale.
 */

const ws = {} as WebSocket;

interface XrayReply {
  total: number;
  xray?: {
    total: number;
    system: { total: number; bySource: Record<string, number> };
    tools: {
      total: number;
      builtin: number;
      mcp: number;
      count: number;
      mcpByServer: Record<string, number>;
    };
    history: {
      total: number;
      text: number;
      toolInputs?: number;
      toolResults: number;
      messageCount: number;
    };
    effectiveMaxContext: number;
    warnings: string[];
  };
  cliff?: {
    binding: boolean;
    cliffTokens: number;
    triggerTokens: number;
    uncappedTriggerTokens: number;
  };
}

function mkContext(id: string, opts: { cliffRoute?: string } = {}): Context {
  const meta: Record<string, unknown> = {
    contextWindowMode: 'balanced',
    contextWindowPolicy: {
      id: 'balanced',
      thresholds: { warn: 0.55, soft: 0.7, hard: 0.85 },
      aggressiveOn: 'soft',
      preserveK: 8,
      eliseThreshold: 1200,
      targetLoad: 0.65,
    },
  };
  // A cliff stamped for another route must not be shown as this session's cap.
  if (opts.cliffRoute) {
    writePriceCliffMeta(
      meta,
      { cliffTokens: 200_000, multiplier: 2, field: 'input', baseRate: 3, cliffRate: 6 },
      opts.cliffRoute,
    );
  }
  const messages: unknown[] = [
    { role: 'user', content: 'read the config' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'reading it now' },
        {
          type: 'tool_use',
          id: 't1',
          name: 'read',
          input: { path: 'a-config-file-with-some-length.txt' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: 'file body '.repeat(40),
        },
      ],
    },
  ];
  return {
    session: { id, append: async () => undefined, close: async () => undefined },
    systemPrompt: [
      { type: 'text', text: 'You are the leader agent. '.repeat(12) },
      { type: 'text', text: 'Project instructions for this repository. '.repeat(12) },
    ],
    // Real definitions: getContextBreakdown walks `ctx.tools` directly, so a
    // context without them is not a context the viewer can report on.
    tools: [
      { name: 'read', description: 'Read a file from disk', inputSchema: { type: 'object' } },
      {
        name: 'mcp__kanban__create_card',
        description: 'Create a kanban card',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
      },
      {
        name: 'mcp__sage__recall',
        description: 'Recall project memory',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ],
    messages,
    provider: { id: 'p', capabilities: { maxContext: 1_000_000 } },
    model: 'm',
    meta,
    lastRequestTokens: 0,
    tokenCounter: { reset: vi.fn(), total: () => ({ input: 0, output: 0 }), account: vi.fn() },
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
    clearMemoryEvidence: vi.fn(),
    flushConversationJournal: vi.fn(async () => undefined),
    state: {
      messages,
      todos: [],
      replaceMessages: vi.fn(),
      replaceTodos: vi.fn(),
      setMeta: vi.fn(),
      deleteMeta: vi.fn(),
    },
  } as never as Context;
}

function harness(id: string, opts: { cliffRoute?: string } = {}) {
  const context = mkContext(id, opts);
  const sent: Array<{ type: string; payload: unknown }> = [];
  const handlers = createSessionHandlers({
    config: { model: 'm', provider: 'p' },
    context: context as never,
    tokenCounter: { account: vi.fn(), total: () => ({}), reset: vi.fn() } as never,
    listTools: () => [],
    getCompactor: () => ({ compact: async () => ({ before: 1, after: 1 }) }) as never,
    getCustomModeStore: async () => ({ list: () => [], remove: () => ({ ok: true }) }) as never,
    getProjectRoot: () => '/repo',
    getSession: () => context.session as never,
    setSession: vi.fn(),
    getSessionStore: () => ({ list: async () => [] }) as never,
    hasSession: () => true,
    getAgent: () => ({ ctx: context }) as never,
    peekAgent: () => ({ ctx: context }) as never,
    sessionStartPayload: async (o) => ({ ...o }) as never,
    sendMessage: (_ws, message) => sent.push(message),
    broadcastMessage: (message) => sent.push(message),
  });
  return { handlers, sent };
}

async function debugReply(h: ReturnType<typeof harness>): Promise<XrayReply> {
  await h.handlers.debugContext(ws, { type: 'context.debug', payload: {} });
  return h.sent.find((m) => m.type === 'context.debug')?.payload as XrayReply;
}

describe('context.debug Context X-Ray payload', () => {
  it('reports per-section occupancy, including MCP schemas and file outputs', async () => {
    const reply = await debugReply(harness('sess_xray'));
    const xray = reply.xray;
    expect(xray).toBeDefined();
    // Nothing was silently dropped: a broken volatile builder only warns.
    expect(xray?.warnings).toEqual([]);

    expect(xray?.system.total ?? 0).toBeGreaterThan(0);
    expect(xray?.tools.count).toBe(3);
    // One builtin + two `mcp__<server>__<tool>` definitions.
    expect(xray?.tools.mcp).toBeGreaterThan(0);
    expect(xray?.tools.builtin).toBeGreaterThan(0);
    expect(xray?.tools.mcp).toBeLessThan(xray?.tools.total ?? 0);
    expect(Object.keys(xray?.tools.mcpByServer ?? {}).sort()).toEqual(['kanban', 'sage']);

    // The rows the viewer sells: tool arguments and tool_result file bodies
    // are accounted separately instead of hiding inside "text".
    expect(xray?.history.toolInputs ?? 0).toBeGreaterThan(0);
    expect(xray?.history.toolResults).toBeGreaterThan(xray?.history.text ?? 0);
    expect(xray?.history.messageCount).toBe(3);

    const parts = (xray?.system.total ?? 0) + (xray?.tools.total ?? 0) + (xray?.history.total ?? 0);
    expect(xray?.total).toBeGreaterThanOrEqual(parts);
    expect(xray?.effectiveMaxContext).toBe(1_000_000);
    // The coarse total the modal already renders stays the other estimator's
    // business; the X-Ray total is the canonical one and both are populated.
    expect(reply.total).toBeGreaterThan(0);
  });

  it('publishes the cliff the ladder will actually use, for this route only', async () => {
    const route = priceCliffRouteKey('p', 'm');
    const hit = await debugReply(harness('sess_cliff', { cliffRoute: route }));
    expect(hit.cliff?.binding).toBe(true);
    expect(hit.cliff?.cliffTokens).toBe(200_000);
    // 1M window: the window-relative soft rung is ~691K, the cliff forces 190K.
    expect(hit.cliff?.triggerTokens).toBe(190_000);
    expect(hit.cliff?.uncappedTriggerTokens).toBeGreaterThan(hit.cliff?.triggerTokens ?? 0);

    // Same cliff, stamped for a different model route: must not be shown, since
    // the viewer would advertise a cap that never fires for this session.
    const stale = await debugReply(
      harness('sess_stale', { cliffRoute: priceCliffRouteKey('p', 'other') }),
    );
    expect(stale.cliff).toBeUndefined();
    // The X-Ray itself is route-independent and still renders.
    expect(stale.xray?.tools.count).toBe(3);
  });

  it('omits the cliff section when none is published', async () => {
    const reply = await debugReply(harness('sess_none'));
    expect(reply.cliff).toBeUndefined();
    expect(reply.xray).toBeDefined();
  });
});
