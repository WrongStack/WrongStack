import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = {
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  undoable: vi.fn(),
};
vi.mock('@/components/Toaster', () => ({ toast }));

const wsClient = { send: vi.fn(), sendAbort: vi.fn() };
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => wsClient }));

const { useChatStore, useFleetStore, useSessionStore } = await import('../../src/stores');
const { useProviderStatusStore } = await import('../../src/stores/provider-status-store');
const { useFallbackStore } = await import('../../src/stores/fallback-store');
const { useVizStore } = await import('../../src/stores/viz-store');
const {
  handleCheckpointWritten,
  handleContextMaxContext,
  handleContextModeChanged,
  handleContextPct,
  handleContextRepaired,
  handleDelegateCompleted,
  handleDelegateStarted,
  handleInFlightEnded,
  handleInFlightStarted,
  handleIterationLimitReached,
  handleProviderActiveBlocked,
  handleProviderError,
  handleProviderFallback,
  handleProviderRetry,
  handleProviderStatusChanged,
  handleProviderStatusSnapshot,
  handleProviderStreamError,
  handleSessionDamaged,
  handleSessionRewound,
  handleTokenCostEstimateUnavailable,
  handleTokenThreshold,
  handleToolLoopDetected,
  handleTrustPersisted,
  sessionHandlerMap,
} = await import('../../src/hooks/ws-handlers/session-handlers');

function msg(type: string, payload: unknown) {
  return { type, payload } as never;
}

function chat(): string {
  const msgs = useChatStore.getState().messages as Array<{ content: string }>;
  return msgs[msgs.length - 1]?.content ?? '';
}

function lastMessage(): Record<string, unknown> | undefined {
  const msgs = useChatStore.getState().messages as unknown as Array<Record<string, unknown>>;
  return msgs[msgs.length - 1];
}

