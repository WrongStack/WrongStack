import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WrongStackWebSocketClient } from '../../src/lib/ws-client';
import { DEFAULT_LANE_ID, useChatLanes } from '../../src/stores/chat-lanes';
import {
  SESSION_DEFAULT_LANE_ID,
  setActiveSessionLane,
  useSessionLanes,
} from '../../src/stores/session-lanes';

/**
 * The client exposes ~50 one-line methods that translate a call-site
 * signature into a wire frame. They are the bulk of the file's uncovered
 * surface and are pure translation — asserted here by spying on `send`
 * rather than standing up a socket.
 */

const URL = 'ws://127.0.0.1:3457';

let client: WrongStackWebSocketClient;
let send: ReturnType<typeof vi.spyOn>;

/** The single frame the last call produced. */
function frame(): Record<string, unknown> {
  expect(send).toHaveBeenCalledTimes(1);
  return send.mock.calls[0]![0] as Record<string, unknown>;
}

beforeEach(() => {
  useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
  useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
  client = new WrongStackWebSocketClient(URL);
  send = vi.spyOn(client, 'send').mockReturnValue(true);
});

// ── provider / model / key management ───────────────────────────────────────

describe('provider and key management', () => {
  it.each([
    ['listProviders', 'providers.list'],
    ['listSavedProviders', 'providers.saved'],
  ] as Array<[keyof WrongStackWebSocketClient, string]>)('%s sends %s', (method, type) => {
    (client[method] as () => void)();
    expect(frame()).toEqual({ type });
  });

  it('getPrefs names the session it is asking about', () => {
    // The session-scoped half of the snapshot lives on that session's meta —
    // an untagged ask is answered about whichever session the runtime is on,
    // which is a different tab from the asking one as often as not.
    client.getPrefs('tab-2');
    expect(frame()).toEqual({ type: 'prefs.get', payload: { sessionId: 'tab-2' } });
  });

  it('getPrefs stays untagged when there is no session yet', () => {
    client.getPrefs();
    expect(frame()).toEqual({ type: 'prefs.get', payload: {} });
  });

  it('listProviderModels keys by providerId', () => {
    client.listProviderModels('openai');
    expect(frame()).toEqual({ type: 'provider.models', payload: { providerId: 'openai' } });
  });

  it('searchProviderModels omits the limit when not given', () => {
    client.searchProviderModels('gpt');
    expect(frame()).toEqual({ type: 'provider.models.search', payload: { query: 'gpt' } });
  });

  it('searchProviderModels includes an explicit limit', () => {
    client.searchProviderModels('gpt', 10);
    expect(frame()).toEqual({
      type: 'provider.models.search',
      payload: { query: 'gpt', limit: 10 },
    });
  });

  it('searchProviderModels keeps a zero limit', () => {
    client.searchProviderModels('gpt', 0);
    expect(frame()).toMatchObject({ payload: { limit: 0 } });
  });

  it.each([
    ['addKey', 'key.add'],
    ['updateKey', 'key.update'],
  ] as Array<[keyof WrongStackWebSocketClient, string]>)(
    '%s carries the secret',
    (method, type) => {
      (client[method] as (a: string, b: string, c: string) => void)('openai', 'work', 'sk-1');
      expect(frame()).toEqual({
        type,
        payload: { providerId: 'openai', label: 'work', apiKey: 'sk-1' },
      });
    },
  );

  it.each([
    ['deleteKey', 'key.delete'],
    ['setActiveKey', 'key.set_active'],
  ] as Array<[keyof WrongStackWebSocketClient, string]>)('%s keys by label', (method, type) => {
    (client[method] as (a: string, b: string) => void)('openai', 'work');
    expect(frame()).toEqual({ type, payload: { providerId: 'openai', label: 'work' } });
  });

  it('removeProvider keys by providerId', () => {
    client.removeProvider('openai');
    expect(frame()).toEqual({ type: 'provider.remove', payload: { providerId: 'openai' } });
  });

  describe('addProvider', () => {
    it('sends the required fields with undefined placeholders', () => {
      client.addProvider('acme', 'openai');
      expect(frame()).toEqual({
        type: 'provider.add',
        payload: { id: 'acme', family: 'openai', baseUrl: undefined, apiKey: undefined },
      });
    });

    it('includes baseUrl and apiKey when given', () => {
      client.addProvider('acme', 'openai', 'https://api.acme.test', 'sk-1');
      expect(frame()).toMatchObject({
        payload: { baseUrl: 'https://api.acme.test', apiKey: 'sk-1' },
      });
    });

    it('includes the model allowlist only when non-empty', () => {
      client.addProvider('acme', 'openai', undefined, undefined, ['m1']);
      expect(frame()).toMatchObject({ payload: { models: ['m1'] } });
    });

    it('still sends an empty model list — [] is truthy, so the guard lets it through', () => {
      // `...(models ? { models } : {})` keeps `[]` because an empty array is
      // truthy. Only `undefined` drops the key. Pinned so a future switch to
      // `models?.length` is a deliberate wire change, not an accident.
      client.addProvider('acme', 'openai', undefined, undefined, []);
      expect(frame()).toMatchObject({ payload: { models: [] } });
    });

    it('includes customModels when given', () => {
      const customModels = { m1: { contextWindow: 1000 } } as never;
      client.addProvider('acme', 'openai', undefined, undefined, undefined, customModels);
      expect(frame()).toMatchObject({ payload: { customModels } });
    });
  });

  it('probeProvider omits the timeout when not given', () => {
    client.probeProvider('openai');
    expect(frame()).toEqual({ type: 'provider.probe', payload: { providerId: 'openai' } });
  });

  it('probeProvider includes an explicit timeout', () => {
    client.probeProvider('openai', 5_000);
    expect(frame()).toEqual({
      type: 'provider.probe',
      payload: { providerId: 'openai', timeoutMs: 5_000 },
    });
  });

  it('probeProvider keeps a zero timeout', () => {
    client.probeProvider('openai', 0);
    expect(frame()).toMatchObject({ payload: { timeoutMs: 0 } });
  });

  it('clearProviderModels delegates to the shared builder', () => {
    client.clearProviderModels('ollama');
    expect(frame()).toEqual({
      type: 'provider.clear_models',
      payload: { providerId: 'ollama' },
    });
  });

  it('undoProviderClear restores the previous allowlist', () => {
    client.undoProviderClear('ollama', ['a', 'b']);
    expect(frame()).toEqual({
      type: 'provider.undo_clear',
      payload: { providerId: 'ollama', previousModels: ['a', 'b'] },
    });
  });

  it('updateProvider delegates to the shared builder', () => {
    client.updateProvider({ id: 'acme', family: 'openai' });
    expect(frame()).toMatchObject({ type: 'provider.update' });
  });
});

