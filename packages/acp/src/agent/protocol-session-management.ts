import {
  ACP_ERROR,
  type ClientCapabilities,
  type ContentBlock,
  configOptionValues,
  type ProtocolHandlerOptions,
  type RunTurn,
  type RunTurnResult,
  type SessionConfigOption,
  type SessionMode,
  type SessionPersistence,
  type SessionState,
} from './protocol-contract.js';
import {
  createRunTurnApi,
  errorToJsonRpc,
  offeredModeId,
  openSessionConfigOptions,
  parseMcpServers,
  parseSystemPrompt,
  resolveSessionCwd,
} from './protocol-session-ops.js';

export interface ProtocolSessionContext {
  sessions: Map<string, SessionState>;
  maxSessions: number;
  defaultCwd: string;
  modes: readonly SessionMode[];
  configOptions: readonly SessionConfigOption[];
  sessionConfigOptions?: ProtocolHandlerOptions['sessionConfigOptions'];
  sessionCommands?: ProtocolHandlerOptions['sessionCommands'];
  store: SessionPersistence | undefined;
  replayFor:
    | ((sessionId: string) => Array<{ sessionUpdate: string; content: unknown }>)
    | undefined;
  seedFor:
    | ((sessionId: string, history: Array<{ sessionUpdate: string; content: unknown }>) => void)
    | undefined;
  disposeFor?: ((sessionId: string) => void) | undefined;
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
    await ctx.sendError(
      id,
      ACP_ERROR.SESSION_LIMIT,
      `active session limit reached (${ctx.maxSessions})`,
    );
    return false;
  }
  const p = (params ?? {}) as { cwd?: unknown; mcpServers?: unknown; systemPrompt?: unknown };
  let cwd = ctx.defaultCwd;
  if (typeof p.cwd === 'string') {
    const resolved = await resolveSessionCwd(p.cwd);
    if (resolved === null) {
      await ctx.sendError(id, -32602, `cwd must be an absolute path to an existing directory`);
      return false;
    }
    cwd = resolved;
  }
  const skipped: string[] = [];
  const mcpServers = parseMcpServers(p.mcpServers, (reason) => skipped.push(reason));
  const systemPrompt = parseSystemPrompt(p.systemPrompt);
  const configOptions = await openSessionConfigOptions(ctx);
  // cwd validation yields; another request may have filled the last slot.
  if (ctx.sessions.size >= ctx.maxSessions) {
    await ctx.sendError(
      id,
      ACP_ERROR.SESSION_LIMIT,
      `active session limit reached (${ctx.maxSessions})`,
    );
    return false;
  }
  const sessionId = `sess_${ctx.allocId()}`;
  const now = new Date().toISOString();
  const state: SessionState = {
    id: sessionId,
    cwd,
    abort: new AbortController(),
    modeId: offeredModeId(ctx.modes, undefined),
    configOptions,
    createdAt: now,
    updatedAt: now,
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
  };
  ctx.sessions.set(sessionId, state);
  ctx.onSessionNew(state);
  await ctx.persist(state);

  // The response carries the session's modes and config options, so no
  // current_mode_update / config_option_update is sent for them. Nothing may
  // be sent for this session before the response either: until then the
  // client does not know the id, and strict clients drop such updates.
  await ctx.sendResult(id, {
    sessionId,
    modes: { currentModeId: state.modeId, availableModes: ctx.modes },
    configOptions: state.configOptions,
  });
  await announceSession(ctx, sessionId, skipped);
  return false;
}

