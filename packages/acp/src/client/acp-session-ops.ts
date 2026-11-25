import type { AgentCapabilities, McpServer, SessionId, SessionInfo } from '../types/acp-v1.js';
import { acpSessionModeOptions } from './acp-runtime-options.js';
import { ACPSessionError, isJsonRpcError } from './acp-session-errors.js';
import type { ACPSessionOptions } from './acp-session-types.js';

export function filterMcpServers(
  agentCapabilities: AgentCapabilities,
  servers?: McpServer[],
): McpServer[] {
  if (!servers || servers.length === 0) return [];
  const mcpCaps = agentCapabilities.mcpCapabilities ?? {};
  const eligible = servers.filter((s) => {
    if ('type' in s && s.type === 'http') return mcpCaps.http === true;
    if ('type' in s && s.type === 'sse') return mcpCaps.sse === true;
    return true; // stdio — always supported per spec
  });
  // When both an HTTP (e.g. shared ProjectMcpGateway) and stdio fallback entry
  // exist for the same server name, prefer HTTP (zero child processes) if the
  // agent advertised `mcpCapabilities.http`, otherwise keep stdio.
  const byName = new Map<string, McpServer>();
  const rank = (s: McpServer): number =>
    'type' in s && s.type === 'http' ? 3 : 'type' in s && s.type === 'sse' ? 2 : 1;
  for (const server of eligible) {
    const prev = byName.get(server.name);
    if (!prev || rank(server) > rank(prev)) {
      byName.set(server.name, server);
    }
  }
  return [...byName.values()];
}

export interface ACPSessionOpContext {
  closed: boolean;
  sessionId: SessionId | null;
  agentCapabilities: AgentCapabilities;
  opts: ACPSessionOptions;
  allocId: () => number;
  sendRequest: (
    id: number,
    method: string,
    params: unknown,
    timeoutMs?: number,
  ) => Promise<unknown>;
  setSessionId: (id: SessionId | null) => void;
  setCurrentMode?: (id: string) => void;
  resetScratch: () => void;
  closeSession: () => Promise<void>;
}

function additionalDirectoriesParam(
  ctx: ACPSessionOpContext,
): { additionalDirectories: string[] } | Record<string, never> {
  if (
    !ctx.agentCapabilities.sessionCapabilities?.additionalDirectories ||
    !ctx.opts.additionalDirectories?.length
  ) {
    return {};
  }
  return { additionalDirectories: [...ctx.opts.additionalDirectories] };
}

export async function executeLoadSession(
  ctx: ACPSessionOpContext,
  sessionId: SessionId,
  mcpServers?: McpServer[],
  cwd?: string,
): Promise<void> {
  if (ctx.closed) throw new ACPSessionError('closed', 'session is closed');
  if (!ctx.agentCapabilities.loadSession) {
    throw new ACPSessionError(
      'unsupported_capability',
      'agent does not support session/load (loadSession capability not advertised)',
    );
  }
  if (ctx.sessionId && ctx.sessionId !== sessionId) {
    await ctx.closeSession();
  }

  if (ctx.closed) throw new ACPSessionError('closed', 'session is closed');
  const previousSessionId = ctx.sessionId;
  ctx.resetScratch();
  ctx.setSessionId(sessionId);
  const servers = filterMcpServers(ctx.agentCapabilities, mcpServers ?? ctx.opts.mcpServers);
  const id = ctx.allocId();
  let result: unknown;
  try {
    result = await ctx.sendRequest(id, 'session/load', {
      sessionId,
      cwd: cwd ?? ctx.opts.cwd ?? ctx.opts.projectRoot,
      mcpServers: servers,
      ...additionalDirectoriesParam(ctx),
    });
  } catch (err) {
    ctx.setSessionId(previousSessionId);
    ctx.resetScratch();
    throw err;
  }
  if (isJsonRpcError(result)) {
    ctx.setSessionId(previousSessionId);
    ctx.resetScratch();
    throw new ACPSessionError('prompt_failed', `session/load failed: ${result.message}`, result);
  }
  if (ctx.closed) {
    ctx.setSessionId(null);
    throw new ACPSessionError('closed', 'session is closed');
  }
}

