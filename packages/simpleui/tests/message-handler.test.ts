// @vitest-environment node

/**
 * PR-0 safety net: behavior coverage for `createMessageHandler` so the upcoming
 * `app.tsx` decomposition (PR-1..PR-8) cannot silently regress the WebSocket
 * message routing logic that the React tree depends on.
 *
 * The handler is a pure function over its dependency bag, so we exercise it
 * without React, jsdom, or a real WebSocket: every `useState` setter becomes a
 * stateful holder that mimics React's `setState(prev => next)` contract, and
 * every `ref` becomes a plain mutable holder. The handler itself stays
 * untouched — this file is a read-only safety net, not a refactor.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEADER_AGENT_ID } from '../src/lib/agent-model.js';
import type { FileMention } from '../src/lib/file-mention.js';
import type { MessageHandlerDeps, ServerMessageHandler } from '../src/lib/message-handler.js';
import { createMessageHandler } from '../src/lib/message-handler.js';
import { DEFAULT_PREFS } from '../src/lib/prefs-model.js';
import type { QueuedItem } from '../src/lib/queue-model.js';
import type { RefineState } from '../src/lib/refine-model.js';
import type { StatusNoticeProjection } from '../src/lib/status-notice.js';
import { createWorklistStore } from '../src/lib/worklist-store.js';
import type {
  AgentTranscriptEntry,
  ChatMessage,
  ContextInfo,
  FileEditMeta,
  ModelDescriptor,
  PendingConfirm,
  ResumeProgressInfo,
  SessionInfo,
  SimplePrefs,
  SimpleSessionSummary,
  SimpleSubagent,
  ToolCallInfo,
} from '../src/types.js';

/**
 * State shape stored via the optional `setFallbackPending` dep — mirrors the
 * inline type in `MessageHandlerDeps` (`message-handler.ts`) so the harness
 * can hold and assert the projected fallback modal.
 */
interface FallbackPendingState {
  requestId: string;
  from: { providerId: string; model: string };
  status: number;
  candidates: Array<{ providerId: string; model: string }>;
  autoSwitchSeconds: number;
}

interface Harness {
  /**
   * Streaming text deltas are coalesced onto an animation frame, so a test that
   * asserts on transcript text right after a `provider.text_delta` must call
   * `handler.flush()` first. Any other message type flushes implicitly.
   */
  handler: ServerMessageHandler;
  /**
   * Live snapshot of every stateful setter. Reading `state.messages`
   * always returns the latest committed value because each property is a
   * getter that re-reads the underlying holder's `latest` reference —
   * not a snapshot taken at harness-construction time.
   */
  readonly state: {
    readonly messages: ChatMessage[];
    readonly running: boolean;
    readonly activity: string;
    readonly toolCalls: ToolCallInfo[];
    readonly subagents: SimpleSubagent[];
    readonly agentTranscripts: Record<string, AgentTranscriptEntry[]>;
    readonly session: SessionInfo | null;
    readonly resumeProgress: ResumeProgressInfo | null;
    readonly sessions: SimpleSessionSummary[];
    readonly sessionMenuOpen: boolean;
    readonly context: ContextInfo;
    readonly models: Record<string, ModelDescriptor[]>;
    readonly modes: { id: string; name: string; description?: string }[];
    readonly activeModeId: string;
    readonly prefs: SimplePrefs;
    readonly draft: string;
    readonly fileRefs: string[];
    readonly fileMention: FileMention | null;
    readonly notice: (StatusNoticeProjection & { id: string }) | null;
    readonly queue: QueuedItem[];
    readonly refineState: RefineState | null;
    readonly pendingConfirm: PendingConfirm | null;
    readonly selectedAgentId: string;
    readonly sessionStart: number | null;
    readonly showJumpToLatest: boolean;
    readonly fileMatches: string[];
    readonly filePickerIndex: number;
    readonly fileSearching: boolean;
    readonly attachedImages: { id: string; data: string; mime: string; name: string }[];
    readonly copiedMessageId: string | null;
    readonly providerLabels: Record<string, string>;
    readonly diffFiles: FileEditMeta[] | null;
    readonly fallbackPending: FallbackPendingState | null;
    /**
     * How many times `setMessages` has been dispatched. Streaming coalescing is
     * a claim about update *count*, which the resulting text cannot show.
     */
    readonly setMessagesCalls: number;
  };
  /**
   * Live snapshot of mutable refs. Each property reads the current `current`
   * field of the corresponding ref-like object so tests see the latest value
   * after the handler mutates the ref.
   */
  readonly refs: {
    readonly sessionId: string | null;
    readonly activeModel: { provider: string; model: string } | null;
    readonly requestedModels: Set<string>;
    readonly stickToBottom: boolean;
  };
  /**
   * Read/write handle to the underlying mutable refs. Tests use this to seed
   * state before feeding a server frame — the handler reads these refs at
   * dispatch time, so mutating them here is equivalent to a real composer
   * edit or session switch. The exposed ref objects share identity with the
   * ones the handler closes over, so any later handler call sees the latest
   * mutation.
   */
  readonly mutableRefs: {
    sessionIdRef: { current: string | null };
    activeModelRef: { current: { provider: string; model: string } | null };
    messagesRef: { current: ChatMessage[] };
    runningRef: { current: boolean };
    queueRef: { current: QueuedItem[] };
    draftRef: { current: string };
    fileRefsRef: { current: string[] };
    prefsRef: { current: SimplePrefs };
  };
  socket: { sent: { type: string; payload?: Record<string, unknown> }[] };
  dispatchUserMessage: ReturnType<typeof vi.fn>;
  requestProviderModels: ReturnType<typeof vi.fn>;
  onChime: ReturnType<typeof vi.fn>;
  writeComposerDraft: ReturnType<typeof vi.fn>;
  clearComposerDraft: ReturnType<typeof vi.fn>;
  readComposerDraft: ReturnType<typeof vi.fn>;
  resetAgentNameCache: ReturnType<typeof vi.fn>;
  worklists: ReturnType<typeof createWorklistStore>;
}

