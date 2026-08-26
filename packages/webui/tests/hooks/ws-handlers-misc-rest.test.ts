import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = {
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  undoable: vi.fn(),
};
vi.mock('@/components/Toaster', () => ({ toast }));

const send = vi.fn();
const refineModel = vi.fn();
const sendMessage = vi.fn();
const getGitChanges = vi.fn();
const getGitInfo = vi.fn();
vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ send, refineModel, sendMessage, getGitChanges, getGitInfo }),
}));

const {
  useChatStore,
  useCouncilLogStore,
  useCronStore,
  useFileStore,
  useGitChangesStore,
  useGitInfoStore,
  useGoalStateStore,
  useSessionStore,
  useUIStore,
  useVizStore,
} = await import('../../src/stores');
const { useMemoryInjectorTraceStore } = await import('../../src/stores/memory-injector-store');
const { useMemoryLifecycleStore } = await import('../../src/stores/memory-lifecycle-store');
const {
  handleBrainAnswer,
  handleBrainEvent,
  handleBrainStatus,
  handleChimeraReportAvailable,
  handleCollabEvent,
  handleCollabInjectionGranted,
  handleCronJobFired,
  handleCronSnapshot,
  handleEternalIteration,
  handleGitActionResult,
  handleGitChanges,
  handleGitDiff,
  handleGitInfo,
  handleMemoryEvent,
  handleModelRefineResult,
  handleWorkingDirChanged,
} = await import('../../src/hooks/ws-handlers/misc-handlers');

function msg(type: string, payload: unknown) {
  return { type, payload } as never;
}

/** Last message pushed to the chat transcript. */
function lastChat(): { role: string; content: string } | undefined {
  const msgs = useChatStore.getState().messages;
  return msgs[msgs.length - 1] as { role: string; content: string } | undefined;
}

