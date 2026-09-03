import { describe, it, expect, vi } from 'vitest';
import {
  createEternalSubscription,
  type EternalBroadcast,
  type EternalSubscribe,
} from '../src/server/eternal-iteration-broadcast.js';
import type { WebSocket } from 'ws';

describe('eternal-iteration-broadcast', () => {
  describe('createEternalSubscription', () => {
    it('subscribes and broadcasts journal entries to clients', () => {
      const disposeOriginal = vi.fn();
      const broadcast = vi.fn();
      const clientsRef = vi.fn(() => new Map<WebSocket, any>());

      const subscribe = vi.fn((fn: (entry: any) => void) => {
        // Simulate the engine calling the callback with an entry
        fn({ id: 'entry-1', type: 'iteration' });
        return disposeOriginal;
      });

      const sub = createEternalSubscription(subscribe, broadcast, clientsRef);

      expect(subscribe).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveBeenCalledWith(clientsRef(), {
        type: 'eternal.iteration',
        payload: { entry: { id: 'entry-1', type: 'iteration' } },
      });
      expect(disposeOriginal).not.toHaveBeenCalled();

      sub.dispose();
      expect(disposeOriginal).toHaveBeenCalled();
    });

    it('dispose is idempotent', () => {
      const disposeOriginal = vi.fn();
      const subscribe = vi.fn(() => disposeOriginal);
      const sub = createEternalSubscription(subscribe, vi.fn(), () => new Map());

      sub.dispose();
      sub.dispose();

      expect(disposeOriginal).toHaveBeenCalledTimes(1);
    });

    it('skips broadcast when disposed before callback fires', () => {
      const disposeOriginal = vi.fn();
      // Capture the callback function that subscribe stores
      let capturedCallback: ((entry: any) => void) | null = null;
      const subscribe = vi.fn((fn: (entry: any) => void) => {
        capturedCallback = fn;
        return disposeOriginal;
      });
      const broadcast = vi.fn();

      const sub = createEternalSubscription(subscribe, broadcast, () => new Map());

      // Dispose before the engine fires any callbacks
      sub.dispose();

      // After dispose, the callback should skip broadcasting
      capturedCallback!({ id: 'late-entry' });
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('returns an EternalSubscription object', () => {
      const sub = createEternalSubscription(
        vi.fn(() => vi.fn()),
        vi.fn(),
        () => new Map(),
      );

      expect(sub).toHaveProperty('dispose');
      expect(typeof sub.dispose).toBe('function');
    });

    // B-07: migrated from packages/webui/tests/server/eternal-iteration-broadcast.test.ts
    // — pins the generic `Map<WebSocket, C>` typing so the CLI's `runWebUI`
    // can pass a structurally-similar clients map (its own
    // `Map<WebSocket, { ws; sessionId }>` shape) with a broadcast callback
    // that drops the first argument. The server's existing suite only
    // exercises `Map<WebSocket, any>`; a future refactor that tightened
    // the generic back to `ConnectedClient` would break the CLI without
    // breaking any server test.
    it('broadcast callback can ignore the clients map (CLI pattern)', () => {
      interface CliConnectedClient {
        ws: unknown;
        sessionId: string | null;
      }
      const cliClients = new Map<unknown, CliConnectedClient>();
      const cliClientsRef = () => cliClients;
      const sentTo: unknown[] = [];
      const cliBroadcast: EternalBroadcast<CliConnectedClient> = (_c, msg) => {
        sentTo.push(msg);
      };
      const sub = createEternalSubscription(
        ((fn: (entry: unknown) => void) => {
          fn({ kind: 'cli' });
          return () => {};
        }) as EternalSubscribe,
        cliBroadcast,
        cliClientsRef,
      );
      expect(sentTo).toHaveLength(1);
      expect(sentTo[0]).toEqual({ type: 'eternal.iteration', payload: { entry: { kind: 'cli' } } });
      sub.dispose();
    });
  });
});