/**
 * Build a stateful holder that mimics React's `useState` setter semantics:
 * accepts either a value or an updater `prev => next`. Records the latest value
 * in `latest` and pushes every update into `history` for assertions.
 */
function makeHolder<T>(initial: T) {
  const latest = { current: initial };
  const history: T[] = [initial];
  const setter = vi.fn((value: T | ((prev: T) => T)) => {
    const next = typeof value === 'function' ? (value as (prev: T) => T)(latest.current) : value;
    latest.current = next;
    history.push(next);
  });
  return Object.assign(setter, { latest, history });
}

function makeRef<T>(initial: T): { current: T } {
  return { current: initial };
}

function createHarness(overrides: Partial<MessageHandlerDeps> = {}): Harness {
  const messages = makeHolder<ChatMessage[]>([]);
  const running = makeHolder<boolean>(false);
  const activity = makeHolder<string>('');
  const toolCalls = makeHolder<ToolCallInfo[]>([]);
  const subagents = makeHolder<SimpleSubagent[]>([]);
  const agentTranscripts = makeHolder<Record<string, AgentTranscriptEntry[]>>({});
  const session = makeHolder<SessionInfo | null>(null);
  const resumeProgress = makeHolder<ResumeProgressInfo | null>(null);
  const sessions = makeHolder<SimpleSessionSummary[]>([]);
  const sessionMenuOpen = makeHolder<boolean>(false);
  const context = makeHolder<ContextInfo>({ load: 0, tokens: 0, maxContext: 0, cache: null });
  const models = makeHolder<Record<string, ModelDescriptor[]>>({});
  const modes = makeHolder<{ id: string; name: string; description?: string }[]>([]);
  const activeModeId = makeHolder<string>('default');
  const prefs = makeHolder<SimplePrefs>({ ...DEFAULT_PREFS });
  const draft = makeHolder<string>('');
  const fileRefs = makeHolder<string[]>([]);
  const fileMention = makeHolder<FileMention | null>(null);
  const notice = makeHolder<(StatusNoticeProjection & { id: string }) | null>(null);
  const queue = makeHolder<QueuedItem[]>([]);
  const refineState = makeHolder<RefineState | null>(null);
  const pendingConfirm = makeHolder<PendingConfirm | null>(null);
  const selectedAgentId = makeHolder<string>(LEADER_AGENT_ID);
  const sessionStart = makeHolder<number | null>(null);
  const showJumpToLatest = makeHolder<boolean>(false);
  const fileMatches = makeHolder<string[]>([]);
  const filePickerIndex = makeHolder<number>(0);
  const fileSearching = makeHolder<boolean>(false);
  const attachedImages = makeHolder<{ id: string; data: string; mime: string; name: string }[]>([]);
  const copiedMessageId = makeHolder<string | null>(null);
  const providerLabels = makeHolder<Record<string, string>>({});
  const diffFiles = makeHolder<FileEditMeta[] | null>(null);
  const fallbackPending = makeHolder<FallbackPendingState | null>(null);

  const prefsRef = makeRef<SimplePrefs>({ ...DEFAULT_PREFS });
  const draftRef = makeRef<string>('');
  const fileRefsRef = makeRef<string[]>([]);
  const queueRef = makeRef<QueuedItem[]>([]);
  const sessionIdRef = makeRef<string | null>(null);
  const messagesRef = makeRef<ChatMessage[]>([]);
  const activeModelRef = makeRef<{ provider: string; model: string } | null>(null);
  const runningRef = makeRef<boolean>(false);
  const refineStateRef = makeRef<RefineState | null>(null);
  const refineEpochRef = makeRef<number>(0);
  const requestedModelsRef = makeRef<Set<string>>(new Set<string>());
  const stickToBottomRef = makeRef<boolean>(true);

  const socket = {
    sent: [] as { type: string; payload?: Record<string, unknown> }[],
    send: vi.fn((type: string, payload?: Record<string, unknown>) => {
      socket.sent.push(payload === undefined ? { type } : { type, payload });
    }),
  };

  const worklists = overrides.worklists ?? createWorklistStore();

  // Default: dispatch succeeds. `dispatchUserMessage` returns a boolean now —
  // the queue drain only advances when it returns true, so the default mock
  // must report success or every drain test would see a "dropped" no-op.
  const dispatchUserMessage = overrides.dispatchUserMessage ?? vi.fn().mockReturnValue(true);
  const requestProviderModels = overrides.requestProviderModels ?? vi.fn();
  const onChime = overrides.onChime ?? vi.fn();
  const writeComposerDraft = overrides.writeComposerDraft ?? vi.fn();
  const clearComposerDraft = overrides.clearComposerDraft ?? vi.fn();
  const readComposerDraft =
    overrides.readComposerDraft ?? vi.fn(() => ({ text: '', fileRefs: [] as string[] }));
  const resetAgentNameCache = overrides.resetAgentNameCache ?? vi.fn();

  const handler = createMessageHandler({
    prefsRef,
    draftRef,
    fileRefsRef,
    queueRef,
    sessionIdRef,
    messagesRef,
    activeModelRef,
    runningRef,
    refineStateRef,
    refineEpochRef,
    socketRef: makeRef(socket),
    requestedModelsRef,
    stickToBottomRef,
    setMessages: messages,
    setRunning: running,
    setActivity: activity,
    setToolCalls: toolCalls,
    setSubagents: subagents,
    setAgentTranscripts: agentTranscripts,
    setSession: session,
    setResumeProgress: resumeProgress,
    setSessionMenuOpen: sessionMenuOpen,
    setSessions: sessions,
    setContext: context,
    setModels: models,
    setModes: modes,
    setActiveModeId: activeModeId,
    setPrefs: prefs,
    setDraft: draft,
    setFileRefs: fileRefs,
    setFileMention: fileMention,
    setNotice: notice,
    setQueue: queue,
    setRefineState: refineState,
    setPendingConfirm: pendingConfirm,
    setSelectedAgentId: selectedAgentId,
    setSessionStart: sessionStart,
    setShowJumpToLatest: showJumpToLatest,
    setFileMatches: fileMatches,
    setFilePickerIndex: filePickerIndex,
    setFileSearching: fileSearching,
    setAttachedImages: attachedImages,
    setCopiedMessageId: copiedMessageId,
    setProviderLabels: providerLabels,
    setDiffFiles: diffFiles,
    setFallbackPending: fallbackPending,
    resetAgentNameCache,
    onChime,
    dispatchUserMessage,
    requestProviderModels,
    writeComposerDraft,
    clearComposerDraft,
    readComposerDraft,
    worklists,
    ...overrides,
  });

  return {
    handler,
    state: {
      get messages() {
        return messages.latest.current;
      },
      get setMessagesCalls() {
        return messages.mock.calls.length;
      },
      get running() {
        return running.latest.current;
      },
      get activity() {
        return activity.latest.current;
      },
      get toolCalls() {
        return toolCalls.latest.current;
      },
      get subagents() {
        return subagents.latest.current;
      },
      get agentTranscripts() {
        return agentTranscripts.latest.current;
      },
      get session() {
        return session.latest.current;
      },
      get resumeProgress() {
        return resumeProgress.latest.current;
      },
      get sessions() {
        return sessions.latest.current;
      },
      get sessionMenuOpen() {
        return sessionMenuOpen.latest.current;
      },
      get context() {
        return context.latest.current;
      },
      get models() {
        return models.latest.current;
      },
      get modes() {
        return modes.latest.current;
      },
      get activeModeId() {
        return activeModeId.latest.current;
      },
      get prefs() {
        return prefs.latest.current;
      },
      get draft() {
        return draft.latest.current;
      },
      get fileRefs() {
        return fileRefs.latest.current;
      },
      get fileMention() {
        return fileMention.latest.current;
      },
      get notice() {
        return notice.latest.current;
      },
      get queue() {
        return queue.latest.current;
      },
      get refineState() {
        return refineState.latest.current;
      },
      get pendingConfirm() {
        return pendingConfirm.latest.current;
      },
      get selectedAgentId() {
        return selectedAgentId.latest.current;
      },
      get sessionStart() {
        return sessionStart.latest.current;
      },
      get showJumpToLatest() {
        return showJumpToLatest.latest.current;
      },
      get fileMatches() {
        return fileMatches.latest.current;
      },
      get filePickerIndex() {
        return filePickerIndex.latest.current;
      },
      get fileSearching() {
        return fileSearching.latest.current;
      },
      get attachedImages() {
        return attachedImages.latest.current;
      },
      get copiedMessageId() {
        return copiedMessageId.latest.current;
      },
      get providerLabels() {
        return providerLabels.latest.current;
      },
      get diffFiles() {
        return diffFiles.latest.current;
      },
      get fallbackPending() {
        return fallbackPending.latest.current;
      },
    },
    refs: {
      get sessionId() {
        return sessionIdRef.current;
      },
      get activeModel() {
        return activeModelRef.current;
      },
      get requestedModels() {
        return requestedModelsRef.current;
      },
      get stickToBottom() {
        return stickToBottomRef.current;
      },
    },
    mutableRefs: {
      sessionIdRef,
      activeModelRef,
      messagesRef,
      runningRef,
      queueRef,
      draftRef,
      fileRefsRef,
      prefsRef,
    },
    socket,
    dispatchUserMessage: dispatchUserMessage as ReturnType<typeof vi.fn>,
    requestProviderModels,
    onChime,
    writeComposerDraft,
    clearComposerDraft,
    readComposerDraft,
    resetAgentNameCache,
    worklists,
  };
}

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('session.start', () => {
  /**
   * The context bar reports how full the WINDOW is, so it may only ever be fed
   * a per-request measurement. This used to prefer `replayUsage.input`, the
   * session's running total across every request it ever made, and divide it
   * by `maxContext` — so a resumed long conversation opened at several hundred
   * percent (one measured session reported 9,672,042 against a 1M window).
   */
  it('feeds the context bar the last request, not the session total', () => {
    harness.handler({
      type: 'session.start',
      payload: {
        sessionId: 'sess-resumed',
        provider: 'openai',
        model: 'gpt-4o',
        maxContext: 1_000_000,
        reset: true,
        lastInputTokens: 120_000,
        replayMessages: [{ role: 'user', content: 'hi', ts: '2026-01-01T00:00:00.000Z' }],
        replayUsage: { input: 9_672_042, output: 277_805, cacheRead: 61_728_448, cacheWrite: 0 },
      },
    });

    expect(harness.state.context.tokens).toBe(120_000);
    expect(harness.state.context.load).toBeCloseTo(0.12, 5);
  });

  it('leaves the bar unset when the server has no per-request reading', () => {
    harness.handler({
      type: 'session.start',
      payload: {
        sessionId: 'sess-fresh',
        provider: 'openai',
        model: 'gpt-4o',
        maxContext: 1_000_000,
        reset: true,
        replayUsage: { input: 9_672_042, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    });

    expect(harness.state.context.tokens).toBe(0);
    expect(harness.state.context.load).toBe(0);
  });

  it('seeds session, restores draft, requests providers and recent sessions', () => {
    harness.readComposerDraft.mockReturnValue({ text: 'half a thought', fileRefs: ['a.ts'] });
    harness.handler({
      type: 'session.resume_progress',
      payload: {
        sessionId: 'sess-1',
        stage: 'open_journal',
        loadedBytes: 10,
        totalBytes: 100,
      },
    });

    harness.handler({
      type: 'session.start',
      payload: {
        sessionId: 'sess-1',
        provider: 'openai',
        model: 'gpt-4o',
        projectName: 'Demo',
        cwd: '/demo',
        maxContext: 128_000,
      },
    });

    expect(harness.state.session).toEqual({
      id: 'sess-1',
      provider: 'openai',
      model: 'gpt-4o',
      projectName: 'Demo',
      cwd: '/demo',
      maxContext: 128_000,
    });
    expect(harness.refs.activeModel).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(harness.refs.sessionId).toBe('sess-1');
    expect(harness.state.draft).toBe('half a thought');
    expect(harness.state.fileRefs).toEqual(['a.ts']);
    expect(harness.state.context.maxContext).toBe(128_000);
    expect(harness.state.resumeProgress).toBeNull();
    expect(harness.requestProviderModels).toHaveBeenCalledWith('openai');
    const sent = harness.socket.sent.map((entry) => entry.type);
    expect(sent).toContain('sessions.list');
    expect(sent[0]).toBe('sessions.list');
  });

  it('tracks resume progress until the session opens or resume is refused', () => {
    harness.handler({
      type: 'session.resume_progress',
      payload: {
        sessionId: 'sess-old',
        stage: 'open_journal',
        loadedBytes: 4096,
        totalBytes: 8192,
      },
    });

    expect(harness.state.resumeProgress).toEqual({
      sessionId: 'sess-old',
      stage: 'open_journal',
      loadedBytes: 4096,
      totalBytes: 8192,
    });

    harness.handler({
      type: 'error',
      payload: {
        phase: 'session.resume',
        message: 'Session is already owned',
      },
    });

    expect(harness.state.resumeProgress).toBeNull();
  });

  it('persists the previous draft when switching sessions', () => {
    // Simulate a populated previous draft before the switch arrives.
    // We do this by feeding a session.start first to set state, then switching.
    harness.handler({
      type: 'session.start',
      payload: { sessionId: 'sess-prev', provider: 'openai', model: 'gpt-4o' },
    });
    // Pretend the user typed something into the composer between sessions.
    // Mutate the refs the handler reads directly, since the handler's
    // draft/fileRefs setters are only called when the server-side frame arrives.
    harness.mutableRefs.draftRef.current = 'unsent thought';
    harness.mutableRefs.fileRefsRef.current = ['src/keep.ts'];

    harness.handler({
      type: 'session.start',
      payload: { sessionId: 'sess-next', provider: 'openai', model: 'gpt-4o' },
    });

    expect(harness.writeComposerDraft).toHaveBeenCalledWith('sess-prev', {
      text: 'unsent thought',
      fileRefs: ['src/keep.ts'],
    });
  });

  it('clears state when the server marks reset:true', () => {
    // A fresh session.start without reset behaves like the first connect.
    // A second session.start with reset:true must wipe every ephemeral surface
    // (messages, tool calls, pending confirm, queue, attached images, selected
    // agent) and re-point the session at the new id.
    harness.handler({
      type: 'session.start',
      payload: { sessionId: 'old', provider: 'openai', model: 'gpt-4o' },
    });
    // Populate a tool call and a worker so reset:true has something to clear.
    harness.handler({ type: 'tool.started', payload: { id: 'stale-tc', name: 'read', input: {} } });
    harness.mutableRefs.selectedAgentId = 'worker-1' as never;
    // Selected-agent id is a setter, not a mutable ref. Reach the holder by
    // simulating a server-driven status_changed (which would normally select it).
    // Simpler: dispatch a second session.start with reset and assert the leader
    // is selected and toolCalls are cleared.
    harness.handler({
      type: 'session.start',
      payload: {
        sessionId: 'fresh',
        provider: 'openai',
        model: 'gpt-4o',
        maxContext: 100_000,
        reset: true,
      },
    });

    expect(harness.state.messages).toEqual([]);
    expect(harness.state.toolCalls).toEqual([]);
    expect(harness.state.selectedAgentId).toBe(LEADER_AGENT_ID);
    expect(harness.state.attachedImages).toEqual([]);
    expect(harness.state.context.maxContext).toBe(100_000);
    // The handler only calls clearComposerDraft on the `else if (reset === true)`
    // branch (i.e. same-session reset). A cross-session reset goes through the
    // `switchedSession` branch, which writes the previous draft via
    // writeComposerDraft instead. Assert the invariant we actually rely on:
    // the reset wiped every ephemeral surface and the leader was re-selected.
    expect(harness.resetAgentNameCache).toHaveBeenCalledTimes(1);
  });

  it('hydrates replayed thinking and tool calls on session resume', () => {
    harness.handler({
      type: 'session.start',
      payload: {
        sessionId: 'resumed',
        provider: 'openai',
        model: 'gpt-4o',
        maxContext: 100_000,
        reset: true,
        replayMessages: [
          { role: 'user', content: 'Inspect it', ts: '2026-07-25T10:00:00Z' },
          {
            role: 'assistant',
            ts: '2026-07-25T10:00:05Z',
            content: [
              { type: 'thinking', thinking: 'Need file context' },
              { type: 'text', text: 'Reading first.' },
              { type: 'tool_use', id: 'tc-1', name: 'read', input: { path: 'src/app.ts' } },
            ],
          },
          {
            role: 'user',
            ts: '2026-07-25T10:00:06Z',
            content: [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'source text' }],
          },
          { role: 'assistant', content: 'Done.' },
        ],
      },
    });

    expect(harness.state.messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'Inspect it' },
      { role: 'thinking', text: 'Need file context' },
      { role: 'assistant', text: 'Reading first.' },
      { role: 'assistant', text: 'Done.' },
    ]);
    expect(harness.state.toolCalls).toEqual([
      {
        id: 'tc-1',
        name: 'read',
        input: { path: 'src/app.ts' },
        replayOrder: 3,
        status: 'done',
        ok: true,
        output: 'source text',
        ts: '2026-07-25T10:00:05Z',
      },
    ]);
  });

  it('keeps a resumed running session visibly running', () => {
    harness.handler({
      type: 'session.start',
      payload: {
        sessionId: 'running-resume',
        startedAt: '2026-07-25T10:00:00Z',
        provider: 'openai',
        model: 'gpt-4o',
        reset: true,
        isRunning: true,
        replayMessages: [
          { role: 'user', content: 'Keep going', ts: '2026-07-25T10:00:00Z' },
          {
            role: 'assistant',
            ts: '2026-07-25T10:00:05Z',
            content: [
              { type: 'text', text: 'Checking the file.' },
              { type: 'tool_use', id: 'tc-live', name: 'read', input: { path: 'src/app.ts' } },
            ],
          },
        ],
      },
    });

    expect(harness.state.running).toBe(true);
    expect(harness.state.activity).toBe('Running read');
    expect(harness.state.sessionStart).toBe(Date.parse('2026-07-25T10:00:00Z'));
    expect(harness.state.toolCalls).toMatchObject([
      { id: 'tc-live', name: 'read', status: 'running' },
    ]);
  });

  it('does not hydrate subagent snapshots into the resumed main screen', () => {
    harness.handler({
      type: 'session.start',
      payload: {
        sessionId: 'sess-1',
        provider: 'openai',
        model: 'gpt-4o',
        agentSessions: [
          {
            subagentId: 'worker-a',
            agentName: 'A',
            status: 'running',
            transcript: [
              {
                id: 'tx-1',
                subagentId: 'worker-a',
                agentName: 'A',
                content: 'hello',
                kind: 'text',
                iteration: 0,
                ts: '2026-07-19T00:00:00Z',
              },
            ],
          },
          {
            // Leader entries must NEVER leak into the worker transcript store.
            subagentId: LEADER_AGENT_ID,
            agentName: 'LEADER',
            status: 'idle',
            transcript: [
              {
                id: 'tx-leader',
                subagentId: LEADER_AGENT_ID,
                agentName: 'LEADER',
                content: 'should not appear',
                kind: 'text',
                iteration: 0,
                ts: '2026-07-19T00:00:00Z',
              },
            ],
          },
        ],
      },
    });

    expect(harness.state.subagents).toEqual([]);
    expect(harness.state.agentTranscripts).toEqual({});
  });
});

