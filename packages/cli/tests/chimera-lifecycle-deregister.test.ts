/**
 * End-to-end lifecycle: Director retirement → mailbox deregister.
 *
 * Pins the fix for chimera subagents leaking in the mailbox registry.
 * Real components wired together:
 *
 *   Director (with real coordinator + fleet bus)
 *     ↓ idle retirement fires
 *   coordinator.remove() → fleetBus.emit('subagent.removed')
 *     ↓ host filter (mirrors packages/cli/src/fleet/host.ts:817-831)
 *   EventBus.emit('subagent.removed')
 *     ↓ broadcaster (mirrors status-broadcast.ts)
 *   mailbox.deregisterAgent(agentId)
 *
 * The broadcaster unit test already validates the last hop (EventBus →
 * deregisterAgent). This test validates the full Director → fleetBus →
 * EventBus → broadcaster chain, which is the chain that was previously
 * broken — the host's subagent.removed forwarding was never reaching the
 * broadcaster for retired chimera agents.
 */

import { Director } from '@wrongstack/core/coordination';
import { EventBus } from '@wrongstack/core/kernel';
import type { SubagentRunContext, SubagentRunOutcome, TaskSpec } from '@wrongstack/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFleetStatusBroadcaster } from '../src/fleet/status-broadcast.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

type Runner = (task: TaskSpec, ctx: SubagentRunContext) => Promise<SubagentRunOutcome>;

function makeFakeMailbox() {
  const deregistered: string[] = [];
  const heartbeats: unknown[] = [];
  return {
    mailbox: {
      send: vi.fn(async () => ({})),
      heartbeat: vi.fn(async (h: unknown) => {
        heartbeats.push(h);
      }),
      deregisterAgent: vi.fn(async (agentId: string) => {
        deregistered.push(agentId);
      }),
    },
    deregistered,
    heartbeats,
  };
}

describe('chimera subagent lifecycle → mailbox deregister', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('deregisters the agent from the mailbox the moment the Director retires it (no 60s wait)', async () => {
    // ── 1. Wire a real Director with a runner that finishes instantly ──
    // The runner returns the terminal outcome directly — no provider.response
    // event needed, which keeps the coordinator's internal timer polling away
    // from setTimeout entirely.
    const runner = vi.fn<Runner>(async (_task, _ctx) => ({
      result: 'chimera-review-done',
      iterations: 1,
      toolCalls: 1,
    }));

    const director = new Director({
      sessionId: TEST_SESSION_ID,
      config: {
        coordinatorId: 'chimera-e2e',
        doneCondition: { type: 'all_tasks_done' },
        maxConcurrent: 1,
      },
      runner,
      // retireSubagentOnTaskComplete defaults to true — retirement fires
      // on the next event-loop tick after task completion.
      subagentIdleTimeoutMs: 30_000,
    });

    // ── 2. Mirror the host's fleet-bus → EventBus forwarding ──
    // Real code: packages/cli/src/fleet/host.ts:817-831
    const events = new EventBus();
    const off = director.fleet.filter('subagent.removed', (e) => {
      const payload = e.payload as { subagentId?: string };
      events.emit('subagent.removed', {
        sessionId: 'sess-test',
        subagentId: payload.subagentId ?? e.subagentId,
        reason: 'subagent lifecycle completed',
      });
    });

    // ── 3. Wire the broadcaster against the same EventBus + fake mailbox ──
    const fake = makeFakeMailbox();
    const broadcaster = createFleetStatusBroadcaster({
      events,
      mailboxFactory: () => fake.mailbox as never,
      sessionTag: () => 'e2e1234',
      subagentName: (id) => `chimera-review-${id.slice(0, 4)}`,
    });
    broadcaster.start();

    try {
      // ── 4. Spawn a chimera-review subagent and assign one task ──
      const subagentId = await director.spawn({
        name: 'chimera-review',
        role: 'reviewer',
        maxIterations: 10,
        maxToolCalls: 50,
      });

      const taskId = 'task-chimera-1';
      await director.assign({
        id: taskId,
        description: 'Review changed files for the e2e lifecycle test',
        subagentId,
      });

      // ── 5. Await the task so the coordinator records completion ──
      const results = await director.awaitTasks([taskId]);
      expect(results[0]?.status).toBe('success');
      expect(results[0]?.result).toBe('chimera-review-done');

      // At this point: subagent is idle, idle retirement timer is
      // armed with delay=0 (via setTimeout). It fires on the next
      // timer phase, then Director.remove() → coordinator.remove() →
      // fleetBus.emit('subagent.removed'). The host filter forwards it
      // to the broadcaster, which calls deregisterAgent. awaitTasks
      // resolves before the timer fires, so we need a real tick to let
      // the setTimeout(0) run.
      await new Promise((r) => setTimeout(r, 10));

      // ── 6. Verify deregisterAgent was called BEFORE the 60s prune ──
      expect(fake.deregistered).toContain(subagentId);

      // ── 7. Verify the coordinator entry is actually gone (not just deregistered) ──
      const st = director.status();
      expect(st.subagents.find((s) => s.id === subagentId)).toBeUndefined();
    } finally {
      broadcaster.stop();
      off();
    }
  });
});