export async function executeResumeSession(
  ctx: ACPSessionOpContext,
  sessionId: SessionId,
  mcpServers?: McpServer[],
  cwd?: string,
): Promise<void> {
  if (ctx.closed) throw new ACPSessionError('closed', 'session is closed');
  if (!ctx.agentCapabilities.sessionCapabilities?.resume) {
    throw new ACPSessionError(
      'unsupported_capability',
      'agent does not support session/resume (sessionCapabilities.resume not advertised)',
    );
  }
  if (ctx.sessionId && ctx.sessionId !== sessionId) {
    await ctx.closeSession();
  }

  if (ctx.closed) throw new ACPSessionError('closed', 'session is closed');
  const previousSessionId = ctx.sessionId;
  ctx.resetScratch();
  ctx.setSessionId(sessionId);
  const servers = filterMcpServers(ctx.agentCapabilities, mcpServers ?? ctx.opts.mcpServers);
  const id = ctx.allocId();
  let result: unknown;
  try {
    result = await ctx.sendRequest(id, 'session/resume', {
      sessionId,
      cwd: cwd ?? ctx.opts.cwd ?? ctx.opts.projectRoot,
      mcpServers: servers,
      ...additionalDirectoriesParam(ctx),
    });
  } catch (err) {
    ctx.setSessionId(previousSessionId);
    ctx.resetScratch();
    throw err;
  }
  if (isJsonRpcError(result)) {
    ctx.setSessionId(previousSessionId);
    ctx.resetScratch();
    throw new ACPSessionError('prompt_failed', `session/resume failed: ${result.message}`, result);
  }
  if (ctx.closed) {
    ctx.setSessionId(null);
    throw new ACPSessionError('closed', 'session is closed');
  }
}

export async function executeListSessions(
  ctx: ACPSessionOpContext,
  cursor?: string,
  cwd?: string,
): Promise<{ sessions: SessionInfo[]; nextCursor?: string | undefined }> {
  if (ctx.closed) throw new ACPSessionError('closed', 'session is closed');
  if (!ctx.agentCapabilities.sessionCapabilities?.list) {
    throw new ACPSessionError(
      'unsupported_capability',
      'agent does not support session/list (sessionCapabilities.list not advertised)',
    );
  }

  const id = ctx.allocId();
  const params: Record<string, unknown> = {};
  if (cursor !== undefined) params.cursor = cursor;
  if (cwd !== undefined) params.cwd = cwd;
  const result = await ctx.sendRequest(id, 'session/list', params);
  if (isJsonRpcError(result)) {
    throw new ACPSessionError('prompt_failed', `session/list failed: ${result.message}`, result);
  }
  const r = result as { sessions?: SessionInfo[]; nextCursor?: string };
  return {
    sessions: r.sessions ?? [],
    nextCursor: r.nextCursor,
  };
}

export async function executeDeleteSession(
  ctx: ACPSessionOpContext,
  sessionId: SessionId,
): Promise<void> {
  if (ctx.closed) throw new ACPSessionError('closed', 'session is closed');
  if (!ctx.agentCapabilities.sessionCapabilities?.delete) {
    throw new ACPSessionError(
      'unsupported_capability',
      'agent does not support session/delete (sessionCapabilities.delete not advertised)',
    );
  }

  const id = ctx.allocId();
  const result = await ctx.sendRequest(id, 'session/delete', { sessionId });
  if (isJsonRpcError(result)) {
    throw new ACPSessionError('prompt_failed', `session/delete failed: ${result.message}`, result);
  }

  if (ctx.sessionId === sessionId) {
    ctx.setSessionId(null);
  }
}

export async function executeForkSession(
  ctx: ACPSessionOpContext,
  sourceSessionId: SessionId,
  cwd?: string,
  mcpServers?: McpServer[],
): Promise<SessionId> {
  if (ctx.closed) throw new ACPSessionError('closed', 'session is closed');

  const servers = filterMcpServers(ctx.agentCapabilities, mcpServers ?? ctx.opts.mcpServers);
  const id = ctx.allocId();
  const result = await ctx.sendRequest(id, 'session/fork', {
    sessionId: sourceSessionId,
    cwd: cwd ?? ctx.opts.cwd ?? ctx.opts.projectRoot,
    ...(servers.length > 0 ? { mcpServers: servers } : {}),
  });
  if (isJsonRpcError(result)) {
    throw new ACPSessionError('prompt_failed', `session/fork failed: ${result.message}`, result);
  }
  const newId = (result as { sessionId?: unknown }).sessionId;
  if (typeof newId !== 'string' || !newId) {
    throw new ACPSessionError('protocol_error', 'session/fork returned no sessionId', result);
  }
  return newId as SessionId;
}

