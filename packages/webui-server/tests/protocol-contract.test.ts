import { readFileSync } from 'node:fs';
import {
  CLIENT_MESSAGE_TYPES,
  decodeProtocolFrame,
  decodeProtocolMessage,
  negotiateProtocol,
  protocolAdvertisement,
  SERVER_MESSAGE_TYPES,
  SURFACE_PROTOCOL_VERSION,
} from '@wrongstack/webui-protocol';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { IntrospectionRouteContext } from '../src/server/introspection-routes.js';
import {
  createRouteFamilyDispatcher,
  type RouteFamilyTable,
} from '../src/server/route-family-dispatcher.js';

interface GoldenProtocolFixture {
  version: number;
  client: unknown[];
  server: unknown[];
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/protocol-v1.json', import.meta.url), 'utf8'),
) as GoldenProtocolFixture;

describe('surface protocol contract', () => {
  it('decodes the versioned cross-domain golden fixtures', () => {
    expect(fixture.version).toBe(SURFACE_PROTOCOL_VERSION);
    for (const message of fixture.client) {
      expect(decodeProtocolMessage(message, 'client')).toMatchObject({ ok: true });
    }
    for (const message of fixture.server) {
      expect(decodeProtocolMessage(message, 'server')).toMatchObject({ ok: true });
    }
  });

  it('keeps every exact registry entry executable through its directional decoder', () => {
    expect(new Set(CLIENT_MESSAGE_TYPES).size).toBe(235);
    expect(new Set(SERVER_MESSAGE_TYPES).size).toBe(251);
    for (const type of CLIENT_MESSAGE_TYPES) {
      expect(decodeProtocolMessage({ type }, 'client')).toEqual({
        ok: true,
        message: { type },
      });
    }
    for (const type of SERVER_MESSAGE_TYPES) {
      expect(decodeProtocolMessage({ type, payload: null }, 'server')).toEqual({
        ok: true,
        message: { type, payload: null },
      });
    }
  });

  it('accepts every prompt-library response emitted by the server', () => {
    const responseTypes = [
      'prompts.list',
      'prompts.search',
      'prompts.content',
      'prompts.favorite',
      'prompts.created',
      'prompts.used',
      'prompts.recent',
      'prompts.journal',
    ];

    for (const type of responseTypes) {
      expect(decodeProtocolMessage({ type, payload: {} }, 'server')).toMatchObject({ ok: true });
    }
  });

  it('supports the documented kanban extension namespace in both directions', () => {
    expect(decodeProtocolMessage({ type: 'kanban.custom' }, 'client').ok).toBe(true);
    expect(decodeProtocolMessage({ type: 'kanban.custom', payload: {} }, 'server').ok).toBe(true);
    expect(decodeProtocolMessage({ type: 'kanban.' }, 'client')).toMatchObject({
      ok: false,
      issue: { code: 'unknown_type' },
    });
  });

  it('rejects malformed, unknown, and payload-less server frames', () => {
    expect(decodeProtocolFrame('{', 'client')).toMatchObject({
      ok: false,
      issue: { code: 'invalid_envelope' },
    });
    expect(decodeProtocolMessage([], 'client')).toMatchObject({
      ok: false,
      issue: { code: 'invalid_envelope' },
    });
    expect(decodeProtocolMessage({ type: 'future.unknown' }, 'client')).toMatchObject({
      ok: false,
      issue: { code: 'unknown_type' },
    });
    expect(decodeProtocolMessage({ type: 'session.start' }, 'server')).toMatchObject({
      ok: false,
      issue: { code: 'invalid_envelope' },
    });
  });

  it('rejects unsafe keys recursively and caps hostile nesting', () => {
    const polluted = JSON.parse(
      '{"type":"user_message","payload":{"nested":{"__proto__":{"polluted":true}}}}',
    );
    expect(decodeProtocolMessage(polluted, 'client')).toMatchObject({
      ok: false,
      issue: { code: 'unsafe_key', path: '$.payload.nested.__proto__' },
    });

    let nested: Record<string, unknown> = {};
    const message = { type: 'user_message', payload: nested };
    for (let depth = 0; depth < 40; depth++) {
      nested['next'] = {};
      nested = nested['next'] as Record<string, unknown>;
    }
    expect(decodeProtocolMessage(message, 'client')).toMatchObject({
      ok: false,
      issue: { code: 'too_deep' },
    });
  });

  it('negotiates current peers while preserving version-less legacy clients', () => {
    const advertisement = protocolAdvertisement();
    expect(negotiateProtocol(advertisement)).toMatchObject({
      compatible: true,
      legacyPeer: false,
      version: SURFACE_PROTOCOL_VERSION,
      capabilities: advertisement.protocolCapabilities,
    });
    expect(negotiateProtocol({})).toMatchObject({
      compatible: true,
      legacyPeer: true,
      version: SURFACE_PROTOCOL_VERSION,
      capabilities: [],
    });
    expect(negotiateProtocol({ protocolVersion: 0 })).toMatchObject({ compatible: false });
  });
});

