import { describe, expect, it, vi } from 'vitest';
import { registerSetupEventsProviderHandlers } from '../src/server/setup-events-provider-handlers.js';

describe('registerSetupEventsProviderHandlers', () => {
  it('registers handlers for provider.response and flushes stream buffers', () => {
    const listeners: Record<string, (e: any) => void> = {};
    const on = vi.fn((event: string, listener: (e: any) => void) => {
      listeners[event] = listener;
    });
    const broadcast = vi.fn();
    const clients = new Map();
    const flushAllStreamBuffers = vi.fn();
    const projection = { flushAllStreamBuffers };
    const sessionPayload = vi.fn((payload) => ({ ...payload, sessionId: payload.sessionId ?? 'default' }));

    registerSetupEventsProviderHandlers({
      on: on as never,
      broadcast,
      clients,
      projection: projection as never,
      sessionPayload,
    });

    expect(on).toHaveBeenCalledWith('provider.response', expect.any(Function));
    expect(on).toHaveBeenCalledWith('ctx.pct', expect.any(Function));
    expect(on).toHaveBeenCalledWith('ctx.max_context', expect.any(Function));
    expect(on).toHaveBeenCalledWith('token.threshold', expect.any(Function));
    expect(on).toHaveBeenCalledWith('token.cost_estimate_unavailable', expect.any(Function));
    expect(on).toHaveBeenCalledWith('context.repaired', expect.any(Function));

    // Test provider.response
    listeners['provider.response']?.({
      sessionId: 'sess-1',
      content: 'Hello world',
      usage: { promptTokens: 10, completionTokens: 20 },
      ctx: { provider: { id: 'anthropic' } },
      stopReason: 'end_turn',
    });

    expect(flushAllStreamBuffers).toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(clients, {
      type: 'provider.response',
      payload: expect.objectContaining({
        sessionId: 'sess-1',
        content: 'Hello world',
        provider: 'anthropic',
        stopReason: 'end_turn',
        messageId: 'current',
      }),
    });
  });

  it('handles provider.response without projection safely', () => {
    const listeners: Record<string, (e: any) => void> = {};
    const on = vi.fn((event: string, listener: (e: any) => void) => {
      listeners[event] = listener;
    });
    const broadcast = vi.fn();
    const clients = new Map();

    registerSetupEventsProviderHandlers({
      on: on as never,
      broadcast,
      clients,
      projection: undefined,
      sessionPayload: (p) => p as never,
    });

    expect(() => {
      listeners['provider.response']?.({
        sessionId: 'sess-1',
        content: 'Hi',
        usage: {},
        ctx: { provider: { id: 'openai' } },
        stopReason: 'stop',
      });
    }).not.toThrow();

    expect(broadcast).toHaveBeenCalledWith(clients, {
      type: 'provider.response',
      payload: expect.objectContaining({ provider: 'openai' }),
    });
  });

  it('handles ctx.pct event and broadcasts both ctx.pct and subagent.event', () => {
    const listeners: Record<string, (e: any) => void> = {};
    const on = vi.fn((event: string, listener: (e: any) => void) => {
      listeners[event] = listener;
    });
    const broadcast = vi.fn();
    const clients = new Map();

    registerSetupEventsProviderHandlers({
      on: on as never,
      broadcast,
      clients,
      sessionPayload: (p) => p as never,
    });

    listeners['ctx.pct']?.({
      sessionId: 'sess-1',
      load: 0.75,
      tokens: 15000,
      maxContext: 20000,
    });

    expect(broadcast).toHaveBeenCalledWith(clients, {
      type: 'ctx.pct',
      payload: {
        sessionId: 'sess-1',
        load: 0.75,
        tokens: 15000,
        maxContext: 20000,
      },
    });

    expect(broadcast).toHaveBeenCalledWith(clients, {
      type: 'subagent.event',
      payload: {
        sessionId: 'sess-1',
        kind: 'ctx_pct',
        subagentId: 'leader',
        load: 0.75,
        tokens: 15000,
        maxContext: 20000,
      },
    });
  });

  it('handles ctx.max_context with optional fields (full and minimal)', () => {
    const listeners: Record<string, (e: any) => void> = {};
    const on = vi.fn((event: string, listener: (e: any) => void) => {
      listeners[event] = listener;
    });
    const broadcast = vi.fn();
    const clients = new Map();

    registerSetupEventsProviderHandlers({
      on: on as never,
      broadcast,
      clients,
      sessionPayload: (p) => p as never,
    });

    // Full fields
    listeners['ctx.max_context']?.({
      sessionId: 'sess-1',
      providerId: 'anthropic',
      modelId: 'claude-3-opus',
      maxContext: 200000,
      previousMaxContext: 100000,
      source: 'dynamic_cap',
      decreased: true,
    });

    expect(broadcast).toHaveBeenCalledWith(clients, {
      type: 'ctx.max_context',
      payload: {
        sessionId: 'sess-1',
        providerId: 'anthropic',
        modelId: 'claude-3-opus',
        maxContext: 200000,
        previousMaxContext: 100000,
        source: 'dynamic_cap',
        decreased: true,
      },
    });

    // Minimal fields (optional omitted)
    broadcast.mockClear();
    listeners['ctx.max_context']?.({
      sessionId: 'sess-2',
      providerId: 'openai',
      modelId: 'gpt-4o',
      maxContext: 128000,
      previousMaxContext: undefined,
      source: undefined,
      decreased: undefined,
    });

    expect(broadcast).toHaveBeenCalledWith(clients, {
      type: 'ctx.max_context',
      payload: {
        sessionId: 'sess-2',
        providerId: 'openai',
        modelId: 'gpt-4o',
        maxContext: 128000,
      },
    });
  });

  it('handles token.threshold, token.cost_estimate_unavailable, and context.repaired', () => {
    const listeners: Record<string, (e: any) => void> = {};
    const on = vi.fn((event: string, listener: (e: any) => void) => {
      listeners[event] = listener;
    });
    const broadcast = vi.fn();
    const clients = new Map();

    registerSetupEventsProviderHandlers({
      on: on as never,
      broadcast,
      clients,
      sessionPayload: (p) => p as never,
    });

    // token.threshold
    listeners['token.threshold']?.({
      sessionId: 'sess-1',
      used: 95000,
      limit: 100000,
    });
    expect(broadcast).toHaveBeenCalledWith(clients, {
      type: 'token.threshold',
      payload: { sessionId: 'sess-1', used: 95000, limit: 100000 },
    });

    // token.cost_estimate_unavailable
    broadcast.mockClear();
    listeners['token.cost_estimate_unavailable']?.({
      sessionId: 'sess-1',
      model: 'custom-fine-tune',
    });
    expect(broadcast).toHaveBeenCalledWith(clients, {
      type: 'token.cost_estimate_unavailable',
      payload: { sessionId: 'sess-1', model: 'custom-fine-tune' },
    });

    // context.repaired
    broadcast.mockClear();
    listeners['context.repaired']?.({
      sessionId: 'sess-1',
      removedToolUses: ['tu_1', 'tu_2'],
      removedToolResults: ['tr_1'],
      removedMessages: ['m_1'],
    });
    expect(broadcast).toHaveBeenCalledWith(clients, {
      type: 'context.repaired',
      payload: {
        sessionId: 'sess-1',
        removedToolUses: ['tu_1', 'tu_2'],
        removedToolResults: ['tr_1'],
        removedMessages: ['m_1'],
      },
    });
  });
});