describe('tool call lifecycle', () => {
  it('retains successful nextsteps tool input when the terminal response is absent', () => {
    harness.handler({
      type: 'tool.started',
      payload: {
        id: 'next-1',
        name: 'nextsteps',
        input: {
          steps: [{ text: 'Run the focused tests', auto: true }, { text: 'Review the diff' }],
        },
      },
    });
    harness.handler({
      type: 'tool.executed',
      payload: { id: 'next-1', name: 'nextsteps', ok: true },
    });
    harness.handler({ type: 'run.result', payload: { status: 'done' } });

    expect(harness.state.messages.at(-1)).toMatchObject({
      role: 'assistant',
      final: true,
      nextSteps: [
        { index: 1, text: 'Run the focused tests', auto: true },
        { index: 2, text: 'Review the diff' },
      ],
    });
  });

  it('does not duplicate nextsteps already folded into the terminal response', () => {
    harness.handler({
      type: 'tool.started',
      payload: { id: 'next-2', name: 'nextsteps', input: { steps: [{ text: 'Fallback step' }] } },
    });
    harness.handler({
      type: 'tool.executed',
      payload: { id: 'next-2', name: 'nextsteps', ok: true },
    });
    harness.handler({
      type: 'provider.response',
      payload: {
        content: 'Done.\n<nextsteps>\n1. Canonical step\n</nextsteps>',
        stopReason: 'end_turn',
      },
    });
    harness.handler({ type: 'run.result', payload: { status: 'done' } });

    expect(harness.state.messages).toHaveLength(1);
    expect(harness.state.messages[0]?.text).toContain('Canonical step');
  });

  it('records running → done transitions for tool.started and tool.executed', () => {
    harness.handler({
      type: 'tool.started',
      payload: { id: 'tc-1', name: 'read', input: { path: 'a' } },
    });
    expect(harness.state.toolCalls).toEqual([
      {
        id: 'tc-1',
        name: 'read',
        input: { path: 'a' },
        status: 'running',
        ts: expect.any(String) as unknown as string,
      },
    ]);

    harness.handler({
      type: 'tool.executed',
      payload: { id: 'tc-1', name: 'read', ok: true, output: 'hello', durationMs: 7 },
    });

    expect(harness.state.toolCalls).toEqual([
      {
        id: 'tc-1',
        name: 'read',
        input: { path: 'a' },
        status: 'done',
        ok: true,
        output: 'hello',
        durationMs: 7,
        ts: expect.any(String) as unknown as string,
      },
    ]);
  });

  it('marks tool calls as error when the server reports ok:false', () => {
    harness.handler({ type: 'tool.started', payload: { id: 'tc-2', name: 'write', input: {} } });
    harness.handler({
      type: 'tool.executed',
      payload: { id: 'tc-2', name: 'write', ok: false, output: 'permission denied' },
    });

    expect(harness.state.toolCalls[0]).toMatchObject({ status: 'error', ok: false });
    // Tool failure must NOT be inferred from string scanning rendered output.
    expect(harness.state.toolCalls[0]).toMatchObject({ status: 'error' });
  });

  it('closes only the last running same-name call when tool.executed has no id', () => {
    // Two concurrent `read` calls are running at once.
    harness.handler({
      type: 'tool.started',
      payload: { id: 'read-a', name: 'read', input: { path: 'a' } },
    });
    harness.handler({
      type: 'tool.started',
      payload: { id: 'read-b', name: 'read', input: { path: 'b' } },
    });
    expect(harness.state.toolCalls.map((tc) => tc.status)).toEqual(['running', 'running']);

    // An id-less executed event arrives. Regression: a `.map` fallback closed
    // BOTH running `read` calls, collapsing two calls into one shared result.
    // Only the LAST running match may be closed.
    harness.handler({
      type: 'tool.executed',
      payload: { name: 'read', ok: true, output: 'from b', durationMs: 5 },
    });

    const [first, second] = harness.state.toolCalls;
    // First `read` (path a) must stay running and untouched.
    expect(first).toMatchObject({ id: 'read-a', status: 'running' });
    expect(first).not.toHaveProperty('output');
    // Last `read` (path b) is the one that got closed.
    expect(second).toMatchObject({
      id: 'read-b',
      status: 'done',
      ok: true,
      output: 'from b',
      durationMs: 5,
    });

    // A second id-less executed event closes the remaining running call.
    harness.handler({
      type: 'tool.executed',
      payload: { name: 'read', ok: true, output: 'from a', durationMs: 3 },
    });
    expect(harness.state.toolCalls[0]).toMatchObject({
      id: 'read-a',
      status: 'done',
      output: 'from a',
    });
    // The already-closed call is not re-touched.
    expect(harness.state.toolCalls[1]).toMatchObject({ id: 'read-b', output: 'from b' });
  });
});

