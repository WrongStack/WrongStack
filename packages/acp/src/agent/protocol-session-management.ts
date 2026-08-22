import type {
  ClientCapabilities,
  ContentBlock,
  RunTurn,
  RunTurnResult,
  SessionConfigOption,
  SessionMode,
  SessionPersistence,
  SessionState,
} from './protocol-contract.js';
import {
  createRunTurnApi,
  DEFAULT_MODE_ID,
  errorToJsonRpc,
  resolveSessionCwd,
} from './protocol-session-ops.js';

export interface ProtocolSessionContext {
  sessions: Map<string, SessionState>;
  maxSessions: number;
  defaultCwd: string;
  modes: readonly SessionMode[];
  configOptions: readonly SessionConfigOption[];
  store: SessionPersistence | undefined;
  replayFor:
    | ((sessionId: string) => Array<{ sessionUpdate: string; content: unknown }>)
    | undefined;
  seedFor:
    | ((sessionId: string, history: Array<{ sessionUpdate: string; content: unknown }>) => void)
    | undefined;
  onSessionNew: (state: SessionState) => void;
  allocId: () => string;
  persist: (
    state: SessionState,
    history?: Array<{ sessionUpdate: string; content: unknown }>,
  ) => Promise<void>;
  sendNotification: (params: unknown) => Promise<void>;
  sendError: (id: string | number, code: number, message: string, data?: unknown) => Promise<void>;
  sendResult: (id: string | number, result: unknown) => Promise<void>;
  request: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;
  runTurn: RunTurn;
  clientCapabilities: ClientCapabilities;
}

export async function handleSessionNewOp(
  ctx: ProtocolSessionContext,
  id: string | number,
  params: unknown,
): Promise<boolean> {
  if (ctx.sessions.size >= ctx.maxSessions) {
    await ctx.sendError(id, -32000, `active session limit reached (${ctx.maxSessions})`);
    return false;
  }
  const p = (params ?? {}) as { cwd?: unknown; mcpServers?: unknown };
  let cwd = ctx.defaultCwd;
  if (typeof p.cwd === 'string') {
    const resolved = await resolveSessionCwd(p.cwd);
    if (resolved === null) {
      await ctx.sendError(id, -32602, `cwd must be an absolute path to an existing directory`);
      return false;
    }
    cwd = resolved;
  }
  const sessionId = `sess_${ctx.allocId()}`;
  const now = new Date().toISOString();
  const state: SessionState = {
    id: sessionId,
    cwd,
    abort: new AbortController(),
    modeId: DEFAULT_MODE_ID,
    createdAt: now,
    updatedAt: now,
  };
  ctx.sessions.set(sessionId, state);
  ctx.onSessionNew(state);
  await ctx.persist(state);

  await ctx.sendNotification({
    sessionId,
    update: {
      sessionUpdate: 'current_mode_update',
      modeId: ctx.modes[0]?.id ?? DEFAULT_MODE_ID,
    },
  });
  if (ctx.configOptions.length > 0) {
    await ctx.sendNotification({
      sessionId,
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [...ctx.configOptions],
      },
    });
  }

  await ctx.sendResult(id, {
    sessionId,
    modes: ctx.modes,
    configOptions: ctx.configOptions,
  });
  return false;
}

