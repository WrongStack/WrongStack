// @vitest-environment jsdom

// Hoist the chime module mock so the hook's named `playChime` import is
// replaced before the hook itself is evaluated. Vitest's `vi.mock` is the
// supported channel for hoisted module mocking; using `vi.spyOn` on a
// namespace import would patch the namespace but miss the hook's named
// binding (`import { playChime } from '...'`) and the spy would record
// zero calls even though the hook still plays the chime.
vi.mock('../src/lib/chime.js', () => ({
  playChime: vi.fn(),
}));

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type UseSimpleMailboxResult, useSimpleMailbox } from '../src/hooks/use-simple-mailbox.js';
import { type StatusNotice, useStatusNotice } from '../src/hooks/use-status-notice.js';
import { playChime } from '../src/lib/chime.js';
import { DEFAULT_PREFS, type SimplePrefs } from '../src/lib/prefs-model.js';
import type { ServerMessage } from '../src/types.js';

const playChimeSpy = playChime as unknown as ReturnType<typeof vi.fn>;

/**
 * Pin the wire-protocol contract for `useSimpleMailbox.applyMailboxMessage` so
 * future refactors (changing the `isUnreadIncomingMailboxMessage` predicate,
 * rewording the notice, or accepting additional message types) cannot
 * silently regress the user-visible behaviour:
 *
 *  - the store accepts `mailbox.messages` and `mailbox.agents` and mutates the
 *    snapshot the consumer can read through `mailboxUnreadCount` /
 *    `mailboxStore.getSnapshot()`.
 *  - non-mailbox frames pass through with `false` and do not touch the store
 *    or raise a notice (the caller then falls through to the main handler).
 *  - `mailbox.received` for an incoming (non-`webui` / non-`simpleui` / unread
 *    / open) message fires the chime-suppressed `'New email received'` notice;
 *    a self-message from `simpleui` is silent.
 *  - `mailbox.sent` for a previously-pending request id with `success: true`
 *    fires `'Email sent'`; with `success: false` it fires `'Email failed: …'`
 *    regardless of whether the request id is in the pending set (the wire
 *    response is the source of truth for failure).
 *  - `mailbox.action_result` is pending-gated: a notice (success or failure)
 *    fires only when the request id is in the pending set. Unmatched frames
 *    are silent — same as `mailbox.sent` for `success: true`.
 *
 * Harness follows `use-status-notice.test.tsx` and `agent-chat-pane.test.tsx`:
 * real `createRoot` + `act`, no testing-library dependency. `chime.playChime`
 * is mocked so chime-call counts are observable.
 */

interface Captured {
  current: UseSimpleMailboxResult | null;
  /** Notices pushed via the `useStatusNotice` instance the harness mounts. */
  notices: Array<StatusNotice>;
}

function makeSocketStub(): {
  ref: React.MutableRefObject<{
    send: (type: string, payload: Record<string, unknown>) => void;
  } | null>;
  sends: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const sends: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ref: React.MutableRefObject<{
    send: (type: string, payload: Record<string, unknown>) => void;
  } | null> = {
    current: {
      send: (type, payload) => {
        sends.push({ type, payload });
      },
    },
  };
  return { ref, sends };
}

function makePrefsRef(initial: Partial<SimplePrefs> = {}): React.MutableRefObject<SimplePrefs> {
  return { current: { ...DEFAULT_PREFS, ...initial } } as React.MutableRefObject<SimplePrefs>;
}

function renderProbeWithSocket(
  captured: Captured,
  prefsRef: React.MutableRefObject<SimplePrefs>,
  socketStub: ReturnType<typeof makeSocketStub>,
): Root {
  function Probe(): null {
    const { showNotice } = useStatusNotice();
    // Wrap showNotice so the test harness captures every push into the
    // shared notices buffer (one entry per push, never cleared).
    // `recordNotice` is a fresh closure per render, but it only forwards
    // to `showNotice` (a stable callback from useStatusNotice), so the
    // hook's behaviour is identical to the production wiring.
    const recordNotice = (next: Parameters<typeof showNotice>[0]): void => {
      // Only object values are real notices: `null` clears the notice and
      // an updater function is a state-setter call this harness never
      // makes — skip both so the buffer holds only pushed notices.
      if (next && typeof next === 'object') captured.notices.push(next);
      showNotice(next);
    };
    const api = useSimpleMailbox({
      socketRef: socketStub.ref,
      setNotice: recordNotice,
      prefsRef,
    });
    captured.current = api;
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Probe />);
  });
  return root;
}

