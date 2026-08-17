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

import type { Context, TodoItem } from '@wrongstack/core/agent';
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
import type { WebSocket } from 'ws';
import { buildReplayPayload } from '../protocol/index.js';
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
import { broadcast, errMessage, send } from './ws-utils.js';

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
  sessionStartPayload: (overrides?: Record<string, unknown>) => Promise<SessionStartPayload>;
}

export function createSessionHandlers(ctx: SessionHandlersContext): SessionRouteHandlers {
  const currentConfig = (): { provider: string; model: string } => ctx.getConfig?.() ?? ctx.config;
  const sendTo = (ws: WebSocket, message: OutboundMessage): void => {
    if (ctx.sendMessage) ctx.sendMessage(ws, message);
    else send(ws, message);
  };
  const broadcastToAll = (message: OutboundMessage): void => {
    if (ctx.broadcastMessage) ctx.broadcastMessage(message);
    else broadcast(ctx.clients ?? new Map(), message);
  };
  const result = (ws: WebSocket, success: boolean, message: string): void => {
    sendTo(ws, { type: 'key.operation_result', payload: { success, message } });
  };
  const sessionsDirectory = (): string =>
    ctx.getSessionsDir?.() ?? ctx.sessionsDir ?? `${ctx.getProjectRoot()}/.wrongstack/sessions`;
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
  const ensureCurrentSession = (ws: WebSocket, msg: WSMessageLike, op: string): boolean => {
    const requested = requestedSessionId(msg);
    const current = currentSessionId();
    if (!requested || requested === current) return true;
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
  let sessionTransitionTail = Promise.resolve();
  const serializeSessionTransition = async <T>(operation: () => Promise<T>): Promise<T> => {
    const current = sessionTransitionTail.then(operation, operation);
    sessionTransitionTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };
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
  const resetContextAccounting = (): void => {
    ctx.context.lastRequestTokens = undefined;
    ctx.context.lastRealInputTokens = undefined;
    ctx.context.state.deleteMeta?.('lastRequestTokensAt');
    ctx.context.state.deleteMeta?.('realAnchorMsgCount');
  };
  const activateSession = async (
    next: Session,
    messages: Context['messages'],
    usage?: Parameters<TokenCounter['account']>[0],
    todos: TodoItem[] = [],
  ): Promise<void> => {
    const current = ctx.getSession();
    if (current !== next) {
      // Stop the previous session's in-flight run before swapping — a slow
      // provider stream would otherwise keep running (and emitting events)
      // in the background after session.new/resume.
      try {
        ctx.abortActiveRun?.(current.id);
      } catch {
        // Aborting is best-effort; ownership/session finalization must still
        // advance so a faulty host callback cannot strand a claimed session.
      }
      // Drain the exact-conversation journal into the OUTGOING writer before
      // closing it. Those events were queued against `current`, and a closed
      // FileSessionWriter drops appends silently — so closing first ends the
      // session we are leaving with its last turns missing from the
      // transcript. The TUI resume path already flushes in this order.
      await ctx.context.flushConversationJournal?.().catch(() => undefined);
      await finalizeSession(current);
    }
    ctx.setSession(next);
    ctx.context.session = next;
    ctx.context.state.replaceMessages(messages);
    await ctx.context.flushConversationJournal?.();
    // Rebind durable todo persistence before replaceTodos emits. Detaching
    // afterward would flush this new-session snapshot into the previous file.
    await ctx.onBeforeSessionTodosReplaced?.(next.id, sessionsDirectory());
    // Restore the resumed session's todo board from its .todos.json sidecar
    // (empty for a fresh session). Without this a resume cleared the panel.
    ctx.context.state.replaceTodos(todos);
    resetContextAccounting();
    ctx.context.clearMemoryEvidence?.();
    ctx.context.readFiles.clear();
    ctx.context.fileMtimes.clear();
    ctx.context.state.setMeta?.(
      'plan.path',
      sessionScopedPath(sessionsDirectory(), next.id, '.plan.json'),
    );
    ctx.context.state.setMeta?.(
      'task.path',
      sessionScopedPath(sessionsDirectory(), next.id, '.tasks.json'),
    );
    ctx.tokenCounter.reset?.();
    if (usage) {
      ctx.tokenCounter.account(usage, currentConfig().model, ctx.context.provider.id);
      if (typeof usage.input === 'number' && usage.input > 0) {
        ctx.context.lastRequestTokens = usage.input;
      }
    }
    ctx.setSessionStartedAt?.(Date.now());
    await ctx.onSessionSwapped?.(next.id);
  };

  return {
    newSession: (ws, msg) =>
      serializeSessionTransition(async () => {
        if (!ensureCurrentSession(ws, msg, 'session.new')) return;
        const clearedSessionId = currentSessionId();
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
            ctx.abortActiveRun?.(clearedSessionId);
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
        broadcastToAll({
          type: 'session.start',
          payload: await ctx.sessionStartPayload({ reset: true, clearedSessionId }),
        });
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
        ctx: ctx.context,
        tools: ctx.listTools?.() ?? ctx.toolRegistry?.list(),
        baseRevision: typeof payload['baseRevision'] === 'string' ? payload['baseRevision'] : '',
        messages: payload['messages'],
        removals: payload['removals'],
        allowRepair: payload['allowRepair'] === true,
        runActive: ctx.isRunActive?.() === true,
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
        ctx: ctx.context,
        tools: ctx.listTools?.() ?? ctx.toolRegistry?.list(),
        baseRevision: typeof payload['baseRevision'] === 'string' ? payload['baseRevision'] : '',
        messages: payload['messages'],
        removals: payload['removals'],
        allowRepair: payload['allowRepair'] === true,
        runActive: ctx.isRunActive?.() === true,
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
      try {
        await deleteWebUISession(
          {
            getActiveSessionId: () => ctx.getSession().id,
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
          if (canonicalId === current.id) {
            result(ws, false, 'Session is already active');
            return;
          }
          rollbackClaim = await ctx.claimSession?.(canonicalId);
          const resumed = await store.resume(canonicalId);
          // Restore the resumed session's todo board from its sidecar so the
          // panel isn't wiped on resume (parity with the boot `--resume` path).
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
          broadcastToAll({
            type: 'session.start',
            payload: await ctx.sessionStartPayload({
              reset: true,
              // Same builder the connect path uses, so a resume and a reconnect
              // hand the client an identical transcript (markers included).
              ...buildReplayPayload({
                messages: resumed.data.messages,
                events: resumed.data.events,
                usage: resumed.data.usage,
              }),
            }),
          });
          // The client resets todos to [] on session.start(reset); push the
          // restored board AFTER so the panel repopulates.
          broadcastToAll({
            type: 'todos.updated',
            payload: { sessionId: resumed.writer.id, todos: restoredTodos },
          });
          result(ws, true, `Resumed session ${id}`);
        } catch (err) {
          if (!activated) await rollbackClaim?.().catch(() => undefined);
          result(ws, false, errMessage(err));
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