export async function handleSessionLoadOp(
  ctx: ProtocolSessionContext,
  id: string | number,
  params: unknown,
  replayHistory = true,
): Promise<boolean> {
  const p = (params ?? {}) as { sessionId?: unknown; cwd?: unknown; mcpServers?: unknown };
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
  const loadCwd = typeof p.cwd === 'string' ? p.cwd : undefined;
  const loadSkipped: string[] = [];
  const loadMcpServers = parseMcpServers(p.mcpServers, (reason) => loadSkipped.push(reason));
  const existing = sessionId ? ctx.sessions.get(sessionId) : undefined;

  if (!existing && sessionId && ctx.store) {
    const persisted = await ctx.store.load(sessionId, loadCwd);
    if (persisted) {
      // Another cold load may have published this id while the read waited.
      if (ctx.sessions.has(sessionId)) {
        return handleSessionLoadOp(ctx, id, params, replayHistory);
      }
      if (ctx.sessions.size >= ctx.maxSessions) {
        await ctx.sendError(
          id,
          ACP_ERROR.SESSION_LIMIT,
          `active session limit reached (${ctx.maxSessions})`,
        );
        return false;
      }
      if (loadCwd !== undefined && (await resolveSessionCwd(loadCwd)) === null) {
        await ctx.sendError(id, -32602, `cwd must be an absolute path to an existing directory`);
        return false;
      }
      // A client-supplied `cwd` wins. It was just validated above (an invalid
      // one rejects the whole load with -32602), so ignoring it here made the
      // validation pure overhead: every load with a `cwd` restored the
      // directory recorded at save time instead of the one the caller asked
      // for, and a turn then ran its tools against that stale project. This
      // matches handleSessionNewOp / handleSessionForkOp, which both let the
      // client's `cwd` win over the inherited one. Only when the client sends
      // none does the persisted (or default) cwd apply.
      const candidateCwd = loadCwd ?? persisted.cwd ?? ctx.defaultCwd;
      const restoredCwd = (await resolveSessionCwd(candidateCwd)) ?? ctx.defaultCwd;
      // Rebuilt, not trusted from disk: the providers behind a model picker
      // may have changed since the session was saved. The saved selection
      // survives wherever it is still offered.
      const restoredConfig = await openSessionConfigOptions(ctx, persisted.configOptions);
      if (ctx.sessions.has(sessionId)) {
        return handleSessionLoadOp(ctx, id, params, replayHistory);
      }
      if ((await ctx.store.load(sessionId, loadCwd)) === null) {
        await sendSessionNotFound(ctx, id, sessionId);
        return false;
      }
      if (ctx.sessions.size >= ctx.maxSessions) {
        await ctx.sendError(
          id,
          ACP_ERROR.SESSION_LIMIT,
          `active session limit reached (${ctx.maxSessions})`,
        );
        return false;
      }
      const restoredMcpServers = Array.isArray(p.mcpServers)
        ? loadMcpServers
        : persisted.mcpServers;
      const restoredSystemPrompt =
        'systemPrompt' in p
          ? parseSystemPrompt((p as { systemPrompt?: unknown }).systemPrompt)
          : persisted.systemPrompt;
      const restored: SessionState = {
        id: sessionId,
        cwd: restoredCwd,
        abort: new AbortController(),
        modeId: offeredModeId(ctx.modes, persisted.modeId),
        configOptions: restoredConfig,
        createdAt: persisted.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(persisted.title !== undefined ? { title: persisted.title } : {}),
        ...(restoredMcpServers && restoredMcpServers.length > 0
          ? { mcpServers: restoredMcpServers }
          : {}),
        ...(restoredSystemPrompt ? { systemPrompt: restoredSystemPrompt } : {}),
      };
      ctx.sessions.set(sessionId, restored);
      ctx.seedFor?.(sessionId, persisted.history ?? []);
      if (loadCwd !== undefined || Array.isArray(p.mcpServers)) {
        await ctx.persist(restored, persisted.history);
      }
      for (const update of replayHistory ? (persisted.history ?? []) : []) {
        if (ctx.sessions.get(sessionId) !== restored) return false;
        await ctx.sendNotification({ sessionId, update });
      }
      if (ctx.sessions.get(sessionId) !== restored) return false;
      if (replayHistory && restored.title !== undefined) {
        await ctx.sendNotification({
          sessionId,
          update: {
            sessionUpdate: 'session_info_update',
            title: restored.title,
            updatedAt: restored.updatedAt,
          },
        });
      }
      if (replayHistory)
        await ctx.sendNotification({
          sessionId,
          update: {
            sessionUpdate: 'current_mode_update',
            currentModeId: restored.modeId,
          },
        });
      await announceSession(ctx, sessionId, loadSkipped);
      await ctx.sendResult(id, {
        modes: { currentModeId: restored.modeId, availableModes: ctx.modes },
        configOptions: restored.configOptions,
      });
      return false;
    }
  }

  if (existing) {
    if (existing.prompting) {
      await ctx.sendError(
        id,
        ACP_ERROR.SESSION_BUSY,
        'cannot reload a session while a prompt is running',
      );
      return false;
    }
    let nextCwd = existing.cwd;
    if (loadCwd !== undefined) {
      const resolvedCwd = await resolveSessionCwd(loadCwd);
      if (resolvedCwd === null) {
        await ctx.sendError(id, -32602, 'cwd must be an absolute path to an existing directory');
        return false;
      }
      if (ctx.sessions.get(sessionId!) !== existing) {
        return handleSessionLoadOp(ctx, id, params, replayHistory);
      }
      if (existing.prompting) {
        await ctx.sendError(
          id,
          ACP_ERROR.SESSION_BUSY,
          'cannot reload a session while a prompt is running',
        );
        return false;
      }
      nextCwd = resolvedCwd;
    }
    existing.updatedAt = new Date().toISOString();
    const replay = ctx.replayFor?.(sessionId!);
    const cwdChanged = nextCwd !== existing.cwd;
    // A warm `session/load` carries the client's current server set; honour it
    // so a client that added a server since `session/new` is not stuck with
    // the old list. An explicit empty array clears the client's server set.
    const mcpChanged =
      Array.isArray(p.mcpServers) &&
      JSON.stringify(existing.mcpServers ?? []) !== JSON.stringify(loadMcpServers);
    // The client's current systemPrompt rides the same contract (the cold
    // branch above already reads it): an explicit value replaces the session's,
    // an explicit empty/invalid one clears it. The live agent was built with
    // the old prompt, so a change disposes it and the next turn rebuilds.
    const loadSystemPrompt =
      'systemPrompt' in p
        ? parseSystemPrompt((p as { systemPrompt?: unknown }).systemPrompt)
        : undefined;
    const promptChanged =
      'systemPrompt' in p &&
      JSON.stringify(existing.systemPrompt ?? null) !== JSON.stringify(loadSystemPrompt ?? null);
    if (cwdChanged || mcpChanged || promptChanged) {
      ctx.disposeFor?.(sessionId!);
      ctx.seedFor?.(sessionId!, replay ?? []);
    }
    existing.cwd = nextCwd;
    if (Array.isArray(p.mcpServers)) existing.mcpServers = loadMcpServers;
    if ('systemPrompt' in p) {
      if (loadSystemPrompt) existing.systemPrompt = loadSystemPrompt;
      else delete existing.systemPrompt;
    }
    if (cwdChanged || mcpChanged || promptChanged) {
      await ctx.persist(existing, replay);
    }
    if (replayHistory && replay) {
      for (const update of replay) {
        if (ctx.sessions.get(sessionId!) !== existing) return false;
        await ctx.sendNotification({ sessionId, update });
      }
    }
    if (ctx.sessions.get(sessionId!) !== existing) return false;
    if (replayHistory)
      await ctx.sendNotification({
        sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          ...(existing.title !== undefined ? { title: existing.title } : {}),
          updatedAt: existing.updatedAt,
        },
      });
    if (replayHistory)
      await ctx.sendNotification({
        sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: existing.modeId,
        },
      });
    await announceSession(ctx, sessionId!, loadSkipped);
    await ctx.sendResult(id, {
      modes: {
        currentModeId: existing.modeId,
        availableModes: ctx.modes,
      },
      configOptions: existing.configOptions ?? [...ctx.configOptions],
    });
    return false;
  }

  await sendSessionNotFound(ctx, id, sessionId);
  return false;
}

