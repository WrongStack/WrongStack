/**
 * Session route handler helpers and shared types.
 * Extracted from session-handlers.ts to keep handler modules focused and manageable.
 */

import type { Agent, Context, TodoItem } from '@wrongstack/core/agent';
import type { createStrategyCompactor } from '@wrongstack/core/execution';
import type { EventBus } from '@wrongstack/core/kernel';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { SessionLoadProgress, SessionStore, TokenCounter } from '@wrongstack/core/types';
import { sessionScopedPath } from '@wrongstack/core/utils';
import {
  buildReplayPayload,
  MAX_OPEN_SESSIONS_PER_CONNECTION,
  type ReplaySource,
} from '@wrongstack/webui-protocol';
import type { WebSocket } from 'ws';
import type { CustomModeStore } from './custom-context-modes.js';
import type { LoadAgentSessions } from './session-agent-sessions.js';
import type { SessionIdentityTarget } from './standalone-session-identity.js';
import type { ConnectedClient } from './types.js';
import { broadcastAll, send } from './ws-utils.js';

export type Session = Awaited<ReturnType<SessionStore['create']>>;
export type WSMessageLike = { type: string; payload?: unknown | undefined };
export type OutboundMessage = { type: string; payload: unknown };

export function isRecordPayload(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export type SessionStartPayload = {
  sessionId: string;
  startedAt?: string | undefined;
  model: string;
  provider: string;
  maxContext: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  projectName: string;
  projectRoot: string;
  cwd: string;
  mode: string;
  contextMode: string;
};
/**
 * Every session a connected surface is currently displaying.
 *
 * `client.sessionId` alone is the tab the connection last acted on; a WebUI
 * page holds up to four on one socket and declares them with
 * `session.subscribe`. Deleting or garbage-collecting a session that a
 * background tab is showing is the same class of bug as broadcasting to the
 * wrong tab, so both guards read the declared set.
 */
export function collectDisplayedSessionIds(ctx: {
  getSession: () => { id: string };
  // Structural, not `Map<WebSocket, ConnectedClient>`: the embedded CLI host
  // keeps its own, narrower client record, and this helper reads only these
  // two fields. Naming the full type here made the shared rule unusable from
  // the host that needed it most.
  clients?:
    | {
        values(): Iterable<{
          sessionId?: string | null | undefined;
          sessionIds?: ReadonlySet<string> | undefined;
        }>;
      }
    | undefined;
}): string[] {
  const ids = new Set<string>();
  ids.add(ctx.getSession().id);
  for (const client of ctx.clients?.values() ?? []) {
    // The declared set is authoritative for a multi-tab page — the same rule
    // `clientWantsSession` applies to delivery. `client.sessionId` is the tab
    // last acted on and goes stale the moment the foreground moves without a
    // session-tagged message in between; honoring it here would keep a closed
    // tab's session "displayed" forever and permanently refuse its deletion.
    if (client.sessionIds && client.sessionIds.size > 0) {
      for (const id of client.sessionIds) ids.add(id);
    } else if (client.sessionId) {
      ids.add(client.sessionId);
    }
  }
  return Array.from(ids);
}

/**
 * Is this session on someone's SCREEN right now?
 *
 * Deliberately narrower than `collectDisplayedSessionIds`, which also folds in
 * the runtime's own current session. The question here is "does a surface
 * exist that could stop this run" — and only a client tab has a Stop button.
 */
export function displayedByAnyClient(
  ctx: { clients?: Map<WebSocket, ConnectedClient> | undefined },
  sessionId: string,
): boolean {
  // A host that tracks no connections cannot prove the session is off-screen,
  // so it answers "displayed" and keeps the plain refusal.
  if (!ctx.clients) return true;
  for (const client of ctx.clients.values()) {
    if (client.sessionIds && client.sessionIds.size > 0) {
      if (client.sessionIds.has(sessionId)) return true;
    } else if (client.sessionId === sessionId) {
      return true;
    }
  }
  return false;
}

/** How long `session.delete` waits for an aborted run to unwind. */
export const RUN_STOP_GRACE_MS = 2000;

/**
 * Poll until an aborted run has actually released its lock.
 *
 * `abortActiveRun` only signals; the controller is removed by the run's own
 * `finally`, one microtask-plus-unwind later. Deleting the journal underneath
 * a run still writing to it is exactly the corruption the refusal exists to
 * prevent, so the delete waits for the lock to clear rather than assuming it.
 */
export async function waitForRunToStop(
  ctx: { isRunActive?: ((sessionId?: string) => boolean) | undefined },
  sessionId: string,
  graceMs: number = RUN_STOP_GRACE_MS,
): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  while (ctx.isRunActive?.(sessionId)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/**
 * Hard ceiling on declared tabs per connection.
 *
 * Imported rather than restated: the browser allocates its lanes and tab slots
 * against the same number, and a server that trimmed a set the client believed
 * it had declared would drop those tabs' traffic without telling anyone.
 */
export const MAX_SUBSCRIBED_SESSIONS = MAX_OPEN_SESSIONS_PER_CONNECTION;

export interface SessionHandlersContext {
  config: { provider: string; model: string };
  getConfig?: () => { provider: string; model: string };
  clients?: Map<WebSocket, ConnectedClient>;
  /** Host-neutral transport adapters. Standalone callers may keep using `clients`. */
  sendMessage?: (ws: WebSocket, message: OutboundMessage) => void;
  broadcastMessage?: (message: OutboundMessage) => void;
  context: Context;
  events?: EventBus | undefined;
  toolRegistry?: Pick<ToolRegistry, 'list'>;
  listTools?: () => ReturnType<ToolRegistry['list']>;
  compactor?: ReturnType<typeof createStrategyCompactor>;
  getCompactor?: () => ReturnType<typeof createStrategyCompactor> | undefined;
  customModeStore?: CustomModeStore;
  getCustomModeStore?: () => CustomModeStore | Promise<CustomModeStore>;
  tokenCounter: TokenCounter;
  /** Live reads of the mutable startWebUI bindings. */
  getProjectRoot: () => string;
  getSession: () => Session;
  getSessionStore: () => SessionStore;
  /** Hosts without a wired durable store may keep session.new as an in-memory reset. */
  canSwapSessions?: () => boolean;
  sessionsDir?: string;
  getSessionsDir?: () => string;
  /** Mutations of the startWebUI bindings. */
  setSession: (s: Session) => void;
  setSessionStartedAt?: (t: number) => void;
  /** Atomically reserve an explicitly selected session before opening its writer. */
  claimSession?: ((sessionId: string) => Promise<() => Promise<void>>) | undefined;
  onBeforeSessionTodosReplaced?:
    | ((sessionId: string, sessionsDir: string) => void | Promise<void>)
    | undefined;
  onSessionSwapped?: (sessionId: string, target?: SessionIdentityTarget) => void | Promise<void>;
  /**
   * Abort the in-flight agent run (if any) before the active session is
   * swapped. Without this, a run started in the previous session keeps
   * streaming/tool-calling in the background after session.new/resume.
   */
  /** When sessionId is provided, abort only that session's run; otherwise abort all. */
  abortActiveRun?: ((sessionId?: string) => void) | undefined;
  isRunActive?: ((sessionId?: string) => boolean) | undefined;
  hasSession?: ((id: string) => boolean) | undefined;
  /**
   * Does this host ALREADY hold an open writer for this session?
   *
   * Distinct from `hasSession`, which every multi-session host answers `true`
   * to (it only says "this runtime can serve that id"). Re-opening the journal
   * for a session that is already live leaks a second `FileSessionWriter` and
   * file handle onto the same file, and with four tabs that happens on every
   * single tab click. Hosts that cannot tell leave it undefined and keep the
   * old behaviour.
   */
  isSessionLive?: ((id: string) => boolean) | undefined;
  /**
   * Sessions that just stopped being displayed by ANY connection.
   *
   * A closed tab leaves its per-session agent — context, transcript, open
   * journal writer — behind, and nothing ever asked for it again. The host
   * uses this to retire them; it must still refuse to retire one whose run is
   * live, because a background run outlives the tab that started it.
   */
  onSessionsUndisplayed?: ((sessionIds: string[]) => void) | undefined;
  getAgent?: ((sessionId?: string) => Agent) | undefined;
  /**
   * Non-creating registry lookup for READ paths. `getAgent` CREATES on read
   * (and can evict a live tab's agent to make room), so a read such as
   * `context.debug` resolves through this when the host supplies one. A miss
   * here must surface as an explicit "not available" answer — never a silent
   * fallback to the shared root context, which belongs to whichever session
   * the runtime currently points at.
   */
  peekAgent?: ((sessionId?: string) => Agent | undefined) | undefined;
  sessionStartPayload: (overrides?: Record<string, unknown>) => Promise<SessionStartPayload>;
  systemPrompt?: { applyVariant?: (variant: string) => Promise<void> } | undefined;
  /**
   * Host-owned serialiser shared with `createConversationOperations`. When
   * omitted the handlers create a private one, which still orders session
   * transitions against each other but not against run setup.
   */
  withSessionTransition?: (<T>(operation: () => Promise<T>) => Promise<T>) | undefined;
  /**
   * Read back the transcripts of NAMED subagents (see
   * `session-agent-sessions.ts`). Hosts that run a fleet supply it; hosts that
   * do not leave it undefined and their replays simply carry no subagents.
   */
  loadAgentSessions?: LoadAgentSessions | undefined;
}

/**
 * Serialiser for operations that re-point a session's runtime context.
 *
 * Session transitions (session.new / session.resume) swap writers, contexts
 * and todo sidecars in several steps. A turn that begins mid-swap would read
 * a half-applied context, so `user_message` setup runs through the SAME gate
 * — which is why this is created once per host and shared, rather than being
 * private to the session handlers.
 *
 * Only the SETUP is gated; agent runs proceed outside it so four tabs still
 * stream concurrently.
 */
export function createSessionTransitionGate(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const current = tail.then(operation, operation);
    tail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };
}
/**
 * Live session window for policy resolution: the effective limit (probe /
 * model-switch wiring writes it) first, the provider capability as fallback,
 * 0 when unknown.
 */
export function readSessionWindowTokens(context: Context): number {
  const meta = context.meta?.['effectiveMaxContext'];
  if (typeof meta === 'number' && Number.isFinite(meta) && meta > 0) return meta;
  const cap = context.provider?.capabilities?.maxContext;
  return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : 0;
}

export interface SessionHandlerShared {
  ctx: SessionHandlersContext;
  currentConfig: () => { provider: string; model: string };
  sendTo: (ws: WebSocket, message: OutboundMessage) => void;
  sendSessionStart: (ws: WebSocket, payload: unknown) => void;
  sendTodosUpdated: (ws: WebSocket, payload: unknown) => void;
  broadcastToAll: (message: OutboundMessage) => void;
  result: (ws: WebSocket, success: boolean, message: string) => void;
  sendResumeProgress: (
    ws: WebSocket,
    sessionId: string,
    stage: string,
    progress?: SessionLoadProgress,
  ) => void;
  sessionsDirectory: () => string;
  resetContextAccounting: () => void;
  activateSession: (
    next: Session,
    messages: Context['messages'],
    usage?: Parameters<TokenCounter['account']>[0],
    todos?: TodoItem[],
    lastRequestTokens?: number | undefined,
  ) => Promise<void>;
  modeStore: () => Promise<CustomModeStore>;
  currentSessionId: () => string;
  sessionPayload: <T extends object>(payload: T) => T & { sessionId: string };
  requestedSessionId: (msg: WSMessageLike) => string | undefined;
  replacedSessionId: (msg: WSMessageLike) => string | undefined;
  peekForRead: (sessionId: string) => Agent | undefined;
  replaySourceFor: (sessionId: string) => Promise<ReplaySource | undefined>;
  sendSessionReplay: (ws: WebSocket, sessionId: string) => Promise<void>;
  contextForMessage: (msg: WSMessageLike) => Context | null;
  sendContextUnavailable: (ws: WebSocket, msg: WSMessageLike, op: string) => void;
  actingSessionId: (msg: WSMessageLike) => string;
  ensureCurrentSession: (ws: WebSocket, msg: WSMessageLike, op: string) => boolean;
  serializeSessionTransition: <T>(operation: () => Promise<T>) => Promise<T>;
  finalizeSession: (writer: Session) => Promise<void>;
}

export function buildSessionHandlerShared(ctx: SessionHandlersContext): SessionHandlerShared {
  const currentConfig = (): { provider: string; model: string } => ctx.getConfig?.() ?? ctx.config;
  const sendTo = (ws: WebSocket, message: OutboundMessage): void => {
    if (ctx.sendMessage) ctx.sendMessage(ws, message);
    else send(ws, message);
  };
  const sendSessionStart = (ws: WebSocket, payload: unknown): void => {
    sendTo(ws, { type: 'session.start', payload });
    if (ctx.broadcastMessage) {
      ctx.broadcastMessage({ type: 'session.start', payload });
    }
  };
  const sendTodosUpdated = (ws: WebSocket, payload: unknown): void => {
    sendTo(ws, { type: 'todos.updated', payload });
    if (ctx.broadcastMessage) {
      ctx.broadcastMessage({ type: 'todos.updated', payload });
    }
  };
  const broadcastToAll = (message: OutboundMessage): void => {
    if (ctx.broadcastMessage) ctx.broadcastMessage(message);
    else broadcastAll(ctx.clients ?? new Map(), message);
  };
  const result = (ws: WebSocket, success: boolean, message: string): void => {
    sendTo(ws, { type: 'key.operation_result', payload: { success, message } });
  };
  const sendResumeProgress = (
    ws: WebSocket,
    sessionId: string,
    stage: string,
    progress?: SessionLoadProgress,
  ): void => {
    sendTo(ws, {
      type: 'session.resume_progress',
      payload: {
        sessionId,
        stage,
        loadedBytes: progress?.loadedBytes ?? 0,
        totalBytes: progress?.totalBytes ?? 0,
      },
    });
  };
  const sessionsDirectory = (): string =>
    ctx.getSessionsDir?.() ?? ctx.sessionsDir ?? `${ctx.getProjectRoot()}/.wrongstack/sessions`;
  const resetContextAccounting = (): void => {
    ctx.context.lastRequestTokens = undefined;
    ctx.context.lastRealInputTokens = undefined;
    ctx.context.state.deleteMeta?.('lastRequestTokensAt');
    ctx.context.state.deleteMeta?.('totalUsage');
    ctx.context.state.deleteMeta?.('realAnchorMsgCount');
  };
  const activateSession = async (
    next: Session,
    messages: Context['messages'],
    usage?: Parameters<TokenCounter['account']>[0],
    todos: TodoItem[] = [],
    /**
     * Size of this session's LAST prompt, from its journal — the number the
     * context-fill bar means. Distinct from `usage`, which is the session's
     * running total and belongs to the cost readout only. See
     * {@link projectLastRequestTokens}; omitted by callers with no event
     * stream (a brand-new session), which correctly leaves the estimate unset.
     */
    lastRequestTokens?: number | undefined,
  ): Promise<void> => {
    // Resolve the TARGET session's agent while the runtime still reports the
    // previous session as current. `getAgent` adopts the shared root agent
    // when the id it is handed matches the live session, so re-pointing first
    // would hand a session that is mid-run to the incoming tab — and the very
    // next `replaceMessages` would wipe that run's transcript.
    const targetAgent = ctx.getAgent?.(next.id);
    const targetCtx = targetAgent?.ctx ?? ctx.context;
    const isRunning = ctx.isRunActive?.(next.id) ?? false;

    ctx.setSession(next);
    targetCtx.session = next;

    if (!isRunning) {
      targetCtx.state.replaceMessages(messages);
      await targetCtx.flushConversationJournal?.().catch(() => undefined);
      await ctx.onBeforeSessionTodosReplaced?.(next.id, sessionsDirectory());
      targetCtx.state.replaceTodos(todos);
      // The counter belongs to the session being activated; the shared one is
      // only a safe fallback when that session IS the root context.
      (
        targetCtx.tokenCounter ?? (targetCtx === ctx.context ? ctx.tokenCounter : undefined)
      )?.reset?.();
      if (targetCtx === ctx.context) {
        resetContextAccounting();
      }
      targetCtx.clearMemoryEvidence?.();
      targetCtx.readFiles.clear();
      targetCtx.fileMtimes.clear();
    }
    targetCtx.state.setMeta?.(
      'plan.path',
      sessionScopedPath(sessionsDirectory(), next.id, '.plan.json'),
    );
    targetCtx.state.setMeta?.(
      'task.path',
      sessionScopedPath(sessionsDirectory(), next.id, '.tasks.json'),
    );
    if (usage && !isRunning) {
      (targetCtx.tokenCounter ?? ctx.tokenCounter).account(
        usage,
        currentConfig().model,
        targetCtx.provider?.id ?? ctx.context.provider.id,
      );
    }
    // The context-fill estimate is the LAST request's prompt, never the
    // session's running total. This used to read `usage.input` — the sum of
    // every request the session ever made — so resuming a long conversation
    // published a nine-million-token estimate against a one-million-token
    // window. A session with no journalled response leaves it unset rather
    // than publishing a zero, which the bar would draw as "0% full".
    if (!isRunning && typeof lastRequestTokens === 'number' && lastRequestTokens > 0) {
      targetCtx.lastRequestTokens = lastRequestTokens;
    }
    const originalStartedAt = Date.parse(next.startedAt ?? '');
    ctx.setSessionStartedAt?.(Number.isFinite(originalStartedAt) ? originalStartedAt : Date.now());
    await ctx.onSessionSwapped?.(next.id);
  };
  const modeStore = async (): Promise<CustomModeStore> => {
    const store = ctx.getCustomModeStore ? await ctx.getCustomModeStore() : ctx.customModeStore;
    if (!store) throw new Error('Context mode store not available');
    return store;
  };
  const currentSessionId = (): string => ctx.getSession().id;
  const sessionPayload = <T extends object>(payload: T): T & { sessionId: string } => {
    const provided = (payload as { sessionId?: unknown }).sessionId;
    const sessionId =
      typeof provided === 'string' && provided.length > 0 ? provided : currentSessionId();
    return { ...payload, sessionId };
  };
  const requestedSessionId = (msg: WSMessageLike): string | undefined => {
    const payload = msg.payload;
    return payload &&
      typeof payload === 'object' &&
      typeof (payload as { sessionId?: unknown }).sessionId === 'string'
      ? (payload as { sessionId: string }).sessionId
      : undefined;
  };
  /**
   * Explicit "retire this session as part of the same operation" target.
   * Deliberately a DIFFERENT key from `sessionId` (which merely says which
   * session the request originated from) so routing context can never be
   * mistaken for a destructive intent.
   */
  const replacedSessionId = (msg: WSMessageLike): string | undefined => {
    const payload = msg.payload;
    const value =
      payload && typeof payload === 'object'
        ? (payload as { replaceSessionId?: unknown }).replaceSessionId
        : undefined;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };
  // Read-only lookups MUST go through peekAgent when the host supplies one —
  // a registry-backed getAgent CREATES on read and can evict a live tab's
  // agent to make room. Hosts WITHOUT peekAgent have no registry (their
  // getAgent is the single root agent and cannot evict), so falling back to
  // it there preserves the old behaviour without the hazard.
  const peekForRead = (sessionId: string): Agent | undefined =>
    ctx.peekAgent ? ctx.peekAgent(sessionId) : ctx.getAgent?.(sessionId);
  /**
   * Send one session's transcript to one socket, without touching anything.
   *
   * Deliberately NOT a resume: no writer is opened, no claim is taken, the
   * runtime's current session does not move, and the client is not marked as
   * acting on this id. It is a redisplay — the answer to "this tab is on
   * screen again, what does it say?".
   *
   * Served from the JOURNAL whenever the journal is not behind, live session
   * or not: the markers the pane draws are projected from events, and a
   * context's in-memory transcript has none. The live working set is the
   * fallback for a session whose journal cannot be read or has not caught up.
   */
  /**
   * The best replay source for one session: its JOURNAL, falling back to the
   * live working set.
   *
   * The journal comes first even when the session is live in this runtime. A
   * context's in-memory transcript is messages and nothing else, while every
   * mark the pane draws around them — audit marks, checkpoints, and the
   * `tool_call_end` records behind the tool cards' duration and size chips —
   * is projected from EVENTS. Replaying a live tab from memory therefore
   * brought it back as a wall of plain text: the same conversation, visibly
   * not the same session.
   *
   * The journal trails memory by at most one flush window of non-critical
   * records (every record that carries a message is critical and lands
   * immediately), so the only way it can be short is mid-turn — and the length
   * check keeps memory in that case rather than truncating.
   *
   * Shared by BOTH replay paths. `sendSessionReplay` (redisplay) had this
   * fixed while `resumeSession`'s already-live branch still passed
   * `events: []`, so which of the two the client happened to trigger decided
   * whether its markers and tool timings came back.
   */
  const replaySourceFor = async (sessionId: string): Promise<ReplaySource | undefined> => {
    const liveCtx = peekForRead(sessionId)?.ctx;
    const live: ReplaySource | undefined =
      liveCtx && liveCtx.session?.id === sessionId
        ? {
            messages: liveCtx.state?.messages ?? [],
            events: [],
            usage: { input: liveCtx.lastRequestTokens ?? 0, output: 0 },
          }
        : undefined;
    // Defensive: a store that cannot read (no `load`, an unreadable file, a
    // deleted journal) must degrade to the working set, never break the
    // resume. This runs on a path a tab click can reach.
    const stored = await Promise.resolve()
      .then(() => ctx.getSessionStore().load(sessionId))
      .then((data) =>
        Array.isArray(data?.messages)
          ? { messages: data.messages, events: data.events, usage: data.usage }
          : undefined,
      )
      .catch(() => undefined);
    return stored && stored.messages.length >= (live?.messages.length ?? 0) ? stored : live;
  };

  const sendSessionReplay = async (ws: WebSocket, sessionId: string): Promise<void> => {
    const isRunning = ctx.isRunActive?.(sessionId) ?? false;
    const source = await replaySourceFor(sessionId);
    if (!source || source.messages.length === 0) return;
    sendTo(ws, {
      type: 'session.start',
      payload: await ctx.sessionStartPayload({
        sessionId,
        isRunning,
        // Tells the client this frame was ASKED for, so its transcript may
        // replace what the pane is showing. Every other `session.start` for a
        // tab that is not in front must leave that tab's lane alone — see
        // `handleSessionStart`.
        replayReason: 'redisplay',
        ...buildReplayPayload(source),
      }),
    });
  };
  /**
   * Resolve the Context belonging to the session that SENT this message.
   * With up to four tabs live, `ctx.context` (the shared root) is only
   * coincidentally the caller's session — reading it directly leaks one
   * tab's transcript into another tab's request.
   */
  const contextForMessage = (msg: WSMessageLike): Context | null => {
    const requested = requestedSessionId(msg);
    if (!requested) return ctx.context;
    // READ path: resolve through peekForRead — never CREATE on a host that
    // declares a peek. A displayed-but-not-live session must not be served
    // from a materialised phantom, and it must never fall back to the shared
    // root context, which belongs to whichever tab is in front — Compact
    // pressed in a stale tab used to operate on the foreground tab's
    // conversation. The current session keeps ctx.context as its answer; a
    // foreign miss returns null and the caller refuses.
    const agent = peekForRead(requested);
    if (agent) return agent.ctx;
    return requested === currentSessionId() ? ctx.context : null;
  };
  const sendContextUnavailable = (ws: WebSocket, msg: WSMessageLike, op: string): void => {
    const requested = requestedSessionId(msg);
    // `requestedSessionId` must stay OFF this frame: the webui client swallows
    // requestedSessionId-bearing error frames as session-swap guard noise, so
    // the refusal would never reach the tab that asked. The message text
    // already names the session.
    sendTo(ws, {
      type: 'error',
      payload: sessionPayload({
        phase: op,
        message: `Session ${requested ?? ''} is not live in this runtime. Reopen or resume the tab, then refresh.`,
        sessionId: actingSessionId(msg),
      }),
    });
  };
  /**
   * The session a request ACTS ON: the one it named, else the foreground.
   *
   * Everything below that reads or mutates a conversation — clear, compact,
   * repair, rewind, the context editor, the context-window mode — used to work
   * on `ctx.context`, the shared root. With four tabs live that is the tab the
   * runtime happens to be pointing at, not the tab whose button was pressed:
   * pressing Compact in tab 3 compacted tab 1, and Rewind cut a conversation
   * the user was not looking at.
   */
  const actingSessionId = (msg: WSMessageLike): string =>
    requestedSessionId(msg) ?? currentSessionId();
  const ensureCurrentSession = (ws: WebSocket, msg: WSMessageLike, op: string): boolean => {
    const requested = requestedSessionId(msg);
    const current = currentSessionId();
    if (!requested || requested === current) return true;
    if (ctx.hasSession?.(requested)) return true;
    sendTo(ws, {
      type: 'error',
      payload: sessionPayload({
        phase: op,
        message: `Request targeted session ${requested}, but this WebUI runtime is currently on ${current}.`,
        requestedSessionId: requested,
      }),
    });
    return false;
  };
  // Shared with the conversation ops when the host wires one, so a turn's
  // setup and a session swap can never interleave.
  const serializeSessionTransition = ctx.withSessionTransition ?? createSessionTransitionGate();
  const finalizeSession = async (writer: Session): Promise<void> => {
    // This session's own usage, not the process total. Sharing one counter
    // across four tabs stamped every `session_end` with the sum of all of them.
    // Read-only lookup (peek when the host supplies it): creating an agent
    // just to READ its counter could evict a live tab's agent; a miss falls
    // back to the shared counter as before.
    const counter = peekForRead(writer.id)?.ctx.tokenCounter ?? ctx.tokenCounter;
    await writer
      .append({
        type: 'session_end',
        ts: new Date().toISOString(),
        usage: counter.total(),
      })
      .catch(() => undefined);
    await writer.close().catch(() => undefined);
  };

  return {
    ctx,
    currentConfig,
    sendTo,
    sendSessionStart,
    sendTodosUpdated,
    broadcastToAll,
    result,
    sendResumeProgress,
    sessionsDirectory,
    resetContextAccounting,
    activateSession,
    modeStore,
    currentSessionId,
    sessionPayload,
    requestedSessionId,
    replacedSessionId,
    peekForRead,
    replaySourceFor,
    sendSessionReplay,
    contextForMessage,
    sendContextUnavailable,
    actingSessionId,
    ensureCurrentSession,
    serializeSessionTransition,
    finalizeSession,
  };
}
