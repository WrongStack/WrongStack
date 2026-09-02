import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionHandlers, type SessionHandlersContext } from '../src/server/session-handlers.js';

interface SentMessage {
  type: string;
  payload: Record<string, unknown>;
}

function writer(id: string) {
  return {
    id,
    append: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    truncateToCheckpoint: vi.fn(async () => undefined),
  };
}

interface HarnessInput {
  canSwapSessions?: () => boolean;
  compactor?: Record<string, unknown> | undefined;
  getCompactor?: (() => unknown) | undefined;
  store?: Record<string, unknown>;
  customModeStore?: Record<string, unknown>;
  isRunActive?: (id?: string) => boolean;
}

function makeHarness(input: HarnessInput = {}) {
  const current = writer('sess_current');
  let active = current;
  const meta = new Map<string, unknown>([['contextWindowMode', 'balanced']]);
  const context = {
    session: current,
    messages: [],
    provider: { id: 'test-provider', capabilities: { maxContext: 8000 } },
    lastRequestTokens: 999,
    lastRealInputTokens: 888,
    meta,
    systemPrompt: [],
    traceId: 'trace-1',
    state: {
      replaceMessages: vi.fn(),
      replaceTodos: vi.fn(),
      setMeta: vi.fn((key: string, value: unknown) => meta.set(key, value)),
      deleteMeta: vi.fn((key: string) => meta.delete(key)),
    },
    readFiles: new Set<string>(),
    fileMtimes: new Map<string, number>(),
    clearMemoryEvidence: vi.fn(),
    flushConversationJournal: vi.fn(async () => undefined),
  };
  const tokenCounter = {
    total: vi.fn(() => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 })),
    reset: vi.fn(),
    account: vi.fn(),
  };
  const sent: SentMessage[] = [];
  const broadcasts: SentMessage[] = [];
  const ws = {
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data) as SentMessage),
  };
  const customModeStore =
    input.customModeStore ??
    ({
      list: () => [
        {
          id: 'balanced',
          name: 'Balanced',
          description: 'default',
          thresholds: { warn: 70, soft: 85, hard: 95 },
          preserveK: 6,
          eliseThreshold: 0.5,
        },
        {
          id: 'custom-x',
          name: 'Custom X',
          description: 'user mode',
          thresholds: { warn: 60, soft: 80, hard: 90 },
          preserveK: 4,
          eliseThreshold: 0.3,
          custom: true,
        },
      ],
      create: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    } as Record<string, unknown>);
  const store =
    input.store ??
    ({
      create: vi.fn(async () => writer('sess_created')),
      delete: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      list: vi.fn(async () => [{ id: 'sess_current', title: 'Current', updatedAt: '2026-08-01' }]),
      load: vi.fn(async () => ({
        events: [],
        metadata: { id: 'sess_other', title: 'Other', startedAt: 1, endedAt: 2 },
      })),
      resume: vi.fn(async () => ({
        writer: writer('sess_resumed'),
        data: {
          messages: [],
          usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 },
        },
      })),
    } as Record<string, unknown>);
  const onSessionSwapped = vi.fn(async () => undefined);
  const claimSession = vi.fn(async () => async () => undefined);
  const routes = createSessionHandlers({
    config: { provider: 'test-provider', model: 'test-model' },
    clients: new Map(),
    context: context as never,
    tokenCounter: tokenCounter as never,
    getProjectRoot: () => root,
    getSession: () => active as never,
    getSessionStore: () => store as never,
    canSwapSessions: input.canSwapSessions,
    sessionsDir,
    setSession: (next: unknown) => {
      active = next as typeof current;
    },
    setSessionStartedAt: vi.fn(),
    claimSession,
    onSessionSwapped,
    isRunActive: input.isRunActive ?? (() => false),
    abortActiveRun: vi.fn(),
    sessionStartPayload: async (overrides?: Record<string, unknown>) => ({
      sessionId: active.id,
      model: 'test-model',
      provider: 'test-provider',
      maxContext: 8000,
      ...(overrides ?? {}),
    }),
    sendMessage: (_ws: unknown, message: unknown) => ws.send(JSON.stringify(message)),
    broadcastMessage: (message: unknown) => broadcasts.push(message as SentMessage),
    ...(input.compactor !== undefined ? { compactor: input.compactor as never } : {}),
    ...(input.getCompactor !== undefined ? { getCompactor: input.getCompactor as never } : {}),
    customModeStore: customModeStore as never,
    toolRegistry: { list: () => [] },
  } as never as SessionHandlersContext);

  return {
    routes,
    context,
    tokenCounter,
    ws,
    sent,
    broadcasts,
    meta,
    store,
    customModeStore,
    claimSession,
    onSessionSwapped,
    current: () => active,
  };
}