export async function handleSessionForkOp(
  ctx: ProtocolSessionContext,
  id: string | number,
  params: unknown,
): Promise<boolean> {
  const p = (params ?? {}) as { sessionId?: unknown; cwd?: unknown; mcpServers?: unknown };
  const sourceId = typeof p.sessionId === 'string' ? p.sessionId : null;
  const requestedCwd = typeof p.cwd === 'string' ? p.cwd : undefined;
  const liveSource = sourceId ? ctx.sessions.get(sourceId) : undefined;
  const persistedSource =
    !liveSource && sourceId && ctx.store ? await ctx.store.load(sourceId, requestedCwd) : null;
  if (!sourceId || (!liveSource && !persistedSource)) {
    await sendSessionNotFound(ctx, id, sourceId);
    return false;
  }
  if (ctx.sessions.size >= ctx.maxSessions) {
    await ctx.sendError(
      id,
      ACP_ERROR.SESSION_LIMIT,
      `active session limit reached (${ctx.maxSessions})`,
    );
    return false;
  }

  let forkCwd = liveSource?.cwd ?? persistedSource?.cwd ?? ctx.defaultCwd;
  if (typeof p.cwd === 'string') {
    const resolved = await resolveSessionCwd(p.cwd);
    if (resolved === null) {
      await ctx.sendError(id, -32602, `cwd must be an absolute path to an existing directory`);
      return false;
    }
    forkCwd = resolved;
  }
  if (liveSource && ctx.sessions.get(sourceId) !== liveSource) {
    await sendSessionNotFound(ctx, id, sourceId);
    return false;
  }
  const forkSkipped: string[] = [];
  const forkRequested = parseMcpServers(p.mcpServers, (reason) => forkSkipped.push(reason));
  // A fork inherits the source session's servers unless the client names its
  // own set — the fork is a continuation, and dropping the parent's tools
  // would silently change what the agent can do mid-conversation. An explicit
  // array (including `[]`) overrides the parent set, matching `session/load`.
  const sourceMcpServers = liveSource ? liveSource.mcpServers : persistedSource?.mcpServers;
  const forkMcpServers = Array.isArray(p.mcpServers) ? forkRequested : sourceMcpServers;

  const forkedConfigOptions = liveSource
    ? structuredClone(liveSource.configOptions ?? [...ctx.configOptions])
    : await openSessionConfigOptions(ctx, persistedSource?.configOptions);

  if (ctx.sessions.size >= ctx.maxSessions) {
    await ctx.sendError(
      id,
      ACP_ERROR.SESSION_LIMIT,
      `active session limit reached (${ctx.maxSessions})`,
    );
    return false;
  }
  const now = new Date().toISOString();
  const sessionId = `sess_${ctx.allocId()}`;
  const sourceModeId = offeredModeId(ctx.modes, liveSource?.modeId ?? persistedSource?.modeId);
  const sourceTitle = liveSource ? liveSource.title : persistedSource?.title;
  const sourceSystemPrompt = liveSource ? liveSource.systemPrompt : persistedSource?.systemPrompt;
  const forkedSystemPrompt =
    'systemPrompt' in p
      ? parseSystemPrompt((p as { systemPrompt?: unknown }).systemPrompt)
      : sourceSystemPrompt;
  const forked: SessionState = {
    id: sessionId,
    cwd: forkCwd,
    abort: new AbortController(),
    modeId: sourceModeId,
    configOptions: forkedConfigOptions,
    createdAt: now,
    updatedAt: now,
    ...(sourceTitle !== undefined ? { title: sourceTitle } : {}),
    ...(forkMcpServers && forkMcpServers.length > 0 ? { mcpServers: forkMcpServers } : {}),
    ...(forkedSystemPrompt ? { systemPrompt: forkedSystemPrompt } : {}),
  };
  const sourceHistory = liveSource
    ? (ctx.replayFor?.(sourceId) ?? [])
    : (persistedSource?.history ?? []);
  const history = sourceHistory.map((update) => ({
    sessionUpdate: update.sessionUpdate,
    content: structuredClone(update.content),
  }));
  ctx.sessions.set(sessionId, forked);
  ctx.seedFor?.(sessionId, history);
  ctx.onSessionNew(forked);
  await ctx.persist(forked, history);

  // As in session/new: the response carries the mode, and the client cannot
  // route an update for the forked id before it has received that id.
  await ctx.sendResult(id, {
    sessionId,
    modes: { currentModeId: forked.modeId, availableModes: ctx.modes },
    configOptions: forked.configOptions,
  });
  await announceSession(ctx, sessionId, forkSkipped);
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
    await sendSessionNotFound(ctx, id, sessionId);
    return false;
  }
  if (!Array.isArray(p.prompt)) {
    await ctx.sendError(id, -32602, 'prompt must be an array of content blocks');
    return false;
  }
  const session = ctx.sessions.get(sessionId)!;
  if (session.prompting) {
    await ctx.sendError(id, ACP_ERROR.SESSION_BUSY, 'a prompt is already running for this session');
    return false;
  }
  session.prompting = true;

  if (session.title === undefined) {
    const derived = deriveSessionTitle(p.prompt as readonly ContentBlock[]);
    if (derived) session.title = derived;
  }

  if (session.abort.signal.aborted) {
    session.abort = new AbortController();
  }

  const turnSignal = new AbortController();
  const onCancel = (): void => turnSignal.abort();
  session.abort.signal.addEventListener('abort', onCancel, { once: true });

  const api = createRunTurnApi(
    sessionId,
    ctx.clientCapabilities ?? {},
    (method, req) => ctx.request(method, req),
    async (update) => {
      // Unprompted updates outlive this turn. Identity (not just the id) is
      // checked so nothing reaches a client for a session it closed, deleted,
      // or replaced with a fresh `session/load` state.
      if (ctx.sessions.get(sessionId) !== session) return false;
      await ctx.sendNotification({ sessionId, update });
      return true;
    },
    () => ctx.sessions.get(sessionId)?.modeId,
  );

  let result: RunTurnResult;
  const pendingNotifications: Array<Promise<void>> = [];
  const emit = (update: unknown): void => {
    // Same identity guard as the unprompted updater above, and for the same
    // reason: a turn keeps draining after `session/close` / `session/delete`
    // aborts it, or after a cold `session/load` replaces the state under this
    // id. The `cwd` is not the only thing that outlives the session — without
    // this check the final `agent_message_chunk` (and any slow tool's
    // `tool_call_update`) reached a client for a session it had already closed
    // or replaced, and the client folds `session/update` into its scratch with
    // no sessionId check of its own. Silently drop the update instead; the
    // turn still settles normally through the `sendResult` below.
    if (ctx.sessions.get(sessionId) !== session) return;
    const notifPromise = ctx.sendNotification({ sessionId, update });
    pendingNotifications.push(notifPromise.catch(() => {}));
  };
  try {
    result = await ctx.runTurn(
      {
        sessionId,
        prompt: p.prompt as ContentBlock[],
        modeId: session.modeId,
        configOptions: session.configOptions,
        signal: turnSignal.signal,
        cwd: session.cwd,
        ...(session.mcpServers ? { mcpServers: session.mcpServers } : {}),
        ...(session.systemPrompt ? { systemPrompt: session.systemPrompt } : {}),
      },
      emit,
      api,
    );
  } catch (err) {
    session.prompting = false;
    session.abort.signal.removeEventListener('abort', onCancel);
    await Promise.all(pendingNotifications);
    if (turnSignal.signal.aborted) {
      await ctx.sendResult(id, { stopReason: 'cancelled' });
      return false;
    }
    const { code, message, data } = errorToJsonRpc(err);
    await ctx.sendError(id, code, message, data);
    return false;
  }

  await Promise.all(pendingNotifications);
  session.prompting = false;
  session.abort.signal.removeEventListener('abort', onCancel);
  session.updatedAt = new Date().toISOString();
  if (ctx.sessions.get(sessionId) === session) await ctx.persist(session);

  await ctx.sendResult(id, {
    stopReason: turnSignal.signal.aborted ? 'cancelled' : result.stopReason,
  });
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
  if (!session) {
    await sendSessionNotFound(ctx, id, sessionId);
    return false;
  }
  if (!modeId || !ctx.modes.some((m) => m.id === modeId)) {
    await ctx.sendError(id, ACP_ERROR.INVALID_PARAMS, 'invalid modeId');
    return false;
  }
  session.modeId = modeId;
  session.updatedAt = new Date().toISOString();
  await ctx.sendNotification({
    sessionId,
    update: {
      sessionUpdate: 'current_mode_update',
      currentModeId: modeId,
    },
  });
  // Identity check, as session/prompt does: a session/delete that landed
  // during the notification await removed the file, and persisting now
  // would write the deleted session back.
  if (ctx.sessions.get(session.id) === session) await ctx.persist(session);
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
  const session = sessionId ? ctx.sessions.get(sessionId) : undefined;
  const options = session?.configOptions ?? structuredClone([...ctx.configOptions]);
  const option = optionId ? options.find((o) => o.id === optionId) : undefined;
  if (!session) {
    await sendSessionNotFound(ctx, id, sessionId);
    return false;
  }
  const validBoolean = option?.type === 'boolean' && typeof p.value === 'boolean';
  const validSelect =
    option !== undefined &&
    option.type !== 'boolean' &&
    typeof p.value === 'string' &&
    configOptionValues(option).some((o) => o.value === p.value);
  if (!option || (!validBoolean && !validSelect)) {
    await ctx.sendError(id, ACP_ERROR.INVALID_PARAMS, 'invalid configId or value');
    return false;
  }
  option.currentValue = p.value as string | boolean;
  const nextOptions = ctx.sessionConfigOptions
    ? await openSessionConfigOptions(ctx, options)
    : options;
  if (ctx.sessions.get(session.id) !== session) return false;
  session.configOptions = nextOptions;
  session.updatedAt = new Date().toISOString();
  await ctx.sendNotification({
    sessionId,
    update: {
      sessionUpdate: 'config_option_update',
      configOptions: nextOptions,
    },
  });
  if (ctx.sessions.get(session.id) === session) await ctx.persist(session);
  await ctx.sendResult(id, { configOptions: nextOptions });
  return false;
}