const roots: Root[] = [];

beforeEach(() => {
  playChimeSpy.mockClear();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('useSimpleMailbox.applyMailboxMessage — store acceptance', () => {
  it('accepts mailbox.messages and mailbox.agents and mutates the snapshot', () => {
    const captured: Captured = { current: null, notices: [] };
    const prefsRef = makePrefsRef();
    const socket = makeSocketStub();
    const root = renderProbeWithSocket(captured, prefsRef, socket);

    const messagesFrame: ServerMessage = {
      type: 'mailbox.messages',
      payload: {
        messages: [
          {
            id: 'm-1',
            from: 'remote',
            to: 'me',
            type: 'note',
            subject: 'hi',
            body: 'hello',
            priority: 'normal',
            completed: false,
          },
        ],
      },
    };
    const agentsFrame: ServerMessage = {
      type: 'mailbox.agents',
      payload: {
        agents: [{ agentId: 'a-1', name: 'Agent 1', status: 'idle', online: true }],
      },
    };
    expect(captured.current?.applyMailboxMessage(messagesFrame)).toBe(true);
    expect(captured.current?.applyMailboxMessage(agentsFrame)).toBe(true);

    const snap = captured.current?.mailboxStore.getSnapshot();
    expect(snap?.messages).toHaveLength(1);
    expect(snap?.messages[0]?.id).toBe('m-1');
    expect(snap?.agents).toHaveLength(1);
    expect(snap?.agents[0]?.agentId).toBe('a-1');
    expect(captured.current?.mailboxUnreadCount).toBeGreaterThanOrEqual(0);

    roots.push(root);
  });

  it('returns false for a non-mailbox frame and does not raise a notice', () => {
    const captured: Captured = { current: null, notices: [] };
    const prefsRef = makePrefsRef();
    const socket = makeSocketStub();
    const root = renderProbeWithSocket(captured, prefsRef, socket);

    const nonMailbox: ServerMessage = {
      type: 'session.started',
      payload: { sessionId: 's-1' },
    };
    const beforeSnap = captured.current?.mailboxStore.getSnapshot();
    const beforeNotices = captured.notices.length;
    const accepted = captured.current?.applyMailboxMessage(nonMailbox);
    expect(accepted).toBe(false);
    // Snapshot unchanged: still the empty initial state.
    const afterSnap = captured.current?.mailboxStore.getSnapshot();
    expect(afterSnap?.messages).toEqual(beforeSnap?.messages);
    expect(afterSnap?.agents).toEqual(beforeSnap?.agents);
    // No notice was raised. Pin the count before/after so a regression
    // that pushes notices for unrelated frames cannot pass silently.
    expect(captured.notices.length).toBe(beforeNotices);
    roots.push(root);
  });
});

describe('useSimpleMailbox.applyMailboxMessage — mailbox.received', () => {
  it('fires "New email received" for an incoming message and plays the chime', () => {
    const captured: Captured = { current: null, notices: [] };
    const prefsRef = makePrefsRef({ chime: true });
    const socket = makeSocketStub();
    const root = renderProbeWithSocket(captured, prefsRef, socket);

    const received: ServerMessage = {
      type: 'mailbox.received',
      payload: { from: 'colleague' },
    };
    // mailbox.received is a notice-only type: the store returns false and
    // the parent falls through to handleServerMessage. We pin the
    // side-effects (notice + chime) instead.
    expect(captured.current?.applyMailboxMessage(received)).toBe(false);
    // The chime is suppressed when the mailbox panel is closed; with the
    // initial state `mailboxOpen === false` it must play.
    expect(playChimeSpy).toHaveBeenCalledTimes(1);
    // Pin the notice side-effect explicitly so a regression that stopped
    // emitting the info notice (but kept the chime) could not pass.
    expect(captured.notices.find((n) => n.text === 'New email received')).toMatchObject({
      tone: 'info',
    });

    roots.push(root);
  });

  it('is silent for self-messages (from: "simpleui") and does not play the chime', () => {
    const captured: Captured = { current: null, notices: [] };
    const prefsRef = makePrefsRef({ chime: true });
    const socket = makeSocketStub();
    const root = renderProbeWithSocket(captured, prefsRef, socket);

    const received: ServerMessage = {
      type: 'mailbox.received',
      payload: { from: 'simpleui' },
    };
    expect(captured.current?.applyMailboxMessage(received)).toBe(false);
    expect(playChimeSpy).not.toHaveBeenCalled();
    // Self-messages are fully silent: no notice either.
    expect(captured.notices.find((n) => n.text === 'New email received')).toBeUndefined();

    roots.push(root);
  });

  it('suppresses the chime when the mailbox panel is open', () => {
    const captured: Captured = { current: null, notices: [] };
    const prefsRef = makePrefsRef({ chime: true });
    const socket = makeSocketStub();
    const root = renderProbeWithSocket(captured, prefsRef, socket);

    // Force the panel open via the hook's setMailboxOpen (mirrors the
    // user clicking the topbar trigger).
    act(() => {
      captured.current?.setMailboxOpen(true);
    });
    // Re-capture to read the post-update state, then dispatch a received.
    const received: ServerMessage = {
      type: 'mailbox.received',
      payload: { from: 'colleague' },
    };
    expect(captured.current?.applyMailboxMessage(received)).toBe(false);
    expect(playChimeSpy).not.toHaveBeenCalled();

    roots.push(root);
  });

  it('suppresses the chime when the chime preference is off', () => {
    const captured: Captured = { current: null, notices: [] };
    const prefsRef = makePrefsRef({ chime: false });
    const socket = makeSocketStub();
    const root = renderProbeWithSocket(captured, prefsRef, socket);

    const received: ServerMessage = {
      type: 'mailbox.received',
      payload: { from: 'colleague' },
    };
    expect(captured.current?.applyMailboxMessage(received)).toBe(false);
    expect(playChimeSpy).not.toHaveBeenCalled();

    roots.push(root);
  });
});

describe('useSimpleMailbox.applyMailboxMessage — mailbox.sent', () => {
  it('fires "Email failed" for success: false regardless of pending set', () => {
    const captured: Captured = { current: null, notices: [] };
    const prefsRef = makePrefsRef();
    const socket = makeSocketStub();
    const root = renderProbeWithSocket(captured, prefsRef, socket);

    const failure: ServerMessage = {
      type: 'mailbox.sent',
      payload: {
        success: false,
        requestId: 'unmatched',
        error: 'recipient offline',
      },
    };
    // mailbox.sent is notice-only: store returns false, parent falls through.
    expect(captured.current?.applyMailboxMessage(failure)).toBe(false);
    // The notice text carries the server-supplied error string.
    const failed = captured.notices.find((n) => n.text === 'Email failed: recipient offline');
    expect(failed?.tone).toBe('error');

    roots.push(root);
  });

  it('fires "Email sent" only when a request id is pending AND success is true', () => {
    const captured: Captured = { current: null, notices: [] };
    const prefsRef = makePrefsRef();
    const socket = makeSocketStub();
    const root = renderProbeWithSocket(captured, prefsRef, socket);

    // First, drain a successful-but-unmatched response: success: true, no
    // matching pending request id — must be silent (no notice raised).
    const silentSuccess: ServerMessage = {
      type: 'mailbox.sent',
      payload: { success: true, requestId: 'unmatched' },
    };
    expect(captured.current?.applyMailboxMessage(silentSuccess)).toBe(false);
    expect(captured.notices.find((n) => n.text === 'Email sent')).toBeUndefined();

    // Now drive a real send through the hook, capture the request id, and
    // echo it back as a successful response. The notice must fire.
    act(() => {
      captured.current?.sendMailboxMessage({
        to: 'colleague',
        subject: 'ping',
        body: 'hi',
      });
    });
    // Find the mailbox.send entry by type — the earlier refresh probes
    // (mailbox.messages x2, mailbox.agents x1) land in sends[] after the
    // originating mailbox.send, so a positional last-send lookup returns
    // a refresh probe, not the send we just made.
    const originatingSend = socket.sends.find((s) => s.type === 'mailbox.send');
    if (!originatingSend) throw new Error('expected a mailbox.send');
    const requestId = String(originatingSend.payload['requestId'] ?? '');
    expect(requestId).not.toBe('');

    const echoedSuccess: ServerMessage = {
      type: 'mailbox.sent',
      payload: { success: true, requestId },
    };
    expect(captured.current?.applyMailboxMessage(echoedSuccess)).toBe(false);
    const ok = captured.notices.find((n) => n.text === 'Email sent');
    expect(ok?.tone).toBe('info');

    roots.push(root);
  });
});

describe('useSimpleMailbox.applyMailboxMessage — mailbox.action_result', () => {
  it('fires "Email action completed" for success: true on a pending request id', () => {
    const captured: Captured = { current: null, notices: [] };
    const prefsRef = makePrefsRef();
    const socket = makeSocketStub();
    const root = renderProbeWithSocket(captured, prefsRef, socket);

    act(() => {
      captured.current?.handleMailboxAction('m-1', 'mark-read');
    });
    // Find the mailbox.action send by type — refresh probes may interleave.
    const actionSend = socket.sends.find((s) => s.type === 'mailbox.action');
    if (!actionSend) throw new Error('expected a mailbox.action send');
    const requestId = String(actionSend.payload['requestId'] ?? '');
    expect(requestId).not.toBe('');

    const echoed: ServerMessage = {
      type: 'mailbox.action_result',
      payload: { success: true, requestId },
    };
    // mailbox.action_result is notice-only: store returns false, parent falls
    // through.
    expect(captured.current?.applyMailboxMessage(echoed)).toBe(false);
    const ok = captured.notices.find((n) => n.text === 'Email action completed');
    expect(ok?.tone).toBe('info');

    roots.push(root);
  });

  it('fires "Email action failed" for success: false on a pending request id', () => {
    const captured: Captured = { current: null, notices: [] };
    const prefsRef = makePrefsRef();
    const socket = makeSocketStub();
    const root = renderProbeWithSocket(captured, prefsRef, socket);

    // Drive a real action so a request id lands in the pending set, then
    // echo it back with success: false — the failure notice must fire.
    act(() => {
      captured.current?.handleMailboxAction('m-1', 'reopen');
    });
    const actionSend = socket.sends.find((s) => s.type === 'mailbox.action');
    if (!actionSend) throw new Error('expected a mailbox.action send');
    const requestId = String(actionSend.payload['requestId'] ?? '');
    expect(requestId).not.toBe('');

    const failure: ServerMessage = {
      type: 'mailbox.action_result',
      payload: { success: false, requestId, error: 'already deleted' },
    };
    expect(captured.current?.applyMailboxMessage(failure)).toBe(false);
    const failed = captured.notices.find((n) => n.text === 'Email action failed: already deleted');
    expect(failed?.tone).toBe('error');

    roots.push(root);
  });

  it('is silent for unmatched request ids (success or failure)', () => {
    const captured: Captured = { current: null, notices: [] };
    const prefsRef = makePrefsRef();
    const socket = makeSocketStub();
    const root = renderProbeWithSocket(captured, prefsRef, socket);

    // The hook intentionally emits `mailbox.action_result` notices only when
    // there is a matching pending request id (avoiding spurious toasts for
    // unrelated wire responses) — so an unmatched id is silent for both
    // success and failure outcomes.
    const successUnmatched: ServerMessage = {
      type: 'mailbox.action_result',
      payload: { success: true, requestId: 'unmatched' },
    };
    expect(captured.current?.applyMailboxMessage(successUnmatched)).toBe(false);
    expect(captured.notices.find((n) => n.text === 'Email action completed')).toBeUndefined();

    const failureUnmatched: ServerMessage = {
      type: 'mailbox.action_result',
      payload: { success: false, requestId: 'unmatched', error: 'n/a' },
    };
    expect(captured.current?.applyMailboxMessage(failureUnmatched)).toBe(false);
    expect(captured.notices.find((n) => n.text.startsWith('Email action'))).toBeUndefined();

    roots.push(root);
  });
});