// ── OAuth ───────────────────────────────────────────────────────────────────

describe('subscription OAuth', () => {
  it.each(['chatgpt', 'claude', 'copilot'] as const)('startOAuth for %s', (kind) => {
    client.startOAuth(kind);
    expect(frame()).toEqual({ type: 'auth.oauth.start', payload: { kind } });
  });

  it('startOAuth includes an explicit providerId', () => {
    client.startOAuth('claude', 'anthropic-sub');
    expect(frame()).toEqual({
      type: 'auth.oauth.start',
      payload: { kind: 'claude', providerId: 'anthropic-sub' },
    });
  });

  it('startOAuth treats an empty providerId as absent', () => {
    client.startOAuth('claude', '');
    expect(frame()).toEqual({ type: 'auth.oauth.start', payload: { kind: 'claude' } });
  });

  it('submitOAuthCode carries the pasted input', () => {
    client.submitOAuthCode('chatgpt', 'code-123');
    expect(frame()).toEqual({
      type: 'auth.oauth.code',
      payload: { kind: 'chatgpt', input: 'code-123' },
    });
  });

  it('cancelOAuth keys by kind', () => {
    client.cancelOAuth('copilot');
    expect(frame()).toEqual({ type: 'auth.oauth.cancel', payload: { kind: 'copilot' } });
  });
});

// ── context ─────────────────────────────────────────────────────────────────

