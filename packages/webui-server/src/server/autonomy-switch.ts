/**
 * `autonomy.switch`: a tab changes its autonomy mode. Split out of
 * prefs-handlers.ts.
 */
import { toErrorMessage } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import { resolveYoloEligiblePendingConfirms } from './pending-confirms.js';
import { handlePrefsGet, type PrefsHandlerContext } from './prefs-handlers.js';

function sendOperationResult(
  ctx: PrefsHandlerContext,
  ws: WebSocket,
  success: boolean,
  message: string,
): void {
  ctx.send(ws, { type: 'key.operation_result', payload: { success, message } });
}

export async function handleAutonomySwitch(
  ctx: PrefsHandlerContext,
  ws: WebSocket,
  mode: string,
  sessionId?: string,
): Promise<void> {
  let refusal: string | undefined;
  try {
    refusal = await ctx.checkAutonomy?.(mode, sessionId);
  } catch (err) {
    refusal = `Autonomy mode was not changed: ${toErrorMessage(err)}`;
  }
  if (refusal) {
    sendOperationResult(ctx, ws, false, refusal);
    handlePrefsGet(ctx, ws, sessionId);
    return;
  }
  try {
    await ctx.persist({ autonomy: mode });
  } catch (err) {
    sendOperationResult(ctx, ws, false, `Autonomy mode was not saved: ${toErrorMessage(err)}`);
    handlePrefsGet(ctx, ws, sessionId);
    return;
  }
  // Autonomy is per-tab: a tab left running on `eternal` must not drag the
  // tab the user is typing in along with it.
  const meta = ctx.metaFor?.(sessionId) ?? ctx.meta;
  meta['autonomy'] = mode;
  // A host that drives the eternal loop (it answers `checkAutonomy`) turns on
  // this tab's YOLO before the loop starts, as the CLI's `/autonomy eternal`
  // does: an unattended loop must not stop at every tool approval. Explicit
  // deny rules still apply. Same path as `prefs.update { yolo: true }`.
  const yoloForLoop =
    ctx.checkAutonomy !== undefined && isEternalMode(mode) && meta['yolo'] !== true;
  if (yoloForLoop) {
    meta['yolo'] = true;
    ctx.setYolo?.(true, sessionId);
    resolveYoloEligiblePendingConfirms(ctx.pendingConfirms, sessionId);
  }
  ctx.setAutonomy?.(mode, sessionId);
  sendOperationResult(
    ctx,
    ws,
    true,
    yoloForLoop
      ? `Autonomy mode set to "${mode}"; YOLO is on for this conversation, so tools run without approval unless a deny rule blocks them.`
      : `Autonomy mode set to "${mode}"`,
  );
  ctx.broadcast({
    type: 'prefs.updated',
    payload: {
      autonomy: mode,
      ...(yoloForLoop ? { yolo: true } : {}),
      ...(sessionId ? { sessionId } : {}),
    },
  });
}

function isEternalMode(mode: string): boolean {
  return mode === 'eternal' || mode === 'eternal-parallel';
}