export async function executeSetMode(
  ctx: ACPSessionOpContext,
  sessionId: SessionId,
  modeId: string,
): Promise<void> {
  if (ctx.closed) throw new ACPSessionError('closed', 'session is closed');
  const id = ctx.allocId();
  const result = await ctx.sendRequest(id, 'session/set_mode', { sessionId, modeId });
  if (isJsonRpcError(result)) {
    throw new ACPSessionError(
      'prompt_failed',
      `session/set_mode failed: ${result.message}`,
      result,
    );
  }
}

export async function executeSetConfigOption(
  ctx: ACPSessionOpContext,
  sessionId: SessionId,
  configId: string,
  value: string | boolean,
): Promise<unknown> {
  if (ctx.closed) throw new ACPSessionError('closed', 'session is closed');
  const id = ctx.allocId();
  const result = await ctx.sendRequest(id, 'session/set_config_option', {
    sessionId,
    configId,
    value,
    ...(typeof value === 'boolean' ? { type: 'boolean' } : {}),
  });
  if (isJsonRpcError(result)) {
    throw new ACPSessionError(
      'prompt_failed',
      `session/set_config_option failed: ${result.message}`,
      result,
    );
  }
  return result;
}

export async function executeSetModel(
  ctx: ACPSessionOpContext,
  sessionId: SessionId,
  modelId: string,
): Promise<void> {
  if (ctx.closed) throw new ACPSessionError('closed', 'session is closed');
  const id = ctx.allocId();
  const result = await ctx.sendRequest(id, 'session/set_model', {
    sessionId,
    modelId,
  });
  if (isJsonRpcError(result)) {
    throw new ACPSessionError(
      'prompt_failed',
      `session/set_model failed: ${result.message}`,
      result,
    );
  }
}

export async function executeListProviders(
  ctx: ACPSessionOpContext,
): Promise<{ providers: unknown[]; currentProviderId: string | null }> {
  if (ctx.closed) throw new ACPSessionError('closed', 'session is closed');
  const id = ctx.allocId();
  const result = await ctx.sendRequest(id, 'providers/list', {});
  if (isJsonRpcError(result)) {
    throw new ACPSessionError('prompt_failed', `providers/list failed: ${result.message}`, result);
  }
  const r = result as { providers?: unknown[]; currentProviderId?: string | null };
  return { providers: r.providers ?? [], currentProviderId: r.currentProviderId ?? null };
}

export async function executeSetProvider(
  ctx: ACPSessionOpContext,
  providerId: string,
  config?: Record<string, unknown>,
): Promise<void> {
  if (ctx.closed) throw new ACPSessionError('closed', 'session is closed');
  const id = ctx.allocId();
  const result = await ctx.sendRequest(id, 'providers/set', { providerId, ...(config ?? {}) });
  if (isJsonRpcError(result)) {
    throw new ACPSessionError('prompt_failed', `providers/set failed: ${result.message}`, result);
  }
}

export async function executeDisableProvider(ctx: ACPSessionOpContext): Promise<void> {
  if (ctx.closed) throw new ACPSessionError('closed', 'session is closed');
  const id = ctx.allocId();
  const result = await ctx.sendRequest(id, 'providers/disable', {});
  if (isJsonRpcError(result)) {
    throw new ACPSessionError(
      'prompt_failed',
      `providers/disable failed: ${result.message}`,
      result,
    );
  }
}

export async function executeMcpMessage(
  ctx: ACPSessionOpContext,
  connectionId: string,
  message: Record<string, unknown>,
): Promise<unknown> {
  if (ctx.closed) throw new ACPSessionError('closed', 'session is closed');
  const id = ctx.allocId();
  const result = await ctx.sendRequest(id, 'mcp/message', { connectionId, message });
  if (isJsonRpcError(result)) {
    throw new ACPSessionError('prompt_failed', `mcp/message failed: ${result.message}`, result);
  }
  return result;
}