describe('context management', () => {
  it.each([
    ['clearContext', 'context.clear'],
    ['repairContext', 'context.repair'],
    ['openContextEditor', 'context.editor.open'],
    ['listContextModes', 'context.modes.list'],
  ] as Array<[keyof WrongStackWebSocketClient, string]>)(
    '%s sends a session-scoped %s',
    (method, type) => {
      (client[method] as () => void)();
      expect(frame()).toMatchObject({ type });
    },
  );

  it('compactContext defaults aggressive to false', () => {
    client.compactContext();
    expect(frame()).toMatchObject({ type: 'context.compact', payload: { aggressive: false } });
  });

  it('compactContext honours an explicit aggressive flag', () => {
    client.compactContext(true);
    expect(frame()).toMatchObject({ payload: { aggressive: true } });
  });

  it('debugContext forwards send options', () => {
    const options = { echoToChat: false } as never;
    client.debugContext(options);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'context.debug' }), options);
  });

  it.each([
    ['validateContextEditor', 'context.editor.validate'],
    ['applyContextEditor', 'context.editor.apply'],
  ] as Array<[keyof WrongStackWebSocketClient, string]>)(
    '%s carries the edit set',
    (method, type) => {
      const messages = [{ role: 'user', content: 'hi' }] as never;
      const removals: never[] = [];
      (client[method] as (a: string, b: unknown, c: unknown[], d: boolean) => void)(
        'rev-1',
        messages,
        removals,
        true,
      );
      expect(frame()).toMatchObject({
        type,
        payload: { baseRevision: 'rev-1', messages, removals, allowRepair: true },
      });
    },
  );

  it('switchContextMode keys by id', () => {
    client.switchContextMode('lean');
    expect(frame()).toMatchObject({ type: 'context.mode.switch', payload: { id: 'lean' } });
  });

  it('deleteContextMode keys by id', () => {
    client.deleteContextMode('lean');
    expect(frame()).toMatchObject({ type: 'context.mode.delete', payload: { id: 'lean' } });
  });

  it('createContextMode forwards the whole definition', () => {
    const mode = {
      id: 'tight',
      name: 'Tight',
      description: 'small window',
      thresholds: { warn: 0.6, soft: 0.7, hard: 0.8 },
      preserveK: 4,
      eliseThreshold: 0.5,
    };
    client.createContextMode(mode);
    expect(frame()).toMatchObject({ type: 'context.mode.create', payload: mode });
  });

  it('updateContextMode flattens the patch alongside the id', () => {
    client.updateContextMode('tight', { name: 'Tighter', preserveK: 2 });
    expect(frame()).toMatchObject({
      type: 'context.mode.update',
      payload: { id: 'tight', name: 'Tighter', preserveK: 2 },
    });
  });

  it('updateContextMode accepts a partial thresholds object', () => {
    client.updateContextMode('tight', { thresholds: { hard: 0.95 } });
    expect(frame()).toMatchObject({ payload: { thresholds: { hard: 0.95 } } });
  });
});

// ── git / provider status / autonomy ────────────────────────────────────────

describe('git and status requests', () => {
  it.each([
    ['getGitInfo', 'git.info'],
    ['getGitChanges', 'git.changes'],
    ['getProviderStatus', 'provider.status.get'],
  ] as Array<[keyof WrongStackWebSocketClient, string]>)('%s sends %s', (method, type) => {
    (client[method] as () => void)();
    expect(frame()).toMatchObject({ type });
  });

  it('getGitDiff keys by path', () => {
    client.getGitDiff('src/a.ts');
    expect(frame()).toMatchObject({ type: 'git.diff', payload: { path: 'src/a.ts' } });
  });

  it('retryProviderModel keys by provider and model', () => {
    client.retryProviderModel('anthropic', 'opus');
    expect(frame()).toMatchObject({
      type: 'provider.status.retry',
      payload: { providerId: 'anthropic', model: 'opus' },
    });
  });

  it('clearProviderStatus keys by provider and model', () => {
    client.clearProviderStatus('anthropic', 'opus');
    expect(frame()).toMatchObject({ payload: { providerId: 'anthropic', model: 'opus' } });
  });
});

