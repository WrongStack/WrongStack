import { createSessionScopedStore } from './session-scoped-store';

export type MemoryLifecycleAction =
  | 'entered'
  | 'updated'
  | 'merged'
  | 'recovered'
  | 'exited'
  | 'related'
  | 'superseded'
  | 'archived'
  | 'staled'
  | 'contradicted';

interface MemoryLifecycleItem {
  id: string;
  at: string;
  event: string;
  action: MemoryLifecycleAction;
  memoryId?: string | undefined;
  label: string;
  detail?: string | undefined;
}

interface MemoryLifecycleState {
  items: MemoryLifecycleItem[];
  pushEvent: (payload: Record<string, unknown> & { event: string }) => void;
  clear: () => void;
}

const MAX_ITEMS = 100;

const TERMINAL_ACTIONS: ReadonlySet<MemoryLifecycleAction> = new Set([
  'exited',
  'superseded',
  'archived',
  'staled',
  'contradicted',
]);

export function toMemoryLifecycleItem(
  payload: Record<string, unknown> & { event: string },
  now = new Date(),
): MemoryLifecycleItem | null {
  const event = payload.event;
  const memoryId = stringValue(payload.memoryId);
  const at = stringValue(payload.at) ?? now.toISOString();
  const base = {
    id: `${event}_${now.getTime()}_${Math.random().toString(36).slice(2, 7)}`,
    at,
    event,
  };

  if (event === 'memory.accepted' && memoryId) {
    return {
      ...base,
      action: 'entered',
      memoryId,
      label: `${memoryId} entered memory`,
      detail: healthDetail(payload),
    };
  }
  if (event === 'memory.merged' && memoryId) {
    const count = Array.isArray(payload.mergedIds) ? payload.mergedIds.length : 0;
    return {
      ...base,
      action: 'merged',
      memoryId,
      label: `${memoryId} merged`,
      detail: count > 0 ? `${count} records folded in` : undefined,
    };
  }
  if (event === 'memory.recovered' && memoryId) {
    return {
      ...base,
      action: 'recovered',
      memoryId,
      label: `${memoryId} recovered`,
      detail: stringValue(payload.reason),
    };
  }
  if (event === 'memory.deleted' && memoryId) {
    return {
      ...base,
      action: 'exited',
      memoryId,
      label: `${memoryId} exited memory`,
      detail: deletionDetail(payload),
    };
  }
  if (event === 'memory.updated' && memoryId) {
    const status = stringValue(payload.status) ?? 'updated';
    return {
      ...base,
      action: status === 'deleted' ? 'exited' : 'updated',
      memoryId,
      label: status === 'deleted' ? `${memoryId} exited memory` : `${memoryId} updated → ${status}`,
      detail: healthDetail(payload),
    };
  }
  if (event === 'memory.graph_edge_added') {
    const from = stringValue(payload.from);
    const to = stringValue(payload.to);
    // Keep the live operator ledger human-sized. File/directory scaffolding
    // remains visible in the graph itself; this ledger shows memory↔memory.
    if (!from?.startsWith('mem:') || !to?.startsWith('mem:')) return null;
    const relation = stringValue(payload.relation) ?? 'related_to';
    const weight = numberValue(payload.weight);
    const evidence = Array.isArray(payload.evidence)
      ? payload.evidence.filter((value): value is string => typeof value === 'string')
      : [];
    return {
      ...base,
      action: 'related',
      memoryId: from.startsWith('mem:') ? from.slice(4) : undefined,
      label: `${shortNode(from)} ↔ ${shortNode(to)}`,
      detail: [
        relation,
        weight === undefined ? undefined : `weight ${weight.toFixed(2)}`,
        evidence.length > 0 ? `why: ${evidence.join(', ')}` : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
    };
  }
  if (event === 'memory.relationships_rebuilt') {
    return {
      ...base,
      action: 'related',
      label: 'Memory relationships rebuilt',
      detail: `${numberValue(payload.added) ?? 0} added / ${numberValue(payload.proposed) ?? 0} proposed`,
    };
  }
  if (event === 'memory.superseded' && memoryId) {
    return {
      ...base,
      action: 'superseded',
      memoryId,
      label: `${memoryId} → superseded`,
      detail: stringValue(payload.reason) ?? healthDetail(payload),
    };
  }
  if (event === 'memory.archived' && memoryId) {
    return {
      ...base,
      action: 'archived',
      memoryId,
      label: `${memoryId} → archived`,
      detail: stringValue(payload.reason),
    };
  }
  if (event === 'memory.staled' && memoryId) {
    return {
      ...base,
      action: 'staled',
      memoryId,
      label: `${memoryId} → staled`,
      detail: stringValue(payload.reason) ?? 'anchor drift detected',
    };
  }
  if (event === 'memory.contradicted' && memoryId) {
    return {
      ...base,
      action: 'contradicted',
      memoryId,
      label: `${memoryId} → contradicted`,
      detail: stringValue(payload.reason) ?? 'conflicting evidence',
    };
  }
  return null;
}

/**
 * SAGE lifecycle events belong to the conversation whose run produced them,
 * so each tab keeps its own trace.
 */
export const useMemoryLifecycleStore = createSessionScopedStore<MemoryLifecycleState>((set) => ({
  items: [],
  pushEvent: (payload) =>
    set((state) => {
      const item = toMemoryLifecycleItem(payload);
      if (!item) return state;
      const withoutDuplicateExit = TERMINAL_ACTIONS.has(item.action)
        ? state.items.filter(
            (existing) =>
              !(TERMINAL_ACTIONS.has(existing.action) && existing.memoryId === item.memoryId),
          )
        : state.items;
      return { items: [item, ...withoutDuplicateExit].slice(0, MAX_ITEMS) };
    }),
  clear: () => set({ items: [] }),
}));

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function healthDetail(payload: Record<string, unknown>): string | undefined {
  const parts = [stringValue(payload.kind), stringValue(payload.persistence)];
  const confidence = numberValue(payload.confidence);
  const freshness = numberValue(payload.freshness);
  if (confidence !== undefined) parts.push(`confidence ${confidence.toFixed(2)}`);
  if (freshness !== undefined) parts.push(`freshness ${freshness.toFixed(2)}`);
  return parts.filter(Boolean).join(' · ') || undefined;
}

function deletionDetail(payload: Record<string, unknown>): string | undefined {
  const reason = stringValue(payload.reason);
  const removedEdges = numberValue(payload.removedEdges);
  return (
    [reason, removedEdges === undefined ? undefined : `${removedEdges} edges removed`]
      .filter(Boolean)
      .join(' · ') || undefined
  );
}

function shortNode(node: string): string {
  const value = node.replace(/^mem:/, '');
  return value.length > 26 ? `${value.slice(0, 23)}…` : value;
}