describe('provider streaming', () => {
  it('appends thinking deltas and freezes the thinking block when text begins', () => {
    harness.handler({ type: 'provider.thinking_delta', payload: { text: 'hmm ' } });
    harness.handler({ type: 'provider.thinking_delta', payload: { text: 'let me think' } });

    expect(harness.state.messages.at(-1)).toMatchObject({
      role: 'thinking',
      text: 'hmm let me think',
      streaming: true,
    });

    harness.handler({ type: 'provider.text_delta', payload: { text: 'Here is the answer' } });
    harness.handler.flush();

    const last = harness.state.messages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', text: 'Here is the answer', streaming: true });
    // The thinking block must be frozen (streaming:false) once text starts.
    expect(harness.state.messages.find((m) => m.role === 'thinking')?.streaming).toBe(false);
  });

  it('coalesces a burst of text deltas into a single transcript update', () => {
    // Each delta used to trigger its own `setMessages`, so a response streamed
    // one token at a time re-rendered the whole transcript once per token.
    const before = harness.state.setMessagesCalls;
    for (let index = 0; index < 50; index++) {
      harness.handler({ type: 'provider.text_delta', payload: { text: `tok${index} ` } });
    }
    expect(harness.state.setMessagesCalls).toBe(before);

    harness.handler.flush();

    expect(harness.state.setMessagesCalls).toBe(before + 1);
    expect(harness.state.messages.at(-1)).toMatchObject({
      role: 'assistant',
      streaming: true,
    });
    expect(harness.state.messages.at(-1)?.text).toBe(
      Array.from({ length: 50 }, (_, index) => `tok${index} `).join(''),
    );
  });

  it('flushes buffered text before any non-delta message is applied', () => {
    // Ordering guarantee: a tool call must never overtake text that arrived
    // before it, even though that text is still sitting in the delta buffer.
    harness.handler({ type: 'provider.text_delta', payload: { text: 'calling a tool' } });
    harness.handler({ type: 'tool.started', payload: { id: 'tc-1', name: 'read', input: {} } });

    const assistantIndex = harness.state.messages.findIndex(
      (message) => message.role === 'assistant' && message.text === 'calling a tool',
    );
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
  });

  it('treats tool.executed ok:false as the canonical failure signal, not the output text', () => {
    harness.handler({ type: 'tool.started', payload: { id: 'tc-x', name: 'exec', input: {} } });
    harness.handler({
      type: 'tool.executed',
      payload: { id: 'tc-x', name: 'exec', ok: false, output: 'recoverable warning printed' },
    });
    expect(harness.state.toolCalls[0]?.status).toBe('error');
  });

  it('projects fallback activity with the resolved fallback model name', () => {
    harness.handler({
      type: 'provider.fallback',
      payload: { to: { model: 'gpt-4o-mini' } },
    });
    expect(harness.state.activity).toBe('Fallback · gpt-4o-mini');

    harness.handler({ type: 'provider.fallback', payload: {} });
    expect(harness.state.activity).toBe('Switching fallback model');
  });

  it('projects provider.fallback_pending into the fallback modal state', () => {
    harness.mutableRefs.sessionIdRef.current = 'sess-1';
    harness.handler({
      type: 'provider.fallback_pending',
      payload: {
        sessionId: 'sess-1',
        requestId: 'req-42',
        from: { providerId: 'openai', model: 'gpt-4o' },
        status: 429,
        candidates: [
          { providerId: 'anthropic', model: 'claude-haiku' },
          { providerId: 'openai', model: 'gpt-4o-mini' },
        ],
        autoSwitchSeconds: 7,
      },
    });
    expect(harness.state.fallbackPending).toEqual({
      requestId: 'req-42',
      from: { providerId: 'openai', model: 'gpt-4o' },
      status: 429,
      candidates: [
        { providerId: 'anthropic', model: 'claude-haiku' },
        { providerId: 'openai', model: 'gpt-4o-mini' },
      ],
      autoSwitchSeconds: 7,
    });
  });

  it('ignores provider.fallback_pending for a different session', () => {
    harness.mutableRefs.sessionIdRef.current = 'sess-1';
    harness.handler({
      type: 'provider.fallback_pending',
      payload: {
        sessionId: 'sess-other',
        requestId: 'req-42',
        from: { providerId: 'openai', model: 'gpt-4o' },
        status: 429,
        candidates: [],
        autoSwitchSeconds: 7,
      },
    });
    expect(harness.state.fallbackPending).toBeNull();
  });

  it('does not clear the fallback modal on provider.fallback for a different session', () => {
    harness.mutableRefs.sessionIdRef.current = 'sess-1';
    harness.handler({
      type: 'provider.fallback_pending',
      payload: {
        sessionId: 'sess-1',
        requestId: 'req-42',
        from: { providerId: 'openai', model: 'gpt-4o' },
        status: 429,
        candidates: [],
        autoSwitchSeconds: 7,
      },
    });
    expect(harness.state.fallbackPending).not.toBeNull();

    // Another session's fallback resolves — our modal must survive.
    harness.handler({
      type: 'provider.fallback',
      payload: { sessionId: 'sess-other', to: { model: 'claude-haiku' } },
    });
    expect(harness.state.fallbackPending).not.toBeNull();
    expect(harness.state.activity).toBe('');
  });

  it('clears the fallback modal when this session resolves the fallback', () => {
    harness.mutableRefs.sessionIdRef.current = 'sess-1';
    harness.handler({
      type: 'provider.fallback_pending',
      payload: {
        sessionId: 'sess-1',
        requestId: 'req-42',
        from: { providerId: 'openai', model: 'gpt-4o' },
        status: 429,
        candidates: [],
        autoSwitchSeconds: 7,
      },
    });
    expect(harness.state.fallbackPending).not.toBeNull();

    harness.handler({
      type: 'provider.fallback',
      payload: { sessionId: 'sess-1', to: { model: 'gpt-4o-mini' } },
    });
    expect(harness.state.fallbackPending).toBeNull();
    expect(harness.state.activity).toBe('Fallback · gpt-4o-mini');
  });
});