export async function executeCreateSession(ctx: ACPSessionOpContext): Promise<SessionId> {
  const servers = filterMcpServers(ctx.agentCapabilities, ctx.opts.mcpServers);
  const params = {
    cwd: ctx.opts.cwd ?? ctx.opts.projectRoot,
    mcpServers: servers,
    ...additionalDirectoriesParam(ctx),
    ...(ctx.opts.sessionMeta ? { _meta: ctx.opts.sessionMeta } : {}),
  };
  const target = ctx.opts.sessionTarget;
  if (target && !target.sessionId.trim()) {
    throw new ACPSessionError('protocol_error', 'Explicit ACP session target requires an ID');
  }
  if (target?.action === 'fork') {
    if (!ctx.agentCapabilities.sessionCapabilities?.fork) {
      throw new ACPSessionError('unsupported_capability', 'agent does not support session/fork');
    }
    const forked = await ctx.sendRequest(ctx.allocId(), 'session/fork', {
      ...params,
      sessionId: target.sessionId,
    });
    if (isJsonRpcError(forked)) {
      throw new ACPSessionError(
        'session_create_failed',
        `session/fork failed: ${forked.message}`,
        forked,
      );
    }
    const forkId = (forked as { sessionId?: unknown } | null)?.sessionId;
    if (typeof forkId !== 'string' || !forkId || forkId === target.sessionId) {
      throw new ACPSessionError('protocol_error', 'session/fork did not return a new session ID');
    }
    try {
      return await adoptSessionMode(ctx, forkId as SessionId, forked);
    } catch (error) {
      await discardCreatedSession(ctx, forkId as SessionId);
      throw error;
    }
  }
  const resumeId = target?.sessionId ?? ctx.opts.resumeSessionId;
  if (resumeId) {
    const resumeMethod = ctx.agentCapabilities.sessionCapabilities?.resume
      ? 'session/resume'
      : ctx.agentCapabilities.loadSession
        ? 'session/load'
        : null;
    if (target) {
      if (!resumeMethod) {
        throw new ACPSessionError(
          'unsupported_capability',
          'agent does not support session resume or load',
        );
      }
      const resumed = await ctx.sendRequest(ctx.allocId(), resumeMethod, {
        ...params,
        sessionId: resumeId,
      });
      if (ctx.closed) throw new ACPSessionError('closed', 'session is closed');
      if (isJsonRpcError(resumed)) {
        throw new ACPSessionError(
          'session_create_failed',
          `${resumeMethod} failed: ${resumed.message}`,
          resumed,
        );
      }
      if (resumeMethod === 'session/load') ctx.resetScratch();
      return adoptSessionMode(ctx, resumeId as SessionId, resumed);
    }
    if (resumeMethod) {
      // An agent that no longer has the session (deleted, another machine)
      // refuses it; a new session starts instead.
      const refused = Symbol('resume_refused');
      const resumed = await ctx
        .sendRequest(ctx.allocId(), resumeMethod, { ...params, sessionId: resumeId })
        .catch(() => refused);
      if (ctx.closed) throw new ACPSessionError('closed', 'session is closed');
      if (resumed !== refused && !isJsonRpcError(resumed)) {
        if (resumeMethod === 'session/load') ctx.resetScratch();
        return adoptSessionMode(ctx, resumeId as SessionId, resumed);
      }
    }
  }
  const id = ctx.allocId();
  const result = await ctx.sendRequest(id, 'session/new', params);
  if (isJsonRpcError(result)) {
    throw new ACPSessionError(
      'session_create_failed',
      `session/new failed: ${result.message}`,
      result,
    );
  }
  const sessionId = (result as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new ACPSessionError('protocol_error', 'session/new returned no sessionId', result);
  }
  try {
    return await adoptSessionMode(ctx, sessionId as SessionId, result);
  } catch (err) {
    // The agent created this session, and the id is discarded from here on, so
    // a refusal (mode not offered, or the switch failed) would leave it open
    // on the agent for the rest of the process's life.
    await discardCreatedSession(ctx, sessionId as SessionId);
    throw err;
  }
}

/**
 * Best-effort close for a session this client just created and will not use.
 * A resumed session must never come through here: it already existed on the
 * agent and belongs to whoever resumes it.
 */
async function discardCreatedSession(
  ctx: ACPSessionOpContext,
  sessionId: SessionId,
): Promise<void> {
  if (!ctx.agentCapabilities.sessionCapabilities?.close) return;
  try {
    await ctx.sendRequest(ctx.allocId(), 'session/close', { sessionId }, 5_000);
  } catch {
    // Best-effort: the refusal the caller is about to see is the real error.
  }
}

