import * as net from 'node:net';
import type { ConnectionHealthService } from './types.js';

const RESTART_POLL_INTERVAL_MS = 250;
const RESTART_DEADLINE_MS = 3_000;

/**
 * Raw socket probe — checks if anything is listening on an IPC endpoint
 * (Unix domain socket or Windows named pipe) without sending protocol frames.
 * Used for services whose client API offers no non-spawning probe.
 */
export function isEndpointAlive(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(endpoint);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, 500);
    timer.unref?.();
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * Give a shutdown signal time to take effect before re-establishing the
 * connection. When a probe is provided, polls until the server confirms it
 * is down. Falls back to a single sleep when no probe is available.
 */
export async function waitForShutdown(probe?: () => Promise<boolean>): Promise<void> {
  if (!probe) {
    await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_INTERVAL_MS));
    return;
  }
  const deadline = Date.now() + RESTART_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      const stillUp = await probe();
      if (!stillUp) return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_INTERVAL_MS));
  }
}

export function failureService(
  id: ConnectionHealthService['id'],
  label: string,
  required: boolean,
  mode: string,
  error: unknown,
  latencyMs?: number,
): ConnectionHealthService {
  const message = error instanceof Error ? error.message : String(error);
  return {
    id,
    label,
    status: 'error',
    required,
    mode,
    detail: message,
    lastError: message,
    ...(latencyMs === undefined ? {} : { latencyMs }),
  };
}

export function isOfflineConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:ENOENT|ECONNREFUSED|not found|not running|unavailable|connect failed)/iu.test(message);
}
