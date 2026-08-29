/**
 * Session route handlers — extracted from the startWebUI closure in index.ts.
 * The largest builder: session lifecycle (new/clear/resume/save), context ops
 * (debug/compact/repair), context-mode CRUD, and checkpoint list/rewind.
 *
 * Mirrors createProviderHandlers/createModeHandlers/createProjectHandlers. The
 * mutable startWebUI bindings the handlers touch (`session`, `sessionStartedAt`,
 * and the project-switch-mutable `sessionStore`/`projectRoot`) are threaded in
 * as getters/setters so this stays a pure function of its context. Handler
 * bodies are a verbatim lift — only dependency references changed.
 */

import type { Agent, Context, TodoItem } from '@wrongstack/core/agent';
import type { createStrategyCompactor } from '@wrongstack/core/execution';
import type { EventBus } from '@wrongstack/core/kernel';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { loadTodosCheckpoint } from '@wrongstack/core/storage';
import type { SessionStore, TokenCounter } from '@wrongstack/core/types';
import {
  CONTEXT_WINDOW_MODE_PINNED_META_KEY,
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  isContextWindowModeId,
  resolveContextWindowPolicy,
} from '@wrongstack/core/types';
import { mailboxSessionTag } from '@wrongstack/core/coordination';
import { repairToolUseAdjacency, sessionScopedPath } from '@wrongstack/core/utils';
import { buildReplayPayload, type ReplaySource } from '@wrongstack/webui-protocol';
import type { WebSocket } from 'ws';
import {
  applyContextEditorProposal,
  buildContextEditorSnapshot,
  validateContextEditorProposal,
} from './context-editor.js';
import type { CustomModeStore } from './custom-context-modes.js';
import { deleteWebUISession } from './session-deletion.js';
import type { LoadAgentSessions } from './session-agent-sessions.js';
import { buildInspectPayload, toSessionHistoryEntries } from './session-history.js';
import type { SessionRouteHandlers } from './session-routes.js';
import type { SessionIdentityTarget } from './standalone-session-identity.js';
import { estimateContextBreakdown } from './token-estimator.js';
import type { ConnectedClient } from './types.js';
import {
  validateContextModeCreatePayload,
  validateContextModeDeletePayload,
  validateContextModeSwitchPayload,
  validateContextModeUpdatePayload,
} from './ws-payload-validation.js';
import { broadcastAll, errMessage, send } from './ws-utils.js';

type Session = Awaited<ReturnType<SessionStore['create']>>;
type WSMessageLike = { type: string; payload?: unknown | undefined };
type OutboundMessage = { type: string; payload: unknown };