describe('run lifecycle and queue drain', () => {
  it('run.result closes the run, drains queue head via dispatchUserMessage, and finalises streaming', () => {
    harness.mutableRefs.sessionIdRef.current = 'sess-1';
    harness.mutableRefs.activeModelRef.current = { provider: 'openai', model: 'gpt-4o' };
    harness.mutableRefs.runningRef.current = true;
    harness.mutableRefs.queueRef.current = [
      { id: 'q1', text: 'first queue', mode: 'btw', addedAt: 1 },
      { id: 'q2', text: 'second queue', mode: 'queue', addedAt: 2 },
    ];

    harness.handler({
      type: 'run.result',
      payload: {},
    });

    expect(harness.state.running).toBe(false);
    expect(harness.state.activity).toBe('');
    expect(harness.dispatchUserMessage).toHaveBeenCalledWith('first queue');
    expect(harness.mutableRefs.queueRef.current).toHaveLength(1);
    expect(harness.state.queue.map((entry) => entry.id)).toEqual(['q2']);
  });

  it('error appends a system message and still drains the queue head', () => {
    harness.mutableRefs.sessionIdRef.current = 'sess-1';
    harness.mutableRefs.queueRef.current = [
      { id: 'q1', text: 'after error', mode: 'queue', addedAt: 1 },
    ];

    harness.handler({ type: 'error', payload: { message: 'boom' } });

    expect(harness.state.messages.at(-1)).toMatchObject({ role: 'system', text: 'boom' });
    expect(harness.dispatchUserMessage).toHaveBeenCalledWith('after error');
  });

  it('keeps the queued item when a run.result drain is dropped (session cleared)', () => {
    // Simulate the session being cleared between enqueue and drain:
    // dispatchUserMessage bails and returns false. Regression: the drain used
    // to advance the queue (queueRef = rest; setQueue) BEFORE dispatching, so
    // the held message was removed but never sent — silent user-input loss.
    const dropped = vi.fn(() => false);
    const h = createHarness({ dispatchUserMessage: dropped });
    h.mutableRefs.queueRef.current = [
      { id: 'q1', text: 'held message', mode: 'queue', addedAt: 1 },
      { id: 'q2', text: 'second', mode: 'queue', addedAt: 2 },
    ];

    h.handler({ type: 'run.result', payload: {} });

    // Dispatch was attempted on the head...
    expect(dropped).toHaveBeenCalledWith('held message');
    // ...but since it was dropped, the queue ref (the drain's source of truth)
    // is untouched — nothing lost. setQueue is never called on a dropped
    // drain, so the drain does not advance.
    expect(h.mutableRefs.queueRef.current.map((entry) => entry.id)).toEqual(['q1', 'q2']);
  });

  it('keeps the queued item when an error drain is dropped (session cleared)', () => {
    const dropped = vi.fn(() => false);
    const h = createHarness({ dispatchUserMessage: dropped });
    h.mutableRefs.queueRef.current = [
      { id: 'q1', text: 'held after error', mode: 'queue', addedAt: 1 },
    ];

    h.handler({ type: 'error', payload: { message: 'boom' } });

    expect(dropped).toHaveBeenCalledWith('held after error');
    // Dropped drain leaves the queue ref intact; setQueue is never called.
    expect(h.mutableRefs.queueRef.current.map((entry) => entry.id)).toEqual(['q1']);
  });

  it('rate_limit error shows a warning notice and does NOT create a chat message or drain the queue', () => {
    harness.mutableRefs.sessionIdRef.current = 'sess-1';
    harness.mutableRefs.queueRef.current = [
      { id: 'q1', text: 'should not be sent', mode: 'queue', addedAt: 1 },
    ];

    harness.handler({
      type: 'error',
      payload: { phase: 'rate_limit', message: 'Too many messages. Please wait.' },
    });

    // Shown as a transient warning notice, not a permanent system message.
    expect(harness.state.notice).toMatchObject({
      tone: 'warning',
      text: 'Too many messages. Please wait.',
    });
    // No new chat message of any role created.
    expect(harness.state.messages).toEqual([]);
    // Queue is NOT drained — dispatching during cooldown would re-trigger
    // the limiter.
    expect(harness.dispatchUserMessage).not.toHaveBeenCalled();
    expect(harness.mutableRefs.queueRef.current.map((e) => e.id)).toEqual(['q1']);
  });

  it('rate_limit error clears the running spinner (dropped frame leaves no run.result)', () => {
    harness.handler({ type: 'iteration.started', payload: {} });
    expect(harness.state.running).toBe(true);

    harness.handler({
      type: 'error',
      payload: { phase: 'rate_limit', message: 'Too many messages. Please wait.' },
    });

    // The server dropped the frame, so no run.result will clear it — the
    // rate_limit branch must clear the spinner itself.
    expect(harness.state.running).toBe(false);
    expect(harness.state.activity).toBe('');
  });

  it('drains the same held item on the next run.result once dispatch succeeds again', () => {
    // First drain is dropped (session gone), item stays queued. When a later
    // run.result arrives with a live session, the SAME item finally sends.
    let live = false;
    const dispatch = vi.fn(() => live);
    const h = createHarness({ dispatchUserMessage: dispatch });
    h.mutableRefs.queueRef.current = [
      { id: 'q1', text: 'eventually sent', mode: 'queue', addedAt: 1 },
    ];

    h.handler({ type: 'run.result', payload: {} }); // dropped
    expect(h.mutableRefs.queueRef.current.map((e) => e.id)).toEqual(['q1']);

    live = true;
    h.handler({ type: 'run.result', payload: {} }); // succeeds
    expect(dispatch).toHaveBeenLastCalledWith('eventually sent');
    expect(h.mutableRefs.queueRef.current).toEqual([]);
    expect(h.state.queue).toEqual([]);
  });
});

