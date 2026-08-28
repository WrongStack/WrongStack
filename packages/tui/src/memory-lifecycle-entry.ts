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

interface MemoryLifecycleEntryData {
  action: MemoryLifecycleAction;
  label: string;
  detail?: string | undefined;
}

export function memoryLifecycleEntry(
  event: string,
  payload: Record<string, unknown>,
): MemoryLifecycleEntryData | null {
  const memoryId = stringValue(payload.memoryId);
  if (event === 'memory.accepted' && memoryId) {
    return { action: 'entered', label: `${memoryId} entered`, detail: health(payload) };
  }
  if (event === 'memory.merged' && memoryId) {
    return { action: 'merged', label: `${memoryId} merged` };
  }
  if (event === 'memory.recovered' && memoryId) {
    return {
      action: 'recovered',
      label: `${memoryId} recovered`,
      detail: stringValue(payload.reason),
    };
  }
  if (event === 'memory.deleted' && memoryId) {
    const removed = numberValue(payload.removedEdges);
    return {
      action: 'exited',
      label: `${memoryId} exited`,
      detail:
        [
          stringValue(payload.reason),
          removed === undefined ? undefined : `${removed} edges removed`,
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
    };
  }
  if (event === 'memory.updated' && memoryId) {
    const status = stringValue(payload.status) ?? 'updated';
    // Explicit deletes immediately emit the richer memory.deleted event.
    if (status === 'deleted') return null;
    return { action: 'updated', label: `${memoryId} → ${status}`, detail: health(payload) };
  }
  if (event === 'memory.graph_edge_added') {
    const from = stringValue(payload.from);
    const to = stringValue(payload.to);
    // File/directory scaffolding is useful graph data but far too noisy for
    // the human timeline. Show direct memory relationships only.
    if (!from?.startsWith('mem:') || !to?.startsWith('mem:')) return null;
    const evidence = Array.isArray(payload.evidence)
      ? payload.evidence.filter((value): value is string => typeof value === 'string')
      : [];
    return {
      action: 'related',
      label: `${shortId(from)} ↔ ${shortId(to)}`,
      detail: [
        stringValue(payload.relation) ?? 'related_to',
        evidence.length > 0 ? `why: ${evidence.join(', ')}` : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
    };
  }
  if (event === 'memory.relationships_rebuilt') {
    return {
      action: 'related',
      label: 'relationships rebuilt',
      detail: `${numberValue(payload.added) ?? 0} added / ${numberValue(payload.proposed) ?? 0} proposed`,
    };
  }
  if (event === 'memory.superseded' && memoryId) {
    return {
      action: 'superseded',
      label: `${memoryId} → superseded`,
      detail: stringValue(payload.reason) ?? health(payload),
    };
  }
  if (event === 'memory.archived' && memoryId) {
    return {
      action: 'archived',
      label: `${memoryId} → archived`,
      detail: stringValue(payload.reason),
    };
  }
  if (event === 'memory.staled' && memoryId) {
    return {
      action: 'staled',
      label: `${memoryId} → staled`,
      detail: stringValue(payload.reason) ?? 'anchor drift detected',
    };
  }
  if (event === 'memory.contradicted' && memoryId) {
    return {
      action: 'contradicted',
      label: `${memoryId} → contradicted`,
      detail: stringValue(payload.reason) ?? 'conflicting evidence',
    };
  }
  return null;
}

function health(payload: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const kind = stringValue(payload.kind);
  const persistence = stringValue(payload.persistence);
  const confidence = numberValue(payload.confidence);
  const freshness = numberValue(payload.freshness);
  if (kind) parts.push(kind);
  if (persistence) parts.push(persistence);
  if (confidence !== undefined) parts.push(`confidence ${confidence.toFixed(2)}`);
  if (freshness !== undefined) parts.push(`freshness ${freshness.toFixed(2)}`);
  return parts.join(' · ') || undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function shortId(node: string): string {
  const value = node.slice(4);
  return value.length > 22 ? `${value.slice(0, 19)}…` : value;
}
