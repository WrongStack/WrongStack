// HqPublisher local auto-discovery: `resolveEndpoint` is consulted before
// EVERY connect attempt, so a client can boot before `wstack --hq` exists,
// stay dormant on a cheap fixed-interval poll, and attach the moment a
// runtime marker appears — including HQ restarts on a different port and
// tokens minted after the client started.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HqPublisher, type HqSocketLike } from '../../src/hq/publisher.js';

class FakeSocket implements HqSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: unknown) => void,
  ): void {
    const existing = this.listeners.get(type) ?? new Set();
    existing.add(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: unknown) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const client = {
  clientId: 'client_1',
  kind: 'cli' as const,
  machineId: 'machine_1',
  startedAt: '2026-07-03T09:00:00.000Z',
};

const project = {
  projectId: 'project_1',
  projectRoot: '/repo',
  projectName: 'repo',
  machineId: 'machine_1',
  workspaceKind: 'git' as const,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('HqPublisher — endpoint auto-discovery', () => {
  it('stays dormant (no dial) while resolveEndpoint yields nothing, then attaches when an HQ appears', () => {
    let endpoint: { url: string; token?: string } | undefined;
    const dialed: string[] = [];
    const sockets: FakeSocket[] = [];
    const publisher = new HqPublisher({
      url: 'http://127.0.0.1:3499', // dormant placeholder — must NOT be dialed
      client,
      project,
      discoveryPollMs: 1_000,
      resolveEndpoint: () => endpoint,
      socketFactory: (url) => {
        dialed.push(url);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    publisher.connect();
    expect(dialed).toHaveLength(0);

    // Events published while dormant queue up (bounded) instead of dialing.
    publisher.publishEvent({ type: 'session.snapshot', payload: { hello: 1 } });
    vi.advanceTimersByTime(3_000);
    expect(dialed).toHaveLength(0);

    // `wstack --hq` starts: the runtime marker + first client token appear.
    endpoint = { url: 'http://127.0.0.1:45123', token: 'minted-later' };
    vi.advanceTimersByTime(1_000);
    expect(dialed).toEqual(['ws://127.0.0.1:45123/ws/client?token=minted-later']);

    // Queued telemetry flushes right after hello.
    sockets[0]?.open();
    const frames = sockets[0]?.sent.map((f) => JSON.parse(f) as { type: string }) ?? [];
    expect(frames[0]?.type).toBe('client.hello');
    expect(frames.some((f) => f.type === 'client.event')).toBe(true);

    publisher.close();
  });

  it('re-resolves the endpoint on reconnect — an HQ restart on a new port is picked up', () => {
    let endpoint: { url: string } | undefined = { url: 'http://127.0.0.1:45123' };
    const dialed: string[] = [];
    const sockets: FakeSocket[] = [];
    const publisher = new HqPublisher({
      url: 'http://127.0.0.1:3499',
      client,
      project,
      reconnectBaseMs: 100,
      discoveryPollMs: 1_000,
      resolveEndpoint: () => endpoint,
      socketFactory: (url) => {
        dialed.push(url);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    publisher.connect();
    sockets[0]?.open();
    expect(dialed).toEqual(['ws://127.0.0.1:45123/ws/client']);

    // HQ dies (marker cleared) — the reconnect finds nothing and goes dormant.
    endpoint = undefined;
    sockets[0]?.close();
    vi.advanceTimersByTime(5_000);
    expect(dialed).toHaveLength(1);

    // HQ restarts on ANOTHER port — the next discovery poll attaches there.
    endpoint = { url: 'http://127.0.0.1:45999' };
    vi.advanceTimersByTime(1_000);
    expect(dialed[1]).toBe('ws://127.0.0.1:45999/ws/client');

    publisher.close();
  });

  it('without resolveEndpoint the static URL behaviour is unchanged', () => {
    const dialed: string[] = [];
    const publisher = new HqPublisher({
      url: 'http://127.0.0.1:3499',
      token: 'static-token',
      client,
      project,
      socketFactory: (url) => {
        dialed.push(url);
        return new FakeSocket();
      },
    });
    publisher.connect();
    expect(dialed).toEqual(['ws://127.0.0.1:3499/ws/client?token=static-token']);
    publisher.close();
  });

  it('publish while a retry is pending does not stack extra dials', () => {
    let endpoint: { url: string } | undefined;
    let resolves = 0;
    const publisher = new HqPublisher({
      url: 'http://127.0.0.1:3499',
      client,
      project,
      discoveryPollMs: 1_000,
      resolveEndpoint: () => {
        resolves += 1;
        return endpoint;
      },
      socketFactory: () => new FakeSocket(),
    });

    publisher.connect();
    expect(resolves).toBe(1);
    // A burst of publishes while dormant must not re-read the marker per event.
    for (let i = 0; i < 50; i++) {
      publisher.publishEvent({ type: 'tool.executed', payload: { i } });
    }
    expect(resolves).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(resolves).toBe(2);

    publisher.close();
  });
});
