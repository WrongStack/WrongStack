import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  handlePrefsGet,
  handlePrefsUpdate,
  type PrefsHandlerContext,
  SESSION_SCOPED_PREF_KEYS,
} from '../src/server/prefs-handlers.js';
import type { WSServerMessage } from '../src/server/types.js';

/**
 * Preferences are answered and echoed PER SESSION.
 *
 * The server already stored the session-scoped keys on the asking session's
 * context meta, but both replies were session-blind: `prefs.get` answered from
 * whichever session the runtime happened to be on, and `prefs.update`
 * broadcast one untagged snapshot to every connected tab. With four tabs on
 * one page that is a direct cross-tab write — tab 2 turning on YOLO flipped
 * the switch tab 1 was looking at.
 */

const ws = {} as WebSocket;

/** Read a captured frame's payload as a plain bag. */
function payloadOf(message: WSServerMessage | undefined): Record<string, unknown> {
  return (message?.payload ?? {}) as Record<string, unknown>;
}

function makeContext() {
  const metas = new Map<string, Record<string, unknown>>();
  const shared: Record<string, unknown> = {};
  const sent: WSServerMessage[] = [];
  const broadcasts: WSServerMessage[] = [];
  const metaFor = (sessionId?: string): Record<string, unknown> => {
    if (!sessionId) return shared;
    let m = metas.get(sessionId);
    if (!m) {
      m = {};
      metas.set(sessionId, m);
    }
    return m;
  };
  const context: PrefsHandlerContext = {
    meta: shared,
    metaFor,
    // Mirrors the real wiring in `routes.ts`: a snapshot for one session is
    // that session's meta, not the runtime's.
    snapshot: (sessionId?: string) => ({ ...shared, ...(sessionId ? metaFor(sessionId) : {}) }),
    persist: vi.fn(async () => {}),
    pendingConfirms: new Map(),
    configStore: { update: vi.fn() } as never,
    setYolo: vi.fn(),
    setAutonomy: vi.fn(),
    applyConfigPrefs: vi.fn(),
    setAutoCompact: vi.fn(),
    setLogLevel: vi.fn(),
    send: (_socket, message) => sent.push(message),
    broadcast: (message) => broadcasts.push(message),
  };
  return { context, metas, shared, sent, broadcasts };
}

describe('prefs.get is answered for the asking session', () => {
  it('stamps the reply so the browser can file it under the right tab', () => {
    const { context, metas, sent } = makeContext();
    metas.set('tab-2', { autonomy: 'eternal' });

    handlePrefsGet(context, ws, 'tab-2');

    expect(sent).toHaveLength(1);
    const payload = sent[0]?.payload as Record<string, unknown>;
    expect(payload['autonomy']).toBe('eternal');
    expect(payload['sessionId']).toBe('tab-2');
  });

  it('answers about that session, not the one the runtime is on', () => {
    const { context, metas, sent } = makeContext();
    metas.set('tab-1', { autonomy: 'eternal' });
    metas.set('tab-2', { autonomy: 'off' });

    handlePrefsGet(context, ws, 'tab-2');

    expect(payloadOf(sent[0])['autonomy']).toBe('off');
  });

  it('leaves the reply untagged when no session asked (single-session surfaces)', () => {
    const { context, sent } = makeContext();
    handlePrefsGet(context, ws);
    expect(payloadOf(sent[0])['sessionId']).toBeUndefined();
  });
});

