/**
 * Payload checks and dispatch for the "Import from HQ" messages (`hq.*`).
 * The work is in `hq-import.ts`; every request answers `hq.state`.
 */
import type { WebSocket } from 'ws';
import type { ProviderMutationHandlers } from '../provider-route-types.js';
import type { WSClientMessage } from '../types.js';
import { sendResult } from '../ws-utils.js';

type HqHandlers = Pick<
  ProviderMutationHandlers,
  'handleHqStatus' | 'handleHqEnroll' | 'handleHqImport' | 'handleHqSync' | 'handleHqUnenroll'
>;

const PROFILE_ID = /^(?!__proto__$|prototype$|constructor$)[^\u0000-\u001f]{1,256}$/;

function invalid(ws: WebSocket, type: string): true {
  sendResult(ws, false, `${type} payload is invalid`);
  return true;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** Handles an `hq.*` message; false for any other type. */
export async function dispatchHqRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  handlers: HqHandlers,
): Promise<boolean> {
  const raw = msg.payload;
  const payload =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  switch (msg.type) {
    case 'hq.status':
      await handlers.handleHqStatus(ws);
      return true;
    case 'hq.enroll': {
      const hqUrl = nonEmpty(payload['hqUrl']);
      const token = nonEmpty(payload['token']);
      const label = payload['label'];
      if (!hqUrl || !token || hqUrl.length > 2048 || token.length > 256)
        return invalid(ws, msg.type);
      if (label !== undefined && (typeof label !== 'string' || label.length > 80))
        return invalid(ws, msg.type);
      await handlers.handleHqEnroll(ws, {
        hqUrl,
        token,
        ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
      });
      return true;
    }
    case 'hq.import': {
      const ids = payload['profileIds'];
      if (
        ids !== undefined &&
        (!Array.isArray(ids) ||
          ids.length > 256 ||
          ids.some((id) => typeof id !== 'string' || !PROFILE_ID.test(id)))
      )
        return invalid(ws, msg.type);
      await handlers.handleHqImport(ws, ids as string[] | undefined);
      return true;
    }
    case 'hq.sync':
      await handlers.handleHqSync(ws);
      return true;
    case 'hq.unenroll': {
      const removeKeys = payload['removeKeys'];
      if (removeKeys !== undefined && typeof removeKeys !== 'boolean') return invalid(ws, msg.type);
      await handlers.handleHqUnenroll(ws, removeKeys === true);
      return true;
    }
    default:
      return false;
  }
}
