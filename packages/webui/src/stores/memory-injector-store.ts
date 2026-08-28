import type { StateCreator } from 'zustand/vanilla';
import { createSessionScopedStore } from './session-scoped-store';

export interface MemoryInjectorTraceMemory {
  id: string;
  kind: string;
  text: string;
  score: number;
  relationStrength: number;
  anchor?: string | undefined;
  anchors: string[];
  tags: string[];
  activationReasons: string[];
  importance: number;
  confidence: number;
  freshness: number;
  persistence: string;
}

export interface MemoryInjectorTrace {
  runId: string;
  at: string;
  outcome: 'injected' | 'empty' | 'error';
  trigger: string;
  toolName: string;
  queryPreview: string;
  paths: string[];
  taskSignals: string[];
  contextPressure: number;
  budget: { maxHints: number; maxChars: number };
  candidates: number;
  eligible: number;
  rejected: {
    duplicate: number;
    belowScore: number;
    alreadyVisible: number;
    cooldown: number;
    budget: number;
  };
  activated: MemoryInjectorTraceMemory[];
  injected: MemoryInjectorTraceMemory[];
  injectedChars: number;
  error?: string | undefined;
  sessionId?: string | undefined;
}

export interface MemoryContextSnapshot {
  at: string;
  activeMemoryIds: string[];
  enteredMemoryIds: string[];
  exitedMemoryIds: string[];
  sessionId?: string | undefined;
}

interface ContextMemoryRecord extends MemoryInjectorTraceMemory {
  state: 'injected' | 'active' | 'exited';
  trigger: string;
  enteredAt: string;
  lastSeenAt: string;
  exitedAt?: string | undefined;
  /** True when created by placeholderContextMemory() — the detail fields are zero-value defaults. */
  isPlaceholder?: boolean | undefined;
}

export interface MemoryContextTransition {
  id: string;
  at: string;
  memoryId: string;
  action: 'injected' | 'entered' | 'exited';
  reason: string;
}

interface MemoryInjectorTraceState {
  traces: MemoryInjectorTrace[];
  contextMemories: Record<string, ContextMemoryRecord>;
  transitions: MemoryContextTransition[];
  pushTrace: (trace: MemoryInjectorTrace) => void;
  applyContextSnapshot: (snapshot: MemoryContextSnapshot) => void;
  resetContext: () => void;
  clear: () => void;
}

const MAX_TRACES = 50;

/**
 * Cap on retained `exited` memories. Active/injected entries stay (live
 * provider context); exited ones are historical and prune oldest-first.
 * Without this, every distinct memory id ever injected accumulates forever
 * in long WebUI sessions — the same leak TUI fixed with MAX_EXITED_MEMORIES.
 */
const MAX_EXITED_MEMORIES = 200;

/** UI preview budget; full text lives in SAGE SQLite, not the browser store. */
export const MAX_MEMORY_DETAIL_TEXT_CHARS = 300;

