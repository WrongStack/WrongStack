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

export function markLazySlotDormant(slot: ServerSlot, events: EventBus, reason: string): void {
  slot.client = undefined;
  slot.state = 'dormant';
  events.emit('mcp.server.disconnected', {
    name: slot.cfg.name,
    reason: `${reason} (dormant)`,
  });
}
