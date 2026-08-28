import { EventBus } from '@wrongstack/core/kernel';
import { describe, expect, it, vi } from 'vitest';
import {
  registerCoordinatorLifecycleHandlers,
  registerDirectorBudgetAndContextBridges,
  registerDirectorSubagentLifecycleBridges,
} from '../../src/fleet/host-director-event-bridges.js';

/**
 * A subagent's events belong to the tab that spawned it.
 *
 * `MultiAgentHost` is built once, for the session the process booted with, and
 * these bridges used to stamp every per-subagent emission with that one id.
 * A single CLI session never noticed. Four WebUI tabs share the host: a worker
 * delegated from tab 3 announced its spawn, task start, budget pressure,
 * context load and removal into TAB 1 — which showed a roster row for work it
 * never asked for, while tab 3 showed none and had nothing to stop.
 *
 * The owning session comes from the coordinator's spawn-time stamp
 * (`SubagentConfig.originSessionId`, resolved by `MultiAgentHost.sessionForSubagent`).
 * These tests pin that the bridges ASK, rather than assuming the host's own.
 */

/** Minimal director stand-in: a fleet bus whose `filter` we can fire by hand. */
function fakeDirector() {
  const listeners = new Map<string, (e: Record<string, unknown>) => void>();
  return {
    director: {
      fleet: {
        filter: (type: string, fn: (e: Record<string, unknown>) => void) => {
          listeners.set(type, fn);
          return () => listeners.delete(type);
        },
      },
    } as never,
    fire: (type: string, event: Record<string, unknown>) => {
      const fn = listeners.get(type);
      if (!fn) throw new Error(`nothing subscribed to ${type}`);
      fn(event);
    },
  };
}

/** Two workers, two tabs — neither of them the host's own session. */
const OWNER_OF: Record<string, string> = { w_tab2: 'sess_tab2', w_tab3: 'sess_tab3' };
const sessionFor = (subagentId: string): string => OWNER_OF[subagentId] ?? 'sess_boot';

describe('subagent lifecycle bridges address the owning tab', () => {
  it('announces a spawn to the session that asked for the worker', () => {
    const { director, fire } = fakeDirector();
    const events = new EventBus();
    const seen: Array<Record<string, unknown>> = [];
    events.on('subagent.spawned', (e) => seen.push(e as never));

    registerDirectorSubagentLifecycleBridges({
      director,
      events,
      sessionFor,
      onSubagentRemoved: () => {},
    });
    fire('subagent.spawned', {
      subagentId: 'w_tab3',
      payload: { subagentId: 'w_tab3', taskId: 't1', name: 'Reviewer' },
    });

    expect(seen[0]?.['sessionId']).toBe('sess_tab3');
  });

  it('files a removal under the owner, resolved before the host forgets it', () => {
    const { director, fire } = fakeDirector();
    const events = new EventBus();
    const seen: Array<Record<string, unknown>> = [];
    events.on('subagent.removed', (e) => seen.push(e as never));
    // The host's own bookkeeping runs first; the lookup must not depend on
    // anything it clears.
    const onSubagentRemoved = vi.fn();

    registerDirectorSubagentLifecycleBridges({ director, events, sessionFor, onSubagentRemoved });
    fire('subagent.removed', {
      subagentId: 'w_tab2',
      payload: { subagentId: 'w_tab2', reason: 'done' },
    });

    expect(onSubagentRemoved).toHaveBeenCalledWith('w_tab2');
    expect(seen[0]?.['sessionId']).toBe('sess_tab2');
  });

  it('routes budget and context pressure to the owner, not the boot tab', () => {
    const { director, fire } = fakeDirector();
    const events = new EventBus();
    const seen: Array<[string, unknown]> = [];
    events.on('subagent.budget_warning', (e) => seen.push(['budget_warning', e.sessionId]));
    events.on('subagent.budget_extended', (e) => seen.push(['budget_extended', e.sessionId]));
    events.on('subagent.ctx_pct', (e) => seen.push(['ctx_pct', e.sessionId]));

    registerDirectorBudgetAndContextBridges({ director, events, sessionFor });
    fire('budget.threshold_reached', {
      subagentId: 'w_tab3',
      payload: { kind: 'tokens', used: 9, limit: 10 },
    });
    fire('budget.extended', {
      subagentId: 'w_tab3',
      payload: { kind: 'tokens', newLimit: 20, totalExtensions: 1 },
    });
    fire('ctx.pct', {
      subagentId: 'w_tab2',
      payload: { load: 0.8, tokens: 80, maxContext: 100 },
    });

    expect(seen).toEqual([
      ['budget_warning', 'sess_tab3'],
      ['budget_extended', 'sess_tab3'],
      ['ctx_pct', 'sess_tab2'],
    ]);
  });

  it('starts a task in the owning tab', () => {
    const events = new EventBus();
    const handlers = new Map<string, (payload: never) => void>();
    const coordinator = {
      on: (type: string, fn: (payload: never) => void) => handlers.set(type, fn),
      off: () => {},
    } as never;
    const seen: Array<Record<string, unknown>> = [];
    events.on('subagent.task_started', (e) => seen.push(e as never));

    registerCoordinatorLifecycleHandlers({
      coordinator,
      events,
      sessionFor,
      isShadowTask: () => false,
      onSubagentStopped: () => {},
    });
    handlers.get('task.assigned')?.({
      task: { id: 't1', description: 'review' },
      subagentId: 'w_tab2',
    } as never);

    expect(seen[0]?.['sessionId']).toBe('sess_tab2');
  });

  it('falls back to the host session for a worker nobody claims', () => {
    const { director, fire } = fakeDirector();
    const events = new EventBus();
    const seen: Array<Record<string, unknown>> = [];
    events.on('subagent.spawned', (e) => seen.push(e as never));

    registerDirectorSubagentLifecycleBridges({
      director,
      events,
      sessionFor,
      onSubagentRemoved: () => {},
    });
    fire('subagent.spawned', {
      subagentId: 'w_unknown',
      payload: { subagentId: 'w_unknown', taskId: 't1' },
    });

    // Single-session hosts spawn without an origin and must keep behaving
    // exactly as before.
    expect(seen[0]?.['sessionId']).toBe('sess_boot');
  });
});
