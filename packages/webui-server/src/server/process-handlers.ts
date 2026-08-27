/**
 * Process-registry WebSocket handlers for the WebUI server, extracted from the
 * `handleMessage` switch in `index.ts` as part of splitting that file (#31).
 *
 *   case 'process.list':    return handleProcessList(ws, msg);
 *   case 'process.kill':    return handleProcessKill(ws, msg.payload);
 *   case 'process.killAll': return handleProcessKillAll(ws, …, msg.payload);
 *
 * Four tabs share one registry. A list/kill that ignores sessionId lets tab 2
 * see (and terminate) tab 1's bash. When the request names a session, list
 * and kill-all are confined to that session's children; a kill of a PID that
 * belongs to a different session is refused.
 *
 * Registry failures never escape the handler; they are reported over the
 * socket using the existing protocol envelopes.
 */

import { createCompatibilityTrustBoundary, type TrustBoundary } from '@wrongstack/core/security';
import type { Logger } from '@wrongstack/core/types';
import { getProcessRegistry } from '@wrongstack/tools';
import type { WebSocket } from 'ws';
import { authorizeWebUIAction, type WebUIPrivilegedAction } from './privileged-actions.js';
import { validateProcessKillPayload } from './ws-payload-validation.js';
import { errMessage, send, sendResult } from './ws-utils.js';

function payloadSessionId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as { sessionId?: unknown }).sessionId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Broadcast the tracked-process list; an empty list on any registry failure. */
export function handleProcessList(ws: WebSocket, msg?: { payload?: unknown }): void {
  const sessionId = payloadSessionId(msg?.payload);
  try {
    const registry = getProcessRegistry();
    const procs = sessionId ? registry.bySession(sessionId) : registry.list();
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
          background: p.background,
          ...(p.sessionId ? { sessionId: p.sessionId } : {}),
        })),
        ...(sessionId ? { sessionId } : {}),
      },
    });
  } catch {
    send(ws, {
      type: 'process.list',
      payload: { processes: [], ...(sessionId ? { sessionId } : {}) },
    });
  }
}

/** Kill one tracked PID. Rejects invalid payloads and protected processes. */
export async function handleProcessKill(
  ws: WebSocket,
  payload: unknown,
  trustBoundary: TrustBoundary = createCompatibilityTrustBoundary({
    policyId: 'webui-process-compat-v1',
  }),
  logger?: Logger | undefined,
  metadata?: WebUIPrivilegedAction['metadata'] | undefined,
): Promise<void> {
  const parsed = validateProcessKillPayload(payload);
  if (!parsed.ok) {
    sendResult(ws, false, parsed.message);
    return;
  }
  const { pid } = parsed.value;
  const authorization = await authorizeWebUIAction(
    trustBoundary,
    {
      capability: 'process.terminate',
      subject: { kind: 'process', id: String(pid), attributes: { operation: 'kill' } },
      risk: 'high',
      metadata: { transport: 'websocket', ...(metadata ?? {}) },
    },
    logger,
  );
  if (!authorization.allowed) {
    sendResult(ws, false, `Process termination denied: ${authorization.reason}`);
    return;
  }
  try {
    const proc = getProcessRegistry().get(pid);
    const requestedSession = payloadSessionId(payload);
    if (requestedSession && proc?.sessionId && proc.sessionId !== requestedSession) {
      sendResult(ws, false, `Process ${pid} belongs to another session`);
      return;
    }
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
export async function handleProcessKillAll(
  ws: WebSocket,
  trustBoundary: TrustBoundary = createCompatibilityTrustBoundary({
    policyId: 'webui-process-compat-v1',
  }),
  logger?: Logger | undefined,
  metadata?: WebUIPrivilegedAction['metadata'] | undefined,
  payload?: unknown,
): Promise<void> {
  const sessionId = payloadSessionId(payload);
  const authorization = await authorizeWebUIAction(
    trustBoundary,
    {
      capability: 'process.terminate-all',
      subject: {
        kind: 'resource',
        id: sessionId ? `tracked-process-registry:${sessionId}` : 'tracked-process-registry',
      },
      risk: 'critical',
      metadata: { transport: 'websocket', ...(metadata ?? {}) },
    },
    logger,
  );
  if (!authorization.allowed) {
    sendResult(ws, false, `Process termination denied: ${authorization.reason}`);
    return;
  }
  try {
    if (sessionId) {
      getProcessRegistry().killSession(sessionId);
      sendResult(ws, true, `Killed processes for session ${sessionId}`);
      return;
    }
    getProcessRegistry().killAll();
    sendResult(ws, true, 'All processes killed');
  } catch (err) {
    sendResult(ws, false, errMessage(err));
  }
}