describe('context accounting', () => {
  // Wire contract: `ctx.pct` `load` is a 0-1 fraction of the context budget.
  // Core computes rawLoad = tokens / maxContext and emits it already clamped
  // as load = Math.max(0, Math.min(1, rawLoad)) (see emitContextPct in core
  // agent-loop.ts). So 0.68 = 68% full and a full budget is exactly 1. The
  // handler must pass the fraction through deterministically — never
  // magnitude-sniff or divide (the old `load > 1 ? load / 100` heuristic
  // corrupted any value it mistook for a percentage).

  it('passes a mid-range fraction through untouched (68% -> 0.68)', () => {
    harness.handler({
      type: 'ctx.pct',
      payload: { load: 0.68, tokens: 136_000, maxContext: 200_000 },
    });
    expect(harness.state.context).toEqual({
      load: 0.68,
      tokens: 136_000,
      maxContext: 200_000,
      cache: null,
    });
  });

  it('keeps a 1% fraction as 0.01 (not inflated to 100%)', () => {
    harness.handler({
      type: 'ctx.pct',
      payload: { load: 0.01, tokens: 1_000, maxContext: 100_000 },
    });
    expect(harness.state.context.load).toBe(0.01);
  });

  it('keeps a full budget (100%) as exactly 1', () => {
    harness.handler({
      type: 'ctx.pct',
      payload: { load: 1, tokens: 100_000, maxContext: 100_000 },
    });
    expect(harness.state.context.load).toBe(1);
  });

  it('passes a malformed out-of-range frame through without dividing (defensive)', () => {
    // The producer already clamps `load` to [0, 1], so the UI should never
    // receive a value above 1 on the wire. If a malformed frame ever does,
    // the handler must NOT magnitude-sniff/divide it (the old bug turned
    // 1.35 into 0.0135). It passes the value through untouched; the render
    // layer is responsible for any display clamping.
    harness.handler({
      type: 'ctx.pct',
      payload: { load: 1.35, tokens: 270_000, maxContext: 200_000 },
    });
    expect(harness.state.context.load).toBe(1.35);
  });

  it('clamps a negative or non-finite load to 0', () => {
    harness.handler({
      type: 'ctx.pct',
      payload: { load: -0.5, tokens: 0, maxContext: 100_000 },
    });
    expect(harness.state.context.load).toBe(0);

    harness.handler({
      type: 'ctx.pct',
      payload: { load: Number.NaN, tokens: 0, maxContext: 100_000 },
    });
    expect(harness.state.context.load).toBe(0);
  });
});

