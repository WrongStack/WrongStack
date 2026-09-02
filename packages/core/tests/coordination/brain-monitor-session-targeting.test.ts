import { describe, expect, it, vi } from 'vitest';
import { BrainMonitor, type BrainInterventionInput } from '../../src/coordination/brain-monitor.js';
import { EventBus } from '../../src/kernel/events.js';

/**
 * The Brain is project-wide; a Brain DECISION is not.
 *
 * Every engagement is about ONE session's distress, and its corrective steer
 * has to reach that session's leader. Two things used to break that once more
 * than one session ran under a single host:
 *
 *  - the evidence was pooled. Tab 1's failing tool and tab 2's failing tool
 *    advanced the same streak counter, so a threshold could be crossed by two
 *    sessions that were each doing fine.
 *  - the engagement was stamped with the HOST's current session rather than
 *    the one the evidence came from, so the steer landed on whichever tab
 *    happened to be in front.
 *
 * A host that runs exactly one session (the CLI) pins `leaderSessionId` and
 * filters everything else out; a host that serves several (the WebUI) leaves it
 * unset and gets one independent bucket per session.
 */

function makeMonitor(opts: { leaderSessionId?: string } = {}) {
  const events = new EventBus();
  // Type the intervene mock as `(input: BrainInterventionInput) => Promise<void>`
  // so it satisfies the `BrainMonitor` constructor AND `mock.calls` infers as
  // `BrainInterventionInput[][]` — no empty-tuple `noUncheckedIndexedAccess`
  // complaint on `calls[0]?.[0].sessionId`.
  const intervene = vi.fn(async (_input: BrainInterventionInput) => undefined);
  const monitor = new BrainMonitor({
    events,
    brain: {
      decide: async () => ({ type: 'answer', optionId: 'steer', text: 'steer' }),
    } as never,
    policy: 'steer',
    toolFailureStreak: 2,
    cooldownMs: 0,
    ...(opts.leaderSessionId ? { leaderSessionId: opts.leaderSessionId } : {}),
    intervene,
  });
  monitor.start();
  return { events, intervene, stop: () => monitor.stop() };
}

function failTool(events: EventBus, sessionId: string, times: number, name = 'read') {
  for (let i = 0; i < times; i++) {
    events.emit('tool.executed', {
      sessionId,
      agentId: 'leader',
      id: `${sessionId}-t${i}`,
      name,
      ok: false,
      input: {},
      output: 'boom',
    } as never);
  }
}

describe('BrainMonitor attributes distress to the session that produced it', () => {
  it('names the triggering session on the intervention', async () => {
    const { events, intervene, stop } = makeMonitor();
    failTool(events, 'tab-2', 2);
    await vi.waitFor(() => expect(intervene).toHaveBeenCalled());

    expect(intervene.mock.calls[0]?.[0] as unknown as { sessionId?: string }).toMatchObject({
      sessionId: 'tab-2',
    });
    stop();
  });

  it('does not pool two sessions failures into one streak', async () => {
    // One failure each. Pooled, that is a streak of two and both tabs get
    // steered for something neither of them did.
    const { events, intervene, stop } = makeMonitor();
    failTool(events, 'tab-1', 1);
    failTool(events, 'tab-2', 1);
    await new Promise((r) => setTimeout(r, 20));

    expect(intervene).not.toHaveBeenCalled();
    stop();
  });

  it('steers each session on its own evidence', async () => {
    const { events, intervene, stop } = makeMonitor();
    failTool(events, 'tab-1', 2);
    await vi.waitFor(() => expect(intervene).toHaveBeenCalledTimes(1));
    failTool(events, 'tab-2', 2);
    await vi.waitFor(() => expect(intervene).toHaveBeenCalledTimes(2));

    const targets = intervene.mock.calls.map(
      (call) => (call as unknown as readonly [{ sessionId?: string }])[0].sessionId,
    );
    expect(targets).toEqual(['tab-1', 'tab-2']);
    stop();
  });

  it('a single-session host still ignores everything but its leader', async () => {
    // The CLI pins `leaderSessionId`; subagent and foreign-session activity
    // must not steer the leader.
    const { events, intervene, stop } = makeMonitor({ leaderSessionId: 'the-only-one' });
    failTool(events, 'someone-else', 4);
    await new Promise((r) => setTimeout(r, 20));

    expect(intervene).not.toHaveBeenCalled();

    failTool(events, 'the-only-one', 2);
    await vi.waitFor(() => expect(intervene).toHaveBeenCalledTimes(1));
    expect(intervene.mock.calls[0]?.[0] as unknown as { sessionId?: string }).toMatchObject({
      sessionId: 'the-only-one',
    });
    stop();
  });
});
