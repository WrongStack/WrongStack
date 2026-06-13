import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type Agent,
  DefaultSessionRewinder,
  type SessionStore,
  type SessionWriter,
} from '@wrongstack/core';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import type { WebSocket } from 'ws';
import type { WsCommon } from './index.js';

/**
 * PR 5j of Issue #30: session-management WebSocket handlers — `goal.get`,
 * `sessions.list`, `session.new`/`delete`/`save`, `session.checkpoints`/
 * `rewind`/`resume`.
 *
 * The session-swapping handlers (new/resume) and the rewinder mutate the
 * LIVE session writer on `agent.ctx.session` and reset the token counter,
 * exactly as the inline cases did. `opts` is read-only here (no field is
 * reassigned — unlike projects.select), so `SessionsOptions` is just the
 * subset these handlers read, passed by reference so they see live
 * `agent.ctx.session` / `opts.sessionStore` at call time.
 */

export interface SessionsOptions {
  projectRoot?: string | undefined;
  agent: Agent;
  session: SessionWriter;
  sessionStore?: SessionStore | undefined;
  sessionsDir?: string | undefined;
  onSessionSwapped?: ((newSessionId: string) => void) | undefined;
}

export interface SessionsContext extends WsCommon {
  opts: SessionsOptions;
  /** Build the reset session.start payload (runWebUI closure). */
  buildSessionStart: (overrides?: Record<string, unknown>) => Promise<unknown>;
}

function sendResult(ctx: WsCommon, ws: WebSocket, success: boolean, message: string): void {
  ctx.send(ws, { type: 'key.operation_result', payload: { success, message } });
}

/** The session store to use: the wired one, else a transient legacy fallback. */
function storeFor(opts: SessionsOptions): SessionStore {
  return (
    opts.sessionStore ??
    new DefaultSessionStore({
      dir: path.join(opts.projectRoot ?? opts.agent.ctx.projectRoot, '.wrongstack', 'sessions'),
    })
  );
}

export async function handleGoalGet(ctx: SessionsContext, _ws: WebSocket): Promise<void> {
  // Read goal.json from disk and broadcast the latest snapshot.
  const projectRoot = ctx.opts.projectRoot ?? ctx.opts.agent.ctx.projectRoot;
  try {
    const goalPath = path.join(projectRoot, '.wrongstack', 'goal.json');
    const raw = await fs.readFile(goalPath, 'utf8');
    ctx.broadcast({ type: 'goal.updated', payload: JSON.parse(raw) });
  } catch {
    ctx.broadcast({ type: 'goal.updated', payload: null });
  }
}

