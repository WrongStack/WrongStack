/**
 * Closing a tab releases the background help pinned to its conversation.
 *
 * `MultiAgentHost` builds an explore companion per conversation (with a poll
 * timer) and keeps shadow-review bookkeeping per conversation. Both were only
 * ever torn down by `dispose()`, i.e. at process exit, so a page that opened
 * and closed tabs all day accumulated helpers watching conversations nobody
 * was looking at.
 *
 * The signal is the same one the agent retirement already uses — the shrinking
 * `session.subscribe` set — and the ordering matters: the hook fires only
 * AFTER the live-run check, because a background run outlives the tab that
 * started it and still deserves its helpers.
 */
import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWebUI } from '../../src/webui-server.js';
import { openWs } from '../_ws-client.js';

const BOOT = 'retire-boot-session';
const TAB_2 = 'retire-tab-2';

describe('runWebUI releases per-conversation helpers when a tab closes', () => {
  beforeEach(() => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  afterEach(() => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('calls onSessionRetired for the dropped tab, never for the boot session', async () => {
    const events = new EventBus();
    const onSessionRetired = vi.fn();
    let listeningInfo: { httpPort: number; wsPort: number; host: string } | undefined;
    let signalReady: (() => void) | undefined;
    const listening = new Promise<void>((r) => {
      signalReady = r;
    });

    const serverDone = runWebUI({
      host: '127.0.0.1',
      profileConfigPath: '/tmp/test-profile.json',
      onListening: (info) => {
        listeningInfo = info;
        signalReady?.();
      },
      events,
      onSessionRetired,
      session: { id: BOOT } as never,
      agent: {
        ctx: { model: 'm', provider: { id: 'p' } },
        run: vi.fn(),
      } as never,
    });

    try {
      await listening;
      const { ws, waitForMessage } = await openWs(`ws://127.0.0.1:${listeningInfo!.wsPort}`);
      await waitForMessage('session.start');

      // Two tabs open.
      ws.send(
        JSON.stringify({ type: 'session.subscribe', payload: { sessionIds: [BOOT, TAB_2] } }),
      );
      await waitForMessage(
        'session.run_state',
        (m) => (m['payload'] as { sessionId?: string }).sessionId === TAB_2,
      );

      // The second tab closes: the strip re-declares the set without it.
      ws.send(JSON.stringify({ type: 'session.subscribe', payload: { sessionIds: [BOOT] } }));

      await vi.waitFor(() => expect(onSessionRetired).toHaveBeenCalledWith(TAB_2));
      expect(onSessionRetired).not.toHaveBeenCalledWith(BOOT);

      ws.close();
    } finally {
      process.emit('SIGINT');
      await serverDone;
    }
  });
});