function isRecordPayload(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
type SessionStartPayload = {
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
function displayedByAnyClient(
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
const RUN_STOP_GRACE_MS = 2000;

/**
 * Poll until an aborted run has actually released its lock.
 *
 * `abortActiveRun` only signals; the controller is removed by the run's own
 * `finally`, one microtask-plus-unwind later. Deleting the journal underneath
 * a run still writing to it is exactly the corruption the refusal exists to
 * prevent, so the delete waits for the lock to clear rather than assuming it.
 */
async function waitForRunToStop(
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

/** Hard ceiling on declared tabs per connection — mirrors the UI's four slots. */
const MAX_SUBSCRIBED_SESSIONS = 4;

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

export function createSessionHandlers(ctx: SessionHandlersContext): SessionRouteHandlers {
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
      if (typeof usage.input === 'number' && usage.input > 0) {
        targetCtx.lastRequestTokens = usage.input;
      }
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
    newSession: (ws, msg) =>
      serializeSessionTransition(async () => {
        if (!ensureCurrentSession(ws, msg, 'session.new')) return;
        const requestedVariant = (msg as { payload?: { systemPromptVariant?: unknown } })?.payload
          ?.systemPromptVariant;
        if (typeof requestedVariant === 'string' && ctx.systemPrompt?.applyVariant) {
          try {
            await ctx.systemPrompt.applyVariant(requestedVariant);
          } catch {
            // best-effort
          }
        }
        // `session.new` opens an ADDITIONAL session (a new WebUI tab). It must
        // never touch an existing one. The old code read `payload.sessionId` —
        // which every client stamps with the *currently active* session — as
        // "the session being replaced", then aborted its run and closed its
        // journal writer. Opening a tab killed whatever was running.
        //
        // Replacement is now opt-in and explicit: only `replaceSessionId`
        // requests it, and only for a session that actually exists.
        const explicitTarget = replacedSessionId(msg);
        if (explicitTarget) {
          try {
            ctx.abortActiveRun?.(explicitTarget);
          } catch {
            // best-effort
          }
        }
        const clearedSessionId = explicitTarget;
        if (ctx.canSwapSessions?.() !== false) {
          const store = ctx.getSessionStore();
          const config = currentConfig();
          const next = await store.create({
            id: '',
            title: '',
            model: config.model,
            provider: config.provider,
          });
          let rollbackClaim: (() => Promise<void>) | undefined;
          let activated = false;
          try {
            rollbackClaim = await ctx.claimSession?.(next.id);
            if (explicitTarget) {
              const current = ctx.getSession();
              if (current.id === explicitTarget) {
                await ctx.context.flushConversationJournal?.().catch(() => undefined);
                await finalizeSession(current);
              }
            }
            // activateSession cannot fail before replacing the runtime writer:
            // finalizeSession is best-effort and setSession is synchronous.
            activated = true;
            await activateSession(next, []);
          } catch (err) {
            if (!activated) {
              await rollbackClaim?.().catch(() => undefined);
              await next.close().catch(() => undefined);
              await store.delete(next.id).catch(() => undefined);
            }
            result(ws, false, errMessage(err));
            return;
          }
        } else {
          try {
            ctx.abortActiveRun?.(clearedSessionId ?? currentSessionId());
          } catch {
            // Aborting is best-effort
          }
          ctx.context.state.replaceMessages([]);
          ctx.context.state.replaceTodos([]);
          resetContextAccounting();
          ctx.context.clearMemoryEvidence?.();
          ctx.context.readFiles.clear();
          ctx.context.fileMtimes.clear();
          ctx.tokenCounter.reset?.();
        }
        const nextId = ctx.getSession().id;
        const client = ctx.clients?.get(ws);
        if (client) {
          client.sessionId = nextId;
        }
        const startPayload = await ctx.sessionStartPayload({
          reset: true,
          ...(clearedSessionId ? { clearedSessionId } : {}),
          sessionId: nextId,
        });
        sendSessionStart(ws, startPayload);
        try {
          const list = await ctx.getSessionStore().list(200);
          broadcastToAll({
            type: 'sessions.list',
            payload: {
              sessions: toSessionHistoryEntries(list, nextId),
            },
          });
        } catch {
          // best-effort
        }
      }),
    clearContext: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.clear')) return;
      const target = contextForMessage(msg);
      if (!target) {
        sendContextUnavailable(ws, msg, 'context.clear');
        return;
      }
      target.state.replaceMessages([]);
      target.state.replaceTodos([]);
      // This session's own counter. Falling back to the shared one is only
      // safe for the root context — doing it for a session agent would zero
      // the numbers of the three tabs beside it.
      const counter =
        target.tokenCounter ?? (target === ctx.context ? ctx.tokenCounter : undefined);
      counter?.reset?.();
      // The meta keys `resetContextAccounting` clears live on the root context.
      if (target === ctx.context) resetContextAccounting();
      target.clearMemoryEvidence?.();
      target.readFiles.clear();
      target.fileMtimes.clear();
      result(ws, true, 'Context cleared');
      // The reset must describe AND name the session that was CLEARED. Built
      // without a sessionId override the payload describes the FOREGROUND
      // session (its model/provider/maxContext), and restamping only the id
      // still hydrated the cleared lane with the other tab's metadata —
      // `session.start` is the status bar's source of truth. The targeted
      // build is the same form `rewind` uses.
      broadcastToAll({
        type: 'session.start',
        payload: await ctx.sessionStartPayload({
          reset: true,
          sessionId: actingSessionId(msg),
        }),
      });
    },
    debugContext: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.debug')) return;
      // A named session is read from ITS OWN agent — resolved WITHOUT
      // creating one, always through `peekAgent`. `getAgent` is deliberately
      // NOT a fallback here: it CREATES on read, and on a full registry that
      // materialisation can evict a live tab's agent to make room — then
      // answer the breakdown with a phantom empty context. A host without
      // `peekAgent` gets the same explicit "not live" error a peekAgent miss
      // produces, which is what the peekAgent contract above already
      // mandates. The shared root context belongs to whichever session the
      // runtime currently points at; with four tabs on one socket that is
      // routinely a DIFFERENT tab, and serving it stamped with the
      // requester's id is exactly how one tab's breakdown modal rendered
      // another tab's tokens. `ctx.context` stays the answer only for the
      // runtime's own current session and for pre-session requests that name
      // no session at all.
      const requested = requestedSessionId(msg);
      const agent = requested ? ctx.peekAgent?.(requested) : undefined;
      const target =
        agent && agent.ctx.session?.id === requested
          ? agent.ctx
          : !requested || requested === currentSessionId()
            ? ctx.context
            : undefined;
      if (!target) {
        // Route through the shared refusal helper — it stamps the
        // ASKING tab's id (not the runtime's current one) and omits
        // `requestedSessionId`, which the webui client treats as a
        // session-swap guard marker and would swallow before delivery.
        sendContextUnavailable(ws, msg, 'context.debug');
        return;
      }
      const breakdown = estimateContextBreakdown({
        systemPrompt: target.systemPrompt,
        tools: ctx.listTools?.() ?? ctx.toolRegistry?.list() ?? [],
        messages: target.messages,
      });
      sendTo(ws, {
        type: 'context.debug',
        payload: {
          ...breakdown,
          mode: target.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID,
          policy: target.meta['contextWindowPolicy'],
          sessionId: actingSessionId(msg),
        },
      });
    },
    compactContext: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.compact')) return;
      const aggressive = !!(msg as { payload?: { aggressive?: boolean | undefined } }).payload
        ?.aggressive;
      try {
        const compactor = ctx.getCompactor?.() ?? ctx.compactor;
        if (!compactor) {
          result(ws, false, 'Compactor not available');
          return;
        }
        const target = contextForMessage(msg);
        if (!target) {
          sendContextUnavailable(ws, msg, 'context.compact');
          return;
        }
        const counter = target.tokenCounter ?? ctx.tokenCounter;
        const beforeUsage = counter.total();
        const report = await compactor.compact(target, { aggressive });
        const afterUsage = counter.total();
        const before =
          typeof report.before === 'number'
            ? report.before
            : beforeUsage.input + beforeUsage.output;
        const after =
          typeof report.after === 'number' ? report.after : afterUsage.input + afterUsage.output;
        sendTo(ws, {
          type: 'context.compacted',
          payload: sessionPayload({
            before,
            after,
            saved: Math.max(0, before - after),
            reductions: report.reductions ?? [],
            repaired: report.repaired ?? false,
          }),
        });
        result(
          ws,
          true,
          `Compacted: ${before} → ${after} tokens (saved ~${Math.max(0, before - after)})`,
        );
      } catch (err) {
        result(ws, false, errMessage(err));
      }
    },
    repairContext: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.repair')) return;
      const target = contextForMessage(msg);
      if (!target) {
        sendContextUnavailable(ws, msg, 'context.repair');
        return;
      }
      const beforeMessages = target.messages.length;
      const repaired = repairToolUseAdjacency(target.messages);
      if (repaired.report.changed) {
        target.state.replaceMessages(repaired.messages);
      }
      const payload = {
        sessionId: actingSessionId(msg),
        removedToolUses: repaired.report.removedToolUses,
        removedToolResults: repaired.report.removedToolResults,
        removedMessages: repaired.report.removedMessages,
        beforeMessages,
        afterMessages: target.messages.length,
      };
      broadcastToAll({ type: 'context.repaired', payload });
      const removed =
        payload.removedToolUses.length +
        payload.removedToolResults.length +
        payload.removedMessages;
      result(
        ws,
        true,
        removed > 0
          ? `Context repaired: removed ${removed} orphan protocol item(s)`
          : 'Context repair found no orphan protocol blocks',
      );
    },
    openContextEditor: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.editor.open')) return;
      const target = contextForMessage(msg);
      if (!target) {
        sendContextUnavailable(ws, msg, 'context.editor.open');
        return;
      }
      const snapshot = buildContextEditorSnapshot(
        target,
        ctx.listTools?.() ?? ctx.toolRegistry?.list(),
      );
      sendTo(ws, {
        type: 'context.editor.snapshot',
        payload: { ...snapshot, sessionId: actingSessionId(msg) },
      });
    },
    validateContextEditor: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.editor.validate')) return;
      const payload = isRecordPayload(msg.payload) ? msg.payload : {};
      const target = contextForMessage(msg);
      if (!target) {
        sendContextUnavailable(ws, msg, 'context.editor.validate');
        return;
      }
      const validation = validateContextEditorProposal({
        ctx: target,
        tools: ctx.listTools?.() ?? ctx.toolRegistry?.list(),
        baseRevision: typeof payload['baseRevision'] === 'string' ? payload['baseRevision'] : '',
        messages: payload['messages'],
        removals: payload['removals'],
        allowRepair: payload['allowRepair'] === true,
        runActive: ctx.isRunActive?.(requestedSessionId(msg) ?? currentSessionId()) === true,
      });
      sendTo(ws, {
        type: 'context.editor.validation',
        // Stamped with the ASKING session: `sessionPayload` alone would stamp
        // the runtime's current (root) session, so a background tab's edit
        // results were tagged for — and dropped by — the wrong lane.
        payload: sessionPayload({ ...validation, sessionId: actingSessionId(msg) }),
      });
    },
    applyContextEditor: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.editor.apply')) return;
      const payload = isRecordPayload(msg.payload) ? msg.payload : {};
      const target = contextForMessage(msg);
      if (!target) {
        sendContextUnavailable(ws, msg, 'context.editor.apply');
        return;
      }
      const applied = await applyContextEditorProposal({
        ctx: target,
        tools: ctx.listTools?.() ?? ctx.toolRegistry?.list(),
        baseRevision: typeof payload['baseRevision'] === 'string' ? payload['baseRevision'] : '',
        messages: payload['messages'],
        removals: payload['removals'],
        allowRepair: payload['allowRepair'] === true,
        runActive: ctx.isRunActive?.(requestedSessionId(msg) ?? currentSessionId()) === true,
      });
      if ('ok' in applied) {
        sendTo(ws, {
          type: 'context.editor.validation',
          // Same asking-session stamp as the validate path (see above).
          payload: sessionPayload({ ...applied, sessionId: actingSessionId(msg) }),
        });
        return;
      }
      broadcastToAll({
        type: 'context.editor.applied',
        payload: sessionPayload({ ...applied, sessionId: actingSessionId(msg) }),
      });
      result(
        ws,
        true,
        `Context editor applied: ${applied.before.messages} → ${applied.after.messages} messages`,
      );
    },
    listContextModes: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.modes.list')) return;
      const target = contextForMessage(msg);
      if (!target) {
        sendContextUnavailable(ws, msg, 'context.modes.list');
        return;
      }
      const active = String(target.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID);
      const store = await modeStore();
      const allModes = store.list().map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        isActive: m.id === active,
        thresholds: m.thresholds,
        preserveK: m.preserveK,
        eliseThreshold: m.eliseThreshold,
        custom: (m as { custom?: boolean }).custom === true,
      }));
      sendTo(ws, {
        type: 'context.modes.list',
        payload: { activeId: active, modes: allModes, sessionId: actingSessionId(msg) },
      });
    },
    switchContextMode: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.mode.switch')) return;
      const parsed = validateContextModeSwitchPayload(msg.payload);
      if (!parsed.ok) {
        result(ws, false, parsed.message);
        return;
      }
      const { id } = parsed.value;
      const target = contextForMessage(msg);
      if (!target) {
        sendContextUnavailable(ws, msg, 'context.mode.switch');
        return;
      }
      let policy = resolveContextWindowPolicy({}, id, readSessionWindowTokens(target));
      // A built-in id always resolves (a ≥1M window swaps the balanced default
      // to Deep); only a NON-built-in id that failed to resolve can be a custom
      // mode — without the guard, that swap would make "balanced" read as
      // unknown on a 1M session.
      if (!isContextWindowModeId(id) && policy.id !== id) {
        const customModes = (await modeStore())
          .list()
          .filter((m) => (m as { custom?: boolean }).custom === true);
        const custom = customModes.find((m) => m.id === id);
        if (!custom) {
          result(ws, false, `Unknown context mode "${id}"`);
          return;
        }
        policy = custom as never as typeof policy;
      }
      target.meta['contextWindowMode'] = policy.id;
      target.meta['contextWindowPolicy'] = policy;
      // The user picked this policy for the session — later window changes
      // (model switch) must not overwrite it.
      target.meta[CONTEXT_WINDOW_MODE_PINNED_META_KEY] = true;
      result(ws, true, `Context mode switched to ${policy.id}`);
      broadcastToAll({
        type: 'context.mode.changed',
        payload: {
          id: policy.id,
          name: policy.name,
          policy,
          sessionId: actingSessionId(msg),
        },
      });
    },
    createContextMode: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.mode.create')) return;
      const parsed = validateContextModeCreatePayload(msg.payload);
      if (!parsed.ok) {
        result(ws, false, parsed.message);
        return;
      }
      const payload = parsed.value;
      const store = await modeStore();
      const operation = store.create({
        id: payload.id,
        name: payload.name,
        description: payload.description,
        thresholds: payload.thresholds,
        preserveK: payload.preserveK,
        eliseThreshold: payload.eliseThreshold,
        custom: true,
        aggressiveOn: 'soft',
        targetLoad: 0.65,
      });
      if (operation.ok) await store.save().catch(() => undefined);
      result(ws, operation.ok, operation.error ?? `Mode "${payload.id}" created`);
    },
    updateContextMode: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.mode.update')) return;
      const parsed = validateContextModeUpdatePayload(msg.payload);
      if (!parsed.ok) {
        result(ws, false, parsed.message);
        return;
      }
      const payload = parsed.value;
      const store = await modeStore();
      const operation = store.update(payload.id, {
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.description !== undefined ? { description: payload.description } : {}),
        ...(payload.thresholds
          ? {
              thresholds: {
                warn: payload.thresholds.warn ?? 0.6,
                soft: payload.thresholds.soft ?? 0.75,
                hard: payload.thresholds.hard ?? 0.9,
              },
            }
          : {}),
        ...(payload.preserveK !== undefined ? { preserveK: payload.preserveK } : {}),
        ...(payload.eliseThreshold !== undefined ? { eliseThreshold: payload.eliseThreshold } : {}),
      });
      if (operation.ok) await store.save().catch(() => undefined);
      result(ws, operation.ok, operation.error ?? `Mode "${payload.id}" updated`);
    },
    deleteContextMode: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.mode.delete')) return;
      const parsed = validateContextModeDeletePayload(msg.payload);
      if (!parsed.ok) {
        result(ws, false, parsed.message);
        return;
      }
      const { id } = parsed.value;
      // A deleted mode has to be replaced everywhere it is in use, not just on
      // the tab that pressed delete — the mode store is project-wide, so a tab
      // left pointing at a mode that no longer exists resolves to nothing.
      const requestContext = contextForMessage(msg);
      if (!requestContext) {
        sendContextUnavailable(ws, msg, 'context.mode.delete');
        return;
      }
      const affected = new Set<Context>([ctx.context, requestContext]);
      for (const sessionId of collectDisplayedSessionIds(ctx)) {
        // Peek first: a displayed-but-not-live id is skipped, not materialised.
        const agentCtx = peekForRead(sessionId)?.ctx;
        if (agentCtx) affected.add(agentCtx);
      }
      for (const target of affected) {
        if (String(target.meta['contextWindowMode'] ?? '') !== id) continue;
        const policy = resolveContextWindowPolicy(
          {},
          DEFAULT_CONTEXT_WINDOW_MODE_ID,
          readSessionWindowTokens(target),
        );
        target.meta['contextWindowMode'] = policy.id;
        target.meta['contextWindowPolicy'] = policy;
        delete target.meta[CONTEXT_WINDOW_MODE_PINNED_META_KEY];
      }
      const store = await modeStore();
      const operation = store.remove(id);
      if (operation.ok) await store.save().catch(() => undefined);
      result(ws, operation.ok, operation.error ?? `Mode "${id}" deleted`);
    },
    listSessions: async (ws, msg) => {
      const limit = (msg as { payload?: { limit?: number | undefined } }).payload?.limit ?? 50;
      // "Current" means the session of the tab that ASKED, not the one the
      // runtime last switched to. The client keys several behaviours off the
      // flag — the resume button is disabled for it, the "active" filter
      // shows only it, and the empty-session sweep spares it — so answering
      // with the runtime's session disabled resume on a row the user was not
      // on and offered three live tabs' fresh sessions up for deletion.
      const askingSessionId = actingSessionId(msg);
      try {
        const list = await ctx.getSessionStore().list(limit);
        sendTo(ws, {
          type: 'sessions.list',
          payload: {
            sessionId: askingSessionId,
            sessions: toSessionHistoryEntries(list, askingSessionId),
          },
        });
      } catch (err) {
        sendTo(ws, {
          type: 'sessions.list',
          payload: { sessionId: askingSessionId, sessions: [], error: errMessage(err) },
        });
      }
    },
    deleteSession: async (ws, msg) => {
      const { id } = (msg as { payload: { id: string } }).payload;
      // The run check runs OUTSIDE the transition gate on purpose. Aborting a
      // wedged run and waiting for it to unwind can take up to
      // RUN_STOP_GRACE_MS, and the gate is shared with `user_message` setup —
      // holding it that long would stall the next turn in every OTHER tab for
      // a delete that concerns none of them.
      if (ctx.isRunActive?.(id)) {
        // A run whose tab is still open has a Stop button — refuse and let the
        // user press it. A run whose tab is GONE has no surface at all:
        // nothing can stop it, nothing can answer a permission prompt it is
        // blocked on, and nothing will ever release its lock. Refusing that
        // one forever is what turned a closed tab into an undeletable ghost,
        // so an explicit delete of an off-screen session stops the run first.
        if (displayedByAnyClient(ctx, id) || !ctx.abortActiveRun) {
          result(
            ws,
            false,
            'Cannot delete session while an agent run is active. Please stop the run first.',
          );
          return;
        }
        ctx.abortActiveRun(id);
        const stopped = await waitForRunToStop(ctx, id);
        if (!stopped) {
          result(
            ws,
            false,
            `Session ${id} has a run that did not stop within ${RUN_STOP_GRACE_MS}ms. Try again in a moment.`,
          );
          return;
        }
      }
      return serializeSessionTransition(async () => {
        try {
          // The pre-gate check above ran before this gate was acquired, and
          // runs proceed OUTSIDE the gate — only setup is serialised. A
          // queued or auto-submitted message can therefore start a turn in
          // the window between "run checked" and "gate held". Deleting under
          // a live run destroys the journal writer of an in-flight turn, so
          // the decision is re-made here, where it is finally safe to act on.
          if (ctx.isRunActive?.(id)) {
            result(
              ws,
              false,
              `Session ${id} started a run while the delete was being prepared. Stop the run and try again.`,
            );
            return;
          }
          // Deleting the runtime's CURRENT session would strand the host on a
          // record that no longer exists. A client that just closed that tab
          // tags the delete with the session it re-pointed the strip to; move
          // the host onto that live writer first — the same rebind
          // `session.resume` performs for an already-live session. Without a
          // live fallback named, the active-session guard below still refuses.
          const fallback = requestedSessionId(msg);
          if (
            ctx.getSession().id === id &&
            fallback &&
            fallback !== id &&
            ctx.isSessionLive?.(fallback)
          ) {
            const liveWriter = peekForRead(fallback)?.ctx?.session;
            if (liveWriter && liveWriter.id === fallback) {
              ctx.setSession(liveWriter);
              await ctx.onSessionSwapped?.(fallback);
            }
          }
          await deleteWebUISession(
            {
              getActiveSessionId: () => ctx.getSession().id,
              getActiveSessionIds: () => collectDisplayedSessionIds(ctx),
              getSessionStore: ctx.getSessionStore,
              refreshSessions: async () => {
                const list = await ctx.getSessionStore().list(200);
                broadcastToAll({
                  type: 'sessions.list',
                  payload: { sessions: toSessionHistoryEntries(list, ctx.getSession().id) },
                });
              },
            },
            id,
          );
          result(ws, true, `Session ${id} deleted`);
        } catch (err) {
          result(ws, false, errMessage(err));
        }
      });
    },
    renameSession: async (ws, msg) => {
      const payload = (msg as { payload?: { id?: unknown; name?: unknown } }).payload ?? {};
      const id = typeof payload.id === 'string' ? payload.id : '';
      const name = typeof payload.name === 'string' ? payload.name : '';
      if (!id) {
        result(ws, false, 'Session id is required');
        return;
      }
      try {
        await ctx.getSessionStore().rename(id, name);
        result(ws, true, name ? `Renamed session to "${name}"` : `Cleared session name`);
        // Broadcast the refreshed list so every open WebUI reflects the new name.
        try {
          const list = await ctx.getSessionStore().list(200);
          const currentId = ctx.getSession().id;
          broadcastToAll({
            type: 'sessions.list',
            payload: {
              sessions: toSessionHistoryEntries(list, currentId),
            },
          });
        } catch {
          // The rename succeeded; keep the optimistic name and allow manual refresh.
        }
      } catch (err) {
        result(ws, false, errMessage(err));
      }
    },
    /**
     * Serves BOTH `session.resume` and `session.focus`.
     *
     * They differ in exactly one place: what a session this process is already
     * holding gets back. `session.resume` means "open this conversation" and
     * answers with its transcript. `session.focus` means "this tab came to the
     * front" — the runtime's current session, the connection's acting id and
     * the todo board all move, and the transcript is deliberately NOT sent,
     * because the tab is already displaying it and the replay would be the
     * poorer copy (rebuilt from the working set, with no audit markers and
     * fresh message ids).
     *
     * A focus on a session this process is NOT holding falls through to the
     * full resume below — the tab has to be reopened before it can be fronted,
     * which is what a page that outlived its server needs.
     */
    resumeSession: (ws, msg) =>
      serializeSessionTransition(async () => {
        const { id } = (msg as { payload: { id: string } }).payload;
        const focusOnly = (msg as { type?: string }).type === 'session.focus';
        if (ctx.canSwapSessions?.() === false) {
          result(ws, false, 'Session store not available');
          return;
        }
        let rollbackClaim: (() => Promise<void>) | undefined;
        let activated = false;
        try {
          const current = ctx.getSession();
          const store = ctx.getSessionStore();
          const canonicalId = store.resolveId ? await store.resolveId(id) : id;
          const isCurrentSession = canonicalId === current.id;
          // Already open in this process — either it IS the runtime's current
          // session, or it is one of the other tabs, whose writer is still
          // held by its own agent. Both are served from memory. Going down the
          // full resume path for a live session opens a SECOND writer and file
          // handle on the same journal (the first is never closed) and re-reads
          // the whole transcript from disk, and with four tabs that is the cost
          // of every tab click.
          const isLiveHere = isCurrentSession || (ctx.isSessionLive?.(canonicalId) ?? false);
          if (isLiveHere) {
            const client = ctx.clients?.get(ws);
            if (client) {
              client.sessionId = canonicalId;
            }
            // Read the TARGET session's own agent, not the shared root
            // context — with several sessions live, the root context may be
            // pointing at a different tab entirely.
            const activeAgent = peekForRead(canonicalId);
            const activeCtx = activeAgent?.ctx ?? ctx.context;
            const liveMessages = activeCtx?.state?.messages ?? [];
            const currentTodos = activeCtx?.state?.todos ?? [];
            const isRunning = ctx.isRunActive?.(canonicalId) ?? false;
            if (!isCurrentSession) {
              // Move the host's "current session" onto the writer this tab
              // already owns, so presence, identity and the untagged legacy
              // paths follow the foreground — WITHOUT re-opening anything.
              const liveWriter = activeCtx?.session;
              if (liveWriter && liveWriter.id === canonicalId) ctx.setSession(liveWriter);
              await ctx.onSessionSwapped?.(canonicalId);
            }
            const liveReplaySource: ReplaySource = focusOnly
              ? { messages: [] }
              : ((await replaySourceFor(canonicalId)) ?? {
                  messages: liveMessages,
                  events: [],
                  // This session's own pre-flight estimate. Reading the root
                  // context reported the foreground tab's number on a
                  // background tab's context bar.
                  usage: { input: activeCtx?.lastRequestTokens ?? 0, output: 0 },
                });
            const startPayload = await ctx.sessionStartPayload({
              reset: true,
              sessionId: canonicalId,
              isRunning,
              // A focus carries no transcript: see the note on this handler.
              // A resume gets the journal-first source, so an already-live
              // session replays with its markers and tool timings intact —
              // reading the in-memory working set here handed the tab a
              // marker-less, timing-less copy of its own conversation.
              ...(focusOnly ? {} : buildReplayPayload(liveReplaySource)),
            });
            sendTo(ws, {
              type: 'session.start',
              payload: startPayload,
            });
            sendTo(ws, {
              type: 'todos.updated',
              payload: { sessionId: canonicalId, todos: currentTodos },
            });
            result(ws, true, 'Session is already active');
            return;
          }
          rollbackClaim = await ctx.claimSession?.(canonicalId);
          const resumed = await store.resume(canonicalId);
          if (!ctx.hasSession) {
            await ctx.context.flushConversationJournal?.().catch(() => undefined);
            await finalizeSession(current);
          }
          const restoredTodos =
            (await loadTodosCheckpoint(
              sessionScopedPath(sessionsDirectory(), resumed.writer.id, '.todos.json'),
              ctx.events,
              ctx.context.traceId,
              resumed.writer.id,
            ).catch(() => null)) ?? [];
          activated = true;
          await activateSession(
            resumed.writer,
            resumed.data.messages,
            resumed.data.usage,
            restoredTodos,
          );
          const client = ctx.clients?.get(ws);
          if (client) {
            client.sessionId = resumed.writer.id;
          }
          const isRunning = ctx.isRunActive?.(resumed.writer.id) ?? false;
          const targetAgent = ctx.getAgent?.(resumed.writer.id);
          const liveMessages =
            isRunning && targetAgent?.ctx?.messages && targetAgent.ctx.messages.length > 0
              ? targetAgent.ctx.messages
              : resumed.data.messages;
          const startPayload = await ctx.sessionStartPayload({
            reset: true,
            sessionId: resumed.writer.id,
            isRunning,
            // Same builder the connect path uses, so a resume and a reconnect
            // hand the client an identical transcript (markers included).
            ...buildReplayPayload({
              messages: liveMessages,
              events: resumed.data.events,
              usage: resumed.data.usage,
            }),
          });
          sendSessionStart(ws, startPayload);
          // The client resets todos to [] on session.start(reset); push the
          // restored board AFTER so the panel repopulates.
          sendTodosUpdated(ws, { sessionId: resumed.writer.id, todos: restoredTodos });
          try {
            const list = await ctx.getSessionStore().list(200);
            broadcastToAll({
              type: 'sessions.list',
              payload: {
                sessions: toSessionHistoryEntries(list, resumed.writer.id),
              },
            });
          } catch {
            // best-effort
          }
          result(ws, true, `Resumed session ${id}`);
        } catch (err) {
          if (!activated) await rollbackClaim?.().catch(() => undefined);
          result(ws, false, errMessage(err));
          try {
            const list = await ctx.getSessionStore().list(200);
            sendTo(ws, {
              type: 'sessions.list',
              payload: { sessions: toSessionHistoryEntries(list, ctx.getSession().id) },
            });
          } catch {
            // best-effort
          }
        }
      }),
    saveSession: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'session.save')) return;
      // Name the tab that asked, not the runtime's session: with four tabs
      // open the toast quoted a conversation the user was not looking at.
      result(ws, true, `Session ${actingSessionId(msg)} is auto-saved`);
    },
    inspectSession: async (ws, msg) => {
      const { id } = (msg as { payload: { id: string } }).payload;
      if (!id) {
        sendTo(ws, {
          type: 'session.inspect',
          payload: { id: '', error: 'Session id is required' },
        });
        return;
      }
      try {
        const store = ctx.getSessionStore();
        const data = await store.load(id);
        // Best-effort summary lookup — fall back to deriving from events when
        // the session is not in the capped list (older sessions).
        let summary: import('@wrongstack/core/types').SessionSummary | undefined;
        try {
          const summaries = await store.list(200);
          summary = summaries.find((s) => s.id === id);
        } catch {
          summary = undefined;
        }
        const payload = buildInspectPayload(summary, data.events, {
          id: data.metadata.id,
          title: data.metadata.title ?? '',
          model: data.metadata.model ?? '',
          provider: data.metadata.provider ?? '',
          startedAt: data.metadata.startedAt,
          endedAt: data.metadata.endedAt,
        });
        sendTo(ws, {
          type: 'session.inspect',
          payload,
        });
      } catch (err) {
        sendTo(ws, {
          type: 'session.inspect',
          payload: {
            id,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    },
    listCheckpoints: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'session.checkpoints')) return;
      try {
        const { DefaultSessionRewinder } = await import('@wrongstack/core/storage');
        const projectRoot = ctx.getProjectRoot();
        const rewinder = new DefaultSessionRewinder(sessionsDirectory(), projectRoot);
        const checkpoints = await rewinder.listCheckpoints(actingSessionId(msg));
        sendTo(ws, {
          type: 'session.checkpoints',
          payload: { checkpoints, sessionId: actingSessionId(msg) },
        });
      } catch {
        sendTo(ws, {
          type: 'session.checkpoints',
          payload: { checkpoints: [], sessionId: actingSessionId(msg) },
        });
      }
    },
    rewindSession: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'session.rewind')) return;
      const { checkpointIndex } = (msg as { payload: { checkpointIndex: number } }).payload;
      try {
        const { applyRewindToConversation, DefaultSessionRewinder } = await import(
          '@wrongstack/core/storage'
        );
        const projectRoot = ctx.getProjectRoot();
        const rewinder = new DefaultSessionRewinder(sessionsDirectory(), projectRoot);
        const targetSessionId = actingSessionId(msg);
        const target = contextForMessage(msg);
        // Refuse to rewind a session whose journal this process does not
        // actually hold open: cutting the file while another context still
        // appends to it leaves the two out of step. A peek-less host that
        // cannot resolve the session lands here too (target null).
        if (!target || target.session?.id !== targetSessionId) {
          result(ws, false, `Session ${targetSessionId} is not open in this runtime`);
          return;
        }
        const reverted = await rewinder.rewindToCheckpoint(targetSessionId, checkpointIndex);
        // Cut the live conversation too — the replay below comes from the
        // session's own state, so truncating only the JSONL would replay the
        // rewound turns straight back to the client and leave them in the
        // model's working set.
        await applyRewindToConversation({
          session: target.session,
          state: target.state,
          sessionsDir: sessionsDirectory(),
          promptIndex: checkpointIndex,
          revertedFiles: reverted.revertedFiles,
        });
        result(ws, true, `Rewound to checkpoint ${checkpointIndex}`);
        broadcastToAll({
          type: 'session.start',
          payload: await ctx.sessionStartPayload({ reset: true, sessionId: targetSessionId }),
        });
      } catch (err) {
        result(ws, false, errMessage(err));
      }
    },

    /**
     * Declare the sessions this connection is displaying.
     *
     * A WebUI page holds up to four tabs on ONE socket, so the server cannot
     * infer the open set from the last message's `sessionId` — doing that
     * filtered the other three tabs' runs out of every broadcast, which looks
     * from the browser exactly like a background tab that stopped working.
     * The client re-sends the whole set whenever a tab opens or closes, so
     * this is a replace, not a merge: a closed tab must actually stop
     * receiving.
     */
    subscribeSessions: async (ws, msg) => {
      const payload =
        (msg as { payload?: { sessionIds?: unknown; replayFor?: unknown } }).payload ?? {};
      const raw = Array.isArray(payload.sessionIds) ? payload.sessionIds : [];
      const replayFor = new Set(
        (Array.isArray(payload.replayFor) ? payload.replayFor : []).filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        ),
      );
      const client = ctx.clients?.get(ws);
      if (!client) return;
      const previous = client.sessionIds;
      const next = new Set<string>();
      for (const id of raw) {
        if (typeof id !== 'string' || id.length === 0) continue;
        next.add(id);
        if (next.size >= MAX_SUBSCRIBED_SESSIONS) break;
      }
      // The session this connection is acting on is always part of its set,
      // even if the strip has not caught up with it yet — but the four-id
      // ceiling is a hard one. When the declared set is already full and does
      // not name the acting session, the LAST DECLARED id (rightmost tab)
      // gives up its slot: dropping the acting session instead would make the
      // tab in front look dead, and growing to five is the leak.
      //
      // The safety net only catches a strip that LAGS (the acting session was
      // never declared). A set that previously declared the acting session
      // and now omits it removed it on purpose — the tab closed — and
      // re-adding it would keep a closed tab's session "displayed", blocking
      // its deletion and delivering events to nothing.
      if (
        client.sessionId &&
        !next.has(client.sessionId) &&
        !(previous && previous.has(client.sessionId))
      ) {
        if (next.size >= MAX_SUBSCRIBED_SESSIONS) {
          const lastDeclared = [...next].at(-1);
          if (lastDeclared !== undefined) next.delete(lastDeclared);
        }
        next.add(client.sessionId);
      }
      client.sessionIds = next.size > 0 ? next : undefined;

      // Hand every NEWLY declared tab its transcript.
      //
      // This is what makes a reload bring all four tabs back. The browser
      // persists its slot list, so after F5 `restoreOpenTabsOnBoot` recreates
      // four lanes — but only the foreground one had ever been given a
      // transcript (`buildInitialPayload` builds exactly one replay, for the
      // runtime's own session). The other three came back as empty chat panes
      // that only filled in if the user happened to click them, and clicking
      // them went down the resume path, which is not what a redisplay should
      // cost.
      //
      // Two gates, both necessary. `replayFor` is the client saying THIS pane
      // is empty — a tab that already shows its chat must not have it replaced
      // by a replay rebuilt from the working set, which carries no live tool
      // cards and no audit markers for a session this process still holds.
      // `!previous.has(id)` keeps it to ids this connection had not declared
      // before, so a later subscribe (a tab opened or closed) cannot re-send
      // transcripts for the tabs that did not change.
      const freshlyDeclared = [...next].filter((id) => replayFor.has(id) && !previous?.has(id));
      for (const id of freshlyDeclared) {
        try {
          await sendSessionReplay(ws, id);
        } catch {
          // Best-effort per tab: one unreadable transcript must not stop the
          // other tabs from coming back.
        }
      }

      // Answer, per declared tab, whether its run is still live.
      //
      // Only the foreground tab is re-announced with `session.start` after a
      // reconnect, and `run.result` — the message that stops a lane's
      // spinner — was broadcast once, while the socket was down. Without this
      // the other tabs spin forever: they count as busy, refuse to be
      // recycled, and offer to abort a run that finished minutes ago. The
      // client re-declares its whole set on every reconnect, so this arrives
      // exactly when it is needed.
      // A host that cannot answer stays silent rather than reporting `false`
      // for a tab that is genuinely running.
      const runActive = ctx.isRunActive;
      if (runActive) {
        for (const id of next) {
          sendTo(ws, {
            type: 'session.run_state',
            payload: { sessionId: id, isRunning: runActive(id) },
          });
        }
      }

      // Give every declared tab a leader in its own roster.
      //
      // `leader_updated` used to be broadcast exactly once, at boot, with the
      // literal id `leader` and the boot session's stamp. One row, one owner:
      // the roster filters fail-CLOSED by session, so tabs 2-4 listed their
      // workers under no leader at all — no leader card, `leaderId`
      // undefined, and the "is the focused agent the leader" check in ChatView
      // permanently false. The id has to be session-scoped as well as the
      // stamp, because a second row under the same key would have re-pointed
      // the first tab's leader at the second tab.
      //
      // `leader@<sessionTag>` is the address the rest of the system already
      // uses for a conversation's leader (mailbox identity, task-result
      // reports, the office map's leader test), so the roster now agrees with
      // it instead of inventing a name. Re-sending on every subscribe is
      // deliberate: it is idempotent in the store and a reconnecting page
      // needs it again.
      for (const id of next) {
        sendTo(ws, {
          type: 'subagent.event',
          payload: {
            kind: 'leader_updated',
            sessionId: id,
            subagentId: `leader@${mailboxSessionTag(id)}`,
            isLeader: true,
            name: 'Leader',
            status: 'idle',
          },
        });
      }

      if (!ctx.onSessionsUndisplayed || !previous) return;
      // Dropped by THIS connection and claimed by no other one. Computed after
      // the assignment above so a second page showing the same session keeps
      // it alive.
      const stillShown = new Set(
        collectDisplayedSessionIds({ getSession: ctx.getSession, clients: ctx.clients }),
      );
      const gone = [...previous].filter((id) => !stillShown.has(id));
      if (gone.length > 0) ctx.onSessionsUndisplayed(gone);
    },
  };
}

/**
 * Live session window for policy resolution: the effective limit (probe /
 * model-switch wiring writes it) first, the provider capability as fallback,
 * 0 when unknown.
 */
function readSessionWindowTokens(context: Context): number {
  const meta = context.meta?.['effectiveMaxContext'];
  if (typeof meta === 'number' && Number.isFinite(meta) && meta > 0) return meta;
  const cap = context.provider?.capabilities?.maxContext;
  return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : 0;
}