describe('misc ws-handlers — brain / memory / collab / git / cron', () => {
  beforeEach(() => {
    for (const fn of Object.values(toast)) fn.mockReset();
    send.mockReset();
    refineModel.mockReset();
    sendMessage.mockReset();
    getGitChanges.mockReset();
    getGitInfo.mockReset();
    useChatStore.setState({ messages: [], pendingRefinement: null } as never);
    useSessionStore.setState({ session: null } as never);
    useUIStore.setState({ refinePanel: null } as never);
    useVizStore.setState({ events: [], isActive: false } as never);
    useCronStore.getState().clear();
  });

  it('shows Chimera availability without starting chat work', () => {
    handleChimeraReportAvailable(
      msg('chimera.report_available', {
        message: '🦂 Chimera report ready. No follow-up started.',
      }),
    );
    expect(toast.info).toHaveBeenCalledWith(
      '🦂 Chimera report ready. No follow-up started.',
      8_000,
    );
    expect(useChatStore.getState().messages).toEqual([]);
  });

  // ── session gating ────────────────────────────────────────────────────────

  describe('active-session gating', () => {
    it('accepts a message with no sessionId', () => {
      useSessionStore.setState({ session: { id: 's1' } } as never);
      handleBrainAnswer(
        msg('brain.answer', { question: 'q', decision: { type: 'answer', text: 'yes' } }),
      );
      expect(lastChat()?.content).toContain('yes');
    });

    it('accepts a message for the active session', () => {
      useSessionStore.setState({ session: { id: 's1' } } as never);
      handleBrainAnswer(
        msg('brain.answer', {
          sessionId: 's1',
          question: 'q',
          decision: { type: 'answer', text: 'yes' },
        }),
      );
      expect(lastChat()?.content).toContain('yes');
    });

    it('drops a message addressed to a different session', () => {
      useSessionStore.setState({ session: { id: 's1' } } as never);
      handleBrainAnswer(
        msg('brain.answer', {
          sessionId: 'other',
          question: 'q',
          decision: { type: 'answer', text: 'nope' },
        }),
      );
      expect(lastChat()).toBeUndefined();
    });
  });

  // ── brain.status ──────────────────────────────────────────────────────────

  describe('brain.status', () => {
    it('renders the autonomy ceiling', () => {
      handleBrainStatus(msg('brain.status', { maxAutoRisk: 'medium', log: [] }));
      expect(lastChat()?.content).toContain('Autonomy ceiling: `medium`');
    });

    it('says so when nothing has been decided yet', () => {
      handleBrainStatus(msg('brain.status', { maxAutoRisk: 'low', log: [] }));
      expect(lastChat()?.content).toContain('_No decisions recorded yet this session._');
    });

    it('lists recent decisions with a count', () => {
      handleBrainStatus(
        msg('brain.status', {
          maxAutoRisk: 'low',
          log: [{ at: Date.now(), kind: 'confirm', question: 'Run bash?', outcome: 'allowed' }],
        }),
      );
      const content = lastChat()?.content ?? '';
      expect(content).toContain('Recent decisions (1):');
      expect(content).toContain('**confirm**');
      expect(content).toContain('Run bash?');
      expect(content).toContain('_allowed_');
    });

    it('shows only the last 10 entries', () => {
      const log = Array.from({ length: 15 }, (_, i) => ({
        at: Date.now(),
        kind: `k${i}`,
        question: `q${i}`,
        outcome: '',
      }));
      handleBrainStatus(msg('brain.status', { maxAutoRisk: 'low', log }));
      const content = lastChat()?.content ?? '';
      expect(content).toContain('Recent decisions (15):');
      expect(content).not.toContain('**k4**');
      expect(content).toContain('**k5**');
      expect(content).toContain('**k14**');
    });

    it.each([
      [5_000, 's'],
      [120_000, 'm'],
      [7_200_000, 'h'],
    ])('renders an age suffix for %ims', (ageMs, suffix) => {
      handleBrainStatus(
        msg('brain.status', {
          maxAutoRisk: 'low',
          log: [{ at: Date.now() - ageMs, kind: 'k', question: 'q', outcome: '' }],
        }),
      );
      expect(lastChat()?.content).toMatch(new RegExp(`\\d+${suffix} ago`));
    });

    it('clamps a future timestamp to 0s rather than a negative age', () => {
      handleBrainStatus(
        msg('brain.status', {
          maxAutoRisk: 'low',
          log: [{ at: Date.now() + 60_000, kind: 'k', question: 'q', outcome: '' }],
        }),
      );
      expect(lastChat()?.content).toContain('`0s ago`');
    });

    it('truncates a long question at 67 chars plus an ellipsis', () => {
      handleBrainStatus(
        msg('brain.status', {
          maxAutoRisk: 'low',
          log: [{ at: Date.now(), kind: 'k', question: 'q'.repeat(100), outcome: '' }],
        }),
      );
      expect(lastChat()?.content).toContain(`${'q'.repeat(67)}…`);
    });

    it('keeps a question exactly at the 70-char limit intact', () => {
      const q = 'q'.repeat(70);
      handleBrainStatus(
        msg('brain.status', {
          maxAutoRisk: 'low',
          log: [{ at: Date.now(), kind: 'k', question: q, outcome: '' }],
        }),
      );
      expect(lastChat()?.content).toContain(q);
      expect(lastChat()?.content).not.toContain('…');
    });

    it('omits the outcome clause when there is none', () => {
      handleBrainStatus(
        msg('brain.status', {
          maxAutoRisk: 'low',
          log: [{ at: Date.now(), kind: 'k', question: 'q', outcome: '' }],
        }),
      );
      // The header line itself contains an arrow, so assert on the entry row.
      const row = (lastChat()?.content ?? '').split('\n').find((line) => line.startsWith('- `'));
      expect(row).toBeDefined();
      expect(row).not.toContain('→');
    });
  });

  // ── brain.answer ──────────────────────────────────────────────────────────

  describe('brain.answer', () => {
    it('renders an answer', () => {
      handleBrainAnswer(
        msg('brain.answer', { question: 'q', decision: { type: 'answer', text: 'Use option B' } }),
      );
      expect(lastChat()?.content).toBe('🧠 Use option B');
    });

    it('appends a rationale that differs from the answer', () => {
      handleBrainAnswer(
        msg('brain.answer', {
          question: 'q',
          decision: { type: 'answer', text: 'B', rationale: 'B is cheaper' },
        }),
      );
      expect(lastChat()?.content).toBe('🧠 B\n\n_B is cheaper_');
    });

    it('omits a rationale identical to the answer', () => {
      handleBrainAnswer(
        msg('brain.answer', {
          question: 'q',
          decision: { type: 'answer', text: 'B', rationale: 'B' },
        }),
      );
      expect(lastChat()?.content).toBe('🧠 B');
    });

    it('tolerates an answer with no text', () => {
      handleBrainAnswer(msg('brain.answer', { question: 'q', decision: { type: 'answer' } }));
      expect(lastChat()?.content).toBe('🧠 ');
    });

    it('renders a denial with its reason', () => {
      handleBrainAnswer(
        msg('brain.answer', { question: 'q', decision: { type: 'deny', reason: 'too risky' } }),
      );
      expect(lastChat()?.content).toBe('🧠 Denied: too risky');
    });

    it('renders a denial with no reason', () => {
      handleBrainAnswer(msg('brain.answer', { question: 'q', decision: { type: 'deny' } }));
      expect(lastChat()?.content).toBe('🧠 Denied: ');
    });

    it('renders an escalation for any other decision type', () => {
      handleBrainAnswer(msg('brain.answer', { question: 'q', decision: { type: 'escalate' } }));
      expect(lastChat()?.content).toContain('escalated this question back to you');
    });
  });

  // ── brain.event ───────────────────────────────────────────────────────────

  describe('brain.event', () => {
    it('reports an intervention and toasts', () => {
      handleBrainEvent(
        msg('brain.event', {
          event: 'brain.intervention',
          intervened: true,
          request: { question: 'Agent is stuck' },
          decision: { rationale: 'Try the other API' },
        }),
      );
      const content = lastChat()?.content ?? '';
      expect(content).toContain('**Brain intervention**');
      expect(content).toContain('Agent is stuck');
      expect(content).toContain('_Try the other API_');
      expect(toast.info).toHaveBeenCalledWith('Brain intervened: agent steered');
    });

    it('reports a no-action check without a toast', () => {
      handleBrainEvent(
        msg('brain.event', { event: 'brain.intervention', intervened: false, request: {} }),
      );
      expect(lastChat()?.content).toContain('**Brain check**');
      expect(toast.info).not.toHaveBeenCalled();
    });

    it('falls back from rationale to decision text', () => {
      handleBrainEvent(
        msg('brain.event', {
          event: 'brain.intervention',
          intervened: true,
          decision: { text: 'do X' },
        }),
      );
      expect(lastChat()?.content).toContain('_do X_');
    });

    it('drops empty sections from the message', () => {
      handleBrainEvent(msg('brain.event', { event: 'brain.intervention', intervened: false }));
      expect(lastChat()?.content).not.toContain('\n\n\n');
    });

    it('warns on a denied decision using the reason', () => {
      handleBrainEvent(
        msg('brain.event', { event: 'brain.decision_denied', decision: { reason: 'unsafe' } }),
      );
      expect(toast.warn).toHaveBeenCalledWith('Brain denied: unsafe');
    });

    it('falls back to the question, then to a generic label', () => {
      handleBrainEvent(
        msg('brain.event', { event: 'brain.decision_denied', request: { question: 'delete all' } }),
      );
      expect(toast.warn).toHaveBeenCalledWith('Brain denied: delete all');

      toast.warn.mockReset();
      handleBrainEvent(msg('brain.event', { event: 'brain.decision_denied' }));
      expect(toast.warn).toHaveBeenCalledWith('Brain denied: request');
    });

    it('ignores an unrelated brain event', () => {
      handleBrainEvent(msg('brain.event', { event: 'brain.something_else' }));
      expect(lastChat()).toBeUndefined();
      expect(toast.warn).not.toHaveBeenCalled();
    });

    // ── council log ──────────────────────────────────────────────────────
    describe('council', () => {
      beforeEach(() => {
        useCouncilLogStore.getState().clear();
      });

      it('assembles a panel from seat votes and its resolution', () => {
        handleBrainEvent(
          msg('brain.event', {
            event: 'brain.council_vote',
            requestId: 'req-9',
            seatId: 'voter-0',
            persona: 'executor',
            status: 'valid',
            optionId: 'merge',
            model: 'gpt-5',
          }),
        );
        handleBrainEvent(
          msg('brain.event', {
            event: 'brain.council_resolved',
            requestId: 'req-9',
            status: 'decided',
            resolution: 'majority',
            configuredSeatCount: 1,
            validVoteCount: 1,
            distinctTargetCount: 1,
            judgeUsed: false,
          }),
        );

        const [entry] = useCouncilLogStore.getState().panels;
        expect(entry).toMatchObject({
          requestId: 'req-9',
          phase: 'resolved',
          resolution: 'majority',
        });
        expect(entry?.seats).toHaveLength(1);
      });

      it('clears the stale verdict when a new-seat vote starts a fresh run on a resolved panel', () => {
        handleBrainEvent(
          msg('brain.event', {
            event: 'brain.council_vote',
            requestId: 'req-fresh',
            seatId: 'voter-0',
            persona: 'executor',
            status: 'valid',
            optionId: 'merge',
            model: 'gpt-5',
          }),
        );
        handleBrainEvent(
          msg('brain.event', {
            event: 'brain.council_resolved',
            requestId: 'req-fresh',
            status: 'decided',
            resolution: 'majority',
            configuredSeatCount: 1,
            validVoteCount: 1,
          }),
        );
        expect(useCouncilLogStore.getState().panels[0]?.phase).toBe('resolved');
        expect(useCouncilLogStore.getState().panels[0]?.resolution).toBe('majority');

        // A retry reuses the request id with a different seat: the stale
        // verdict (and the previous run's seats) must be cleared while the
        // new run votes — the summary panel must not keep showing the old
        // verdict.
        handleBrainEvent(
          msg('brain.event', {
            event: 'brain.council_vote',
            requestId: 'req-fresh',
            seatId: 'voter-1',
            persona: 'auditor',
            status: 'valid',
            optionId: 'hold',
            model: 'claude',
          }),
        );
        const panel = useCouncilLogStore.getState().panels[0]!;
        expect(panel.phase).toBe('voting');
        expect(panel.resolution).toBeUndefined();
        expect(panel.status).toBeUndefined();
        expect(panel.validVoteCount).toBeUndefined();
        expect(panel.configuredSeatCount).toBeUndefined();
        expect(panel.seats.map((seat) => seat.seatId)).toEqual(['voter-1']);
      });

      it('keeps the verdict when a re-delivered vote replays an existing seat', () => {
        handleBrainEvent(
          msg('brain.event', {
            event: 'brain.council_vote',
            requestId: 'req-replay',
            seatId: 'voter-0',
            persona: 'executor',
            status: 'valid',
            optionId: 'merge',
            model: 'gpt-5',
          }),
        );
        handleBrainEvent(
          msg('brain.event', {
            event: 'brain.council_resolved',
            requestId: 'req-replay',
            status: 'decided',
            resolution: 'majority',
            configuredSeatCount: 1,
            validVoteCount: 1,
          }),
        );
        // A reconnect replay re-delivers the SAME seat's vote after
        // resolution — must NOT clear the verdict or flip the panel back to
        // voting.
        handleBrainEvent(
          msg('brain.event', {
            event: 'brain.council_vote',
            requestId: 'req-replay',
            seatId: 'voter-0',
            persona: 'executor',
            status: 'valid',
            optionId: 'merge',
            model: 'gpt-5',
          }),
        );
        const panel = useCouncilLogStore.getState().panels[0]!;
        expect(panel.phase).toBe('resolved');
        expect(panel.resolution).toBe('majority');
        expect(panel.seats).toHaveLength(1);
      });

      it('folds in the question from the nested request.id of a decision event', () => {
        // The two event families spell the id differently: council events carry
        // a top-level `requestId`, decision events nest it as `request.id`.
        // Reading only the former matched nothing and left every row titled by
        // a bare request id.
        handleBrainEvent(
          msg('brain.event', { event: 'brain.council_vote', requestId: 'req-10', seatId: 's0' }),
        );
        handleBrainEvent(
          msg('brain.event', {
            event: 'brain.decision_answered',
            request: { id: 'req-10', question: 'Merge the risky auth change?' },
            decision: { type: 'answer' },
          }),
        );

        expect(useCouncilLogStore.getState().panels[0]?.question).toBe(
          'Merge the risky auth change?',
        );
      });

      it('does not open a panel for a decision that never convened a council', () => {
        handleBrainEvent(
          msg('brain.event', {
            event: 'brain.decision_answered',
            request: { id: 'req-policy', question: 'Retry the tool?' },
            decision: { type: 'answer' },
          }),
        );

        expect(useCouncilLogStore.getState().panels).toHaveLength(0);
      });
    });
  });

  // ── memory.event ──────────────────────────────────────────────────────────

  describe('memory.event', () => {
    it('pushes a viz event labelled with the bare event name', () => {
      handleMemoryEvent(msg('memory.event', { event: 'memory.recalled' }));
      expect(useVizStore.getState().events[0]).toMatchObject({
        kind: 'memory:event',
        source: 'sage',
        target: 'leader',
        label: 'recalled',
        flowGroup: 'memory',
      });
    });

    it('forwards every event to the lifecycle store', () => {
      const pushEvent = vi.fn();
      useMemoryLifecycleStore.setState({ pushEvent } as never);
      handleMemoryEvent(msg('memory.event', { event: 'memory.recalled' }));
      expect(pushEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'memory.recalled' }));
    });

    it('routes an injector run to the trace store', () => {
      const pushTrace = vi.fn();
      useMemoryInjectorTraceStore.setState({ pushTrace } as never);
      handleMemoryEvent(msg('memory.event', { event: 'memory.injector_run', injected: 2 }));
      expect(pushTrace).toHaveBeenCalledWith(expect.objectContaining({ injected: 2 }));
    });

    it('routes a context snapshot to the trace store', () => {
      const applyContextSnapshot = vi.fn();
      useMemoryInjectorTraceStore.setState({ applyContextSnapshot } as never);
      handleMemoryEvent(msg('memory.event', { event: 'memory.context_snapshot', tokens: 10 }));
      expect(applyContextSnapshot).toHaveBeenCalledWith(expect.objectContaining({ tokens: 10 }));
    });

    it('warns when a memory goes stale', () => {
      handleMemoryEvent(msg('memory.event', { event: 'memory.staled', memoryId: 'm1' }));
      expect(toast.warn).toHaveBeenCalledWith('Memory became stale: m1');
    });

    it('warns on a contradiction', () => {
      handleMemoryEvent(msg('memory.event', { event: 'memory.contradicted', memoryId: 'm2' }));
      expect(toast.warn).toHaveBeenCalledWith('Memory contradicted: m2');
    });

    it('renders an empty id rather than "undefined"', () => {
      handleMemoryEvent(msg('memory.event', { event: 'memory.staled' }));
      expect(toast.warn).toHaveBeenCalledWith('Memory became stale: ');
    });

    it('reports hygiene completion', () => {
      handleMemoryEvent(msg('memory.event', { event: 'memory.hygiene_completed' }));
      expect(toast.info).toHaveBeenCalledWith('SAGE hygiene completed');
    });

    it('stays quiet for other memory events', () => {
      handleMemoryEvent(msg('memory.event', { event: 'memory.recalled' }));
      expect(toast.warn).not.toHaveBeenCalled();
      expect(toast.info).not.toHaveBeenCalled();
    });
  });

  // ── collab ────────────────────────────────────────────────────────────────

  describe('collab.event', () => {
    it('labels from kind, then event, then a default', () => {
      handleCollabEvent(msg('collab.event', { kind: 'control_granted' }));
      expect(useVizStore.getState().events[0]?.label).toBe('control_granted');

      handleCollabEvent(msg('collab.event', { event: 'paused' }));
      expect(useVizStore.getState().events[0]?.label).toBe('paused');

      handleCollabEvent(msg('collab.event', {}));
      expect(useVizStore.getState().events[0]?.label).toBe('collab.event');
    });

    it('targets the session id when present, else a generic target', () => {
      handleCollabEvent(msg('collab.event', { sessionId: 's1' }));
      expect(useVizStore.getState().events[0]?.target).toBe('s1');

      handleCollabEvent(msg('collab.event', { sessionId: 42 }));
      expect(useVizStore.getState().events[0]?.target).toBe('session');
    });

    it('activates the viz surface', () => {
      handleCollabEvent(msg('collab.event', {}));
      expect(useVizStore.getState().isActive).toBe(true);
    });
  });

  describe('collab.injection.granted', () => {
    it('reports a consumed injection with the tool name', () => {
      handleCollabInjectionGranted(
        msg('collab.injection.granted', { phase: 'consumed', toolName: 'bash' }),
      );
      expect(toast.success).toHaveBeenCalledWith('Tool injection applied to bash');
    });

    it('omits the tool name when absent', () => {
      handleCollabInjectionGranted(msg('collab.injection.granted', { phase: 'consumed' }));
      expect(toast.success).toHaveBeenCalledWith('Tool injection applied');
    });

    it('reports a queued injection for any other phase', () => {
      handleCollabInjectionGranted(msg('collab.injection.granted', { phase: 'queued' }));
      expect(toast.info).toHaveBeenCalledWith('Collab tool injection queued');
    });

    it('treats an empty payload as a queued injection', () => {
      handleCollabInjectionGranted(msg('collab.injection.granted', {}));
      expect(toast.info).toHaveBeenCalledWith('Collab tool injection queued');
    });

    it('throws on a payload-less frame — the decoder is what guarantees one', () => {
      // `handleCollabInjectionGranted` types its payload as possibly undefined
      // but delegates to `handleCollabEvent`, which dereferences it unguarded.
      // Server frames without a `payload` are rejected by
      // `decodeProtocolMessage` before reaching any handler, so this is
      // unreachable in practice — pinned here so the coupling is explicit.
      expect(() =>
        handleCollabInjectionGranted(msg('collab.injection.granted', undefined)),
      ).toThrow(TypeError);
    });

    it('also pushes the underlying collab viz event', () => {
      handleCollabInjectionGranted(msg('collab.injection.granted', { phase: 'consumed' }));
      expect(useVizStore.getState().events[0]?.kind).toBe('collab:event');
    });
  });

  // ── eternal.iteration ─────────────────────────────────────────────────────

  describe('eternal.iteration', () => {
    it('ignores a frame with no entry', () => {
      handleEternalIteration(msg('eternal.iteration', {}));
      handleEternalIteration(msg('eternal.iteration', undefined));
      expect(useVizStore.getState().events).toHaveLength(0);
    });

    it('appends a journal entry and pushes a viz event', () => {
      useGoalStateStore.getState().setGoal({ goal: 'Ship it', iterations: 1, journal: [] });
      handleEternalIteration(
        msg('eternal.iteration', {
          entry: { iteration: 4, task: 'add tests', status: 'success', at: '2026-07-29T00:00:00Z' },
        }),
      );
      const journal = useGoalStateStore.getState().goal?.journal ?? [];
      expect(journal[0]).toMatchObject({ iteration: 4, task: 'add tests', status: 'success' });
      expect(useVizStore.getState().events[0]).toMatchObject({
        kind: 'eternal:iteration',
        label: 'L4: add tests',
        flowGroup: 'eternal',
      });
    });

    it('labels an entry with no task by iteration number', () => {
      handleEternalIteration(msg('eternal.iteration', { entry: { iteration: 7 } }));
      expect(useVizStore.getState().events[0]?.label).toBe('Eternal iteration 7');
    });

    it('defaults a non-numeric iteration to 0', () => {
      handleEternalIteration(msg('eternal.iteration', { entry: { iteration: 'x' } }));
      expect(useVizStore.getState().events[0]?.label).toBe('Eternal iteration 0');
    });

    it('uses costUsd as the magnitude, defaulting to 1', () => {
      handleEternalIteration(msg('eternal.iteration', { entry: { iteration: 1, costUsd: 0.42 } }));
      expect(useVizStore.getState().events[0]?.magnitude).toBe(0.42);

      handleEternalIteration(msg('eternal.iteration', { entry: { iteration: 2 } }));
      expect(useVizStore.getState().events[0]?.magnitude).toBe(1);
    });

    it('colours a failed iteration red', () => {
      handleEternalIteration(
        msg('eternal.iteration', { entry: { iteration: 1, status: 'failure' } }),
      );
      expect(useVizStore.getState().events[0]?.color).toBe('hsl(0, 80%, 55%)');

      handleEternalIteration(
        msg('eternal.iteration', { entry: { iteration: 2, status: 'success' } }),
      );
      expect(useVizStore.getState().events[0]?.color).toBe('hsl(220, 80%, 60%)');
    });

    it('synthesises a timestamp when the entry has none', () => {
      useGoalStateStore.getState().setGoal({ goal: 'Ship it', journal: [] });
      handleEternalIteration(msg('eternal.iteration', { entry: { iteration: 1 } }));
      const entry = useGoalStateStore.getState().goal?.journal?.[0];
      expect(typeof entry?.timestamp).toBe('string');
      expect(Number.isFinite(Date.parse(entry?.timestamp ?? ''))).toBe(true);
    });

    it('activates the viz surface', () => {
      handleEternalIteration(msg('eternal.iteration', { entry: { iteration: 1 } }));
      expect(useVizStore.getState().isActive).toBe(true);
    });
  });

  // ── working_dir.changed ───────────────────────────────────────────────────

  describe('working_dir.changed', () => {
    it('updates the session env and re-requests the tree', () => {
      handleWorkingDirChanged(
        msg('working_dir.changed', { cwd: '/repo/sub', projectRoot: '/repo' }),
      );
      expect(useSessionStore.getState()).toMatchObject({
        cwd: '/repo/sub',
        projectRoot: '/repo',
        projectName: 'repo',
      });
      expect(useFileStore.getState().treeLoading).toBe(true);
      expect(send).toHaveBeenCalledWith({ type: 'files.tree', payload: { path: '/repo/sub' } });
    });

    it('derives the project name from a Windows path', () => {
      handleWorkingDirChanged(
        msg('working_dir.changed', { cwd: 'D:\\code\\app', projectRoot: 'D:\\code\\app' }),
      );
      expect(useSessionStore.getState().projectName).toBe('app');
    });

    it('falls back to the whole root when no segment can be derived', () => {
      handleWorkingDirChanged(msg('working_dir.changed', { cwd: '/', projectRoot: '/' }));
      expect(useSessionStore.getState().projectName).toBe('/');
    });
  });

  // ── git ───────────────────────────────────────────────────────────────────

  describe('git.info', () => {
    it('stores the branch summary with a fetch timestamp', () => {
      handleGitInfo(
        msg('git.info', {
          branch: 'main',
          added: 1,
          deleted: 2,
          untracked: 3,
          behind: 0,
          ahead: 4,
        }),
      );
      const info = useGitInfoStore.getState().info;
      expect(info).toMatchObject({ branch: 'main', added: 1, deleted: 2, untracked: 3, ahead: 4 });
      expect(info?.fetchedAt).toBeGreaterThan(0);
    });
  });

  describe('git.changes', () => {
    it('stores the file list', () => {
      const files = [{ path: 'a.ts', status: 'M', added: 1, deleted: 0, staged: false }];
      handleGitChanges(msg('git.changes', { files }));
      expect(useGitChangesStore.getState().files).toEqual(files);
      expect(useGitChangesStore.getState().error).toBeNull();
    });

    it('normalises a missing list and carries the error', () => {
      handleGitChanges(msg('git.changes', { error: 'not a repo' }));
      expect(useGitChangesStore.getState().files).toEqual([]);
      expect(useGitChangesStore.getState().error).toBe('not a repo');
    });
  });

  describe('git.action_result', () => {
    it('refreshes git state after a successful mutation', () => {
      handleGitActionResult(msg('git.action_result', { action: 'stage', ok: true }));

      expect(getGitChanges).toHaveBeenCalledOnce();
      expect(getGitInfo).toHaveBeenCalledOnce();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('surfaces a failed mutation without refreshing stale state', () => {
      handleGitActionResult(
        msg('git.action_result', { action: 'commit', ok: false, error: 'commit failed' }),
      );

      expect(toast.error).toHaveBeenCalledWith('commit failed');
      expect(getGitChanges).not.toHaveBeenCalled();
      expect(getGitInfo).not.toHaveBeenCalled();
    });
  });

  describe('git.diff', () => {
    it('stores the diff for the selected file', () => {
      useGitChangesStore.setState({ selectedPath: 'a.ts' } as never);
      handleGitDiff(msg('git.diff', { path: 'a.ts', oldText: 'old', newText: 'new' }));
      expect(useGitChangesStore.getState().diff).toMatchObject({
        path: 'a.ts',
        oldText: 'old',
        newText: 'new',
      });
    });

    it('drops a diff for a file the user already navigated away from', () => {
      useGitChangesStore.setState({ selectedPath: 'a.ts', diff: null } as never);
      handleGitDiff(msg('git.diff', { path: 'b.ts', oldText: 'x', newText: 'y' }));
      expect(useGitChangesStore.getState().diff).toBeNull();
    });

    it('defaults missing text to empty strings', () => {
      useGitChangesStore.setState({ selectedPath: 'a.ts' } as never);
      handleGitDiff(msg('git.diff', { path: 'a.ts' }));
      expect(useGitChangesStore.getState().diff).toMatchObject({ oldText: '', newText: '' });
    });

    it('carries the binary / tooLarge / error flags', () => {
      useGitChangesStore.setState({ selectedPath: 'a.png' } as never);
      handleGitDiff(
        msg('git.diff', { path: 'a.png', binary: true, tooLarge: true, error: 'skipped' }),
      );
      expect(useGitChangesStore.getState().diff).toMatchObject({
        binary: true,
        tooLarge: true,
        error: 'skipped',
      });
    });
  });

  // ── cron ──────────────────────────────────────────────────────────────────

  describe('cron', () => {
    it('stores the snapshot', () => {
      const jobs = [
        {
          name: 'nightly',
          intervalMs: 1,
          action: '/x',
          enabled: true,
          lastRun: null,
          nextRun: 'n',
          runCount: 0,
          overdue: false,
        },
      ];
      handleCronSnapshot(msg('cron.snapshot', { count: 1, maxConcurrent: 2, jobs }));
      expect(useCronStore.getState().snapshot).toEqual({ count: 1, maxConcurrent: 2, jobs });
    });

    it('normalises a missing job list to []', () => {
      handleCronSnapshot(msg('cron.snapshot', { count: 0, maxConcurrent: 1 }));
      expect(useCronStore.getState().snapshot?.jobs).toEqual([]);
    });

    it('records a job firing by name', () => {
      handleCronJobFired(
        msg('cron.job_fired', { name: 'nightly', action: '/x', runCount: 2, ts: 'T' }),
      );
      expect(useCronStore.getState().lastFiredAt).toEqual({ nightly: 'T' });
    });
  });

  // ── model.refine_result ───────────────────────────────────────────────────

  describe('model.refine_result — pre-queue path', () => {
    beforeEach(() => {
      useUIStore.setState({ refinePanel: null } as never);
    });

    it('enqueues the original when refinement errored', () => {
      const enqueue = vi.fn();
      const setPendingRefinement = vi.fn();
      const setRefining = vi.fn();
      useChatStore.setState({
        pendingRefinement: { text: 'do the thing' },
        enqueue,
        setPendingRefinement,
        setRefining,
      } as never);

      handleModelRefineResult(
        msg('model.refine_result', { refined: '', english: '', error: 'timeout' }),
      );
      expect(setRefining).toHaveBeenCalledWith(false);
      expect(setPendingRefinement).toHaveBeenCalledWith(null);
      expect(enqueue).toHaveBeenCalledWith('do the thing', 'queue', undefined);
    });

    it('converts pending images to the queue format', () => {
      const enqueue = vi.fn();
      useChatStore.setState({
        pendingRefinement: {
          text: 'do it',
          images: [{ data: 'AAAA', mime: 'image/png' }],
        },
        enqueue,
        setPendingRefinement: vi.fn(),
        setRefining: vi.fn(),
      } as never);

      handleModelRefineResult(msg('model.refine_result', { refined: '', english: '', error: 'x' }));
      const images = enqueue.mock.calls[0]?.[2] as Array<Record<string, unknown>>;
      expect(images).toHaveLength(1);
      expect(images[0]).toMatchObject({
        dataUrl: 'data:image/png;base64,AAAA',
        mediaType: 'image/png',
        bytes: 3,
      });
    });

    it('enqueues the original when the refinement is a no-op', () => {
      const enqueue = vi.fn();
      useChatStore.setState({
        pendingRefinement: { text: 'do it' },
        enqueue,
        setPendingRefinement: vi.fn(),
        setRefining: vi.fn(),
      } as never);

      handleModelRefineResult(msg('model.refine_result', { refined: 'do it', english: 'do it' }));
      expect(enqueue).toHaveBeenCalledWith('do it', 'queue', undefined);
      expect(useUIStore.getState().refinePanel).toBeNull();
    });

    it('enqueues the original when the refinement came back empty', () => {
      const enqueue = vi.fn();
      useChatStore.setState({
        pendingRefinement: { text: 'do it' },
        enqueue,
        setPendingRefinement: vi.fn(),
        setRefining: vi.fn(),
      } as never);

      handleModelRefineResult(msg('model.refine_result', { refined: '', english: '' }));
      expect(enqueue).toHaveBeenCalledWith('do it', 'queue', undefined);
    });

    it('opens the approval panel for a real refinement', () => {
      useChatStore.setState({
        pendingRefinement: { text: 'do it' },
        enqueue: vi.fn(),
        setPendingRefinement: vi.fn(),
        setRefining: vi.fn(),
      } as never);

      handleModelRefineResult(
        msg('model.refine_result', {
          refined: 'Please do the thing precisely',
          english: 'Please do the thing precisely',
          refinedWith: { provider: 'anthropic', model: 'opus' },
        }),
      );
      expect(useUIStore.getState().refinePanel).toMatchObject({
        original: 'do it',
        refined: 'Please do the thing precisely',
        status: 'ready',
        provider: 'anthropic',
        model: 'opus',
      });
    });

    it('falls back to the refined text when no english rendering is sent', () => {
      useChatStore.setState({
        pendingRefinement: { text: 'do it' },
        enqueue: vi.fn(),
        setPendingRefinement: vi.fn(),
        setRefining: vi.fn(),
      } as never);
      handleModelRefineResult(msg('model.refine_result', { refined: 'REFINED', english: '' }));
      expect(useUIStore.getState().refinePanel?.english).toBe('REFINED');
    });
  });

  describe('model.refine_result — panel path', () => {
    it('is a no-op with no panel and no pending refinement', () => {
      useChatStore.setState({ pendingRefinement: null } as never);
      useUIStore.setState({ refinePanel: null } as never);
      handleModelRefineResult(msg('model.refine_result', { refined: 'x', english: 'x' }));
      expect(useUIStore.getState().refinePanel).toBeNull();
    });

    it('auto-retries once on a timeout with the server-suggested window', () => {
      useUIStore.setState({
        refinePanel: { original: 'do it', status: 'refining', retried: false },
      } as never);
      handleModelRefineResult(
        msg('model.refine_result', {
          refined: '',
          english: '',
          error: 'timed out',
          errorKind: 'timeout',
          retryTimeoutMs: 30_000,
        }),
      );
      expect(useUIStore.getState().refinePanel).toMatchObject({
        status: 'refining',
        retried: true,
      });
      expect(refineModel).toHaveBeenCalledWith('do it', { timeoutMs: 30_000 });
    });

    it('surfaces the failure on a second timeout instead of retrying again', () => {
      useUIStore.setState({
        refinePanel: { original: 'do it', status: 'refining', retried: true },
      } as never);
      handleModelRefineResult(
        msg('model.refine_result', {
          refined: '',
          english: '',
          error: 'timed out',
          errorKind: 'timeout',
          retryTimeoutMs: 30_000,
        }),
      );
      expect(refineModel).not.toHaveBeenCalled();
      expect(useUIStore.getState().refinePanel).toMatchObject({
        status: 'failed',
        error: 'timed out',
        errorKind: 'timeout',
      });
    });

    it('does not retry a timeout with no suggested window', () => {
      useUIStore.setState({
        refinePanel: { original: 'do it', status: 'refining', retried: false },
      } as never);
      handleModelRefineResult(
        msg('model.refine_result', {
          refined: '',
          english: '',
          error: 'timed out',
          errorKind: 'timeout',
        }),
      );
      expect(refineModel).not.toHaveBeenCalled();
      expect(useUIStore.getState().refinePanel?.status).toBe('failed');
    });

    it('surfaces a non-timeout failure with its fallback suggestion', () => {
      useUIStore.setState({
        refinePanel: { original: 'do it', status: 'refining', retried: false },
      } as never);
      handleModelRefineResult(
        msg('model.refine_result', {
          refined: '',
          english: '',
          error: 'provider down',
          errorKind: 'provider_error',
          fallbackRef: 'anthropic/haiku',
        }),
      );
      expect(useUIStore.getState().refinePanel).toMatchObject({
        status: 'failed',
        error: 'provider down',
        errorKind: 'provider_error',
        fallbackRef: 'anthropic/haiku',
      });
      expect(refineModel).not.toHaveBeenCalled();
    });

    it('sends the original immediately when refinement changed nothing', () => {
      const addMessage = vi.fn();
      const setLoading = vi.fn();
      useChatStore.setState({ addMessage, setLoading, pendingRefinement: null } as never);
      useUIStore.setState({ refinePanel: { original: 'do it', status: 'refining' } } as never);

      handleModelRefineResult(msg('model.refine_result', { refined: 'do it', english: 'do it' }));
      expect(useUIStore.getState().refinePanel).toBeNull();
      expect(addMessage).toHaveBeenCalledWith({ role: 'user', content: 'do it' });
      expect(setLoading).toHaveBeenCalledWith(true);
      expect(sendMessage).toHaveBeenCalledWith('do it');
    });

    it('populates the panel for review on a real refinement', () => {
      useUIStore.setState({
        refinePanel: { original: 'do it', status: 'refining', error: 'stale', errorKind: 'empty' },
      } as never);
      handleModelRefineResult(
        msg('model.refine_result', {
          refined: 'Please do the thing',
          english: 'Please do the thing',
          refinedWith: { provider: 'openai', model: 'gpt-5' },
        }),
      );
      expect(useUIStore.getState().refinePanel).toMatchObject({
        status: 'ready',
        refined: 'Please do the thing',
        english: 'Please do the thing',
        provider: 'openai',
        model: 'gpt-5',
      });
      // Stale failure state from the prior round is cleared.
      expect(useUIStore.getState().refinePanel?.error).toBeUndefined();
      expect(useUIStore.getState().refinePanel?.errorKind).toBeUndefined();
    });

    it('omits provider/model when the server does not report them', () => {
      useUIStore.setState({
        refinePanel: { original: 'do it', status: 'refining' },
      } as never);
      handleModelRefineResult(
        msg('model.refine_result', { refined: 'Please do it', english: 'Please do it' }),
      );
      const panel = useUIStore.getState().refinePanel;
      expect(panel).toMatchObject({ status: 'ready' });
      expect(panel).not.toHaveProperty('provider');
    });
  });
});
