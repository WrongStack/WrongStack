interface MemoryContextDetail {
  id: string;
  kind: string;
  text: string;
  score: number;
  /**
   * The relation gate's own value. `score` alone cannot explain an injection
   * because metadata boosts can carry a weak relation over the score bar —
   * this is the number the `relationFloor` gate actually tested.
   */
  relationStrength: number;
  confidence: number;
  freshness: number;
  importance: number;
  persistence: string;
  anchors: string[];
  tags: string[];
  activationReasons: string[];
  state: 'injected' | 'active' | 'exited';
  trigger: string;
  enteredAt: string;
  lastSeenAt: string;
  exitedAt?: string | undefined;
  /** True when created by placeholder() — the detail fields are zero-value defaults. */
  isPlaceholder?: boolean | undefined;
}

export interface MemoryContextTransition {
  id: string;
  at: string;
  memoryId: string;
  action: 'injected' | 'entered' | 'exited';
  reason: string;
}

interface MemoryInjectorSummary {
  at: string;
  trigger: string;
  matched: number;
  injected: number;
  filtered: number;
  contextPressure: number;
  injectedChars: number;
  outcome?: 'injected' | 'empty' | 'error' | undefined;
  error?: string | undefined;
}

export interface MemoryContextMonitorState {
  latest?: MemoryInjectorSummary | undefined;
  memories: Record<string, MemoryContextDetail>;
  transitions: MemoryContextTransition[];
}

export function emptyMemoryContextMonitor(): MemoryContextMonitorState {
  return { memories: {}, transitions: [] };
}

/**
 * Cap on retained `exited` memories. Active/injected memories are always kept
 * (they reflect live provider context); exited ones are historical and are
 * pruned oldest-first past this bound. Without this, every distinct memory id
 * ever injected accumulates forever — each holding full `text` + anchor/tag/
 * reason arrays — over a long autonomous session. Mirrors the `transitions`
 * .slice(0, 100) cap and the token-preview store's LRU.
 */
const MAX_EXITED_MEMORIES = 200;

/**
 * UI-only text budget for memory detail cards. Full text lives in SAGE
 * SQLite; the TUI only needs a short preview for the context panel.
 */
export const MAX_MEMORY_DETAIL_TEXT_CHARS = 300;