/**
 * Tell the client about MCP server entries we refused to connect.
 *
 * `parseMcpServers` drops malformed entries so one bad config cannot fail the
 * whole session, but dropping without saying so is how an editor ends up
 * believing it has tools it does not have. Best-effort: a notification failure
 * must not fail `session/new`.
 */
/** What a session learns once it is open: skipped MCP servers, then its commands. */
async function announceSession(
  ctx: ProtocolSessionContext,
  sessionId: string,
  skipped: readonly string[],
): Promise<void> {
  await reportSkippedMcpServers(ctx, sessionId, skipped);
  await announceCommands(ctx, sessionId);
}

/** `available_commands_update`; best-effort, like every announcement after the response. */
async function announceCommands(ctx: ProtocolSessionContext, sessionId: string): Promise<void> {
  if (!ctx.sessionCommands) return;
  try {
    const commands = await ctx.sessionCommands(sessionId);
    if (commands.length === 0) return;
    await ctx.sendNotification({
      sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: commands.map((command) => ({
          name: command.name,
          description: command.description,
          ...(command.input ? { input: { hint: command.input.hint } } : {}),
        })),
      },
    });
  } catch {
    // best-effort: a session without its command list still works
  }
}

async function reportSkippedMcpServers(
  ctx: ProtocolSessionContext,
  sessionId: string,
  skipped: readonly string[],
): Promise<void> {
  if (skipped.length === 0) return;
  try {
    await ctx.sendNotification({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `Ignored ${skipped.length} malformed mcpServers entr${
            skipped.length === 1 ? 'y' : 'ies'
          }: ${skipped.join('; ')}`,
        },
      },
    });
  } catch {
    // best-effort
  }
}

function deriveSessionTitle(prompt: readonly ContentBlock[]): string | undefined {
  for (const block of prompt) {
    if (
      block &&
      typeof block === 'object' &&
      block.type === 'text' &&
      typeof block.text === 'string'
    ) {
      const normalized = block.text.replace(/\s+/g, ' ').trim();
      if (normalized.length === 0) continue;
      return normalized.length > 80 ? `${normalized.slice(0, 77)}…` : normalized;
    }
  }
  return undefined;
}

/**
 * Unknown or inactive session: `-32002` with the requested id, as the ACP
 * error reference asks. Never `-32000`, which clients read as "log in".
 */
async function sendSessionNotFound(
  ctx: ProtocolSessionContext,
  id: string | number,
  sessionId: string | null,
): Promise<void> {
  if (sessionId === null) {
    await ctx.sendError(id, ACP_ERROR.INVALID_PARAMS, 'sessionId is required');
    return;
  }
  await ctx.sendError(id, ACP_ERROR.RESOURCE_NOT_FOUND, `session not found: ${sessionId}`, {
    sessionId,
  });
}
