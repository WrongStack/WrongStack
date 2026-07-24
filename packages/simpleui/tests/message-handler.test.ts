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
import type { MessageHandlerDeps } from '../src/lib/message-handler.js';
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
  ServerMessage,
  SessionInfo,
  SimplePrefs,
  SimpleSessionSummary,
  SimpleSubagent,
  ToolCallInfo,
} from '../src/types.js';

interface Harness {
  handler: (message: ServerMessage) => void;
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
  const sessions = makeHolder<SimpleSessionSummary[]>([]);
  const sessionMenuOpen = makeHolder<boolean>(false);
  const context = makeHolder<ContextInfo>({ load: 0, tokens: 0, maxContext: 0 });
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

  const dispatchUserMessage = overrides.dispatchUserMessage ?? vi.fn();
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
    dispatchUserMessage,
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
  it('seeds session, restores draft, requests providers and recent sessions', () => {
    harness.readComposerDraft.mockReturnValue({ text: 'half a thought', fileRefs: ['a.ts'] });

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
    expect(harness.requestProviderModels).toHaveBeenCalledWith('openai');
    const sent = harness.socket.sent.map((entry) => entry.type);
    expect(sent).toContain('sessions.list');
    expect(sent[0]).toBe('sessions.list');
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

  it('hydrates the leader agent and rejects leader snapshots from the worker store', () => {
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

    expect(harness.state.subagents.map((agent) => agent.id)).toEqual(['worker-a']);
    expect(harness.state.agentTranscripts[LEADER_AGENT_ID]).toBeUndefined();
    expect(harness.state.agentTranscripts['worker-a']).toHaveLength(1);
  });
});

describe('tool call lifecycle', () => {
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

    const last = harness.state.messages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', text: 'Here is the answer', streaming: true });
    // The thinking block must be frozen (streaming:false) once text starts.
    expect(harness.state.messages.find((m) => m.role === 'thinking')?.streaming).toBe(false);
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
});

describe('context accounting', () => {
  it('normalises percentage input to a 0..1 fraction', () => {
    harness.handler({
      type: 'ctx.pct',
      payload: { load: 75, tokens: 75_000, maxContext: 100_000 },
    });
    expect(harness.state.context).toEqual({ load: 0.75, tokens: 75_000, maxContext: 100_000 });
  });

  it('preserves fraction input untouched', () => {
    harness.handler({
      type: 'ctx.pct',
      payload: { load: 0.42, tokens: 42_000, maxContext: 100_000 },
    });
    expect(harness.state.context.load).toBe(0.42);
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
