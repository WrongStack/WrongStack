import type { EngineEvent, SessionToolCalls } from './engine-state-types';

export type { SessionToolCalls } from './engine-state-types';

export const emptySessionToolCalls: SessionToolCalls = {
  counts: new Map(),
  active: new Map(),
  anonymous: new Map(),
};

/** Session totals survive bounded transcript windows, including runs with no final answer. */
export function reduceSessionToolCalls(
  state: SessionToolCalls,
  event: EngineEvent,
): SessionToolCalls {
  if (event.type === 'run.result' || event.type === 'desktop.engine_boundary')
    return { ...state, active: new Map(), anonymous: new Map() };
  if (event.type !== 'tool.started' && event.type !== 'tool.executed') return state;
  const payload = event.payload;
  const rawName = typeof payload['name'] === 'string' ? payload['name'].trim() : '';
  const agent = typeof payload['agentId'] === 'string' ? payload['agentId'] : '';
  const id = typeof payload['id'] === 'string' ? payload['id'] : '';
  const counts = new Map(state.counts);
  if (!id) {
    // Legacy frames have no call ID: pair their aggregate start/outcome counts per tool/agent.
    const name = rawName || 'Tool';
    const key = JSON.stringify([agent, name]);
    const previous = state.anonymous.get(key) ?? { started: 0, executed: 0 };
    const next = { ...previous };
    if (event.type === 'tool.started') next.started++;
    else next.executed++;
    const added =
      Math.max(next.started, next.executed) - Math.max(previous.started, previous.executed);
    counts.set(name, (counts.get(name) ?? 0) + added);
    return { ...state, counts, anonymous: new Map(state.anonymous).set(key, next) };
  }
  const key = JSON.stringify([agent, id]);
  const previous = state.active.get(key);
  const name = rawName || previous || 'Tool';
  if (previous === name) return state;
  if (previous) {
    const remaining = (counts.get(previous) ?? 0) - 1;
    if (remaining > 0) counts.set(previous, remaining);
    else counts.delete(previous);
  }
  counts.set(name, (counts.get(name) ?? 0) + 1);
  return { ...state, counts, active: new Map(state.active).set(key, name) };
}
