import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clientMock = vi.hoisted(() => ({
  getKanbanServerConnection: vi.fn(),
}));

vi.mock('../src/server/client.js', () => clientMock);

import { bridgeKanbanSupervisor } from '../src/server/kanban-supervisor-bridge.js';

class FakeConnection {
  private readonly eventListeners = new Set<(event: { event: string }) => void>();
  private readonly disconnectListeners = new Set<() => void>();

  subscribe(listener: (event: { event: string }) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  emit(event: { event: string }): void {
    for (const listener of this.eventListeners) listener(event);
  }

  disconnect(): void {
    for (const listener of [...this.disconnectListeners]) listener();
    this.disconnectListeners.clear();
    this.eventListeners.clear();
  }
}

describe('bridgeKanbanSupervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clientMock.getKanbanServerConnection.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-subscribes after a live daemon connection closes', async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    clientMock.getKanbanServerConnection.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const handler = vi.fn();
    const onConnected = vi.fn();

    const dispose = bridgeKanbanSupervisor('C:\\project', handler, {
      reconnectDelayMs: 25,
      onConnected,
    });
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));

    first.emit({ event: 'board.updated' });
    expect(handler).toHaveBeenCalledTimes(1);

    first.disconnect();
    await vi.advanceTimersByTimeAsync(25);
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledTimes(2));

    second.emit({ event: 'board.updated' });
    expect(handler).toHaveBeenCalledTimes(2);

    dispose();
    second.disconnect();
    await vi.advanceTimersByTimeAsync(50);
    expect(clientMock.getKanbanServerConnection).toHaveBeenCalledTimes(2);
  });
});
