// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useComposerActions } from '../src/hooks/use-composer-actions.js';
import type { RefineState } from '../src/lib/refine-model.js';
import type { ChatMessage, PendingConfirm } from '../src/types.js';
import type { QueuedItem } from '../src/lib/queue-model.js';

interface Captured {
  current: ReturnType<typeof useComposerActions>;
}

interface MockSocket {
  send: ReturnType<typeof vi.fn>;
}

interface TestState {
  messages: ChatMessage[];
  queue: QueuedItem[];
  activity: string;
  running: boolean;
  refineState: RefineState | null;
  pendingConfirm: PendingConfirm | null;
  draft: string;
  fileRefs: string[];
  attachedImages: { id: string; data: string; mime: string; name: string }[];
}

const roots: Root[] = [];

function makeRefineState(text = 'original text'): RefineState {
  return {
    original: text,
    refined: 'refined version',
    english: 'english version',
    status: 'ready',
    provider: 'openai',
    model: 'gpt-4o',
  };
}

function renderHookViaRoot(
  captured: Captured,
  overrides: Partial<{
    session: { id: string } | null;
    running: boolean;
    draft: string;
    fileRefs: string[];
    queue: QueuedItem[];
    refineState: RefineState | null;
  }> = {},
) {
  const socket: MockSocket = { send: vi.fn() };
  const state: TestState = {
    messages: [],
    queue: overrides.queue ?? [],
    activity: '',
    running: overrides.running ?? false,
    refineState: overrides.refineState ?? null,
    pendingConfirm: null,
    draft: overrides.draft ?? '',
    fileRefs: overrides.fileRefs ?? [],
    attachedImages: [] as { id: string; data: string; mime: string; name: string }[],
  };

  const sessionIdRef = { current: overrides.session?.id ?? 'sess-1' };
  const draftRef = { current: state.draft };
  const fileRefsRef = { current: state.fileRefs };
  const refineStateRef = { current: state.refineState };
  const refineEpochRef = { current: 0 };
  const attachedImagesRef = { current: state.attachedImages };

  // startSend mock — the hook uses this as the refine-aware dispatch entry point.
  const startSendMock = vi.fn();
  // dispatchUserMessage mock — the direct send path that bypasses refining.
  const dispatchUserMessageMock = vi.fn();

  function Probe(): null {
    captured.current = useComposerActions({
      sessionIdRef: sessionIdRef as never,
      socketRef: { current: socket as never },
      draftRef: draftRef as never,
      fileRefsRef: fileRefsRef as never,
      refineStateRef: refineStateRef as never,
      refineEpochRef: refineEpochRef as never,
      draft: state.draft,
      fileRefs: state.fileRefs,
      running: state.running,
      startSend: startSendMock,
      dispatchUserMessage: dispatchUserMessageMock,
      setQueue: (updater) => {
        if (typeof updater === 'function') state.queue = updater(state.queue);
        else state.queue = updater;
      },
      setDraft: (v) => {
        state.draft = typeof v === 'function' ? v(state.draft) : v;
        draftRef.current = state.draft;
      },
      setFileRefs: (v) => {
        state.fileRefs = typeof v === 'function' ? v(state.fileRefs) : v;
        fileRefsRef.current = state.fileRefs;
      },
      setAttachedImages: (v) => {
        state.attachedImages = typeof v === 'function' ? v(state.attachedImages) : v;
      },
      attachedImagesRef: attachedImagesRef as never,
      setRefineState: (v) => {
        state.refineState =
          typeof v === 'function'
            ? (v as (prev: RefineState | null) => RefineState | null)(state.refineState)
            : v;
        refineStateRef.current = state.refineState;
      },
    });
    return null;
  }

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<Probe />));
  return {
    root,
    socket,
    state,
    startSendMock,
    dispatchUserMessageMock,
    refs: { sessionIdRef, draftRef, fileRefsRef, refineStateRef, attachedImagesRef },
  };
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('useComposerActions — submitWith', () => {
  it('calls startSend when idle with btw mode', () => {
    const captured: Captured = { current: undefined as never };
    const { state, startSendMock } = renderHookViaRoot(captured, {
      draft: 'hello',
      running: false,
    });
    act(() => captured.current.submitWith('btw'));
    expect(startSendMock).toHaveBeenCalledTimes(1);
    expect(state.draft).toBe('');
  });

  it('enqueues when running with btw mode', () => {
    const captured: Captured = { current: undefined as never };
    const { socket, state } = renderHookViaRoot(captured, { draft: 'hello', running: true });
    act(() => captured.current.submitWith('btw'));
    expect(socket.send).not.toHaveBeenCalledWith('user_message', expect.anything());
    expect(state.queue).toHaveLength(1);
  });

  it('aborts and enqueues at front when steering a live run', () => {
    const captured: Captured = { current: undefined as never };
    const { socket, state } = renderHookViaRoot(captured, { draft: 'redirect', running: true });
    act(() => captured.current.submitWith('steer'));
    expect(socket.send).toHaveBeenCalledWith('abort', expect.anything());
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0]?.text).toBe('redirect');
  });

  it('always enqueues with queue mode, even when idle', () => {
    const captured: Captured = { current: undefined as never };
    const { socket, state } = renderHookViaRoot(captured, { draft: 'queued', running: false });
    act(() => captured.current.submitWith('queue'));
    expect(socket.send).not.toHaveBeenCalledWith('user_message', expect.anything());
    expect(state.queue).toHaveLength(1);
  });

  it('handles /clear by sending session.new and resetting draft', () => {
    const captured: Captured = { current: undefined as never };
    const { socket, state } = renderHookViaRoot(captured, { draft: '/clear' });
    act(() => captured.current.submitWith('btw'));
    expect(socket.send).toHaveBeenCalledWith('session.new', expect.anything());
    expect(state.draft).toBe('');
  });
});

