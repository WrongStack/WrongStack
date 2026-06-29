import {
  type Agent,
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  repairToolUseAdjacency,
  resolveContextWindowPolicy,
  TOKENS,
} from '@wrongstack/core';
import type { CustomModeStore } from '@wrongstack/webui/server';
import type { WebSocket } from 'ws';
import {
  estimateContextBreakdown,
  type MessageLike,
  type PromptBlock,
  type ToolLike,
} from '../context-breakdown.js';
import type { WsCommon } from './index.js';

/**
 * PR 5h of Issue #30: context-window WebSocket handlers — the live
 * context (`context.clear`/`debug`/`compact`/`repair`) and the
 * custom-context-mode CRUD (`context.modes.list`, `context.mode.switch`/
 * `create`/`update`/`delete`).
 *
 * Former closure captures (`opts.agent`, `buildSessionStartPayload`, and
 * the lazily-loaded `getCustomModeStore`) are `ContextHandlerContext`
 * fields. The compactor is resolved off the agent container at call time,
 * exactly as the inline cases did.
 */

export interface ContextHandlerContext extends WsCommon {
  /** The running agent — context state/meta and the compactor container live on it. */
  agent: Agent;
  /** Build the reset session.start payload (runWebUI closure). */
  buildSessionStart: (overrides?: Record<string, unknown>) => Promise<unknown>;
  /** Lazily-loaded custom-context-mode store (runWebUI closure). */
  getCustomModeStore: () => Promise<CustomModeStore>;
}

function sendResult(ctx: WsCommon, ws: WebSocket, success: boolean, message: string): void {
  ctx.send(ws, { type: 'key.operation_result', payload: { success, message } });
}

function sessionPayload<T extends Record<string, unknown>>(
  ctx: ContextHandlerContext,
  payload: T,
): T & { sessionId: string } {
  const provided = payload['sessionId'];
  const fallback = ctx.agent.ctx.session?.id ?? '';
  const sessionId = typeof provided === 'string' && provided.length > 0 ? provided : fallback;
  return { ...payload, sessionId };
}

export async function handleContextClear(ctx: ContextHandlerContext, ws: WebSocket): Promise<void> {
  // In-memory wipe — same as session.new but reuses the current session.
  const actx = ctx.agent.ctx;
  actx.state.replaceMessages([]);
  actx.state.replaceTodos([]);
  actx.readFiles.clear();
  actx.fileMtimes.clear();
  sendResult(ctx, ws, true, 'Context cleared');
  const payload = await ctx.buildSessionStart({ reset: true });
  ctx.broadcast({ type: 'session.start', payload });
}

export function handleContextDebug(ctx: ContextHandlerContext, ws: WebSocket): void {
  // Per-section token estimate so users can see what's eating the context window.
  const actx = ctx.agent.ctx;
  const breakdown = estimateContextBreakdown({
    systemPrompt: actx.systemPrompt as ReadonlyArray<PromptBlock>,
    tools: ctx.agent.tools.list() as ReadonlyArray<ToolLike>,
    messages: actx.messages as ReadonlyArray<MessageLike>,
  });
  ctx.send(ws, {
    type: 'context.debug',
    payload: sessionPayload(ctx, {
      ...breakdown,
      mode: (actx.meta['contextWindowMode'] as string) ?? DEFAULT_CONTEXT_WINDOW_MODE_ID,
      policy: actx.meta['contextWindowPolicy'] ?? null,
    }),
  });
}