describe('protocol registry ↔ route-family dispatcher parity', () => {
  // A callable stub: any property access yields another callable stub and
  // any call yields `undefined`. The real `handleXxxRoute` switch logic then
  // runs exactly as in production (claiming or rejecting the message) while
  // the nested handler it dereferences is a no-op.
  // NOTE: never use this stub for claim-propagation families whose route
  // handler returns or inspects the handler's result (e.g. handleWorktreeRoute
  // returns handlers.handleMessage(...) directly) — an `undefined` result
  // silently drops the claim and the family's messages fall through to
  // onUnknown. Those families need a dedicated `true`-resolving fake (see the
  // `worktree` entry below).
  function stubTable(): unknown {
    const stub = function stubHandler(): undefined {
      return undefined;
    };
    return new Proxy(stub, {
      get: (_target, prop) => {
        // Keep `await`/iteration semantics inert on the stub itself.
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        return stubTable();
      },
    });
  }

  // Registered client types that are dispatched OUTSIDE the route chain, so
  // the chain must not claim them:
  //  - `connections.health` and `codebase.index.server.shutdown` are
  //    short-circuited before the route chain by the standalone dispatcher
  //    (`handleConnectionsHealthRoute` / `handleCodebaseIndexServerControl`,
  //    message-dispatcher.ts:349-379).
  //  - `connections.service_action` is handled ONLY by the CLI-embedded
  //    router (`handleConnectionsServiceAction`, embedded-message-router.ts);
  //    the standalone server currently falls through to `onUnknown`
  //    ("Unknown message type") — a known decoder-accepts/dispatcher-rejects
  //    drift that this list keeps visible. Removing the drift (wiring it into
  //    the standalone pre-chain or a route family) requires removing it here.
  // Keeping this list explicit makes these outside-chain hooks load-bearing
  // in this test: moving one of these into a route family fails the parity
  // assertion below until this set is updated.
  const PRE_CHAIN_TYPES = new Set([
    'connections.health',
    'connections.service_action',
    'codebase.index.server.shutdown',
  ]);

  it('dispatches every registered client type without "Unknown message type"', async () => {
    const unhandled: string[] = [];
    const ws = { readyState: 1, send: vi.fn(), on: vi.fn() } as unknown as WebSocket;
    const dispatch = createRouteFamilyDispatcher({
      routes: {
        shellGit: stubTable(),
        mailbox: stubTable(),
        mcp: stubTable(),
        provider: stubTable(),
        session: stubTable(),
        project: stubTable(),
        mode: stubTable(),
        prefs: stubTable(),
        brain: stubTable(),
        worklist: stubTable(),
        process: stubTable(),
        host: stubTable(),
        clientTransport: stubTable(),
        conversation: stubTable(),
        completion: stubTable(),
        autonomy: stubTable(),
        goalSnapshot: stubTable(),
        goal: stubTable(),
        specs: stubTable(),
        sddBoard: stubTable(),
        sddWizard: stubTable(),
        // WorktreeRouteHandlers.handleMessage returns Promise<boolean> and
        // handleWorktreeRoute returns that value directly (worktree-routes.ts),
        // so the stub must resolve `true` or the claim is dropped.
        worktree: { handleMessage: vi.fn(async () => true) },
        kanbanHost: stubTable(),
        agentRoster: stubTable(),
      } as unknown as RouteFamilyTable,
      memory: {
        getMemoryStore: () => undefined,
        send: vi.fn(),
        sendResult: vi.fn(),
      } as never,
      content: {
        getProjectRoot: () => '',
        getSkillsContext: () => ({ skillLoader: undefined }),
        getPromptsContext: () => ({ promptLoader: undefined }),
        getDesignContext: () => ({ projectRoot: '', agentMeta: undefined }),
        onFileWritten: undefined,
      } as never,
      chronicle: {
        getProjectRoot: () => '',
        send: vi.fn(),
        getChronicleAccess: () => ({
          mode: 'inline',
          call: async () => ({ ok: true, refreshed: false, data: [] }),
        }),
      } as never,
      introspection: {
        agent: {
          ctx: {
            provider: { id: 'test-provider' },
            model: 'test-model',
            tokenCounter: { total: () => 0, cacheStats: () => ({}) },
            messages: [],
            readFiles: new Set<string>(),
            sideEffects: [],
            todos: [],
          },
          tools: { list: () => [] },
        },
        modelsRegistry: undefined,
        getConfig: () => ({ features: {} }),
        getProjectRoot: () => '',
        getSessionId: () => 'test-session',
        getSessionStartedAt: () => 0,
        getModeId: () => 'default',
        send: vi.fn(),
      } as unknown as IntrospectionRouteContext,
      getKanbanContext: () => ({ projectRoot: '' }),
      onUnknown: (_socket, message) => {
        unhandled.push(message.type);
      },
    });

    for (const type of CLIENT_MESSAGE_TYPES) {
      await dispatch(ws, { type });
    }

    // Every registry entry must reach a handler. The only types the chain
    // leaves unclaimed are the pre-chain short-circuits listed above —
    // anything else falling through here means the decoder accepts a
    // message the dispatcher rejects (the model.fallback_choice
    // regression), which a decode-only contract test cannot catch.
    expect([...unhandled].sort()).toEqual([...PRE_CHAIN_TYPES].sort());
  });
});
