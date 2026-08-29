/**
 * Sessions that were opened and never used must not pile up forever.
 *
 * Every launch of the embedded host opens a session, and so does every tab the
 * user opens and closes without typing. The sweeper that removes them existed,
 * but was wired into the STANDALONE WebUI host only — so the host that
 * `wstack --webui` actually runs kept one dead, empty record per launch. They
 * filled the history list, and the ones the runtime or a tab still held could
 * not be deleted by hand either.
 *
 * What must stay untouched is as important as what goes: the runtime's own
 * session, every session a connected page declares (a background tab's
 * brand-new session is empty by definition), and any session with a live run,
 * whose journal is empty only because its first turn has not landed yet.
 */
import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWebUI } from '../../src/webui-server.js';
import { openWs } from '../_ws-client.js';

const BOOT = 'sweep-boot-session';
const DECLARED = 'sweep-declared-tab';
const ORPHAN = 'sweep-orphan-empty';
const INTERVAL_ENV = 'WRONGSTACK_EMPTY_SESSION_CLEANUP_INTERVAL_MS';

describe('runWebUI sweeps empty sessions nobody is holding', () => {
  let previousInterval: string | undefined;

  beforeEach(() => {
    previousInterval = process.env[INTERVAL_ENV];
    process.env[INTERVAL_ENV] = '1000';
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  afterEach(() => {
    if (previousInterval === undefined) delete process.env[INTERVAL_ENV];
    else process.env[INTERVAL_ENV] = previousInterval;
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('deletes the orphan, keeps the boot session and every declared tab', async () => {
    const events = new EventBus();
    const deleted: string[] = [];
    // Everything in this store is empty. The sweeper must still refuse the
    // ones that are being displayed or that the runtime is sitting on.
    const sessionStore = {
      list: async () => [{ id: BOOT }, { id: DECLARED }, { id: ORPHAN }],
      isEmpty: async () => true,
      delete: async (id: string) => {
        deleted.push(id);
      },
    };

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
      sessionStore: sessionStore as never,
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

      // One background tab declared. It has never been typed into, so its
      // record is as empty as the orphan's — the declaration is the only thing
      // separating them.
      ws.send(
        JSON.stringify({ type: 'session.subscribe', payload: { sessionIds: [BOOT, DECLARED] } }),
      );
      await waitForMessage(
        'session.run_state',
        (m) => (m['payload'] as { sessionId?: string }).sessionId === DECLARED,
      );

      await vi.waitFor(() => expect(deleted).toContain(ORPHAN), { timeout: 8_000 });
      expect(deleted).not.toContain(BOOT);
      expect(deleted).not.toContain(DECLARED);

      ws.close();
    } finally {
      process.emit('SIGINT');
      await serverDone;
    }
  }, 20_000);
});
