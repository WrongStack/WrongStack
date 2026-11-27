import { beforeEach, describe, expect, it, vi } from 'vitest';

// The wire reaches for the live socket — stub it so frames can be inspected.
const send = vi.fn();
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => ({ send }) }));

import {
  handleKanbanCompanionStatus,
  setKanbanCompanionEnabled,
  syncKanbanCompanionScope,
} from '../../src/lib/kanban-companion-wire';
import { useKanbanCompanionStore } from '../../src/stores/kanban-companion-store';

/** The most recent outbound frame; fails the test when nothing was sent. */
function lastFrame(): { type: string; payload: Record<string, unknown> } {
  const call = send.mock.calls.at(-1);
  if (!call) throw new Error('expected an outbound frame');
  return call[0] as { type: string; payload: Record<string, unknown> };
}

let scopeSeq = 0;

beforeEach(() => {
  send.mockClear();
  // A fresh scope key deterministically resets all wire correlation state.
  syncKanbanCompanionScope(`scope-${++scopeSeq}`);
});

describe('kanban companion wire', () => {
  it('asks the server on scope entry and keeps the switch unknown until a reply', () => {
    const frame = lastFrame();
    expect(frame.type).toBe('kanban.companion.get');
    expect(typeof frame.payload['requestId']).toBe('string');
    expect(useKanbanCompanionStore.getState()).toMatchObject({
      enabled: null,
      pending: false,
      error: null,
    });
  });

  it('mirrors the switch only when the get reply arrives (non-optimistic)', () => {
    const { requestId } = lastFrame().payload;
    handleKanbanCompanionStatus({ success: true, data: { enabled: true }, requestId });
    expect(useKanbanCompanionStore.getState()).toMatchObject({ enabled: true, error: null });
  });

  it('drops a requestId-less broadcast that arrives before the scope is hydrated', () => {
    // A broadcast from the previous project must not seed the new scope.
    handleKanbanCompanionStatus({ success: true, data: { enabled: true } });
    expect(useKanbanCompanionStore.getState().enabled).toBeNull();
  });

  it('applies a broadcast once hydrated — another client flipped the switch', () => {
    const { requestId } = lastFrame().payload;
    handleKanbanCompanionStatus({ success: true, data: { enabled: false }, requestId });
    handleKanbanCompanionStatus({ success: true, data: { enabled: true } });
    expect(useKanbanCompanionStore.getState().enabled).toBe(true);
  });

  it('sends kanban.companion.set with a requestId and does not flip ahead of the reply', () => {
    const { requestId: getRequestId } = lastFrame().payload;
    handleKanbanCompanionStatus({
      success: true,
      data: { enabled: false },
      requestId: getRequestId,
    });
    send.mockClear();

    setKanbanCompanionEnabled(true);
    const frame = lastFrame();
    expect(frame.type).toBe('kanban.companion.set');
    expect(frame.payload).toMatchObject({ enabled: true });
    expect(typeof frame.payload['requestId']).toBe('string');
    expect(useKanbanCompanionStore.getState()).toMatchObject({ enabled: false, pending: true });

    handleKanbanCompanionStatus({
      success: true,
      data: { enabled: true },
      requestId: frame.payload['requestId'],
    });
    expect(useKanbanCompanionStore.getState()).toMatchObject({
      enabled: true,
      pending: false,
      error: null,
    });
  });

  it('surfaces a failed set and unblocks the switch without touching the value', () => {
    const { requestId: getRequestId } = lastFrame().payload;
    handleKanbanCompanionStatus({
      success: true,
      data: { enabled: false },
      requestId: getRequestId,
    });
    send.mockClear();
    setKanbanCompanionEnabled(true);
    const { requestId } = lastFrame().payload;
    handleKanbanCompanionStatus({ success: false, error: 'kanban offline', requestId });
    expect(useKanbanCompanionStore.getState()).toMatchObject({
      enabled: false,
      pending: false,
      error: 'kanban offline',
    });
  });

  it('falls back to an empty error string when a failure carries no message', () => {
    const { requestId } = lastFrame().payload;
    handleKanbanCompanionStatus({ success: false, requestId });
    expect(useKanbanCompanionStore.getState().error).toBe('');
  });

  it('ignores a second write while one is in flight', () => {
    setKanbanCompanionEnabled(true);
    send.mockClear();
    setKanbanCompanionEnabled(false);
    expect(send).not.toHaveBeenCalled();
    expect(useKanbanCompanionStore.getState().pending).toBe(true);
  });

  it('drops a reply whose requestId was superseded by a newer scope', () => {
    const staleRequestId = lastFrame().payload['requestId'] as string;
    syncKanbanCompanionScope(`scope-${++scopeSeq}`);
    handleKanbanCompanionStatus({
      success: true,
      data: { enabled: true },
      requestId: staleRequestId,
    });
    expect(useKanbanCompanionStore.getState().enabled).toBeNull();
  });

  it('does not duplicate the get when the same scope re-enters before hydration', () => {
    send.mockClear();
    syncKanbanCompanionScope(`scope-${scopeSeq}`);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not duplicate the get when the same scope re-enters after hydration', () => {
    const { requestId } = lastFrame().payload;
    handleKanbanCompanionStatus({ success: true, data: { enabled: false }, requestId });
    send.mockClear();
    syncKanbanCompanionScope(`scope-${scopeSeq}`);
    expect(send).not.toHaveBeenCalled();
    expect(useKanbanCompanionStore.getState().enabled).toBe(false);
  });

  it('resets an in-flight write on a scope change and drops its late reply', () => {
    setKanbanCompanionEnabled(true);
    const pendingRequestId = lastFrame().payload['requestId'] as string;
    syncKanbanCompanionScope(`scope-${++scopeSeq}`);
    expect(useKanbanCompanionStore.getState()).toMatchObject({ enabled: null, pending: false });
    handleKanbanCompanionStatus({
      success: true,
      data: { enabled: true },
      requestId: pendingRequestId,
    });
    expect(useKanbanCompanionStore.getState().enabled).toBeNull();
  });

  it('rejects a malformed success frame and keeps broadcasts locked out', () => {
    const { requestId } = lastFrame().payload;
    handleKanbanCompanionStatus({ success: true, data: { enabled: 'yes' }, requestId });
    expect(useKanbanCompanionStore.getState()).toMatchObject({ enabled: null, error: '' });
    handleKanbanCompanionStatus({ success: true, data: { enabled: true } });
    expect(useKanbanCompanionStore.getState().enabled).toBeNull();
  });

  it('is registered in WS_HANDLERS and dispatches the production map entry', async () => {
    const { WS_HANDLERS } = await import('../../src/hooks/ws-handlers');
    const handler = WS_HANDLERS['kanban.companion.status'];
    expect(handler).toBeTypeOf('function');
    const { requestId } = lastFrame().payload;
    handler?.({
      type: 'kanban.companion.status',
      payload: { success: true, data: { enabled: true }, requestId },
    } as never);
    expect(useKanbanCompanionStore.getState().enabled).toBe(true);
  });
});
