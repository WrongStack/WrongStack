/**
 * `delegate` on a host with nowhere to deliver a background result.
 *
 * A background result is routed to its owning session's leader. When the
 * call has no owning session (no `ctx.session.id`, no pinned run id, no
 * `directorRunId`) the tool must not return a `status:'running'` launch whose
 * result could never arrive — it falls back to the blocking wait mode and
 * returns the settled result inline. The same holds when the host wired no
 * `DelegationTracker`.
 */

import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import type {
  SubagentRunContext,
  SubagentRunOutcome,
  TaskSpec,
} from '@wrongstack/contracts/types/multi-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDelegateTool, type DelegateHost } from '../../src/coordination/delegate-tool.js';
import { leaderDeliveryHub } from '../../src/coordination/delegation/leader-delivery-hub.js';
import { Director } from '../../src/coordination/director.js';
import { FLEET_ROSTER } from '../../src/coordination/fleet.js';

const BOUNDARY = {
  scope: 'The named target only — read, verify, report.',
  outOfScope: ['Do not modify any files'],
} as const;

function hostFor(director: Director): DelegateHost {
  return {
    isDirectorMode: () => true,
    ensureDirector: async () => director,
    promoteToDirector: async () => director,
  };
}

function gatedDirector() {
  const releases: Array<() => void> = [];
  const runner = vi.fn(
    (task: TaskSpec, ctx: SubagentRunContext) =>
      new Promise<SubagentRunOutcome>((resolve, reject) => {
        ctx.signal.addEventListener(
          'abort',
          () => reject(new DOMException('subagent aborted', 'AbortError')),
          { once: true },
        );
        releases.push(() => resolve({ result: `done:${task.id}`, iterations: 1, toolCalls: 1 }));
      }),
  );
  const director = new Director({
    sessionId: 'director-own-session',
    config: {
      coordinatorId: 'fallback-director',
      doneCondition: { type: 'all_tasks_done' },
      maxConcurrent: 2,
    },
    runner,
  });
  return { director, releases };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

describe('delegate — no owning session and no tracker', () => {
  it('falls back to wait mode instead of launching an undeliverable background run', async () => {
    const { director, releases } = gatedDirector();
    cleanups.push(() => director.shutdown());
    const startedModes: unknown[] = [];
    const events = new EventBus();
    events.on('delegate.started', (e) => {
      startedModes.push((e as { mode?: unknown }).mode);
    });
    // No `tracker`, no `directorRunId`, and a ctx without a session id.
    const tool = createDelegateTool({ host: hostFor(director), roster: FLEET_ROSTER, events });
    const pendingBefore = leaderDeliveryHub.pending('undefined');

    let settled = false;
    const call = Promise.resolve(
      tool.execute(
        { role: 'bug-hunter', task: 'audit', ...BOUNDARY },
        // Deliberately session-less: no `ctx.session.id` to route a background result to.
        {} as unknown as AgentContext,
        {
          signal: new AbortController().signal,
        },
      ),
    ).then((result) => {
      settled = true;
      return result as { ok?: boolean; status?: string; delegationId?: string };
    });

    // Blocking: the call does not return while the worker is still running.
    await expect.poll(() => releases.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);

    releases[0]!();
    const result = await call;
    expect(result.status).not.toBe('running');
    expect(result.delegationId).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(startedModes.every((mode) => mode === undefined || mode === 'wait')).toBe(true);
    // Nothing was queued for a leader.
    expect(leaderDeliveryHub.pending('undefined')).toBe(pendingBefore);
  });
});