export async function handleContextCompact(
  ctx: ContextHandlerContext,
  ws: WebSocket,
  aggressive: boolean,
): Promise<void> {
  try {
    const compactor = ctx.agent.container.resolve(TOKENS.Compactor);
    if (!compactor) {
      sendResult(ctx, ws, false, 'Compactor not available');
      return;
    }
    const before = ctx.agent.ctx.tokenCounter.total();
    const report = await compactor.compact(ctx.agent.ctx, { aggressive });
    const after = ctx.agent.ctx.tokenCounter.total();
    ctx.send(ws, {
      type: 'context.compacted',
      payload: sessionPayload(ctx, {
        before: before.input + before.output,
        after: after.input + after.output,
        saved: Math.max(0, before.input + before.output - after.input - after.output),
        reductions: report.reductions ?? [],
        repaired: report.repaired ?? false,
      }),
    });
    sendResult(
      ctx,
      ws,
      true,
      `Compacted: ${before.input + before.output} → ${after.input + after.output} tokens`,
    );
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}

export function handleContextRepair(ctx: ContextHandlerContext, ws: WebSocket): void {
  const actx = ctx.agent.ctx;
  const beforeMessages = actx.messages.length;
  const repaired = repairToolUseAdjacency(actx.messages);
  if (repaired.report.changed) {
    actx.state.replaceMessages(repaired.messages);
  }
  const payload = {
    sessionId: actx.session?.id,
    removedToolUses: repaired.report.removedToolUses,
    removedToolResults: repaired.report.removedToolResults,
    removedMessages: repaired.report.removedMessages,
    beforeMessages,
    afterMessages: actx.messages.length,
  };
  ctx.broadcast({ type: 'context.repaired', payload: sessionPayload(ctx, payload) });
  const removed =
    payload.removedToolUses.length + payload.removedToolResults.length + payload.removedMessages;
  sendResult(
    ctx,
    ws,
    true,
    removed > 0
      ? `Context repaired: removed ${removed} orphan protocol item(s)`
      : 'Context repair found no orphan protocol blocks',
  );
}

export async function handleContextModesList(
  ctx: ContextHandlerContext,
  ws: WebSocket,
): Promise<void> {
  // Built-ins + file-backed custom modes (store.list() merges both).
  const active = String(ctx.agent.ctx.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID);
  const modeStore = await ctx.getCustomModeStore();
  ctx.send(ws, {
    type: 'context.modes.list',
    payload: sessionPayload(ctx, {
      activeId: active,
      modes: modeStore.list().map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        isActive: m.id === active,
        thresholds: m.thresholds,
        preserveK: m.preserveK,
        eliseThreshold: m.eliseThreshold,
        custom: m.custom === true,
      })),
    }),
  });
}

export async function handleContextModeSwitch(
  ctx: ContextHandlerContext,
  ws: WebSocket,
  id: string,
): Promise<void> {
  // Built-in first, then custom.
  let policy = resolveContextWindowPolicy({}, id);
  if (policy.id !== id) {
    const modeStore = await ctx.getCustomModeStore();
    const custom = modeStore.list().find((m) => m.custom === true && m.id === id);
    if (!custom) {
      sendResult(ctx, ws, false, `Unknown context mode "${id}"`);
      return;
    }
    policy = custom as never as typeof policy;
  }
  ctx.agent.ctx.meta['contextWindowMode'] = policy.id;
  ctx.agent.ctx.meta['contextWindowPolicy'] = policy;
  sendResult(ctx, ws, true, `Context mode switched to ${policy.id}`);
  ctx.broadcast({
    type: 'context.mode.changed',
    payload: sessionPayload(ctx, { id: policy.id, name: policy.name, policy }),
  });
}

export async function handleContextModeCreate(
  ctx: ContextHandlerContext,
  ws: WebSocket,
  payload: {
    id: string;
    name: string;
    description: string;
    thresholds: { warn: number; soft: number; hard: number };
    preserveK: number;
    eliseThreshold: number;
  },
): Promise<void> {
  const modeStore = await ctx.getCustomModeStore();
  const result = modeStore.create({
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
  if (result.ok) await modeStore.save().catch(() => undefined); /* best-effort: user preferences */
  sendResult(ctx, ws, result.ok, result.error ?? `Mode "${payload.id}" created`);
}

export async function handleContextModeUpdate(
  ctx: ContextHandlerContext,
  ws: WebSocket,
  payload: {
    id: string;
    name?: string | undefined;
    description?: string | undefined;
    thresholds?:
      | { warn?: number | undefined; soft?: number | undefined; hard?: number | undefined }
      | undefined;
    preserveK?: number | undefined;
    eliseThreshold?: number | undefined;
  },
): Promise<void> {
  const modeStore = await ctx.getCustomModeStore();
  // Build the patch without explicit-undefined keys (exactOptionalPropertyTypes).
  const result = modeStore.update(payload.id, {
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
  if (result.ok) await modeStore.save().catch(() => undefined); /* best-effort: user preferences */
  sendResult(ctx, ws, result.ok, result.error ?? `Mode "${payload.id}" updated`);
}

export async function handleContextModeDelete(
  ctx: ContextHandlerContext,
  ws: WebSocket,
  id: string,
): Promise<void> {
  const actx = ctx.agent.ctx;
  // If the active mode is being deleted, fall back to the default.
  if (String(actx.meta['contextWindowMode'] ?? '') === id) {
    actx.meta['contextWindowMode'] = DEFAULT_CONTEXT_WINDOW_MODE_ID;
    actx.meta['contextWindowPolicy'] = resolveContextWindowPolicy(
      {},
      DEFAULT_CONTEXT_WINDOW_MODE_ID,
    );
  }
  const modeStore = await ctx.getCustomModeStore();
  const result = modeStore.remove(id);
  if (result.ok) await modeStore.save().catch(() => undefined); /* best-effort: user preferences */
  sendResult(ctx, ws, result.ok, result.error ?? `Mode "${id}" deleted`);
}
