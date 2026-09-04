import type { EventBus } from '@wrongstack/core/kernel';
import type { Logger } from '@wrongstack/core/types';
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
  if (slot.reconnectCycles >= maxReconnectCycles) {
    slot.state = 'failed';
    recordReconnectExhausted(slot);
    log.error(
      `MCP server "${slot.cfg.name}" giving up after ${slot.reconnectCycles} reconnect cycles. Use \`/mcp restart ${slot.cfg.name}\` to retry.`,
    );
    events.emit('mcp.server.disconnected', {
      name: slot.cfg.name,
      reason: `reconnect-exhausted:${slot.reconnectCycles}`,
    });
    return;
  }
  slot.reconnectPending = true;
  if (slot.reconnectTimer) {
    clearTimeout(slot.reconnectTimer);
    slot.reconnectTimer = undefined;
  }
  const base = Math.min(baseReconnectDelayMs * 2 ** slot.reconnectCycles, maxReconnectDelayMs);
  const jitter = base * MCP_CONSTANTS.RECONNECT.JITTER_FACTOR * (Math.random() * 2 - 1);
  const delay = Math.max(100, Math.round(base + jitter));
  slot.reconnectTimer = setTimeout(() => {
    slot.reconnectTimer = undefined;
    void attemptReconnect(slot);
  }, delay);
  slot.reconnectTimer.unref?.();
}
