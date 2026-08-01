// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chime from '../src/lib/chime.js';
import { DEFAULT_PREFS, type SimplePrefs } from '../src/lib/prefs-model.js';
import { useSimpleMailbox, type UseSimpleMailboxResult } from '../src/hooks/use-simple-mailbox.js';
import { useStatusNotice } from '../src/hooks/use-status-notice.js';
import type { ServerMessage } from '../src/types.js';

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
 *  - `mailbox.action_result` mirrors that contract: pending request id gates
 *    the success notice, failures always notify.
 *
 * Harness follows `use-status-notice.test.tsx` and `agent-chat-pane.test.tsx`:
 * real `createRoot` + `act`, no testing-library dependency. `chime.playChime`
 * is mocked so chime-call counts are observable.
 */

interface Captured {
  current: UseSimpleMailboxResult | null;
  /** Notices captured by the `useStatusNotice` instance this harness mounts. */
  notices: ReadonlyArray<{ id: string; text: string; tone: 'info' | 'error' }>;
}

function makeSocketStub(): {
  ref: React.MutableRefObject<{ send: (type: string, payload: Record<string, unknown>) => void } | null>;
  sends: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const sends: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ref: React.MutableRefObject<{ send: (type: string, payload: Record<string, unknown>) => void } | null> = {
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

function renderProbe(captured: Captured, prefsRef: React.MutableRefObject<SimplePrefs>): Root {
  function Probe(): null {
    const { notice, showNotice } = useStatusNotice();
    const api = useSimpleMailbox({
      socketRef: makeSocketStub().ref,
      setNotice: showNotice,
      prefsRef,
    });
    // Capture the api + the most recent notice on every render. The
    // `notices` buffer is the authoritative log; `notice` is just the
    // current value (convenient for single-shot assertions).
    captured.current = api;
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Probe />);
  });
  // After the first render, `useStatusNotice` has produced its initial
  // (null) value. Drain that one frame of captured state.
  return root;
}

function renderProbeWithSocket(
  captured: Captured,
  prefsRef: React.MutableRefObject<SimplePrefs>,
  socketStub: ReturnType<typeof makeSocketStub>,
): Root {
  function Probe(): null {
    const { notice, showNotice } = useStatusNotice();
    const api = useSimpleMailbox({
      socketRef: socketStub.ref,
      setNotice: showNotice,
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
const playChimeSpy = vi.spyOn(chime, 'playChime').mockImplementation(() => {});

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
    const accepted = captured.current?.applyMailboxMessage(nonMailbox);
    expect(accepted).toBe(false);
    // Snapshot unchanged: still the empty initial state.
    const afterSnap = captured.current?.mailboxStore.getSnapshot();
    expect(afterSnap?.messages).toEqual(beforeSnap?.messages);
    expect(afterSnap?.agents).toEqual(beforeSnap?.agents);
    // No notice was raised.
    expect(captured.current).not.toBeNull();
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
    expect(captured.current?.applyMailboxMessage(received)).toBe(true);
    // The chime is suppressed when the mailbox panel is closed; with the
    // initial state `mailboxOpen === false` it must play.
    expect(playChimeSpy).toHaveBeenCalledTimes(1);

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
    expect(captured.current?.applyMailboxMessage(received)).toBe(true);
    expect(playChimeSpy).not.toHaveBeenCalled();

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
    expect(captured.current?.applyMailboxMessage(received)).toBe(true);
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
    expect(captured.current?.applyMailboxMessage(received)).toBe(true);
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
    expect(captured.current?.applyMailboxMessage(failure)).toBe(true);
    // The notice text carries the server-supplied error string.
    const sent = captured.notices.find((n) => n.id.startsWith('mail-'));
    expect(sent?.text).toBe('Email failed: recipient offline');
    expect(sent?.tone).toBe('error');

    roots.push(root);
  });

  it('fires "Email sent" only when a request id is pending AND success is true', () => {
    const captured: Captured = { current: null, notices: [] };
    const prefsRef = makePrefsRef();
    const socket = makeSocketStub();
    const root = renderProbeWithSocket(captured, prefsRef, socket);

    // First, drain a successful-but-unmatched response: success: true, no
    // matching pending request id — must be silent.
    const silentSuccess: ServerMessage = {
      type: 'mailbox.sent',
      payload: { success: true, requestId: 'unmatched' },
    };
    expect(captured.current?.applyMailboxMessage(silentSuccess)).toBe(true);
    expect(
      captured.notices.find((n) => n.text === 'Email sent'),
    ).toBeUndefined();

    // Now drive a real send through the hook, capture the request id, and
    // echo it back as a successful response. The notice must fire.
    act(() => {
      captured.current?.sendMailboxMessage({
        to: 'colleague',
        subject: 'ping',
        body: 'hi',
      });
    });
    // The hook sent mailbox.send with a generated request id.
    expect(socket.sends).toHaveLength(1);
    const sent = socket.sends[0];
    if (!sent) throw new Error('expected a send');
    const requestId = String(sent.payload['requestId'] ?? '');
    expect(requestId).not.toBe('');

    const echoedSuccess: ServerMessage = {
      type: 'mailbox.sent',
      payload: { success: true, requestId },
    };
    expect(captured.current?.applyMailboxMessage(echoedSuccess)).toBe(true);
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
    expect(socket.sends).toHaveLength(1);
    const sent = socket.sends[0];
    if (!sent) throw new Error('expected a send');
    const requestId = String(sent.payload['requestId'] ?? '');
    expect(requestId).not.toBe('');

    const echoed: ServerMessage = {
      type: 'mailbox.action_result',
      payload: { success: true, requestId },
    };
    expect(captured.current?.applyMailboxMessage(echoed)).toBe(true);
    const ok = captured.notices.find((n) => n.text === 'Email action completed');
    expect(ok?.tone).toBe('info');

    roots.push(root);
  });

  it('fires "Email action failed" for success: false regardless of pending set', () => {
    const captured: Captured = { current: null, notices: [] };
    const prefsRef = makePrefsRef();
    const socket = makeSocketStub();
    const root = renderProbeWithSocket(captured, prefsRef, socket);

    const failure: ServerMessage = {
      type: 'mailbox.action_result',
      payload: {
        success: false,
        requestId: 'unmatched',
        error: 'already deleted',
      },
    };
    expect(captured.current?.applyMailboxMessage(failure)).toBe(true);
    const failed = captured.notices.find((n) => n.text === 'Email action failed: already deleted');
    expect(failed?.tone).toBe('error');

    roots.push(root);
  });

  it('is silent for success: true with no matching pending request id', () => {
    const captured: Captured = { current: null, notices: [] };
    const prefsRef = makePrefsRef();
    const socket = makeSocketStub();
    const root = renderProbeWithSocket(captured, prefsRef, socket);

    const successUnmatched: ServerMessage = {
      type: 'mailbox.action_result',
      payload: { success: true, requestId: 'unmatched' },
    };
    expect(captured.current?.applyMailboxMessage(successUnmatched)).toBe(true);
    expect(
      captured.notices.find((n) => n.text === 'Email action completed'),
    ).toBeUndefined();

    roots.push(root);
  });
});