describe('agent timeline and subagent events', () => {
  it('subagent.event kind=removed marks the worker stopped and clears its task', () => {
    harness.mutableRefs.sessionIdRef.current = 'sess-1';
    harness.handler({
      type: 'session.start',
      payload: { sessionId: 'sess-1', provider: 'openai', model: 'gpt-4o' },
    });
    // Seed a worker via coordinator.stats before the removal event.
    harness.handler({
      type: 'coordinator.stats',
      payload: {
        subagentStatuses: [
          { id: 'worker-x', name: 'X', status: 'running', currentTask: 'fix bug' },
        ],
      },
    });
    expect(harness.state.subagents).toEqual([
      expect.objectContaining({ id: 'worker-x', status: 'running', task: 'fix bug' }),
    ]);

    harness.handler({
      type: 'subagent.event',
      payload: { kind: 'removed', subagentId: 'worker-x' },
    });

    expect(harness.state.subagents[0]).toMatchObject({ status: 'stopped', task: undefined });
  });

  it('agent.timeline.message appends a transcript entry and registers a new worker', () => {
    harness.handler({
      type: 'agent.timeline.message',
      payload: {
        subagentId: 'worker-y',
        agentName: 'Y',
        kind: 'text',
        content: 'starting work',
        iteration: 1,
        ts: '2026-07-19T00:00:01Z',
      },
    });

    expect(harness.state.subagents).toEqual([
      expect.objectContaining({ id: 'worker-y', name: 'Y', status: 'running' }),
    ]);
    expect(harness.state.agentTranscripts['worker-y']).toHaveLength(1);
  });

  it('leader timeline entries never reach the worker transcript store', () => {
    harness.handler({
      type: 'agent.timeline.message',
      payload: {
        subagentId: LEADER_AGENT_ID,
        agentName: 'LEADER',
        kind: 'text',
        content: 'leader chat',
        iteration: 0,
        ts: '2026-07-19T00:00:00Z',
      },
    });
    expect(harness.state.agentTranscripts[LEADER_AGENT_ID]).toBeUndefined();
  });
});