export async function handleSessionLoadOp(
  ctx: ProtocolSessionContext,
  id: string | number,
  params: unknown,
): Promise<boolean> {
  const p = (params ?? {}) as { sessionId?: unknown; cwd?: unknown; mcpServers?: unknown };
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
  const loadCwd = typeof p.cwd === 'string' ? p.cwd : undefined;
  const existing = sessionId ? ctx.sessions.get(sessionId) : undefined;

  if (!existing && sessionId && ctx.store) {
    const persisted = await ctx.store.load(sessionId);
    if (persisted) {
      if (ctx.sessions.size >= ctx.maxSessions) {
        await ctx.sendError(id, -32000, `active session limit reached (${ctx.maxSessions})`);
        return false;
      }
      if (loadCwd !== undefined && (await resolveSessionCwd(loadCwd)) === null) {
        await ctx.sendError(id, -32602, `cwd must be an absolute path to an existing directory`);
        return false;
      }
      const candidateCwd = persisted.cwd ?? loadCwd ?? ctx.defaultCwd;
      const restoredCwd = (await resolveSessionCwd(candidateCwd)) ?? ctx.defaultCwd;
      const restored: SessionState = {
        id: sessionId,
        cwd: restoredCwd,
        abort: new AbortController(),
        modeId: persisted.modeId ?? DEFAULT_MODE_ID,
        createdAt: persisted.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(persisted.title !== undefined ? { title: persisted.title } : {}),
      };
      ctx.sessions.set(sessionId, restored);
      ctx.seedFor?.(sessionId, persisted.history ?? []);
      for (const update of persisted.history ?? []) {
        await ctx.sendNotification({ sessionId, update });
      }
      await ctx.sendNotification({
        sessionId,
        update: { sessionUpdate: 'current_mode_update', modeId: restored.modeId },
      });
      await ctx.sendResult(id, {
        initialMode: { currentModeId: restored.modeId, availableModes: ctx.modes },
      });
      return false;
    }
  }

  if (existing) {
    existing.updatedAt = new Date().toISOString();
    const replay = ctx.replayFor?.(sessionId!);
    if (replay) {
      for (const update of replay) {
        await ctx.sendNotification({ sessionId, update });
      }
    }
    await ctx.sendNotification({
      sessionId,
      update: {
        sessionUpdate: 'session_info_update',
        updatedAt: existing.updatedAt,
      },
    });
    await ctx.sendNotification({
      sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        modeId: existing.modeId,
      },
    });
    await ctx.sendResult(id, {
      initialMode: {
        currentModeId: existing.modeId,
        availableModes: ctx.modes,
      },
    });
    return false;
  }

  await ctx.sendError(id, -32000, `session not found: ${sessionId}`);
  return false;
}

export async function handleSessionForkOp(
  ctx: ProtocolSessionContext,
  id: string | number,
  params: unknown,
): Promise<boolean> {
  const p = (params ?? {}) as { sessionId?: unknown; cwd?: unknown; mcpServers?: unknown };
  const sourceId = typeof p.sessionId === 'string' ? p.sessionId : null;
  const source = sourceId ? ctx.sessions.get(sourceId) : undefined;
  if (!sourceId || !source) {
    await ctx.sendError(id, -32000, `session not found: ${sourceId}`);
    return false;
  }
  if (ctx.sessions.size >= ctx.maxSessions) {
    await ctx.sendError(id, -32000, `active session limit reached (${ctx.maxSessions})`);
    return false;
  }

  let forkCwd = source.cwd;
  if (typeof p.cwd === 'string') {
    const resolved = await resolveSessionCwd(p.cwd);
    if (resolved === null) {
      await ctx.sendError(id, -32602, `cwd must be an absolute path to an existing directory`);
      return false;
    }
    forkCwd = resolved;
  }

  const now = new Date().toISOString();
  const sessionId = `sess_${ctx.allocId()}`;
  const forked: SessionState = {
    id: sessionId,
    cwd: forkCwd,
    abort: new AbortController(),
    modeId: source.modeId,
    createdAt: now,
    updatedAt: now,
    ...(source.title !== undefined ? { title: source.title } : {}),
  };
  const history = (ctx.replayFor?.(sourceId) ?? []).map((update) => ({
    sessionUpdate: update.sessionUpdate,
    content: structuredClone(update.content),
  }));
  ctx.sessions.set(sessionId, forked);
  ctx.seedFor?.(sessionId, history);
  ctx.onSessionNew(forked);
  await ctx.persist(forked, history);

  await ctx.sendNotification({
    sessionId,
    update: { sessionUpdate: 'current_mode_update', modeId: forked.modeId },
  });
  await ctx.sendResult(id, {
    sessionId,
    modes: ctx.modes,
    configOptions: ctx.configOptions,
  });
  return false;
}