export async function handleSessionsList(
  ctx: SessionsContext,
  ws: WebSocket,
  limit: number,
): Promise<void> {
  try {
    const list = await storeFor(ctx.opts).list(limit);
    const currentId = ctx.opts.agent.ctx.session?.id ?? ctx.opts.session.id;
    ctx.send(ws, {
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
    ctx.send(ws, {
      type: 'sessions.list',
      payload: { sessions: [], error: err instanceof Error ? err.message : String(err) },
    });
  }
}

export async function handleSessionNew(ctx: SessionsContext, _ws: WebSocket): Promise<void> {
  const { opts } = ctx;
  const actx = opts.agent.ctx;
  const oldId = actx.session?.id ?? opts.session.id;
  if (opts.sessionStore) {
    try {
      const oldWriter = actx.session;
      const oldUsage = actx.tokenCounter.total();
      if (oldWriter) {
        void (async () => {
          await oldWriter
            .append({ type: 'session_end', ts: new Date().toISOString(), usage: oldUsage })
            .catch(() => undefined);
          await oldWriter.close().catch(() => undefined);
        })();
      }
      const fresh = await opts.sessionStore.create({
        id: '',
        title: '',
        model: actx.model,
        provider: (actx.provider as { id?: string }).id ?? '',
      });
      actx.session = fresh;
      opts.onSessionSwapped?.(fresh.id);
      actx.tokenCounter.reset();
    } catch (err) {
      // Store failure degrades to the in-memory reset below.
      ctx.log(
        JSON.stringify({
          level: 'warn',
          event: 'webui.session_new_store_failed',
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }
  actx.state.replaceMessages([]);
  actx.state.replaceTodos([]);
  actx.readFiles.clear();
  actx.fileMtimes.clear();
  const payload = await ctx.buildSessionStart({ reset: true, clearedSessionId: oldId });
  ctx.broadcast({ type: 'session.start', payload });
}

function rewinderFor(opts: SessionsOptions): DefaultSessionRewinder {
  const projectRoot = opts.projectRoot ?? opts.agent.ctx.projectRoot;
  return new DefaultSessionRewinder(
    opts.sessionsDir ?? path.join(projectRoot, '.wrongstack', 'sessions'),
    projectRoot,
  );
}

export async function handleSessionCheckpoints(ctx: SessionsContext, ws: WebSocket): Promise<void> {
  try {
    const rewinder = rewinderFor(ctx.opts);
    // Use the LIVE writer's id — after an in-app resume the active session
    // is agent.ctx.session, not the startup one.
    const liveId = ctx.opts.agent.ctx.session?.id ?? ctx.opts.session.id;
    const checkpoints = await rewinder.listCheckpoints(liveId);
    ctx.send(ws, { type: 'session.checkpoints', payload: { checkpoints } });
  } catch {
    ctx.send(ws, { type: 'session.checkpoints', payload: { checkpoints: [] } });
  }
}

export async function handleSessionRewind(
  ctx: SessionsContext,
  ws: WebSocket,
  checkpointIndex: number,
): Promise<void> {
  try {
    const rewinder = rewinderFor(ctx.opts);
    // Rewind the LIVE session — both the file (rewinder) and the JSONL
    // truncation (writer) must target the same session.
    const liveSession = ctx.opts.agent.ctx.session ?? ctx.opts.session;
    await rewinder.rewindToCheckpoint(liveSession.id, checkpointIndex);
    await liveSession.truncateToCheckpoint(checkpointIndex);
    sendResult(ctx, ws, true, `Rewound to checkpoint ${checkpointIndex}`);
    const payload = await ctx.buildSessionStart({ reset: true });
    ctx.broadcast({ type: 'session.start', payload });
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}

export async function handleSessionDelete(
  ctx: SessionsContext,
  ws: WebSocket,
  id: string,
): Promise<void> {
  // Guard against the CURRENT writer — after an in-app resume the active
  // session is agent.ctx.session, not the startup one.
  if (id === (ctx.opts.agent.ctx.session?.id ?? ctx.opts.session.id)) {
    sendResult(ctx, ws, false, 'Cannot delete the active session');
    return;
  }
  try {
    await storeFor(ctx.opts).delete(id);
    sendResult(ctx, ws, true, `Session ${id} deleted`);
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}

export function handleSessionSave(ctx: SessionsContext, ws: WebSocket): void {
  // SessionWriter auto-flushes — confirm for UI habit parity.
  sendResult(ctx, ws, true, `Session ${ctx.opts.session.id} is auto-saved`);
}

export async function handleSessionResume(
  ctx: SessionsContext,
  ws: WebSocket,
  id: string,
): Promise<void> {
  const { opts } = ctx;
  if (!opts.sessionStore) {
    sendResult(ctx, ws, false, 'Session store not available');
    return;
  }
  try {
    const actx = opts.agent.ctx;
    if (id === (actx.session?.id ?? opts.session.id)) {
      sendResult(ctx, ws, false, 'Session is already active');
      return;
    }
    const resumed = await opts.sessionStore.resume(id);
    // Finalize the writer we are leaving, then swap the context to the
    // resumed writer so all new events land in the resumed session's JSONL.
    const oldWriter = actx.session;
    if (oldWriter && oldWriter !== resumed.writer) {
      const oldUsage = actx.tokenCounter.total();
      void (async () => {
        await oldWriter
          .append({ type: 'session_end', ts: new Date().toISOString(), usage: oldUsage })
          .catch(() => undefined);
        await oldWriter.close().catch(() => undefined);
      })();
    }
    actx.session = resumed.writer;
    opts.onSessionSwapped?.(resumed.writer.id);
    // Hydrate the context with the old session's messages.
    actx.state.replaceMessages(resumed.data.messages);
    actx.state.replaceTodos([]);
    actx.readFiles.clear();
    actx.fileMtimes.clear();
    actx.tokenCounter.reset();
    // Replay usage so the topbar shows accurate totals.
    actx.tokenCounter.account(resumed.data.usage, actx.model);
    const payload = await ctx.buildSessionStart({
      reset: true,
      replayMessages: resumed.data.messages,
      replayUsage: resumed.data.usage,
    });
    ctx.broadcast({ type: 'session.start', payload });
    sendResult(ctx, ws, true, `Resumed session ${id}`);
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}