describe('useComposerActions — refineDecision', () => {
  // ── Regression: refineDecision must call dispatchUserMessage, NOT startSend.
  //    startSend re-enters the refine pipeline (sets status to 'refining' and
  //    sends a new model.refine request), which caused an infinite loop where
  //    every panel decision cycled the panel back into the refining state.
  it("dispatches via dispatchUserMessage (not startSend) for 'refined'", () => {
    const captured: Captured = { current: undefined as never };
    const rs = makeRefineState('original');
    const { state, startSendMock, dispatchUserMessageMock } = renderHookViaRoot(captured, {
      refineState: rs,
    });
    act(() => captured.current.refineDecision('refined'));
    expect(state.refineState).toBeNull();
    expect(dispatchUserMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchUserMessageMock).toHaveBeenCalledWith('refined version');
    expect(startSendMock).not.toHaveBeenCalled();
  });

  it("dispatches via dispatchUserMessage (not startSend) for 'original'", () => {
    const captured: Captured = { current: undefined as never };
    const rs = makeRefineState('original text');
    const { startSendMock, dispatchUserMessageMock } = renderHookViaRoot(captured, {
      refineState: rs,
    });
    act(() => captured.current.refineDecision('original'));
    expect(dispatchUserMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchUserMessageMock).toHaveBeenCalledWith('original text');
    expect(startSendMock).not.toHaveBeenCalled();
  });

  it("dispatches via dispatchUserMessage (not startSend) for 'english'", () => {
    const captured: Captured = { current: undefined as never };
    const rs = makeRefineState('original');
    const { startSendMock, dispatchUserMessageMock } = renderHookViaRoot(captured, {
      refineState: rs,
    });
    act(() => captured.current.refineDecision('english'));
    expect(dispatchUserMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchUserMessageMock).toHaveBeenCalledWith('english version');
    expect(startSendMock).not.toHaveBeenCalled();
  });
});

describe('useComposerActions — refineRetry', () => {
  it('re-sends model.refine with the original text', () => {
    const captured: Captured = { current: undefined as never };
    const rs = makeRefineState('retry this');
    const { socket } = renderHookViaRoot(captured, { refineState: rs });
    act(() => captured.current.refineRetry());
    expect(socket.send).toHaveBeenCalledWith(
      'model.refine',
      expect.objectContaining({ text: 'retry this' }),
    );
  });
});

describe('useComposerActions — refineRetry feedback', () => {
  it("sends previousRefined/previousEnglish when retrying from the 'ready' face", () => {
    const captured: Captured = { current: undefined as never };
    const rs = makeRefineState('retry this'); // status: 'ready'
    const { socket } = renderHookViaRoot(captured, { refineState: rs });
    act(() => captured.current.refineRetry());
    expect(socket.send).toHaveBeenCalledWith(
      'model.refine',
      expect.objectContaining({
        text: 'retry this',
        previousRefined: 'refined version',
        previousEnglish: 'english version',
      }),
    );
  });

  it("omits previous round fields when retrying from the 'failed' face", () => {
    const captured: Captured = { current: undefined as never };
    const rs: RefineState = { ...makeRefineState('retry this'), status: 'failed', error: 'boom' };
    const { socket } = renderHookViaRoot(captured, { refineState: rs });
    act(() => captured.current.refineRetry());
    const call = socket.send.mock.calls.find((c) => c[0] === 'model.refine');
    expect(call).toBeDefined();
    expect(call?.[1]).not.toHaveProperty('previousRefined');
    expect(call?.[1]).not.toHaveProperty('previousEnglish');
  });

  it("flips the panel status back to 'refining' and clears the stale error", () => {
    const captured: Captured = { current: undefined as never };
    const rs: RefineState = { ...makeRefineState('retry this'), status: 'failed', error: 'boom' };
    const { state } = renderHookViaRoot(captured, { refineState: rs });
    act(() => captured.current.refineRetry());
    expect(state.refineState?.status).toBe('refining');
    expect(state.refineState?.error).toBeUndefined();
  });
});

describe('useComposerActions — refineRetryFallback', () => {
  it("reflects the fallback provider/model and flips to 'refining'", () => {
    const captured: Captured = { current: undefined as never };
    const rs: RefineState = { ...makeRefineState('retry this'), status: 'failed', error: 'boom' };
    const { socket, state } = renderHookViaRoot(captured, { refineState: rs });
    act(() => captured.current.refineRetryFallback('anthropic/claude-sonnet'));
    expect(state.refineState?.status).toBe('refining');
    expect(state.refineState?.provider).toBe('anthropic');
    expect(state.refineState?.model).toBe('claude-sonnet');
    expect(state.refineState?.error).toBeUndefined();
    expect(socket.send).toHaveBeenCalledWith(
      'model.refine',
      expect.objectContaining({
        text: 'retry this',
        provider: 'anthropic',
        model: 'claude-sonnet',
        timeoutMs: 180_000,
      }),
    );
  });

  it('ignores refs without a provider/model slash', () => {
    const captured: Captured = { current: undefined as never };
    const rs = makeRefineState('retry this');
    const { socket, state } = renderHookViaRoot(captured, { refineState: rs });
    act(() => captured.current.refineRetryFallback('not-a-ref'));
    expect(socket.send).not.toHaveBeenCalledWith('model.refine', expect.anything());
    expect(state.refineState?.status).toBe('ready');
  });
});

describe('useComposerActions — abort', () => {
  it('sends abort frame', () => {
    const captured: Captured = { current: undefined as never };
    const { socket } = renderHookViaRoot(captured);
    act(() => captured.current.abort());
    expect(socket.send).toHaveBeenCalledWith('abort', expect.anything());
  });
});
