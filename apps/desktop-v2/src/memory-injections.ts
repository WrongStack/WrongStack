import { entries, record } from './engine-values';

/** One SAGE memory as an injector run reported it. */
export interface InjectedMemory {
  id: string;
  kind: string;
  text: string;
  score: number | null;
}
/** One on-demand Memory Injector decision, including runs that injected nothing. */
export interface MemoryInjectorRun {
  runId: string;
  at: string;
  outcome: 'injected' | 'empty' | 'error';
  trigger: string;
  toolName: string;
  queryPreview: string;
  candidates: number;
  eligible: number;
  injected: InjectedMemory[];
  injectedChars: number;
  rejected: { gate: string; count: number }[];
  minScore: number | null;
  error: string;
}
/** Which SAGE memories the latest provider request carried. */
export interface MemoryContext {
  at: string;
  active: string[];
  entered: string[];
  exited: string[];
}

/** Injector runs kept per conversation, newest last. */
export const MEMORY_RUN_LIMIT = 30;
const TEXT_LIMIT = 600;

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const ids = (value: unknown) =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
const GATES: Record<string, string> = {
  duplicate: 'Duplicate',
  belowScore: 'Below score',
  alreadyVisible: 'Already in context',
  cooldown: 'Cooling down',
  budget: 'Over budget',
};

/** A `memory.event` payload for `memory.injector_run`; null for anything else. */
export function memoryInjectorRun(payload: Record<string, unknown>): MemoryInjectorRun | null {
  if (payload['event'] !== 'memory.injector_run' || typeof payload['runId'] !== 'string')
    return null;
  const outcome = payload['outcome'];
  if (outcome !== 'injected' && outcome !== 'empty' && outcome !== 'error') return null;
  const rejected = record(payload['rejected']);
  const thresholds = record(payload['thresholds']);
  return {
    runId: payload['runId'],
    at: typeof payload['at'] === 'string' ? payload['at'] : '',
    outcome,
    trigger: String(payload['trigger'] ?? ''),
    toolName: String(payload['toolName'] ?? ''),
    queryPreview: String(payload['queryPreview'] ?? '').slice(0, TEXT_LIMIT),
    candidates: num(payload['candidates']),
    eligible: num(payload['eligible']),
    injected: entries(payload['injected']).flatMap((item) =>
      typeof item['id'] === 'string'
        ? [
            {
              id: item['id'],
              kind: String(item['kind'] ?? ''),
              text: String(item['text'] ?? '').slice(0, TEXT_LIMIT),
              score: typeof item['score'] === 'number' ? item['score'] : null,
            },
          ]
        : [],
    ),
    injectedChars: num(payload['injectedChars']),
    rejected: Object.entries(GATES).flatMap(([key, gate]) =>
      num(rejected[key]) > 0 ? [{ gate, count: num(rejected[key]) }] : [],
    ),
    minScore: typeof thresholds['minScore'] === 'number' ? thresholds['minScore'] : null,
    error: typeof payload['error'] === 'string' ? payload['error'] : '',
  };
}

/** A `memory.event` payload for `memory.context_snapshot`; null for anything else. */
export function memoryContextSnapshot(payload: Record<string, unknown>): MemoryContext | null {
  if (payload['event'] !== 'memory.context_snapshot') return null;
  return {
    at: typeof payload['at'] === 'string' ? payload['at'] : '',
    active: ids(payload['activeMemoryIds']),
    entered: ids(payload['enteredMemoryIds']),
    exited: ids(payload['exitedMemoryIds']),
  };
}

/** Appends a run once (by run id), keeping the newest `MEMORY_RUN_LIMIT`. */
export function appendMemoryRun(runs: MemoryInjectorRun[], run: MemoryInjectorRun) {
  if (runs.some((item) => item.runId === run.runId)) return runs;
  return [...runs, run].slice(-MEMORY_RUN_LIMIT);
}