function capMemoryDetailText(text: string): string {
  if (text.length <= MAX_MEMORY_DETAIL_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_MEMORY_DETAIL_TEXT_CHARS - 1)}…`;
}

/**
 * Evict the oldest `exited` memories once their count exceeds the cap. Returns
 * the same record when nothing needs pruning (no allocation on the hot path).
 */
function pruneExitedMemories(
  memories: Record<string, MemoryContextDetail>,
): Record<string, MemoryContextDetail> {
  const exited: MemoryContextDetail[] = [];
  for (const memory of Object.values(memories)) {
    if (memory.state === 'exited') exited.push(memory);
  }
  if (exited.length <= MAX_EXITED_MEMORIES) return memories;
  // Keep the most recently exited; drop the rest. `exitedAt` falls back to
  // lastSeenAt for records exited via the pre-provider sweep.
  exited.sort((a, b) => (b.exitedAt ?? b.lastSeenAt).localeCompare(a.exitedAt ?? a.lastSeenAt));
  const pruned = { ...memories };
  for (const memory of exited.slice(MAX_EXITED_MEMORIES)) {
    delete pruned[memory.id];
  }
  return pruned;
}

/** Count only memories confirmed present in the latest provider-bound request. */
export function activeMemoryContextCount(state: MemoryContextMonitorState): number {
  return Object.values(state.memories).filter((memory) => memory.state === 'active').length;
}

/** Keep leader telemetry isolated from subagent sessions sharing the same EventBus. */
export function memoryEventMatchesSession(payload: unknown, currentSessionId: string): boolean {
  const eventSessionId = stringValue(recordValue(payload).sessionId);
  return eventSessionId === undefined || eventSessionId === currentSessionId;
}

/** Read the all-status SAGE record total without requiring that backend at the type boundary. */
export async function readMemoryRecordTotal(store: unknown): Promise<number | undefined> {
  if (!store || typeof store !== 'object') return undefined;
  // Production path: MemoryPort exposes stats via the SAGE surface capability
  // (getCapability). ProjectSageMemoryPort proxies over IPC and has no direct
  // stats() method — only the capability accessor.
  if (typeof (store as { getCapability?: unknown }).getCapability === 'function') {
    try {
      const { getSageSurface } = await import('@wrongstack/sage');
      const surface = getSageSurface(store as import('@wrongstack/core/types').MemoryPort);
      if (surface && typeof surface.stats === 'function') {
        const result = await surface.stats();
        return typeof result.total === 'number' &&
          Number.isFinite(result.total) &&
          result.total >= 0
          ? Math.floor(result.total)
          : undefined;
      }
    } catch {
      // Dynamic import or capability resolution failed — fall through to
      // the duck-typing path below (works for SqliteMemoryPort in inline mode).
    }
  }
  // Inline/test fallback: SqliteMemoryPort extends SqliteSageStore and has
  // stats() directly on the object.
  if (!('stats' in store)) return undefined;
  const stats = (store as { stats?: unknown }).stats;
  if (typeof stats !== 'function') return undefined;
  const result = (await stats.call(store)) as { total?: unknown };
  return typeof result.total === 'number' && Number.isFinite(result.total) && result.total >= 0
    ? Math.floor(result.total)
    : undefined;
}

export function applyMemoryInjectorRun(
  state: MemoryContextMonitorState,
  payload: Record<string, unknown>,
): MemoryContextMonitorState {
  const at = stringValue(payload.at) ?? new Date().toISOString();
  const trigger = stringValue(payload.trigger) ?? 'unknown';
  const injected = arrayRecords(payload.injected);
  const rejected = recordValue(payload.rejected);
  const memories = { ...state.memories };
  const transitions = [...state.transitions];
  for (const item of injected) {
    const id = stringValue(item.id);
    if (!id) continue;
    const previous = memories[id];
    memories[id] = {
      id,
      kind: stringValue(item.kind) ?? 'unknown',
      text: capMemoryDetailText(stringValue(item.text) ?? ''),
      score: numberValue(item.score),
      relationStrength: numberValue(item.relationStrength),
      confidence: numberValue(item.confidence),
      freshness: numberValue(item.freshness),
      importance: numberValue(item.importance),
      persistence: stringValue(item.persistence) ?? 'unknown',
      anchors: stringArray(item.anchors),
      tags: stringArray(item.tags),
      activationReasons: stringArray(item.activationReasons),
      // Injection is pending until the next provider request. If this memory
      // was already confirmed in the latest request, a re-injection must not
      // erase that authoritative provider-context state.
      state: previous?.state === 'active' ? 'active' : 'injected',
      trigger,
      enteredAt: previous?.enteredAt ?? at,
      lastSeenAt: at,
    };
    transitions.unshift({
      id: `${at}_injected_${id}`,
      at,
      memoryId: id,
      action: 'injected',
      reason: `${trigger} · score ${numberValue(item.score).toFixed(2)}`,
    });
  }
  const outcome = stringValue(payload.outcome);
  const errorStr = stringValue(payload.error);
  return {
    latest: {
      at,
      trigger,
      matched: numberValue(payload.candidates),
      injected: outcome === 'error' ? 0 : injected.length,
      filtered: Object.values(rejected).reduce<number>((sum, value) => sum + numberValue(value), 0),
      contextPressure: numberValue(payload.contextPressure),
      injectedChars: numberValue(payload.injectedChars),
      outcome: (outcome ?? undefined) as 'injected' | 'empty' | 'error' | undefined,
      ...(outcome === 'error' && errorStr ? { error: errorStr } : {}),
    },
    memories: pruneExitedMemories(memories),
    transitions: transitions.slice(0, 100),
  };
}

export function applyMemoryContextSnapshot(
  state: MemoryContextMonitorState,
  payload: Record<string, unknown>,
): MemoryContextMonitorState {
  const at = stringValue(payload.at) ?? new Date().toISOString();
  const activeIds = stringArray(payload.activeMemoryIds);
  const enteredIds = stringArray(payload.enteredMemoryIds);
  const exitedIds = stringArray(payload.exitedMemoryIds);
  const active = new Set(activeIds);
  const memories = { ...state.memories };
  const transitions = [...state.transitions];

  for (const id of activeIds) {
    const previous = memories[id];
    memories[id] = previous
      ? { ...previous, state: 'active', lastSeenAt: at, exitedAt: undefined }
      : placeholder(id, at, 'active');
  }
  for (const id of enteredIds) {
    transitions.unshift({
      id: `${at}_entered_${id}`,
      at,
      memoryId: id,
      action: 'entered',
      reason: 'provider request',
    });
  }
  for (const id of exitedIds) {
    const previous = memories[id];
    if (previous) memories[id] = { ...previous, state: 'exited', exitedAt: at };
    transitions.unshift({
      id: `${at}_exited_${id}`,
      at,
      memoryId: id,
      action: 'exited',
      reason: 'left provider context',
    });
  }
  for (const [id, memory] of Object.entries(memories)) {
    if ((memory.state === 'injected' || memory.state === 'active') && !active.has(id)) {
      memories[id] = { ...memory, state: 'exited', exitedAt: at };
      if (!exitedIds.includes(id)) {
        transitions.unshift({
          id: `${at}_exited_before_provider_${id}`,
          at,
          memoryId: id,
          action: 'exited',
          reason:
            memory.state === 'injected'
              ? 'removed before provider request'
              : 'absent from provider context snapshot',
        });
      }
    }
  }
  return { ...state, memories: pruneExitedMemories(memories), transitions: transitions.slice(0, 100) };
}

function placeholder(
  id: string,
  at: string,
  state: MemoryContextDetail['state'],
): MemoryContextDetail {
  return {
    id,
    kind: 'unknown',
    text: 'Details unavailable in this TUI process.',
    score: 0,
    relationStrength: 0,
    confidence: 0,
    freshness: 0,
    importance: 0,
    persistence: 'unknown',
    anchors: [],
    tags: [],
    activationReasons: [],
    state,
    trigger: 'context snapshot',
    enteredAt: at,
    lastSeenAt: at,
    isPlaceholder: true,
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
