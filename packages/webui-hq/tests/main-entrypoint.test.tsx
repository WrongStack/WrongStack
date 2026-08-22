/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createRoot: vi.fn(),
  exchangeBootstrapIfNeeded: vi.fn(),
  fetchJson: vi.fn(),
  getHqClient: vi.fn(),
  projectAlert: vi.fn(),
  projectCommand: vi.fn(),
  projectEvent: vi.fn(),
  projectFleet: vi.fn(),
  render: vi.fn(),
  scrubTokenFromUrl: vi.fn(),
  storeSubscribe: vi.fn(),
  upgradeStoredTokenToCookie: vi.fn(),
}));

const state = vi.hoisted(() => ({
  resumeCursors: { sequence: 4 },
  _onAlert: vi.fn(),
  _onCommandStatus: vi.fn(),
  _onEvent: vi.fn(),
  _onSnapshot: vi.fn(),
  _resetResumeCursors: vi.fn(),
  _setConnected: vi.fn(),
  _setNeedsSnapshotRefresh: vi.fn(),
}));

const useHqStore = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    getState: vi.fn(() => state),
    subscribe: mocks.storeSubscribe,
  }),
);

vi.mock('react-dom/client', () => ({ createRoot: mocks.createRoot }));
vi.mock('../src/app.js', () => ({ HqApp: () => null }));
vi.mock('../src/lib/auth.js', () => ({
  exchangeBootstrapIfNeeded: mocks.exchangeBootstrapIfNeeded,
  scrubTokenFromUrl: mocks.scrubTokenFromUrl,
  upgradeStoredTokenToCookie: mocks.upgradeStoredTokenToCookie,
}));
vi.mock('../src/lib/hq-ws-client.js', () => ({ getHqClient: mocks.getHqClient }));
vi.mock('../src/store.js', () => ({ fetchJson: mocks.fetchJson, useHqStore }));
vi.mock('@wrongstack/webui-protocol', () => ({
  projectHqAlertMessage: mocks.projectAlert,
  projectHqCommandStatusMessage: mocks.projectCommand,
  projectHqEventMessage: mocks.projectEvent,
  projectHqFleetMessage: mocks.projectFleet,
}));

describe('WebUI HQ entrypoint', () => {
  let onStateChange: ((value: string) => void) | undefined;
  let onMessage: ((message: Record<string, unknown>) => void) | undefined;
  let onStoreChange:
    | ((next: Record<string, unknown>, previous: Record<string, unknown>) => void)
    | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    document.body.innerHTML = '<div id="root"></div>';
    mocks.createRoot.mockReturnValue({ render: mocks.render });
    mocks.exchangeBootstrapIfNeeded.mockResolvedValue(false);
    mocks.upgradeStoredTokenToCookie.mockResolvedValue(undefined);
    mocks.fetchJson.mockResolvedValue({ generatedAt: 'now' });
    mocks.getHqClient.mockReturnValue({
      onStateChange: vi.fn((handler) => {
        onStateChange = handler;
      }),
      on: vi.fn((handler) => {
        onMessage = handler;
      }),
    });
    mocks.storeSubscribe.mockImplementation((handler) => {
      onStoreChange = handler;
      return vi.fn();
    });
    mocks.projectFleet.mockReturnValue({ snapshot: { id: 'snapshot' } });
    mocks.projectEvent.mockImplementation((message) => ({ event: message.event }));
    mocks.projectAlert.mockReturnValue({ alert: { id: 'alert' } });
    mocks.projectCommand.mockReturnValue({ command: { id: 'command' } });
  });

  it('boots auth, wires live projections, and renders the dashboard', async () => {
    await import('../src/main.js');
    await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledOnce());

    expect(mocks.scrubTokenFromUrl).toHaveBeenCalledOnce();
    expect(mocks.upgradeStoredTokenToCookie).toHaveBeenCalledOnce();
    expect(mocks.getHqClient).toHaveBeenCalledWith({ resumeCursor: expect.any(Function) });
    expect(mocks.createRoot).toHaveBeenCalledWith(document.getElementById('root'));

    onStateChange?.('connected');
    expect(state._setConnected).toHaveBeenCalledWith(true);

    onMessage?.({ type: 'hq.snapshot' });
    onMessage?.({ type: 'hq.event', event: { id: 'event' } });
    onMessage?.({ type: 'hq.alert' });
    onMessage?.({ type: 'hq.command_status' });
    onMessage?.({
      type: 'hq.resume_gap',
      envelopes: [{ id: 'gap-1' }, { id: 'gap-2' }],
    });
    expect(state._onSnapshot).toHaveBeenCalledWith({ id: 'snapshot' });
    expect(state._onEvent).toHaveBeenCalledTimes(3);
    expect(state._onAlert).toHaveBeenCalledWith({ id: 'alert' });
    expect(state._onCommandStatus).toHaveBeenCalledWith({ id: 'command' });
  });

  it('consumes a resume rejection with one authoritative snapshot refresh', async () => {
    await import('../src/main.js');
    await vi.waitFor(() => expect(onMessage).toBeTypeOf('function'));

    onMessage?.({ type: 'hq.resume_reject' });
    expect(state._resetResumeCursors).toHaveBeenCalledOnce();
    expect(state._setNeedsSnapshotRefresh).toHaveBeenCalledWith(true);

    onStoreChange?.({ needsSnapshotRefresh: true }, { needsSnapshotRefresh: false });
    onStoreChange?.({ needsSnapshotRefresh: true }, { needsSnapshotRefresh: false });
    await vi.waitFor(() => expect(state._onSnapshot).toHaveBeenCalledWith({ generatedAt: 'now' }));
    expect(mocks.fetchJson).toHaveBeenCalledOnce();
    expect(state._setNeedsSnapshotRefresh).toHaveBeenCalledWith(false);
  });
});