let root: string;
let sessionsDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sh-gaps-'));
  sessionsDir = path.join(root, 'sessions');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe('createSessionHandlers — context handlers', () => {
  it('rejects requests that target a different session', async () => {
    const h = makeHarness();
    await h.routes.clearContext(h.ws as never, {
      type: 'context.clear',
      payload: { sessionId: 'sess_other' },
    } as never);
    const error = h.sent.find((m) => m.type === 'error');
    expect(error).toBeDefined();
    expect(error?.payload['message']).toContain(
      'Request targeted session sess_other, but this WebUI runtime is currently on sess_current',
    );
  });

  it('clears the context and broadcasts a fresh session start', async () => {
    const h = makeHarness();
    await h.routes.clearContext(h.ws as never, { type: 'context.clear' } as never);
    expect(h.context.state.replaceMessages).toHaveBeenCalledWith([]);
    expect(h.context.state.replaceTodos).toHaveBeenCalledWith([]);
    expect(h.context.state.deleteMeta).toHaveBeenCalledWith('lastRequestTokensAt');
    expect(h.context.clearMemoryEvidence).toHaveBeenCalled();
    expect(h.tokenCounter.reset).toHaveBeenCalled();
    expect(h.sent.some((m) => m.type === 'key.operation_result' && m.payload['success'] === true)).toBe(true);
    expect(h.broadcasts.some((m) => m.type === 'session.start')).toBe(true);
  });

  it('reports the context breakdown with the active mode', async () => {
    const h = makeHarness();
    await h.routes.debugContext(h.ws as never, { type: 'context.debug' } as never);
    const debug = h.sent.find((m) => m.type === 'context.debug');
    expect(debug).toBeDefined();
    expect(debug?.payload['sessionId']).toBe('sess_current');
    expect(debug?.payload['mode']).toBe('balanced');
  });

  it('reports a missing compactor without failing', async () => {
    const h = makeHarness({ compactor: undefined, getCompactor: () => undefined });
    await h.routes.compactContext(h.ws as never, { type: 'context.compact' } as never);
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['success']).toBe(false);
    expect(res?.payload['message']).toBe('Compactor not available');
  });

  it('compacts and reports saved tokens, preferring the report numbers', async () => {
    const compact = vi.fn(async () => ({
      before: 100,
      after: 40,
      reductions: [{ kind: 'elision' }],
      repaired: true,
    }));
    const h = makeHarness({ compactor: { compact } });
    await h.routes.compactContext(h.ws as never, {
      type: 'context.compact',
      payload: { aggressive: true },
    } as never);
    expect(compact).toHaveBeenCalledWith(expect.anything(), { aggressive: true });
    const compacted = h.sent.find((m) => m.type === 'context.compacted');
    expect(compacted?.payload).toMatchObject({ before: 100, after: 40, saved: 60, repaired: true });
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['message']).toContain('Compacted: 100 → 40 tokens');
  });

  it('falls back to token-counter totals when the report omits numbers', async () => {
    const compact = vi.fn(async () => ({ reductions: [] }));
    const h = makeHarness({ compactor: { compact } });
    await h.routes.compactContext(h.ws as never, { type: 'context.compact' } as never);
    const compacted = h.sent.find((m) => m.type === 'context.compacted');
    // total() = input 10 + output 5 on both sides → saved 0.
    expect(compacted?.payload).toMatchObject({ before: 15, after: 15, saved: 0 });
  });

  it('surfaces compactor failures as a failed operation result', async () => {
    const h = makeHarness({
      compactor: {
        compact: async () => {
          throw new Error('compactor exploded');
        },
      },
    });
    await h.routes.compactContext(h.ws as never, { type: 'context.compact' } as never);
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['success']).toBe(false);
    expect(res?.payload['message']).toContain('compactor exploded');
  });

  it('repairs context and reports when nothing was orphaned', async () => {
    const h = makeHarness();
    await h.routes.repairContext(h.ws as never, { type: 'context.repair' } as never);
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['message']).toContain('found no orphan protocol blocks');
    expect(h.broadcasts.some((m) => m.type === 'context.repaired')).toBe(true);
  });

  it('validates context editor proposals with a typed validation payload', async () => {
    const h = makeHarness();
    await h.routes.validateContextEditor(h.ws as never, {
      type: 'context.editor.validate',
      payload: { baseRevision: 'not-a-real-revision', messages: [], removals: [] },
    } as never);
    const validation = h.sent.find((m) => m.type === 'context.editor.validation');
    expect(validation).toBeDefined();
    expect(validation?.payload['sessionId']).toBe('sess_current');
  });
});

