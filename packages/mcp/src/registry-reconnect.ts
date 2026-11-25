import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { MCP_CONSTANTS } from './constants.js';
import type { ServerSlot } from './registry-slots.js';

interface ScheduleReconnectOptions {
  slot: ServerSlot;
  events: EventBus;
  log: Logger;
  maxReconnectCycles: number;
  baseReconnectDelayMs: number;
  maxReconnectDelayMs: number;
  recordReconnectExhausted: (slot: ServerSlot) => void;
  attemptReconnect: (slot: ServerSlot) => Promise<void>;
}

export function scheduleRegistryReconnect({
  slot,
  events,
  log,
  maxReconnectCycles,
  baseReconnectDelayMs,
  maxReconnectDelayMs,
  recordReconnectExhausted,
  attemptReconnect,
}: ScheduleReconnectOptions): void {
  if (slot.reconnectPending) return;
  const maxCycles = Number.isFinite(maxReconnectCycles)
    ? Math.max(0, Math.floor(maxReconnectCycles))
    : 0;
  if (slot.reconnectCycles >= maxCycles) {
    slot.state = 'failed';
    recordReconnectExhausted(slot);
    log.error(
      `MCP server "${slot.cfg.name}" giving up after ${slot.reconnectCycles} reconnect cycles. Use \`/mcp restart ${slot.cfg.name}\` to retry.`,
    );
    events.emit('mcp.server.disconnected', {
      name: slot.cfg.name,
      reason: `reconnect-exhausted:${slot.reconnectCycles}`,
      terminal: true,
    });
    return;
  }
  slot.reconnectPending = true;
  if (slot.reconnectTimer) {
    clearTimeout(slot.reconnectTimer);
    slot.reconnectTimer = undefined;
  }
  const safeBase =
    Number.isFinite(baseReconnectDelayMs) && baseReconnectDelayMs > 0
      ? baseReconnectDelayMs
      : MCP_CONSTANTS.RECONNECT.BASE_DELAY_MS;
  const safeMax =
    Number.isFinite(maxReconnectDelayMs) && maxReconnectDelayMs > 0
      ? maxReconnectDelayMs
      : Math.max(safeBase, 30_000);
  const base = Math.min(
    safeBase * MCP_CONSTANTS.RECONNECT.BACKOFF_MULTIPLIER ** slot.reconnectCycles,
    safeMax,
  );
  const jitter = base * MCP_CONSTANTS.RECONNECT.JITTER_FACTOR * (Math.random() * 2 - 1);
  const MAX_TIMEOUT_MS = 2_147_483_647;
  const delay = Number.isFinite(base + jitter)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(100, Math.round(base + jitter)))
    : 100;
  slot.reconnectTimer = setTimeout(() => {
    slot.reconnectTimer = undefined;
    void attemptReconnect(slot);
  }, delay);
  slot.reconnectTimer.unref?.();
}
