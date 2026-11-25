import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { createAutonomyRouteHandlers } from '../src/server/autonomy-routes.js';
import type { PrefsHandlerContext } from '../src/server/prefs-handlers.js';
import type { WSClientMessage } from '../src/server/types.js';

describe('createAutonomyRouteHandlers (F2217)', () => {
  it('treats whitespace-only sessionId as undefined', async () => {
    let seenSessionId: string | undefined = 'unset';
    const handlers = createAutonomyRouteHandlers({
      checkAutonomy: async (_mode: string, sessionId?: string) => {
        seenSessionId = sessionId;
        return 'stop';
      },
      snapshot: () => ({}),
      send() {},
      meta: {},
      pendingConfirms: new Map(),
      broadcast() {},
      persist: async () => {},
    } as unknown as PrefsHandlerContext);

    await handlers.switchMode(
      {} as unknown as WebSocket,
      {
        type: 'autonomy.switch',
        payload: { mode: 'off', sessionId: '   ' },
      } as unknown as WSClientMessage,
    );

    expect(seenSessionId).toBeUndefined();
  });
});
