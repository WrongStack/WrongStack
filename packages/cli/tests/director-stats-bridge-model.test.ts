/**
 * The fleet-stats bridge is how HQ and the WebUI learn what each worker runs
 * on. Per-session model lanes make that answer load-bearing: two workers can
 * carry the same-looking model id served by different providers, and "did my
 * routing take effect" is unanswerable from a bare model name.
 *
 * Usage tracking only knows the model id, so the bridge prefers the RESOLVED
 * pair from the Director and falls back to usage when the Director has no
 * answer (a worker that never reached the spawn bookkeeping).
 */
import { FleetBus } from '@wrongstack/core/coordination';
import { EventBus } from '@wrongstack/core/kernel';
import { describe, expect, it } from 'vitest';
import { registerDirectorStatsBridge } from '../src/fleet/host-director-event-bridges.js';

interface StatsFrame {
  subagentStatuses: Array<{ subagentId: string; model?: string }>;
}

function emitStats(opts: {
  resolved?: Record<string, { provider?: string; model?: string }>;
  perSubagent?: Record<string, { model?: string }>;
}): StatsFrame {
  const fleet = new FleetBus();
  const events = new EventBus();
  const director = {
    fleet,
    maxSpawns: 10,
    spawnCount: 0,
    fleetManager: undefined,
    snapshot: () => ({ total: { cost: 0 }, perSubagent: opts.perSubagent ?? {} }),
    ...(opts.resolved ? { resolvedModelFor: (id: string) => opts.resolved?.[id] } : {}),
  } as never;

  const frames: StatsFrame[] = [];
  events.on('coordinator.stats', (payload: unknown) => {
    frames.push(payload as StatsFrame);
  });
  const off = registerDirectorStatsBridge({ director, events, sessionId: 'sess-1' });

  fleet.emit({
    type: 'coordinator.stats',
    payload: {
      total: 1,
      running: 1,
      idle: 0,
      stopped: 0,
      inFlight: 1,
      pending: 0,
      completed: 0,
      subagentStatuses: [{ subagentId: 's1', taskId: 't1', status: 'running', assigned: true }],
    },
  } as never);
  off();
  return frames[0] as StatsFrame;
}

describe('director stats bridge — reported model', () => {
  it('reports the resolved provider/model', () => {
    const frame = emitStats({ resolved: { s1: { provider: 'openai', model: 'gpt-5' } } });
    expect(frame.subagentStatuses[0]?.model).toBe('openai/gpt-5');
  });

  it('prefers the resolved pair over the model usage recorded', () => {
    const frame = emitStats({
      resolved: { s1: { provider: 'openai', model: 'gpt-5' } },
      perSubagent: { s1: { model: 'gpt-5' } },
    });
    // Same id, but only the bridge's answer says which provider served it.
    expect(frame.subagentStatuses[0]?.model).toBe('openai/gpt-5');
  });

  it('falls back to the usage model when the Director has no answer', () => {
    const frame = emitStats({ perSubagent: { s1: { model: 'claude-opus-5' } } });
    expect(frame.subagentStatuses[0]?.model).toBe('claude-opus-5');
  });

  it('omits the model when neither source knows one', () => {
    const frame = emitStats({});
    expect(frame.subagentStatuses[0]?.model).toBeUndefined();
  });
});