function capMemoryDetailText(text: string): string {
  if (text.length <= MAX_MEMORY_DETAIL_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_MEMORY_DETAIL_TEXT_CHARS - 1)}…`;
}

function capTraceMemory(memory: MemoryInjectorTraceMemory): MemoryInjectorTraceMemory {
  return { ...memory, text: capMemoryDetailText(memory.text) };
}

/**
 * Evict the oldest exited memories once past the cap. Returns the same
 * record when nothing needs pruning (no allocation on the hot path).
 */
function pruneExitedMemories(
  memories: Record<string, ContextMemoryRecord>,
): Record<string, ContextMemoryRecord> {
  const exited: ContextMemoryRecord[] = [];
  for (const memory of Object.values(memories)) {
    if (memory.state === 'exited') exited.push(memory);
  }
  if (exited.length <= MAX_EXITED_MEMORIES) return memories;
  exited.sort((a, b) => (b.exitedAt ?? b.lastSeenAt).localeCompare(a.exitedAt ?? a.lastSeenAt));
  const pruned = { ...memories };
  for (const memory of exited.slice(MAX_EXITED_MEMORIES)) {
    delete pruned[memory.id];
  }
  return pruned;
}

/**
 * Injector traces and the live context set — both describe ONE conversation's
 * prompt, so each tab keeps its own. The `sessionId` on the payloads was
 * already there; nothing used it, and the handler dropped every background
 * tab's trace instead.
 */
const injectorTraceState: StateCreator<MemoryInjectorTraceState> = (set) => ({
  traces: [],
  contextMemories: {},
  transitions: [],
  pushTrace: (trace) =>
    set((state) => {
      const contextMemories = { ...state.contextMemories };
      const transitions = [...state.transitions];
      const cappedInjected = trace.injected.map(capTraceMemory);
      const cappedActivated = trace.activated.map(capTraceMemory);
      for (const memory of cappedInjected) {
        const previous = contextMemories[memory.id];
        contextMemories[memory.id] = {
          ...memory,
          state: previous?.state === 'active' ? 'active' : 'injected',
          trigger: trace.trigger,
          enteredAt: previous?.enteredAt ?? trace.at,
          lastSeenAt: trace.at,
        };
        const injectedId = `${trace.at}_injected_${memory.id}`;
        if (!transitions.some((t) => t.id === injectedId)) {
          transitions.unshift({
            id: injectedId,
            at: trace.at,
            memoryId: memory.id,
            action: 'injected',
            reason: `${trace.trigger} · score ${memory.score.toFixed(2)}`,
          });
        }
      }
      const cappedTrace: MemoryInjectorTrace = {
        ...trace,
        activated: cappedActivated,
        injected: cappedInjected,
      };
      return {
        traces: [cappedTrace, ...state.traces.filter((item) => item.runId !== trace.runId)].slice(
          0,
          MAX_TRACES,
        ),
        contextMemories: pruneExitedMemories(contextMemories),
        transitions: transitions.slice(0, 100),
      };
    }),
  applyContextSnapshot: (snapshot) =>
    set((state) => {
      const contextMemories = { ...state.contextMemories };
      const transitions = [...state.transitions];
      const active = new Set(snapshot.activeMemoryIds);
      for (const memoryId of snapshot.activeMemoryIds) {
        const previous = contextMemories[memoryId];
        contextMemories[memoryId] = previous
          ? { ...previous, state: 'active', lastSeenAt: snapshot.at, exitedAt: undefined }
          : placeholderContextMemory(memoryId, snapshot.at, 'active');
      }
      for (const memoryId of snapshot.enteredMemoryIds) {
        const enteredId = `${snapshot.at}_entered_${memoryId}`;
        if (!transitions.some((t) => t.id === enteredId)) {
          transitions.unshift({
            id: enteredId,
            at: snapshot.at,
            memoryId,
            action: 'entered',
            reason: 'present in provider request',
          });
        }
      }
      for (const memoryId of snapshot.exitedMemoryIds) {
        const previous = contextMemories[memoryId];
        if (previous)
          contextMemories[memoryId] = { ...previous, state: 'exited', exitedAt: snapshot.at };
        const exitedId = `${snapshot.at}_exited_${memoryId}`;
        if (!transitions.some((t) => t.id === exitedId)) {
          transitions.unshift({
            id: exitedId,
            at: snapshot.at,
            memoryId,
            action: 'exited',
            reason: 'absent from provider request',
          });
        }
      }
      // The activeMemoryIds list is authoritative. Anything pending or active
      // that is absent from it has left (or never reached) provider context.
      for (const [memoryId, memory] of Object.entries(contextMemories)) {
        if ((memory.state === 'injected' || memory.state === 'active') && !active.has(memoryId)) {
          contextMemories[memoryId] = { ...memory, state: 'exited', exitedAt: snapshot.at };
          if (!snapshot.exitedMemoryIds.includes(memoryId)) {
            const sweepId = `${snapshot.at}_exited_before_provider_${memoryId}`;
            if (!transitions.some((t) => t.id === sweepId)) {
              transitions.unshift({
                id: sweepId,
                at: snapshot.at,
                memoryId,
                action: 'exited',
                reason:
                  memory.state === 'injected'
                    ? 'removed before provider request'
                    : 'absent from provider context snapshot',
              });
            }
          }
        }
      }
      return {
        contextMemories: pruneExitedMemories(contextMemories),
        transitions: transitions.slice(0, 100),
      };
    }),
  resetContext: () => set({ contextMemories: {}, transitions: [] }),
  clear: () => set({ traces: [], contextMemories: {}, transitions: [] }),
});

export const useMemoryInjectorTraceStore = createSessionScopedStore(injectorTraceState);

function placeholderContextMemory(
  id: string,
  at: string,
  state: ContextMemoryRecord['state'],
): ContextMemoryRecord {
  return {
    id,
    kind: 'unknown',
    text: 'Memory details were not present in this UI process.',
    score: 0,
    relationStrength: 0,
    anchors: [],
    tags: [],
    activationReasons: [],
    importance: 0,
    confidence: 0,
    freshness: 0,
    persistence: 'unknown',
    state,
    trigger: 'context snapshot',
    enteredAt: at,
    lastSeenAt: at,
    isPlaceholder: true,
  };
}