describe('worklists integration', () => {
  it('forwards every server frame to the worklist store', () => {
    harness.mutableRefs.sessionIdRef.current = 'sess-1';
    harness.worklists.reset('sess-1');
    const before = harness.worklists.getSnapshot().planItems.length;

    harness.handler({
      type: 'plan.updated',
      payload: {
        sessionId: 'sess-1',
        // The worklist store reads `payload.plan` and then parseSimplePlan
        // expects `{ items: [...] }` — see worklist-store.test.ts:29.
        plan: { items: [{ id: 'plan-1', title: 'Phase one', status: 'in_progress' }] },
      },
    });

    const after = harness.worklists.getSnapshot();
    expect(after.planItems.length).toBeGreaterThan(before);
    // The plan entry should appear in the worklist snapshot with its status.
    expect(after.planItems.find((item) => item.id === 'plan-1')?.status).toBe('in_progress');
  });
});

describe('status notice projection', () => {
  it('emits a notice for sessions.list errors but not on success', () => {
    harness.handler({
      type: 'sessions.list',
      payload: { error: 'token expired' },
    });
    expect(harness.state.notice).toMatchObject({ tone: 'error', text: 'Sessions · token expired' });

    harness.handler({ type: 'sessions.list', payload: { sessions: [] } });
    expect(harness.state.notice).toMatchObject({ tone: 'error' });
  });
});
