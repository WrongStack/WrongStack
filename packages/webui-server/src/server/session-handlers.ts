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
import { repairToolUseAdjacency, sessionScopedPath } from '@wrongstack/core/utils';
import { buildReplayPayload } from '@wrongstack/webui-protocol';
import type { WebSocket } from 'ws';
import {
  applyContextEditorProposal,
  buildContextEditorSnapshot,
  validateContextEditorProposal,
} from './context-editor.js';
import type { CustomModeStore } from './custom-context-modes.js';
import { deleteWebUISession } from './session-deletion.js';
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
  clients?: Map<WebSocket, ConnectedClient> | undefined;
}): string[] {
  const ids = new Set<string>();
  ids.add(ctx.getSession().id);
  for (const client of ctx.clients?.values() ?? []) {
    if (client.sessionId) ids.add(client.sessionId);
    for (const id of client.sessionIds ?? []) ids.add(id);
  }
  return Array.from(ids);
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
  getAgent?: ((sessionId?: string) => Agent) | undefined;
  sessionStartPayload: (overrides?: Record<string, unknown>) => Promise<SessionStartPayload>;
  systemPrompt?: { applyVariant?: (variant: string) => Promise<void> } | undefined;
  /**
   * Host-owned serialiser shared with `createConversationOperations`. When
   * omitted the handlers create a private one, which still orders session
   * transitions against each other but not against run setup.
   */
  withSessionTransition?: (<T>(operation: () => Promise<T>) => Promise<T>) | undefined;
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
      if (targetCtx === ctx.context) {
        resetContextAccounting();
        ctx.tokenCounter.reset?.();
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
      ctx.tokenCounter.account(
        usage,
        currentConfig().model,
        targetCtx.provider?.id ?? ctx.context.provider.id,
      );
      if (typeof usage.input === 'number' && usage.input > 0) {
        targetCtx.lastRequestTokens = usage.input;
      }
    }
    ctx.setSessionStartedAt?.(Date.now());
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
  /**
   * Resolve the Context belonging to the session that SENT this message.
   * With up to four tabs live, `ctx.context` (the shared root) is only
   * coincidentally the caller's session — reading it directly leaks one
   * tab's transcript into another tab's request.
   */
  const contextForMessage = (msg: WSMessageLike): Context => {
    const requested = requestedSessionId(msg);
    if (!requested) return ctx.context;
    return ctx.getAgent?.(requested)?.ctx ?? ctx.context;
  };
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
    await writer
      .append({
        type: 'session_end',
        ts: new Date().toISOString(),
        usage: ctx.tokenCounter.total(),
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
      ctx.context.state.replaceMessages([]);
      ctx.context.state.replaceTodos([]);
      resetContextAccounting();
      ctx.context.clearMemoryEvidence?.();
      ctx.context.readFiles.clear();
      ctx.context.fileMtimes.clear();
      ctx.tokenCounter.reset?.();
      result(ws, true, 'Context cleared');
      broadcastToAll({
        type: 'session.start',
        payload: await ctx.sessionStartPayload({ reset: true }),
      });
    },
    debugContext: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.debug')) return;
      const breakdown = estimateContextBreakdown({
        systemPrompt: ctx.context.systemPrompt,
        tools: ctx.listTools?.() ?? ctx.toolRegistry?.list() ?? [],
        messages: ctx.context.messages,
      });
      sendTo(ws, {
        type: 'context.debug',
        payload: sessionPayload({
          ...breakdown,
          mode: ctx.context.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID,
          policy: ctx.context.meta['contextWindowPolicy'],
        }),
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
        const beforeUsage = ctx.tokenCounter.total();
        const report = await compactor.compact(ctx.context, { aggressive });
        const afterUsage = ctx.tokenCounter.total();
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
      const beforeMessages = ctx.context.messages.length;
      const repaired = repairToolUseAdjacency(ctx.context.messages);
      if (repaired.report.changed) {
        ctx.context.state.replaceMessages(repaired.messages);
      }
      const payload = {
        sessionId: currentSessionId(),
        removedToolUses: repaired.report.removedToolUses,
        removedToolResults: repaired.report.removedToolResults,
        removedMessages: repaired.report.removedMessages,
        beforeMessages,
        afterMessages: ctx.context.messages.length,
      };
      broadcastToAll({ type: 'context.repaired', payload: sessionPayload(payload) });
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
      const snapshot = buildContextEditorSnapshot(
        ctx.context,
        ctx.listTools?.() ?? ctx.toolRegistry?.list(),
      );
      sendTo(ws, {
        type: 'context.editor.snapshot',
        payload: sessionPayload(snapshot),
      });
    },
    validateContextEditor: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.editor.validate')) return;
      const payload = isRecordPayload(msg.payload) ? msg.payload : {};
      const validation = validateContextEditorProposal({
        ctx: contextForMessage(msg),
        tools: ctx.listTools?.() ?? ctx.toolRegistry?.list(),
        baseRevision: typeof payload['baseRevision'] === 'string' ? payload['baseRevision'] : '',
        messages: payload['messages'],
        removals: payload['removals'],
        allowRepair: payload['allowRepair'] === true,
        runActive: ctx.isRunActive?.(requestedSessionId(msg) ?? currentSessionId()) === true,
      });
      sendTo(ws, {
        type: 'context.editor.validation',
        payload: sessionPayload(validation),
      });
    },
    applyContextEditor: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.editor.apply')) return;
      const payload = isRecordPayload(msg.payload) ? msg.payload : {};
      const applied = await applyContextEditorProposal({
        ctx: contextForMessage(msg),
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
          payload: sessionPayload(applied),
        });
        return;
      }
      broadcastToAll({
        type: 'context.editor.applied',
        payload: sessionPayload(applied),
      });
      result(
        ws,
        true,
        `Context editor applied: ${applied.before.messages} → ${applied.after.messages} messages`,
      );
    },
    listContextModes: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.modes.list')) return;
      const active = String(
        ctx.context.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID,
      );
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
        payload: sessionPayload({ activeId: active, modes: allModes }),
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
      let policy = resolveContextWindowPolicy({}, id, readSessionWindowTokens(ctx.context));
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
      ctx.context.meta['contextWindowMode'] = policy.id;
      ctx.context.meta['contextWindowPolicy'] = policy;
      // The user picked this policy for the session — later window changes
      // (model switch) must not overwrite it.
      ctx.context.meta[CONTEXT_WINDOW_MODE_PINNED_META_KEY] = true;
      result(ws, true, `Context mode switched to ${policy.id}`);
      broadcastToAll({
        type: 'context.mode.changed',
        payload: sessionPayload({ id: policy.id, name: policy.name, policy }),
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
      if (String(ctx.context.meta['contextWindowMode'] ?? '') === id) {
        const policy = resolveContextWindowPolicy(
          {},
          DEFAULT_CONTEXT_WINDOW_MODE_ID,
          readSessionWindowTokens(ctx.context),
        );
        ctx.context.meta['contextWindowMode'] = policy.id;
        ctx.context.meta['contextWindowPolicy'] = policy;
        delete ctx.context.meta[CONTEXT_WINDOW_MODE_PINNED_META_KEY];
      }
      const store = await modeStore();
      const operation = store.remove(id);
      if (operation.ok) await store.save().catch(() => undefined);
      result(ws, operation.ok, operation.error ?? `Mode "${id}" deleted`);
    },
    listSessions: async (ws, msg) => {
      const limit = (msg as { payload?: { limit?: number | undefined } }).payload?.limit ?? 50;
      try {
        const list = await ctx.getSessionStore().list(limit);
        const currentId = ctx.getSession().id;
        sendTo(ws, {
          type: 'sessions.list',
          payload: {
            sessions: toSessionHistoryEntries(list, currentId),
          },
        });
      } catch (err) {
        sendTo(ws, { type: 'sessions.list', payload: { sessions: [], error: errMessage(err) } });
      }
    },
    deleteSession: async (ws, msg) => {
      const { id } = (msg as { payload: { id: string } }).payload;
      if (ctx.isRunActive?.(id)) {
        result(
          ws,
          false,
          'Cannot delete session while an agent run is active. Please stop the run first.',
        );
        return;
      }
      try {
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
    resumeSession: (ws, msg) =>
      serializeSessionTransition(async () => {
        const { id } = (msg as { payload: { id: string } }).payload;
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
          if (isCurrentSession) {
            const client = ctx.clients?.get(ws);
            if (client) {
              client.sessionId = canonicalId;
            }
            // Read the TARGET session's own agent, not the shared root
            // context — with several sessions live, the root context may be
            // pointing at a different tab entirely.
            const activeAgent = ctx.getAgent?.(canonicalId);
            const activeCtx = activeAgent?.ctx ?? ctx.context;
            const liveMessages = activeCtx?.state?.messages ?? [];
            const currentTodos = activeCtx?.state?.todos ?? [];
            const isRunning = ctx.isRunActive?.(canonicalId) ?? false;
            const startPayload = await ctx.sessionStartPayload({
              reset: true,
              sessionId: canonicalId,
              isRunning,
              ...buildReplayPayload({
                messages: liveMessages,
                events: [],
                usage: {
                  input: ctx.context?.lastRequestTokens ?? 0,
                  output: 0,
                },
              }),
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
      result(ws, true, `Session ${ctx.getSession().id} is auto-saved`);
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
        const checkpoints = await rewinder.listCheckpoints(ctx.getSession().id);
        sendTo(ws, { type: 'session.checkpoints', payload: sessionPayload({ checkpoints }) });
      } catch {
        sendTo(ws, { type: 'session.checkpoints', payload: sessionPayload({ checkpoints: [] }) });
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
        const reverted = await rewinder.rewindToCheckpoint(ctx.getSession().id, checkpointIndex);
        // Cut the live conversation too — sessionStartPayload() below replays
        // from ctx.context.state, so truncating only the JSONL would replay the
        // rewound turns straight back to the client and leave them in the
        // model's working set.
        await applyRewindToConversation({
          session: ctx.context.session,
          state: ctx.context.state,
          sessionsDir: sessionsDirectory(),
          promptIndex: checkpointIndex,
          revertedFiles: reverted.revertedFiles,
        });
        result(ws, true, `Rewound to checkpoint ${checkpointIndex}`);
        broadcastToAll({
          type: 'session.start',
          payload: await ctx.sessionStartPayload({ reset: true }),
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
      const payload = (msg as { payload?: { sessionIds?: unknown } }).payload ?? {};
      const raw = Array.isArray(payload.sessionIds) ? payload.sessionIds : [];
      const client = ctx.clients?.get(ws);
      if (!client) return;
      const next = new Set<string>();
      for (const id of raw) {
        if (typeof id !== 'string' || id.length === 0) continue;
        next.add(id);
        if (next.size >= MAX_SUBSCRIBED_SESSIONS) break;
      }
      // The session this connection is acting on is always part of its set,
      // even if the strip has not caught up with it yet.
      if (client.sessionId) next.add(client.sessionId);
      client.sessionIds = next.size > 0 ? next : undefined;
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