/**
 * Create the session now rather than at the first prompt. `resumed` is true
 * when it continues `opts.resumeSessionId` (the agent remembers it), false for
 * a new session.
 */
export async function executeOpenSession(
  ctx: ACPSessionOpContext,
  create: () => Promise<SessionId>,
): Promise<{ sessionId: SessionId; resumed: boolean }> {
  if (ctx.closed) throw new ACPSessionError('closed', 'session is closed');
  if (ctx.sessionId) return { sessionId: ctx.sessionId, resumed: false };
  const sessionId = await create();
  if (ctx.closed) {
    ctx.setSessionId(null);
    throw new ACPSessionError('closed', 'session is closed');
  }
  ctx.setSessionId(sessionId);
  const resumeId =
    ctx.opts.sessionTarget?.action === 'resume'
      ? ctx.opts.sessionTarget.sessionId
      : ctx.opts.resumeSessionId;
  return { sessionId, resumed: sessionId === resumeId };
}

/** Put a new or resumed session in the mode the host asked for (`initialModeId`). */
async function adoptSessionMode(
  ctx: ACPSessionOpContext,
  sessionId: SessionId,
  result: unknown,
): Promise<SessionId> {
  const want = ctx.opts.initialModeId;
  if (!want) return sessionId;
  const state = result as
    | {
        configOptions?: unknown;
        modes?: { currentModeId?: unknown; availableModes?: unknown };
      }
    | null
    | undefined;
  const modern = acpSessionModeOptions(state?.configOptions).find(
    (option) => option.category === 'mode',
  );
  if (modern?.options.some((value) => value.value === want)) {
    if (modern.currentValue !== want) {
      const reply = (await executeSetConfigOption(ctx, sessionId, modern.id, want)) as
        | {
            configOptions?: unknown;
          }
        | null
        | undefined;
      if (
        acpSessionModeOptions(reply?.configOptions).find((option) => option.id === modern.id)
          ?.currentValue !== want
      ) {
        throw new ACPSessionError(
          'session_create_failed',
          `the agent did not confirm the "${want}" session mode`,
        );
      }
    }
    return sessionId;
  }
  const modes = modern ? undefined : state?.modes;
  const offered =
    Array.isArray(modes?.availableModes) &&
    modes.availableModes.some((m) => (m as { id?: unknown } | null)?.id === want);
  if (!offered && ctx.opts.requireInitialMode) {
    throw new ACPSessionError(
      'session_create_failed',
      `the agent does not offer the "${want}" session mode this host requires`,
      result,
    );
  }
  if (offered && modes?.currentModeId !== want) {
    // A failed switch must not start the turn in a mode the host did not ask for.
    await executeSetMode(ctx, sessionId, want);
    ctx.setCurrentMode?.(want);
  }
  return sessionId;
}

/** What a steer did: joined the running turn, found none, or cannot steer. */
export type AcpSteerOutcome = 'injected' | 'promptRequired' | 'startedNewTurn' | 'unsupported';

/**
 * Inject `text` into the turn the agent is running, through the
 * `_session/steering` extension (Claude's ACP adapter advertises it as
 * `InitializeResponse._meta.steering.supported`). With no turn running the
 * agent hands the text back (`promptRequired`) instead of starting a turn
 * nobody awaits.
 */
export async function executeSteer(
  ctx: ACPSessionOpContext,
  supported: boolean,
  text: string,
): Promise<AcpSteerOutcome> {
  if (ctx.closed || !ctx.sessionId || !supported) return 'unsupported';
  const result = await ctx.sendRequest(
    ctx.allocId(),
    '_session/steering',
    {
      sessionId: ctx.sessionId,
      prompt: [{ type: 'text', text }],
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    },
    10_000,
  );
  if (isJsonRpcError(result)) {
    throw new ACPSessionError(
      'prompt_failed',
      `_session/steering failed: ${result.message}`,
      result,
    );
  }
  const outcome = (result as { outcome?: unknown } | null)?.outcome;
  return outcome === 'injected' || outcome === 'promptRequired' || outcome === 'startedNewTurn'
    ? outcome
    : 'unsupported';
}
