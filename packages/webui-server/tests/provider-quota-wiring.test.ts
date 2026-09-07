/**
 * Plan quota over the WebSocket.
 *
 * Two halves, and both are load-bearing. The push carries a reading to every
 * open tab the moment a metered provider reports one; the `provider.quota.get`
 * replay is what a tab that connected mid-session gets instead, because the
 * server will not re-fetch from the provider — asking a metered plan how much
 * you have spent costs a request against that same plan.
 *
 * The push must also be UNSTAMPED. A plan belongs to the account, not to a
 * conversation: a session-stamped frame is dropped for any page that has not
 * declared that session, which would leave every tab but one showing nothing.
 */

import type { EventBus } from '@wrongstack/core/kernel';
import { recordProviderQuota, resetProviderQuota } from '@wrongstack/core/quota';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { handleProviderRoute, type ProviderRouteHandlers } from '../src/server/provider-routes.js';
import { setupEvents } from '../src/server/setup-events.js';

afterEach(() => {
  resetProviderQuota();
});

function mockWs() {
  return { readyState: 1, send: vi.fn() } as never as WebSocket & {
    send: ReturnType<typeof vi.fn>;
  };
}

function sent(ws: ReturnType<typeof mockWs>) {
  return ws.send.mock.calls.map(
    ([raw]) => JSON.parse(String(raw)) as { type: string; payload: Record<string, unknown> },
  );
}

function snapshot(providerId: string, usedPercent: number) {
  return {
    providerId,
    meterId: 'codex',
    windows: [{ id: 'primary', usedPercent, windowMinutes: 300 }],
    capturedAt: Date.now(),
  };
}

/**
 * An EventBus stub. The quota subscription is not an EventBus listener at all —
 * it is a store subscription — so every bus method here only has to hand back a
 * disposer for the handlers registered alongside it.
 */
function stubEvents(): EventBus {
  const noop = () => () => {};
  return { on: noop, once: noop, onPattern: noop, emit: () => {} } as never as EventBus;
}

describe('provider.quota push', () => {
  it('broadcasts a reading to every client, unstamped', () => {
    const broadcast = vi.fn();
    const clients = new Map();
    const dispose = setupEvents({
      events: stubEvents(),
      broadcast,
      clients,
      config: {},
      context: {} as never,
      pendingConfirms: new Map(),
    } as never);

    recordProviderQuota('openai-codex', [snapshot('openai-codex', 64)]);

    const call = broadcast.mock.calls.find(
      ([, msg]) => (msg as { type: string }).type === 'provider.quota',
    );
    expect(call).toBeDefined();
    const [, msg, targetSessionId] = call as [
      unknown,
      { payload: Record<string, unknown> },
      unknown,
    ];
    expect(targetSessionId).toBeUndefined();
    expect(msg.payload['providerId']).toBe('openai-codex');
    expect(msg.payload['snapshots'] as unknown[]).toHaveLength(1);

    dispose();
  });

  it('stops broadcasting once disposed', () => {
    const broadcast = vi.fn();
    const dispose = setupEvents({
      events: stubEvents(),
      broadcast,
      clients: new Map(),
      config: {},
      context: {} as never,
      pendingConfirms: new Map(),
    } as never);
    dispose();

    recordProviderQuota('openai-codex', [snapshot('openai-codex', 64)]);

    expect(
      broadcast.mock.calls.some(([, msg]) => (msg as { type: string }).type === 'provider.quota'),
    ).toBe(false);
  });
});

describe('provider.quota.get replay', () => {
  it('answers a late tab with everything the store already holds', async () => {
    recordProviderQuota('openai-codex', [snapshot('openai-codex', 51)]);
    recordProviderQuota('anthropic-oauth', [snapshot('anthropic-oauth', 12)]);

    const ws = mockWs();
    await expect(
      handleProviderRoute(ws, { type: 'provider.quota.get' }, {} as ProviderRouteHandlers),
    ).resolves.toBe(true);

    const reply = sent(ws).find((m) => m.type === 'provider.quota');
    expect(reply).toBeDefined();
    const snapshots = reply?.payload['snapshots'] as Array<{ providerId: string }>;
    expect(snapshots.map((s) => s.providerId).sort()).toEqual(['anthropic-oauth', 'openai-codex']);
  });

  it('answers with an empty list before anything has reported', async () => {
    const ws = mockWs();
    await handleProviderRoute(ws, { type: 'provider.quota.get' }, {} as ProviderRouteHandlers);
    expect(sent(ws)[0]?.payload['snapshots']).toEqual([]);
  });
});
