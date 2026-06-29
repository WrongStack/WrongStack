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
import * as path from 'node:path';
import type { WebSocket } from 'ws';
import {
  type Context,
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  type DefaultTokenCounter,
  type SessionStore,
  type ToolRegistry,
  type createStrategyCompactor,
  repairToolUseAdjacency,
  resolveContextWindowPolicy,
} from '@wrongstack/core';
import type { ConnectedClient } from './types.js';
import type { SessionRouteHandlers } from './session-routes.js';
import type { CustomModeStore } from './custom-context-modes.js';
import { broadcast, errMessage, send, sendResult } from './ws-utils.js';
import { estimateContextBreakdown } from './token-estimator.js';
import {
  validateContextModeCreatePayload,
  validateContextModeDeletePayload,
  validateContextModeSwitchPayload,
  validateContextModeUpdatePayload,
} from './ws-payload-validation.js';

type Session = Awaited<ReturnType<SessionStore['create']>>;
type WSMessageLike = { type: string; payload?: unknown | undefined };
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
  clients: Map<WebSocket, ConnectedClient>;
  context: Context;
  toolRegistry: ToolRegistry;
  compactor: ReturnType<typeof createStrategyCompactor>;
  customModeStore: CustomModeStore;
  tokenCounter: DefaultTokenCounter;
  /** Live reads of the mutable startWebUI bindings. */
  getProjectRoot: () => string;
  getSession: () => Session;
  getSessionStore: () => SessionStore;
  /** Mutations of the startWebUI bindings. */
  setSession: (s: Session) => void;
  setSessionStartedAt: (t: number) => void;
  sessionStartPayload: () => Promise<SessionStartPayload>;
}

