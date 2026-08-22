import type { AgentCapabilities, McpServer, SessionId, SessionInfo } from '../types/acp-v1.js';
import { ACPSessionError, isJsonRpcError } from './acp-session-errors.js';
import type { ACPSessionOptions } from './acp-session-types.js';

export function filterMcpServers(
  agentCapabilities: AgentCapabilities,
  servers?: McpServer[],
): McpServer[] {
  if (!servers || servers.length === 0) return [];
  const mcpCaps = agentCapabilities.mcpCapabilities ?? {};
  return servers.filter((s) => {
    if ('type' in s && s.type === 'http') return mcpCaps.http === true;
    if ('type' in s && s.type === 'sse') return mcpCaps.sse === true;
    return true; // stdio — always supported per spec
  });
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
  resetScratch: () => void;
  closeSession: () => Promise<void>;
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
  if (ctx.sessionId) {
    await ctx.closeSession();
  }

  ctx.resetScratch();
  const servers = filterMcpServers(ctx.agentCapabilities, mcpServers ?? ctx.opts.mcpServers);
  const id = ctx.allocId();
  const result = await ctx.sendRequest(id, 'session/load', {
    sessionId,
    cwd: cwd ?? ctx.opts.cwd ?? ctx.opts.projectRoot,
    mcpServers: servers,
  });
  if (isJsonRpcError(result)) {
    throw new ACPSessionError('prompt_failed', `session/load failed: ${result.message}`, result);
  }
  ctx.setSessionId(sessionId);
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
  if (ctx.sessionId) {
    await ctx.closeSession();
  }

  const servers = filterMcpServers(ctx.agentCapabilities, mcpServers ?? ctx.opts.mcpServers);
  const id = ctx.allocId();
  const result = await ctx.sendRequest(id, 'session/resume', {
    sessionId,
    cwd: cwd ?? ctx.opts.cwd ?? ctx.opts.projectRoot,
    mcpServers: servers,
  });
  if (isJsonRpcError(result)) {
    throw new ACPSessionError('prompt_failed', `session/resume failed: ${result.message}`, result);
  }
  ctx.setSessionId(sessionId);
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
  value: string,
): Promise<void> {
  if (ctx.closed) throw new ACPSessionError('closed', 'session is closed');
  const id = ctx.allocId();
  const result = await ctx.sendRequest(id, 'session/set_config_option', {
    sessionId,
    configId,
    value,
  });
  if (isJsonRpcError(result)) {
    throw new ACPSessionError(
      'prompt_failed',
      `session/set_config_option failed: ${result.message}`,
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
  const id = ctx.allocId();
  const result = await ctx.sendRequest(id, 'session/new', {
    cwd: ctx.opts.cwd ?? ctx.opts.projectRoot,
    mcpServers: servers,
  });
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
  return sessionId as SessionId;
}
