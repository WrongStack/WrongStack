import { getProcessRegistry } from '@wrongstack/tools';
import type { WebSocket } from 'ws';
import type { WsCommon } from './index.js';

/**
 * PR 5i of Issue #30: background-process WebSocket handlers —
 * `process.list`, `process.kill`, `process.killAll`.
 *
 * These only touch the global process registry (from `@wrongstack/tools`)
 * — no run-loop state — so they take the bare `WsCommon` messaging
 * surface. The registry import is now static (the switch loaded it
 * lazily per-case).
 */

function sendResult(ctx: WsCommon, ws: WebSocket, success: boolean, message: string): void {
  ctx.send(ws, { type: 'key.operation_result', payload: { success, message } });
}

export function handleProcessList(ctx: WsCommon, ws: WebSocket): void {
  try {
    const procs = getProcessRegistry().list();
    ctx.send(ws, {
      type: 'process.list',
      payload: {
        processes: procs.map((p) => ({
          pid: p.pid,
          command: p.command,
          tool: p.name,
          startedAt: p.startedAt,
          status: p.killed ? ('killed' as const) : ('running' as const),
          protected: p.protected,
        })),
      },
    });
  } catch {
    ctx.send(ws, { type: 'process.list', payload: { processes: [] } });
  }
}

export function handleProcessKill(ctx: WsCommon, ws: WebSocket, pid: number): void {
  try {
    const proc = getProcessRegistry().get(pid);
    if (proc?.protected) {
      sendResult(ctx, ws, false, `Cannot kill protected process (PID ${pid})`);
      return;
    }
    getProcessRegistry().kill(pid);
    sendResult(ctx, ws, true, `Killed PID ${pid}`);
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}

export function handleProcessKillAll(ctx: WsCommon, ws: WebSocket): void {
  try {
    getProcessRegistry().killAll();
    sendResult(ctx, ws, true, 'All processes killed');
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}