export async function handleSessionPromptOp(
  ctx: ProtocolSessionContext,
  id: string | number,
  params: unknown,
): Promise<boolean> {
  const p = (params ?? {}) as { sessionId?: unknown; prompt?: unknown };
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
  if (!sessionId || !ctx.sessions.has(sessionId)) {
    await ctx.sendError(id, -32000, 'unknown or missing sessionId');
    return false;
  }
  if (!Array.isArray(p.prompt)) {
    await ctx.sendError(id, -32602, 'prompt must be an array of content blocks');
    return false;
  }
  const session = ctx.sessions.get(sessionId)!;

  if (session.abort.signal.aborted) {
    session.abort = new AbortController();
  }

  const turnSignal = new AbortController();
  const onCancel = (): void => turnSignal.abort();
  session.abort.signal.addEventListener('abort', onCancel, { once: true });

  const api = createRunTurnApi(sessionId, ctx.clientCapabilities ?? {}, (method, req) =>
    ctx.request(method, req),
  );

  let result: RunTurnResult;
  const pendingNotifications: Array<Promise<void>> = [];
  const emit = (update: unknown): void => {
    const notifPromise = ctx.sendNotification({ sessionId, update });
    pendingNotifications.push(notifPromise.catch(() => {}));
  };
  try {
    result = await ctx.runTurn(
      { sessionId, prompt: p.prompt as ContentBlock[], signal: turnSignal.signal },
      emit,
      api,
    );
  } catch (err) {
    session.abort.signal.removeEventListener('abort', onCancel);
    const { code, message, data } = errorToJsonRpc(err);
    await ctx.sendError(id, code, message, data);
    return false;
  }

  await Promise.all(pendingNotifications);
  session.abort.signal.removeEventListener('abort', onCancel);
  session.updatedAt = new Date().toISOString();
  await ctx.persist(session);

  await ctx.sendResult(id, { stopReason: result.stopReason });
  return false;
}

export async function handleSetModeOp(
  ctx: ProtocolSessionContext,
  id: string | number,
  params: unknown,
): Promise<boolean> {
  const p = (params ?? {}) as { sessionId?: unknown; modeId?: unknown };
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
  const modeId = typeof p.modeId === 'string' ? p.modeId : null;
  const session = sessionId ? ctx.sessions.get(sessionId) : undefined;
  if (!session || !modeId || !ctx.modes.some((m) => m.id === modeId)) {
    await ctx.sendError(id, -32602, 'invalid sessionId or modeId');
    return false;
  }
  session.modeId = modeId;
  session.updatedAt = new Date().toISOString();
  await ctx.sendNotification({
    sessionId,
    update: { sessionUpdate: 'current_mode_update', modeId },
  });
  await ctx.sendResult(id, {});
  return false;
}

export async function handleSetConfigOptionOp(
  ctx: ProtocolSessionContext,
  id: string | number,
  params: unknown,
): Promise<boolean> {
  const p = (params ?? {}) as { sessionId?: unknown; configId?: unknown; value?: unknown };
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
  const optionId = typeof p.configId === 'string' ? p.configId : null;
  const value = typeof p.value === 'string' ? p.value : null;
  const session = sessionId ? ctx.sessions.get(sessionId) : undefined;
  const option = optionId ? ctx.configOptions.find((o) => o.id === optionId) : undefined;
  if (!session || !option || value === null || !option.options.some((o) => o.value === value)) {
    await ctx.sendError(id, -32602, 'invalid sessionId, configId, or value');
    return false;
  }
  option.currentValue = value;
  session.updatedAt = new Date().toISOString();
  await ctx.sendNotification({
    sessionId,
    update: {
      sessionUpdate: 'config_option_update',
      configOptions: [...ctx.configOptions],
    },
  });
  await ctx.sendResult(id, { configOptions: [...ctx.configOptions] });
  return false;
}