describe('autonomy and preferences', () => {
  it('switchAutonomy carries the mode', () => {
    client.switchAutonomy('eternal');
    expect(frame()).toEqual({ type: 'autonomy.switch', payload: { mode: 'eternal' } });
  });

  it('updatePrefs forwards the patch verbatim', () => {
    client.updatePrefs({ yolo: true, maxIterations: 20 });
    expect(frame()).toEqual({
      type: 'prefs.update',
      payload: { yolo: true, maxIterations: 20 },
    });
  });

  it('updatePrefs accepts an empty patch', () => {
    client.updatePrefs({});
    expect(frame()).toEqual({ type: 'prefs.update', payload: {} });
  });
});

// ── confirm ─────────────────────────────────────────────────────────────────

describe('sendConfirm', () => {
  it.each(['yes', 'no', 'always', 'deny'] as const)('forwards the %s decision', (decision) => {
    client.sendConfirm('c1', decision);
    expect(frame()).toMatchObject({ payload: expect.objectContaining({ id: 'c1', decision }) });
  });
});

// ── foreground send routing ─────────────────────────────────────────────────

describe('foreground send routing', () => {
  it('stamps user messages from the foreground lane before session.start lands', () => {
    setActiveSessionLane('sess-front');

    client.sendMessage('hello');

    expect(frame()).toMatchObject({
      type: 'user_message',
      payload: { sessionId: 'sess-front', content: 'hello' },
    });
  });

  it('stamps aborts and mailbox sends with the foreground lane', () => {
    setActiveSessionLane('sess-front');

    client.sendAbort();
    expect(frame()).toMatchObject({ type: 'abort', payload: { sessionId: 'sess-front' } });

    send.mockClear();
    client.sendMailboxMessage({
      type: 'btw',
      to: 'leader',
      subject: 'note',
      body: 'keep going',
    });

    expect(frame()).toMatchObject({
      type: 'mailbox.send',
      payload: { sessionId: 'sess-front', body: 'keep going' },
    });
  });

  it('honours explicit background-session overrides', () => {
    setActiveSessionLane('sess-front');

    client.sendAbort('sess-background');
    expect(frame()).toMatchObject({ type: 'abort', payload: { sessionId: 'sess-background' } });
  });
});

// ── lifecycle ───────────────────────────────────────────────────────────────

describe('disconnect', () => {
  it('reports not-connected with no socket', () => {
    expect(client.isConnected).toBe(false);
  });

  it('exposes a null session id before any session starts', () => {
    expect(client.currentSessionId).toBeNull();
  });

  it('is safe to call with no socket open', () => {
    expect(() => client.disconnect()).not.toThrow();
    expect(client.isConnected).toBe(false);
  });

  it('closes the socket and drops the reference', () => {
    const close = vi.fn();
    (client as unknown as { ws: unknown }).ws = { close, readyState: 1 };
    client.disconnect();
    expect(close).toHaveBeenCalled();
    expect((client as unknown as { ws: unknown }).ws).toBeNull();
  });

  it('clears any pending reconnect timer', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    (client as unknown as { reconnectTimer: unknown }).reconnectTimer = setTimeout(
      () => undefined,
      10_000,
    );
    client.disconnect();
    expect(clearSpy).toHaveBeenCalled();
    expect((client as unknown as { reconnectTimer: unknown }).reconnectTimer).toBeNull();
  });

  it('drops the outbound queue — replaying stale frames after a reconnect is worse than losing them', () => {
    const internals = client as unknown as {
      messageQueue: unknown[];
      pendingSwapTarget: string | null;
      requestedSwitchSessionId: string | null;
    };
    internals.messageQueue.push({ type: 'user_message' }, { type: 'session.new' });
    internals.pendingSwapTarget = 'sess_pending';
    internals.requestedSwitchSessionId = 'sess_pending';

    client.disconnect();

    expect(internals.messageQueue).toHaveLength(0);
    // The swap died with the socket; a reconnect re-announces from scratch and
    // must not inherit a focus grant nobody is waiting on.
    expect(internals.pendingSwapTarget).toBe(null);
    expect(internals.requestedSwitchSessionId).toBe(null);
  });

  it('stops the reconnect loop', () => {
    client.disconnect();
    expect((client as unknown as { shouldReconnect: boolean }).shouldReconnect).toBe(false);
  });
});