describe('createSessionHandlers — context mode handlers', () => {
  it('lists modes with the active flag and custom marker', async () => {
    const h = makeHarness();
    await h.routes.listContextModes(h.ws as never, { type: 'context.modes.list' } as never);
    const list = h.sent.find((m) => m.type === 'context.modes.list');
    expect(list?.payload['activeId']).toBe('balanced');
    const modes = list?.payload['modes'] as Array<Record<string, unknown>>;
    expect(modes).toHaveLength(2);
    expect(modes[0]).toMatchObject({ id: 'balanced', isActive: true, custom: false });
    expect(modes[1]).toMatchObject({ id: 'custom-x', isActive: false, custom: true });
  });

  it('rejects mode switches with an invalid payload', async () => {
    const h = makeHarness();
    await h.routes.switchContextMode(h.ws as never, {
      type: 'context.mode.switch',
      payload: { nope: true },
    } as never);
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['success']).toBe(false);
    expect(String(res?.payload['message'])).toContain('context.mode.switch');
  });

  it('switches to a valid mode and resolves the policy', async () => {
    const h = makeHarness();
    await h.routes.switchContextMode(h.ws as never, {
      type: 'context.mode.switch',
      payload: { id: 'frugal' },
    } as never);
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['success']).toBe(true);
    expect(res?.payload['message']).toBe('Context mode switched to frugal');
    // The handler assigns plain properties on the meta object (not Map keys).
    const metaProps = h.meta as unknown as Record<string, unknown>;
    expect(metaProps['contextWindowMode']).toBe('frugal');
    expect(metaProps['contextWindowPolicy']).toMatchObject({ id: 'frugal' });
    expect(metaProps['contextWindowModePinned']).toBe(true);
    expect(h.broadcasts.some((m) => m.type === 'context.mode.changed')).toBe(true);
  });

  it('rejects custom mode CRUD with malformed payloads', async () => {
    const h = makeHarness();
    await h.routes.createContextMode(h.ws as never, {
      type: 'context.mode.create',
      payload: { id: '' },
    } as never);
    expect(h.sent.some((m) => m.type === 'key.operation_result' && m.payload['success'] === false)).toBe(true);

    await h.routes.updateContextMode(h.ws as never, {
      type: 'context.mode.update',
      payload: 'garbage',
    } as never);
    const failures = h.sent.filter(
      (m) => m.type === 'key.operation_result' && m.payload['success'] === false,
    );
    expect(failures.length).toBeGreaterThanOrEqual(2);

    await h.routes.deleteContextMode(h.ws as never, {
      type: 'context.mode.delete',
      payload: {},
    } as never);
    expect(
      h.sent.filter((m) => m.type === 'key.operation_result' && m.payload['success'] === false).length,
    ).toBeGreaterThanOrEqual(3);
  });
});

