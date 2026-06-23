/**
 * Process-registry WebSocket handlers for the WebUI server, extracted from the
 * `handleMessage` switch in `index.ts` as part of splitting that file (#31).
 *
 *   case 'process.list':    return handleProcessList(ws);
 *   case 'process.kill':    return handleProcessKill(ws, msg.payload);
 *   case 'process.killAll': return handleProcessKillAll(ws);
 *
 * All three reach the registry via a dynamic `@wrongstack/tools` import so the
 * server starts even when that package is unavailable, and never throw — a
 * failure is reported back over the socket instead.
 */

import type { WebSocket } from 'ws';
import { errMessage, send, sendResult } from './ws-utils.js';
import { validateProcessKillPayload } from './ws-payload-validation.js';

/** Broadcast the tracked-process list; an empty list on any registry failure. */
export async function handleProcessList(ws: WebSocket): Promise<void> {
  try {
    const { getProcessRegistry } = await import('@wrongstack/tools');
    const procs = getProcessRegistry().list();
    send(ws, {
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
    send(ws, { type: 'process.list', payload: { processes: [] } });
  }
}

/** Kill one tracked PID. Rejects invalid payloads and protected processes. */
export async function handleProcessKill(ws: WebSocket, payload: unknown): Promise<void> {
  const parsed = validateProcessKillPayload(payload);
  if (!parsed.ok) {
    sendResult(ws, false, parsed.message);
    return;
  }
  const { pid } = parsed.value;
  try {
    const { getProcessRegistry } = await import('@wrongstack/tools');
    const proc = getProcessRegistry().get(pid);
    if (proc?.protected) {
      sendResult(ws, false, `Cannot kill protected process (PID ${pid})`);
      return;
    }
    getProcessRegistry().kill(pid);
    sendResult(ws, true, `Killed PID ${pid}`);
  } catch (err) {
    sendResult(ws, false, errMessage(err));
  }
}

/** Kill every tracked process. */
export async function handleProcessKillAll(ws: WebSocket): Promise<void> {
  try {
    const { getProcessRegistry } = await import('@wrongstack/tools');
    getProcessRegistry().killAll();
    sendResult(ws, true, 'All processes killed');
  } catch (err) {
    sendResult(ws, false, errMessage(err));
  }
}