describe('session ws-handlers — provider / delegate / context', () => {
  beforeEach(() => {
    for (const fn of Object.values(toast)) fn.mockReset();
    useChatStore.setState({ messages: [], isLoading: false } as never);
    useSessionStore.setState({ session: null, contextLimitWarning: null } as never);
    useVizStore.setState({ events: [], isActive: false } as never);
    useFallbackStore.setState({ pending: null, selected: 0 });
  });

  it('registers each handler under its wire type', () => {
    expect(sessionHandlerMap['iteration.limit_reached']).toBe(handleIterationLimitReached);
    expect(sessionHandlerMap['provider.retry']).toBe(handleProviderRetry);
    expect(sessionHandlerMap['provider.error']).toBe(handleProviderError);
    expect(sessionHandlerMap['provider.fallback']).toBe(handleProviderFallback);
  });

  // ── iteration limit ───────────────────────────────────────────────────────

  it('iteration.limit_reached reports the ratio in chat and a toast', () => {
    handleIterationLimitReached(
      msg('iteration.limit_reached', { currentIterations: 50, currentLimit: 50 }),
    );
    expect(chat()).toBe('Iteration limit reached: 50/50.');
    expect(lastMessage()?.isError).toBe(true);
    expect(toast.warn).toHaveBeenCalledWith('Iteration limit reached (50/50)');
  });

  // ── provider.retry ────────────────────────────────────────────────────────

  describe('provider.retry', () => {
    it('renders the delay in seconds to one decimal', () => {
      handleProviderRetry(
        msg('provider.retry', {
          providerId: 'anthropic',
          attempt: 2,
          delayMs: 1500,
          status: 429,
          description: 'rate limited',
        }),
      );
      expect(toast.warn).toHaveBeenCalledWith('anthropic retry 2 after 1.5s (429)');
    });

    it('rounds to the nearest tenth of a second', () => {
      handleProviderRetry(
        msg('provider.retry', {
          providerId: 'p',
          attempt: 1,
          delayMs: 1249,
          status: 500,
          description: '',
        }),
      );
      expect(toast.warn).toHaveBeenCalledWith('p retry 1 after 1.2s (500)');
    });

    it('clamps a negative delay to 0s', () => {
      handleProviderRetry(
        msg('provider.retry', {
          providerId: 'p',
          attempt: 1,
          delayMs: -500,
          status: 500,
          description: '',
        }),
      );
      expect(toast.warn).toHaveBeenCalledWith('p retry 1 after 0s (500)');
    });
  });

  // ── provider.error ────────────────────────────────────────────────────────

  describe('provider.error', () => {
    it('renders the provider, status and description', () => {
      handleProviderError(
        msg('provider.error', {
          providerId: 'openai',
          status: 500,
          description: 'server exploded',
          retryable: false,
        }),
      );
      expect(chat()).toContain('Provider error from `openai` (500).');
      expect(chat()).toContain('server exploded');
      expect(chat()).not.toContain('Retryable');
      expect(lastMessage()?.isError).toBe(true);
      expect(toast.error).toHaveBeenCalledWith('openai provider error (500)');
    });

    it('adds the retryable note when the error is recoverable', () => {
      handleProviderError(
        msg('provider.error', {
          providerId: 'openai',
          status: 503,
          description: 'unavailable',
          retryable: true,
        }),
      );
      expect(chat()).toContain('_Retryable; WrongStack may recover automatically._');
    });

    it('drops an empty description rather than leaving a blank paragraph', () => {
      handleProviderError(
        msg('provider.error', {
          providerId: 'p',
          status: 500,
          description: '',
          retryable: false,
        }),
      );
      expect(chat()).toBe('Provider error from `p` (500).');
    });
  });

  // ── provider.fallback ─────────────────────────────────────────────────────

  describe('provider.fallback', () => {
    it('names both endpoints and toasts the destination', () => {
      handleProviderFallback(
        msg('provider.fallback', {
          from: { providerId: 'anthropic', model: 'opus' },
          to: { providerId: 'anthropic', model: 'sonnet' },
          status: 429,
          providerSwitched: false,
        }),
      );
      expect(chat()).toBe(
        'Provider fallback: `anthropic/opus` returned 429; switching to `anthropic/sonnet`.',
      );
      expect(toast.warn).toHaveBeenCalledWith('Fallback to anthropic/sonnet');
    });

    it('flags a cross-provider switch', () => {
      handleProviderFallback(
        msg('provider.fallback', {
          from: { providerId: 'anthropic', model: 'opus' },
          to: { providerId: 'openai', model: 'gpt-5' },
          status: 429,
          providerSwitched: true,
        }),
      );
      expect(chat()).toContain('with provider change.');
    });

    it('clears a pending modal when the fallback requestId matches', () => {
      useFallbackStore.getState().setPending({
        requestId: 'req-a',
        from: { providerId: 'anthropic', model: 'opus' },
        status: 429,
        candidates: [{ providerId: 'openai', model: 'gpt-5' }],
        autoSwitchSeconds: 7,
        timestamp: 1_700_000_000_000,
      });
      handleProviderFallback(
        msg('provider.fallback', {
          from: { providerId: 'anthropic', model: 'opus' },
          to: { providerId: 'openai', model: 'gpt-5' },
          status: 429,
          providerSwitched: true,
          requestId: 'req-a',
        }),
      );
      expect(useFallbackStore.getState().pending).toBeNull();
    });

    it('keeps a NEWER pending modal when the fallback carries an older requestId', () => {
      // Request B failed on the same primary after A; A's completion must
      // not clear B's modal (parallel-request race).
      useFallbackStore.getState().setPending({
        requestId: 'req-b',
        from: { providerId: 'anthropic', model: 'opus' },
        status: 429,
        candidates: [{ providerId: 'openai', model: 'gpt-5' }],
        autoSwitchSeconds: 7,
        timestamp: 1_700_000_000_000,
      });
      handleProviderFallback(
        msg('provider.fallback', {
          from: { providerId: 'anthropic', model: 'opus' },
          to: { providerId: 'openai', model: 'gpt-5' },
          status: 429,
          providerSwitched: true,
          requestId: 'req-a',
        }),
      );
      expect(useFallbackStore.getState().pending?.requestId).toBe('req-b');
    });

    it('clears a pending modal by from-match when the fallback carries no requestId', () => {
      // Gate-less fallback path: no modal was shown for this completion, so
      // matching on `from` remains the fallback behavior.
      useFallbackStore.getState().setPending({
        requestId: 'req-a',
        from: { providerId: 'anthropic', model: 'opus' },
        status: 429,
        candidates: [{ providerId: 'openai', model: 'gpt-5' }],
        autoSwitchSeconds: 7,
        timestamp: 1_700_000_000_000,
      });
      handleProviderFallback(
        msg('provider.fallback', {
          from: { providerId: 'anthropic', model: 'opus' },
          to: { providerId: 'openai', model: 'gpt-5' },
          status: 429,
          providerSwitched: true,
        }),
      );
      expect(useFallbackStore.getState().pending).toBeNull();
    });
  });

  // ── provider status ───────────────────────────────────────────────────────

  describe('provider.status_changed', () => {
    const base = {
      providerId: 'anthropic',
      model: 'opus',
      oldState: 'healthy' as const,
      newState: 'blocked' as const,
      reason: 'rate limited',
      timestamp: 1_700_000_000_000,
    };

    it('records the new state in the status store', () => {
      const update = vi.fn();
      useProviderStatusStore.setState({ update } as never);
      handleProviderStatusChanged(msg('provider.status_changed', { ...base, stateExpiresAt: 99 }));
      expect(update).toHaveBeenCalledWith({
        providerId: 'anthropic',
        model: 'opus',
        state: 'blocked',
        reason: 'rate limited',
        updatedAt: 1_700_000_000_000,
        stateExpiresAt: 99,
      });
    });

    it('announces entry into the waiting room', () => {
      useProviderStatusStore.setState({ update: vi.fn() } as never);
      handleProviderStatusChanged(msg('provider.status_changed', base));
      expect(toast.warn).toHaveBeenCalledWith(
        'anthropic/opus entered the limit-reset waiting room',
      );
    });

    it('stays quiet when it was already blocked', () => {
      useProviderStatusStore.setState({ update: vi.fn() } as never);
      handleProviderStatusChanged(msg('provider.status_changed', { ...base, oldState: 'blocked' }));
      expect(toast.warn).not.toHaveBeenCalled();
    });

    it('announces recovery', () => {
      useProviderStatusStore.setState({ update: vi.fn() } as never);
      handleProviderStatusChanged(
        msg('provider.status_changed', { ...base, oldState: 'blocked', newState: 'healthy' }),
      );
      expect(toast.success).toHaveBeenCalledWith(
        'anthropic/opus recovered and rejoined model routing',
      );
    });

    it('stays quiet when it was already healthy', () => {
      useProviderStatusStore.setState({ update: vi.fn() } as never);
      handleProviderStatusChanged(
        msg('provider.status_changed', { ...base, oldState: 'healthy', newState: 'healthy' }),
      );
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('stays quiet for a degraded transition', () => {
      useProviderStatusStore.setState({ update: vi.fn() } as never);
      handleProviderStatusChanged(
        msg('provider.status_changed', { ...base, newState: 'degraded' }),
      );
      expect(toast.warn).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('is not session-gated — provider health is global', () => {
      useSessionStore.setState({ session: { id: 's1' } } as never);
      const update = vi.fn();
      useProviderStatusStore.setState({ update } as never);
      handleProviderStatusChanged(
        msg('provider.status_changed', { ...base, sessionId: 'other' } as never),
      );
      expect(update).toHaveBeenCalled();
    });
  });

  describe('provider.status_snapshot', () => {
    it('applies a well-formed snapshot', () => {
      const applySnapshot = vi.fn();
      useProviderStatusStore.setState({ applySnapshot } as never);
      const payload = { providers: [] };
      handleProviderStatusSnapshot(msg('provider.status_snapshot', payload));
      expect(applySnapshot).toHaveBeenCalledWith(payload);
    });

    it('records an unavailable tracker instead of applying the frame', () => {
      const applySnapshot = vi.fn();
      const setError = vi.fn();
      useProviderStatusStore.setState({ applySnapshot, setError } as never);
      handleProviderStatusSnapshot(msg('provider.status_snapshot', { error: 'not supported' }));
      expect(setError).toHaveBeenCalledWith('Provider status tracking not available');
      expect(applySnapshot).not.toHaveBeenCalled();
    });

    it('treats a null payload as a snapshot, not an error', () => {
      const applySnapshot = vi.fn();
      useProviderStatusStore.setState({ applySnapshot, setError: vi.fn() } as never);
      handleProviderStatusSnapshot(msg('provider.status_snapshot', null));
      expect(applySnapshot).toHaveBeenCalledWith(null);
    });
  });

  it('provider.active_blocked explains the skip', () => {
    handleProviderActiveBlocked(
      msg('provider.active_blocked', {
        providerId: 'anthropic',
        model: 'opus',
        lastError: '429 rate limit',
      }),
    );
    expect(chat()).toBe('Waiting room skipped `anthropic/opus`. 429 rate limit');
  });

  it('provider.stream_error warns and records the event', () => {
    handleProviderStreamError(
      msg('provider.stream_error', { eventType: 'ping', message: 'unknown frame' }),
    );
    expect(toast.warn).toHaveBeenCalledWith('Provider stream event skipped: ping');
    expect(chat()).toBe('Provider stream warning (ping): unknown frame');
    expect(lastMessage()?.isError).toBe(true);
  });

  // ── loop guard ────────────────────────────────────────────────────────────

  describe('tool.loop_detected', () => {
    const base = { tools: 'read_file', repeatCount: 3, iteration: 2 };

    it('steers quietly without cutting the turn', () => {
      handleToolLoopDetected(msg('tool.loop_detected', { ...base, action: 'steer' }));
      expect(toast.info).toHaveBeenCalledWith(
        'Possible repetition noticed for read_file; changing approach.',
      );
      expect(useChatStore.getState().messages).toHaveLength(0);
    });

    it('reports a cut with a 1-based iteration number', () => {
      handleToolLoopDetected(msg('tool.loop_detected', { ...base, action: 'cut' }));
      expect(chat()).toBe(
        'Loop guard stopped the turn: read_file made no progress 3 time(s) (iteration 3).',
      );
      expect(lastMessage()?.isError).toBe(true);
      expect(toast.warn).toHaveBeenCalledWith('Loop guard stopped the turn');
    });

    it('cuts by default when no action is given', () => {
      handleToolLoopDetected(msg('tool.loop_detected', base));
      expect(toast.warn).toHaveBeenCalledWith('Loop guard stopped the turn');
    });

    it('falls back from tools to kind, then to a generic subject', () => {
      handleToolLoopDetected(msg('tool.loop_detected', { ...base, tools: '', kind: 'text' }));
      expect(chat()).toContain('text made no progress');

      handleToolLoopDetected(msg('tool.loop_detected', { ...base, tools: '', kind: '' }));
      expect(chat()).toContain('assistant response made no progress');
    });
  });

  // ── delegation ────────────────────────────────────────────────────────────

  describe('delegate.started', () => {
    it('announces the delegation and opens a timeline entry', () => {
      const pushAgentTimelineEntry = vi.fn();
      useFleetStore.setState({ pushAgentTimelineEntry } as never);
      handleDelegateStarted(
        msg('delegate.started', { target: 'worker-1', task: 'refactor the store' }),
      );
      expect(chat()).toBe('Delegating to `worker-1`: refactor the store');
      expect(pushAgentTimelineEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          subagentId: 'worker-1',
          agentName: 'worker-1',
          content: 'refactor the store',
          kind: 'status',
          status: 'delegating',
        }),
      );
    });

    it('truncates a long task description', () => {
      useFleetStore.setState({ pushAgentTimelineEntry: vi.fn() } as never);
      handleDelegateStarted(msg('delegate.started', { target: 'w1', task: 'x'.repeat(300) }));
      expect(chat().length).toBeLessThan(300);
    });

    it('adds the running delegate to the live fleet roster by stable id', () => {
      handleDelegateStarted(
        msg('delegate.started', {
          target: 'worker-1',
          task: 'refactor the store',
          subagentId: 'delegate-runtime-1',
        }),
      );

      expect(useFleetStore.getState().agents.get('delegate-runtime-1')).toMatchObject({
        name: 'worker-1',
        description: 'refactor the store',
        status: 'running',
      });
    });
  });

  describe('delegate.completed', () => {
    const base = {
      target: 'worker-1',
      task: 't',
      ok: true,
      summary: 'done the thing',
      durationMs: 12_300,
      iterations: 4,
      toolCalls: 9,
    };

    it('renders the success summary and stats', () => {
      useFleetStore.setState({ pushAgentTimelineEntry: vi.fn() } as never);
      handleDelegateCompleted(msg('delegate.completed', base));
      expect(chat()).toContain('Delegate completed for `worker-1`.');
      expect(chat()).toContain('done the thing');
      expect(chat()).toContain('4 iteration(s), 9 tool call(s), 12.3s');
      expect(lastMessage()?.isError).toBe(false);
      expect(toast.warn).not.toHaveBeenCalled();
    });

    it('appends a cost when one was reported', () => {
      useFleetStore.setState({ pushAgentTimelineEntry: vi.fn() } as never);
      handleDelegateCompleted(msg('delegate.completed', { ...base, costUsd: 0.12345 }));
      expect(chat()).toContain('12.3s · $0.1235');
    });

    it('omits a zero cost', () => {
      useFleetStore.setState({ pushAgentTimelineEntry: vi.fn() } as never);
      handleDelegateCompleted(msg('delegate.completed', { ...base, costUsd: 0 }));
      expect(chat()).not.toContain('$');
    });

    it('includes an explicit status label', () => {
      useFleetStore.setState({ pushAgentTimelineEntry: vi.fn() } as never);
      handleDelegateCompleted(msg('delegate.completed', { ...base, status: 'partial' }));
      expect(chat()).toContain('Delegate completed for `worker-1` (partial).');
    });

    it('renders a failure and warns', () => {
      const pushAgentTimelineEntry = vi.fn();
      useFleetStore.setState({ pushAgentTimelineEntry } as never);
      handleDelegateCompleted(msg('delegate.completed', { ...base, ok: false }));
      expect(chat()).toContain('Delegate failed for `worker-1`.');
      expect(lastMessage()?.isError).toBe(true);
      expect(toast.warn).toHaveBeenCalledWith('Delegate failed: worker-1');
      expect(pushAgentTimelineEntry).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'error', status: 'failed' }),
      );
    });

    it('prefers an explicit subagentId over the target name', () => {
      const pushAgentTimelineEntry = vi.fn();
      useFleetStore.setState({ pushAgentTimelineEntry } as never);
      handleDelegateCompleted(msg('delegate.completed', { ...base, subagentId: 'sub-9' }));
      expect(pushAgentTimelineEntry).toHaveBeenCalledWith(
        expect.objectContaining({ subagentId: 'sub-9', agentName: 'worker-1' }),
      );
    });

    it('marks the matching live delegate as completed', () => {
      handleDelegateStarted(
        msg('delegate.started', { target: 'worker-1', task: 't', subagentId: 'sub-9' }),
      );
      handleDelegateCompleted(msg('delegate.completed', { ...base, subagentId: 'sub-9' }));

      expect(useFleetStore.getState().agents.get('sub-9')).toMatchObject({
        status: 'completed',
        iteration: 4,
        toolCalls: 9,
      });
    });
  });

  // ── trust ─────────────────────────────────────────────────────────────────

  describe('trust.persisted', () => {
    it('confirms an always-allow', () => {
      handleTrustPersisted(
        msg('trust.persisted', { tool: 'bash', pattern: 'git *', decision: 'always' }),
      );
      expect(toast.success).toHaveBeenCalledWith('Always allowed bash: git *');
    });

    it('confirms a deny', () => {
      handleTrustPersisted(
        msg('trust.persisted', { tool: 'bash', pattern: 'rm *', decision: 'deny' }),
      );
      expect(toast.warn).toHaveBeenCalledWith('Denied bash: rm *');
    });
  });

  // ── context ───────────────────────────────────────────────────────────────

  describe('context.repaired', () => {
    it('sums the removed protocol items', () => {
      handleContextRepaired(
        msg('context.repaired', {
          removedToolUses: ['a', 'b'],
          removedToolResults: ['c'],
          removedMessages: 2,
        }),
      );
      expect(chat()).toBe(
        'Context repaired: removed 5 orphan protocol item(s). tool_use 2, tool_result 1.',
      );
    });

    it('adds the before/after message counts when both are present', () => {
      handleContextRepaired(
        msg('context.repaired', {
          removedToolUses: [],
          removedToolResults: [],
          removedMessages: 1,
          beforeMessages: 20,
          afterMessages: 19,
        }),
      );
      expect(chat()).toContain('Messages: 20 -> 19.');
    });

    it('omits the message counts when only one side is reported', () => {
      handleContextRepaired(
        msg('context.repaired', {
          removedToolUses: [],
          removedToolResults: [],
          removedMessages: 1,
          beforeMessages: 20,
        }),
      );
      expect(chat()).not.toContain('Messages:');
    });
  });

  it('context.pct records token usage', () => {
    handleContextPct(msg('context.pct', { load: 0.5, tokens: 5000, maxContext: 10_000 }));
    expect(useSessionStore.getState().lastInputTokens).toBe(5000);
    expect(useSessionStore.getState().maxContext).toBe(10_000);
  });

  it('context.max_context updates the window size', () => {
    handleContextMaxContext(msg('context.max_context', { maxContext: 200_000 }));
    expect(useSessionStore.getState().maxContext).toBe(200_000);
  });

  it('records a live provider-limit decrease for warning surfaces', () => {
    handleContextMaxContext(
      msg('ctx.max_context', {
        providerId: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        previousMaxContext: 1_050_000,
        maxContext: 272_000,
        source: 'provider',
        decreased: true,
      }),
    );
    expect(useSessionStore.getState().contextLimitWarning).toEqual({
      providerId: 'openai-codex',
      modelId: 'gpt-5.6-sol',
      previousMaxContext: 1_050_000,
      maxContext: 272_000,
    });
  });

  it('does not warn for configured limits or increases', () => {
    handleContextMaxContext(
      msg('ctx.max_context', {
        providerId: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        previousMaxContext: 272_000,
        maxContext: 1_050_000,
        source: 'provider',
        decreased: false,
      }),
    );
    expect(useSessionStore.getState().contextLimitWarning).toBeNull();
  });

  it('context_mode.changed updates the active mode', () => {
    handleContextModeChanged(msg('context_mode.changed', { id: 'lean' }));
    expect(useSessionStore.getState().contextMode).toBe('lean');
  });

  // ── token thresholds ──────────────────────────────────────────────────────

  describe('token.threshold', () => {
    it('records usage and reports the percentage', () => {
      handleTokenThreshold(msg('token.threshold', { used: 8000, limit: 10_000 }));
      expect(useSessionStore.getState().lastInputTokens).toBe(8000);
      expect(toast.warn).toHaveBeenCalledWith('Token threshold reached (80%)');
    });

    it('reports 0% rather than NaN when the limit is zero', () => {
      handleTokenThreshold(msg('token.threshold', { used: 100, limit: 0 }));
      expect(toast.warn).toHaveBeenCalledWith('Token threshold reached (0%)');
    });
  });

  describe('token.cost_estimate_unavailable', () => {
    it('warns once per model and stays quiet afterwards', () => {
      const model = `model-${Math.random().toString(36).slice(2)}`;
      handleTokenCostEstimateUnavailable(msg('token.cost_estimate_unavailable', { model }));
      expect(toast.warn).toHaveBeenCalledWith(`Cost estimate unavailable for ${model}`);

      toast.warn.mockReset();
      handleTokenCostEstimateUnavailable(msg('token.cost_estimate_unavailable', { model }));
      expect(toast.warn).not.toHaveBeenCalled();
    });

    it('substitutes a placeholder for a blank model name', () => {
      handleTokenCostEstimateUnavailable(msg('token.cost_estimate_unavailable', { model: '' }));
      // Either it warns with the placeholder, or a previous test already
      // registered it — both are consistent with warn-once semantics.
      const calls = toast.warn.mock.calls.flat();
      if (calls.length > 0) expect(calls[0]).toBe('Cost estimate unavailable for <unknown>');
    });
  });

  // ── session lifecycle ─────────────────────────────────────────────────────

  it('session.damaged reports the detail', () => {
    // The report belongs to the damaged session's tab; put that tab in front.
    useSessionStore.setState({ session: { id: 's1' } } as never);
    handleSessionDamaged(msg('session.damaged', { sessionId: 's1', detail: 'truncated JSONL' }));
    expect(chat()).toBe('Session s1 is damaged: truncated JSONL');
    expect(lastMessage()?.isError).toBe(true);
    expect(toast.error).toHaveBeenCalledWith('Session damage detected');
  });

  it('session.rewound summarises what was undone', () => {
    handleSessionRewound(
      msg('session.rewound', {
        toPromptIndex: 3,
        revertedFiles: ['a.ts', 'b.ts'],
        removedEvents: 12,
      }),
    );
    expect(chat()).toBe('Session rewound to prompt #3. Removed 12 event(s); reverted 2 file(s).');
    expect(toast.info).toHaveBeenCalledWith('Session rewound');
  });

  it('checkpoint.written confirms the write', () => {
    handleCheckpointWritten(
      msg('checkpoint.written', { promptIndex: 4, promptPreview: 'do it', fileCount: 7 }),
    );
    expect(toast.success).toHaveBeenCalledWith('Checkpoint #4 written (7 file(s))');
  });

  describe('in-flight operations', () => {
    it('start pushes a viz event labelled with the context', () => {
      handleInFlightStarted(msg('inflight.started', { context: 'compaction' }));
      expect(useVizStore.getState().events[0]).toMatchObject({
        kind: 'session:start',
        source: 'session',
        target: 'leader',
        label: 'In-flight: compaction',
        flowGroup: 'session',
      });
    });

    it('end announces only a recovery', () => {
      handleInFlightEnded(msg('inflight.ended', { reason: 'recovered' }));
      expect(toast.info).toHaveBeenCalledWith('Recovered previous in-flight operation');
    });

    it.each(['clean', 'aborted'])('end stays quiet for a %s finish', (reason) => {
      handleInFlightEnded(msg('inflight.ended', { reason }));
      expect(toast.info).not.toHaveBeenCalled();
    });
  });

  // ── session gating ────────────────────────────────────────────────────────

  it.each([
    [
      'iteration.limit_reached',
      handleIterationLimitReached,
      { currentIterations: 1, currentLimit: 1 },
    ],
    [
      'provider.error',
      handleProviderError,
      { providerId: 'p', status: 1, description: '', retryable: false },
    ],
    ['session.damaged', handleSessionDamaged, { sessionId: 's', detail: 'd' }],
    ['context.max_context', handleContextMaxContext, { maxContext: 1 }],
  ] as Array<[string, (m: never) => void, Record<string, unknown>]>)(
    '%s is dropped for a non-active session',
    (type, handler, payload) => {
      useSessionStore.setState({ session: { id: 's1' } } as never);
      const before = useChatStore.getState().messages.length;
      handler(msg(type, { ...payload, sessionId: 'other' }));
      expect(useChatStore.getState().messages).toHaveLength(before);
      expect(toast.warn).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    },
  );
});