describe('createSessionHandlers — session list, rename, delete', () => {
  it('lists sessions and tolerates store failures', async () => {
    const h = makeHarness();
    await h.routes.listSessions(h.ws as never, { type: 'sessions.list' } as never);
    const ok = h.sent.find((m) => m.type === 'sessions.list');
    expect(Array.isArray(ok?.payload['sessions'])).toBe(true);

    const broken = makeHarness({
      store: { list: async () => { throw new Error('store down'); } },
    });
    await broken.routes.listSessions(broken.ws as never, { type: 'sessions.list' } as never);
    const err = broken.sent.find((m) => m.type === 'sessions.list');
    expect(err?.payload['error']).toContain('store down');
  });

  it('requires a session id for renames', async () => {
    const h = makeHarness();
    await h.routes.renameSession(h.ws as never, {
      type: 'session.rename',
      payload: { name: 'no id' },
    } as never);
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['message']).toBe('Session id is required');
  });

  it('renames and broadcasts the refreshed list', async () => {
    const h = makeHarness();
    await h.routes.renameSession(h.ws as never, {
      type: 'session.rename',
      payload: { id: 'sess_current', name: 'Fresh Name' },
    } as never);
    expect(h.store['rename']).toHaveBeenCalledWith('sess_current', 'Fresh Name');
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['message']).toBe('Renamed session to "Fresh Name"');
    expect(h.broadcasts.some((m) => m.type === 'sessions.list')).toBe(true);

    await h.routes.renameSession(h.ws as never, {
      type: 'session.rename',
      payload: { id: 'sess_current', name: '' },
    } as never);
    const cleared = h.sent.filter((m) => m.type === 'key.operation_result').at(-1);
    expect(cleared?.payload['message']).toBe('Cleared session name');
  });

  it('surfaces rename failures', async () => {
    const h = makeHarness({
      store: { rename: async () => { throw new Error('readonly store'); } },
    });
    await h.routes.renameSession(h.ws as never, {
      type: 'session.rename',
      payload: { id: 'x', name: 'y' },
    } as never);
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['success']).toBe(false);
    expect(res?.payload['message']).toContain('readonly store');
  });

  it('deletes a session and refreshes the list broadcast', async () => {
    const h = makeHarness();
    await h.routes.deleteSession(h.ws as never, {
      type: 'session.delete',
      payload: { id: 'sess_other' },
    } as never);
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['success']).toBe(true);
    expect(res?.payload['message']).toBe('Session sess_other deleted');
    expect(h.broadcasts.some((m) => m.type === 'sessions.list')).toBe(true);
  });

  it('reports deletion failures', async () => {
    const h = makeHarness({
      store: {
        list: async () => [],
        delete: async () => {
          throw new Error('cannot delete');
        },
      },
    });
    await h.routes.deleteSession(h.ws as never, {
      type: 'session.delete',
      payload: { id: 'sess_other' },
    } as never);
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['success']).toBe(false);
    expect(res?.payload['message']).toContain('cannot delete');
  });
});

describe('createSessionHandlers — resume, save, inspect', () => {
  it('refuses to resume when session swapping is unavailable', async () => {
    const h = makeHarness({ canSwapSessions: () => false });
    await h.routes.resumeSession(h.ws as never, {
      type: 'session.resume',
      payload: { id: 'sess_other' },
    } as never);
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['message']).toBe('Session store not available');
  });

  it('refuses to resume the already-active session', async () => {
    const h = makeHarness();
    await h.routes.resumeSession(h.ws as never, {
      type: 'session.resume',
      payload: { id: 'sess_current' },
    } as never);
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['message']).toBe('Session is already active');
  });

  it('resumes a session, restores todos, and broadcasts the replay payload', async () => {
    const h = makeHarness();
    await h.routes.resumeSession(h.ws as never, {
      type: 'session.resume',
      payload: { id: 'sess_resumed' },
    } as never);
    expect(h.current().id).toBe('sess_resumed');
    expect(h.context.session).toBe(h.current());
    expect(h.claimSession).toHaveBeenCalledWith('sess_resumed');
    expect(h.onSessionSwapped).toHaveBeenCalledWith('sess_resumed');
    expect(h.broadcasts.some((m) => m.type === 'session.start')).toBe(true);
    expect(h.broadcasts.some((m) => m.type === 'todos.updated')).toBe(true);
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['message']).toBe('Resumed session sess_resumed');
  });

  it('rolls back the claim when resuming fails', async () => {
    const release = vi.fn(async () => undefined);
    const h = makeHarness({
      store: {
        resume: async () => {
          throw new Error('corrupt session file');
        },
      },
    });
    h.claimSession.mockImplementation(async () => release);
    await h.routes.resumeSession(h.ws as never, {
      type: 'session.resume',
      payload: { id: 'sess_broken' },
    } as never);
    expect(release).toHaveBeenCalled();
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['success']).toBe(false);
    expect(res?.payload['message']).toContain('corrupt session file');
  });

  it('confirms sessions are auto-saved', async () => {
    const h = makeHarness();
    await h.routes.saveSession(h.ws as never, { type: 'session.save' } as never);
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['message']).toBe('Session sess_current is auto-saved');
  });

  it('requires an id for inspection and reports load failures', async () => {
    const h = makeHarness();
    await h.routes.inspectSession(h.ws as never, {
      type: 'session.inspect',
      payload: { id: '' },
    } as never);
    expect(h.sent.find((m) => m.type === 'session.inspect')?.payload['error']).toBe(
      'Session id is required',
    );

    const broken = makeHarness({
      store: { list: async () => [], load: async () => { throw new Error('ENOENT'); } },
    });
    await broken.routes.inspectSession(broken.ws as never, {
      type: 'session.inspect',
      payload: { id: 'missing' },
    } as never);
    expect(broken.sent.find((m) => m.type === 'session.inspect')?.payload['error']).toContain('ENOENT');
  });

  it('inspects a session with its metadata', async () => {
    const h = makeHarness();
    await h.routes.inspectSession(h.ws as never, {
      type: 'session.inspect',
      payload: { id: 'sess_other' },
    } as never);
    const payload = h.sent.find((m) => m.type === 'session.inspect')?.payload;
    expect(payload?.['error']).toBeUndefined();
    expect(payload?.['id']).toBe('sess_other');
  });
});