export function createSessionHandlers(ctx: SessionHandlersContext): SessionRouteHandlers {
  const currentSessionId = (): string => ctx.getSession().id;
  const sessionPayload = <T extends Record<string, unknown>>(payload: T): T & { sessionId: string } => {
    const provided = payload['sessionId'];
    const sessionId = typeof provided === 'string' && provided.length > 0 ? provided : currentSessionId();
    return { ...payload, sessionId };
  };
  const requestedSessionId = (msg: WSMessageLike): string | undefined => {
    const payload = msg.payload;
    return payload && typeof payload === 'object' && typeof (payload as { sessionId?: unknown }).sessionId === 'string'
      ? (payload as { sessionId: string }).sessionId
      : undefined;
  };
  const ensureCurrentSession = (ws: WebSocket, msg: WSMessageLike, op: string): boolean => {
    const requested = requestedSessionId(msg);
    const current = currentSessionId();
    if (!requested || requested === current) return true;
    send(ws, {
      type: 'error',
      payload: sessionPayload({
        phase: op,
        message: `Request targeted session ${requested}, but this WebUI runtime is currently on ${current}.`,
        requestedSessionId: requested,
      }),
    });
    return false;
  };

  return {
    newSession: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'session.new')) return;
      const session = ctx.getSession();
      try {
        await session.append({
          type: 'session_end',
          ts: new Date().toISOString(),
          usage: ctx.tokenCounter.total(),
        });
        await session.close();
      } catch {
        // best-effort
      }
      const next = await ctx.getSessionStore().create({
        id: '',
        title: '',
        model: ctx.config.model,
        provider: ctx.config.provider,
      });
      ctx.setSession(next);
      ctx.context.session = next;
      ctx.context.state.replaceMessages([]);
      ctx.context.state.replaceTodos([]);
      ctx.context.readFiles.clear();
      ctx.context.fileMtimes.clear();
      ctx.tokenCounter.reset();
      ctx.setSessionStartedAt(Date.now());
      broadcast(ctx.clients, { type: 'session.start', payload: await ctx.sessionStartPayload() });
    },
    clearContext: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.clear')) return;
      ctx.context.state.replaceMessages([]);
      ctx.context.state.replaceTodos([]);
      ctx.context.readFiles.clear();
      ctx.context.fileMtimes.clear();
      ctx.tokenCounter.reset();
      sendResult(ws, true, 'Context cleared');
      broadcast(ctx.clients, {
        type: 'session.start',
        payload: { ...(await ctx.sessionStartPayload()), reset: true },
      });
    },
    debugContext: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.debug')) return;
      const breakdown = estimateContextBreakdown({
        systemPrompt: ctx.context.systemPrompt,
        tools: ctx.toolRegistry.list(),
        messages: ctx.context.messages,
      });
      send(ws, {
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
      const aggressive = !!(msg as { payload?: { aggressive?: boolean | undefined } }).payload?.aggressive;
      try {
        const report = await ctx.compactor.compact(ctx.context, { aggressive });
        send(ws, {
          type: 'context.compacted',
          payload: sessionPayload({
            before: report.before,
            after: report.after,
            saved: Math.max(0, report.before - report.after),
            reductions: report.reductions,
            repaired: report.repaired,
          }),
        });
        sendResult(
          ws,
          true,
          `Compacted: ${report.before} → ${report.after} tokens (saved ~${Math.max(0, report.before - report.after)})`,
        );
      } catch (err) {
        sendResult(ws, false, errMessage(err));
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
        sessionId: ctx.context.session.id,
        removedToolUses: repaired.report.removedToolUses,
        removedToolResults: repaired.report.removedToolResults,
        removedMessages: repaired.report.removedMessages,
        beforeMessages,
        afterMessages: ctx.context.messages.length,
      };
      broadcast(ctx.clients, { type: 'context.repaired', payload: sessionPayload(payload) });
      const removed =
        payload.removedToolUses.length + payload.removedToolResults.length + payload.removedMessages;
      sendResult(
        ws,
        true,
        removed > 0
          ? `Context repaired: removed ${removed} orphan protocol item(s)`
          : 'Context repair found no orphan protocol blocks',
      );
    },
    listContextModes: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.modes.list')) return;
      const active = String(ctx.context.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID);
      const allModes = ctx.customModeStore.list().map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        isActive: m.id === active,
        thresholds: m.thresholds,
        preserveK: m.preserveK,
        eliseThreshold: m.eliseThreshold,
        custom: (m as { custom?: boolean }).custom === true,
      }));
      send(ws, { type: 'context.modes.list', payload: sessionPayload({ activeId: active, modes: allModes }) });
    },
    switchContextMode: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.mode.switch')) return;
      const parsed = validateContextModeSwitchPayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      const { id } = parsed.value;
      let policy = resolveContextWindowPolicy({}, id);
      if (policy.id !== id) {
        const customModes = ctx.customModeStore.list().filter((m) => (m as { custom?: boolean }).custom === true);
        const custom = customModes.find((m) => m.id === id);
        if (!custom) {
          sendResult(ws, false, `Unknown context mode "${id}"`);
          return;
        }
        policy = custom as never as typeof policy;
      }
      ctx.context.meta['contextWindowMode'] = policy.id;
      ctx.context.meta['contextWindowPolicy'] = policy;
      sendResult(ws, true, `Context mode switched to ${policy.id}`);
      broadcast(ctx.clients, {
        type: 'context.mode.changed',
        payload: sessionPayload({ id: policy.id, name: policy.name, policy }),
      });
    },
    createContextMode: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.mode.create')) return;
      const parsed = validateContextModeCreatePayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      const payload = parsed.value;
      const result = ctx.customModeStore.create({
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
      sendResult(ws, result.ok, result.error ?? `Mode "${payload.id}" created`);
    },
    updateContextMode: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.mode.update')) return;
      const parsed = validateContextModeUpdatePayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      const payload = parsed.value;
      const result = ctx.customModeStore.update(payload.id, {
        name: payload.name,
        description: payload.description,
        thresholds: payload.thresholds
          ? {
              warn: payload.thresholds.warn ?? 0.6,
              soft: payload.thresholds.soft ?? 0.75,
              hard: payload.thresholds.hard ?? 0.9,
            }
          : undefined,
        preserveK: payload.preserveK,
        eliseThreshold: payload.eliseThreshold,
      });
      sendResult(ws, result.ok, result.error ?? `Mode "${payload.id}" updated`);
    },
    deleteContextMode: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'context.mode.delete')) return;
      const parsed = validateContextModeDeletePayload(msg.payload);
      if (!parsed.ok) {
        sendResult(ws, false, parsed.message);
        return;
      }
      const { id } = parsed.value;
      if (String(ctx.context.meta['contextWindowMode'] ?? '') === id) {
        ctx.context.meta['contextWindowMode'] = DEFAULT_CONTEXT_WINDOW_MODE_ID;
        ctx.context.meta['contextWindowPolicy'] = resolveContextWindowPolicy({}, DEFAULT_CONTEXT_WINDOW_MODE_ID);
      }
      const result = ctx.customModeStore.remove(id);
      sendResult(ws, result.ok, result.error ?? `Mode "${id}" deleted`);
    },
    listSessions: async (ws, msg) => {
      const limit = (msg as { payload?: { limit?: number | undefined } }).payload?.limit ?? 50;
      try {
        const list = await ctx.getSessionStore().list(limit);
        const currentId = ctx.getSession().id;
        send(ws, {
          type: 'sessions.list',
          payload: {
            sessions: list.map((s) => ({
              id: s.id,
              title: s.title,
              startedAt: s.startedAt,
              model: s.model,
              provider: s.provider,
              tokenTotal: s.tokenTotal,
              isCurrent: s.id === currentId,
            })),
          },
        });
      } catch (err) {
        send(ws, { type: 'sessions.list', payload: { sessions: [], error: errMessage(err) } });
      }
    },
    deleteSession: async (ws, msg) => {
      const { id } = (msg as { payload: { id: string } }).payload;
      try {
        if (id === ctx.getSession().id) {
          sendResult(ws, false, 'Cannot delete the active session');
          return;
        }
        await ctx.getSessionStore().delete(id);
        sendResult(ws, true, `Session ${id} deleted`);
      } catch (err) {
        sendResult(ws, false, errMessage(err));
      }
    },
    resumeSession: async (ws, msg) => {
      const { id } = (msg as { payload: { id: string } }).payload;
      try {
        const current = ctx.getSession();
        if (id === current.id) {
          sendResult(ws, false, 'Session is already active');
          return;
        }
        const resumed = await ctx.getSessionStore().resume(id);
        try {
          await current.append({
            type: 'session_end',
            ts: new Date().toISOString(),
            usage: ctx.tokenCounter.total(),
          });
          await current.close();
        } catch {
          /* noop */
        }
        ctx.setSession(resumed.writer);
        ctx.context.session = resumed.writer;
        ctx.context.state.replaceMessages(resumed.data.messages);
        ctx.context.readFiles.clear();
        ctx.context.fileMtimes.clear();
        ctx.tokenCounter.reset();
        ctx.tokenCounter.account(resumed.data.usage, ctx.config.model);
        ctx.setSessionStartedAt(Date.now());
        broadcast(ctx.clients, {
          type: 'session.start',
          payload: {
            ...(await ctx.sessionStartPayload()),
            reset: true,
            replayMessages: resumed.data.messages,
            replayUsage: resumed.data.usage,
          },
        });
        sendResult(ws, true, `Resumed session ${id}`);
      } catch (err) {
        sendResult(ws, false, errMessage(err));
      }
    },
    saveSession: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'session.save')) return;
      sendResult(ws, true, `Session ${ctx.getSession().id} is auto-saved`);
    },
    listCheckpoints: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'session.checkpoints')) return;
      try {
        const { DefaultSessionRewinder } = await import('@wrongstack/core');
        const projectRoot = ctx.getProjectRoot();
        const rewinder = new DefaultSessionRewinder(
          path.join(projectRoot, '.wrongstack', 'sessions'),
          projectRoot,
        );
        const checkpoints = await rewinder.listCheckpoints(ctx.getSession().id);
        send(ws, { type: 'session.checkpoints', payload: sessionPayload({ checkpoints }) });
      } catch {
        send(ws, { type: 'session.checkpoints', payload: sessionPayload({ checkpoints: [] }) });
      }
    },
    rewindSession: async (ws, msg) => {
      if (!ensureCurrentSession(ws, msg, 'session.rewind')) return;
      const { checkpointIndex } = (msg as { payload: { checkpointIndex: number } }).payload;
      try {
        const { DefaultSessionRewinder } = await import('@wrongstack/core');
        const projectRoot = ctx.getProjectRoot();
        const rewinder = new DefaultSessionRewinder(
          path.join(projectRoot, '.wrongstack', 'sessions'),
          projectRoot,
        );
        await rewinder.rewindToCheckpoint(ctx.getSession().id, checkpointIndex);
        await ctx.context.session.truncateToCheckpoint(checkpointIndex);
        sendResult(ws, true, `Rewound to checkpoint ${checkpointIndex}`);
        broadcast(ctx.clients, {
          type: 'session.start',
          payload: { ...(await ctx.sessionStartPayload()), reset: true },
        });
      } catch (err) {
        sendResult(ws, false, errMessage(err));
      }
    },
  };
}