describe('prefs.update echoes session-scoped and project-wide keys separately', () => {
  it('addresses the session-scoped half at the tab that set it', async () => {
    const { context, broadcasts } = makeContext();

    await handlePrefsUpdate(context, ws, { yolo: true }, 'tab-2');

    const tagged = broadcasts.filter(
      (b) => (b.payload as Record<string, unknown>)['sessionId'] === 'tab-2',
    );
    expect(tagged).toHaveLength(1);
    expect(payloadOf(tagged[0])['yolo']).toBe(true);

    // …and no untagged broadcast carries it, or every other tab would apply it.
    for (const b of broadcasts) {
      const p = b.payload as Record<string, unknown>;
      if (p['sessionId']) continue;
      expect(p['yolo']).toBeUndefined();
    }
  });

  it('still broadcasts project-wide keys to everyone, untagged', async () => {
    const { context, broadcasts } = makeContext();

    await handlePrefsUpdate(context, ws, { indexOnStart: false }, 'tab-2');

    const untagged = broadcasts.filter((b) => !(b.payload as Record<string, unknown>)['sessionId']);
    expect(untagged.length).toBeGreaterThan(0);
    expect(untagged.some((b) => 'indexOnStart' in (b.payload as Record<string, unknown>))).toBe(
      true,
    );
  });

  it('never splits a key into both halves', async () => {
    const { context, broadcasts } = makeContext();

    await handlePrefsUpdate(context, ws, { yolo: true, indexOnStart: false }, 'tab-2');

    for (const b of broadcasts) {
      const p = b.payload as Record<string, unknown>;
      const scoped = p['sessionId'] !== undefined;
      for (const key of Object.keys(p)) {
        if (key === 'sessionId') continue;
        expect(SESSION_SCOPED_PREF_KEYS.has(key)).toBe(scoped);
      }
    }
  });
});

/**
 * Real-host wiring: `snapshot(sessionId)` reads the ASKING TAB's agent meta —
 * a clone taken when the tab was created (`inheritedSessionMeta`), whose
 * project-wide keys are frozen at creation time. The echo must source those
 * keys from the process-wide meta instead, or the stale copy lands after the
 * fresh value and the browser reverts the edit the user just made (the
 * "favorite/fallback models don't save, no error" report).
 */
function makeSessionCloneContext() {
  const shared: Record<string, unknown> = { favoriteModels: ['prov/old'] };
  const tabMeta: Record<string, unknown> = { favoriteModels: ['prov/old'] };
  const sent: WSServerMessage[] = [];
  const broadcasts: WSServerMessage[] = [];
  const context: PrefsHandlerContext = {
    meta: shared,
    metaFor: (sessionId?: string) => (sessionId === 'tab-2' ? tabMeta : shared),
    snapshot: (sessionId?: string) => ({ ...(sessionId ? tabMeta : shared) }),
    persist: vi.fn(async () => {}),
    pendingConfirms: new Map(),
    configStore: { update: vi.fn() } as never,
    setYolo: vi.fn(),
    setAutonomy: vi.fn(),
    applyConfigPrefs: vi.fn(),
    setAutoCompact: vi.fn(),
    setLogLevel: vi.fn(),
    send: (_socket, message) => sent.push(message),
    broadcast: (message) => broadcasts.push(message),
  };
  return { context, shared, tabMeta, sent, broadcasts };
}

describe('prefs echo reads project-wide keys from the process-wide meta', () => {
  it('prefs.update echoes the value just written, not the tab meta clone', async () => {
    const { context, broadcasts } = makeSessionCloneContext();

    await handlePrefsUpdate(context, ws, { favoriteModels: ['prov/old', 'prov/new'] }, 'tab-2');

    const untagged = broadcasts.filter((b) => !(b.payload as Record<string, unknown>)['sessionId']);
    expect(untagged.length).toBeGreaterThan(0);
    for (const b of untagged) {
      expect(payloadOf(b)['favoriteModels']).toEqual(['prov/old', 'prov/new']);
    }
  });

  it('prefs.get answers with the process-wide value, not the tab meta clone', () => {
    const { context, shared, sent } = makeSessionCloneContext();
    shared['favoriteModels'] = ['prov/old', 'prov/new'];

    handlePrefsGet(context, ws, 'tab-2');

    expect(payloadOf(sent[0])['favoriteModels']).toEqual(['prov/old', 'prov/new']);
    expect(payloadOf(sent[0])['sessionId']).toBe('tab-2');
  });

  it('prefs.get still answers scoped keys from the asking tab', () => {
    const { context, tabMeta, sent } = makeSessionCloneContext();
    tabMeta['autonomy'] = 'eternal';

    handlePrefsGet(context, ws, 'tab-2');

    expect(payloadOf(sent[0])['autonomy']).toBe('eternal');
  });
});