describe('createSessionHandlers — checkpoints and rewind', () => {
  it('lists checkpoints (empty for a fresh directory)', async () => {
    const h = makeHarness();
    await h.routes.listCheckpoints(h.ws as never, {
      type: 'session.checkpoints',
      payload: {},
    } as never);
    const message = h.sent.find((m) => m.type === 'session.checkpoints');
    expect(message).toBeDefined();
    const checkpoints = (message as SentMessage).payload['checkpoints'];
    expect(Array.isArray(checkpoints)).toBe(true);
    expect((checkpoints as unknown[]).length).toBe(0);
  });

  it('reports rewind failures for unknown checkpoints', async () => {
    const h = makeHarness();
    await h.routes.rewindSession(h.ws as never, {
      type: 'session.rewind',
      payload: { checkpointIndex: 3 },
    } as never);
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['success']).toBe(false);
  });

  // Rewind truncates the session journal AND reverts project files, so it
  // must refuse while the target session has a live run — the same
  // destructive window `session.delete` refuses. Regression for the
  // round-11 guard: pre-fix, a rewind under an active run reported success
  // while truncating the journal and reverting files under the writer.
  it('refuses to rewind while the session has an active run', async () => {
    const h = makeHarness({ isRunActive: (id) => id === 'sess_current' });
    // Seed a real journal so a guard-less rewind would have destructive work
    // to do: the refusal must come from the run guard, not an empty journal.
    const live = await new DefaultSessionStore({ dir: sessionsDir }).create({
      id: 'sess_current',
      title: '',
      model: 'test-model',
      provider: 'test-provider',
    });
    await live.writeCheckpoint(0, 'first prompt');
    await live.writeFileSnapshot(0, []);
    await live.writeCheckpoint(1, 'second prompt');
    await live.flush();
    await h.routes.rewindSession(h.ws as never, {
      type: 'session.rewind',
      payload: { checkpointIndex: 0 },
    } as never);
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['success']).toBe(false);
    expect(res?.payload['message']).toBe(
      'Cannot rewind while an agent run is active. Please stop the run first.',
    );
    expect(h.context.session.truncateToCheckpoint).not.toHaveBeenCalled();
    expect(h.context.state.replaceMessages).not.toHaveBeenCalled();
    const journal = await fs.readFile(path.join(sessionsDir, 'sess_current.jsonl'), 'utf8');
    expect(journal).toContain('"promptIndex":1');
  });

  it('still rewinds when no run is active', async () => {
    const h = makeHarness();
    const live = await new DefaultSessionStore({ dir: sessionsDir }).create({
      id: 'sess_current',
      title: '',
      model: 'test-model',
      provider: 'test-provider',
    });
    await live.writeCheckpoint(0, 'first prompt');
    await live.writeFileSnapshot(0, []);
    await live.writeCheckpoint(1, 'second prompt');
    await live.flush();
    await h.routes.rewindSession(h.ws as never, {
      type: 'session.rewind',
      payload: { checkpointIndex: 0 },
    } as never);
    const res = h.sent.find((m) => m.type === 'key.operation_result');
    expect(res?.payload['success']).toBe(true);
    expect(h.context.session.truncateToCheckpoint).toHaveBeenCalled();
    expect(h.context.state.replaceMessages).toHaveBeenCalled();
  });
});
