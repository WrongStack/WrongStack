import type { EventBus } from '@wrongstack/core/kernel';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { ServerSlot } from './registry-slots.js';

export function resetDisconnectedSlotTools(slot: ServerSlot, toolRegistry: ToolRegistry): void {
  for (const t of slot.toolNames) {
    try {
      toolRegistry.unregister(t);
    } catch {
      /* ignore */
    }
  }
  slot.toolNames = [];
  slot.lazyTools = [];
  slot.serverMetadata = undefined;
  slot.resources = undefined;
  slot.resourceTemplates = undefined;
  slot.prompts = undefined;
}

export interface MarkLazySlotDormantOptions {
  onChildExit?: (name: string, code: number | null, signal: string | null) => void;
  onToolsChanged?: (name: string, tools: { name: string }[]) => void;
  removeCatalogListeners?: (client: import('./client.js').MCPClient) => void;
}

export function markLazySlotDormant(
  slot: ServerSlot,
  events: EventBus,
  reason: string,
  options?: MarkLazySlotDormantOptions,
): void {
  slot.reconnectPending = false;
  if (slot.reconnectTimer) {
    clearTimeout(slot.reconnectTimer);
    slot.reconnectTimer = undefined;
  }
  if (slot.client) {
    if (options?.onChildExit) {
      slot.client.removeExitListener?.(options.onChildExit);
    }
    if (slot.onDisconnect) {
      slot.client.removeDisconnectListener?.(slot.onDisconnect);
    }
    if (options?.onToolsChanged) {
      slot.client.removeToolsChangedListener?.(options.onToolsChanged);
    }
    options?.removeCatalogListeners?.(slot.client);
    slot.client.close?.().catch(() => {});
    slot.client = undefined;
  }
  slot.onDisconnect = undefined;
  slot.state = 'dormant';
  events.emit('mcp.server.disconnected', {
    name: slot.cfg.name,
    reason: `${reason} (dormant)`,
  });
}

