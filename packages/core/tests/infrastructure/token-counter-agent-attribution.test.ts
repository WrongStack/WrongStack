import { describe, expect, it } from 'vitest';
import { DefaultTokenCounter } from '../../src/infrastructure/token-counter.js';
import { EventBus } from '../../src/kernel/events.js';

/**
 * `token.accounted` must be able to name the agent that spent the tokens.
 *
 * Every subagent runs its own `DefaultTokenCounter`, but constructs it with the
 * LEADER's session id so live cost UIs stay on a single row. That left nothing
 * separating a subagent's spend from the leader's: a measured Chronicle journal
 * held 2,402 `token.accounted` rows with a null `agent_id` — all of them —
 * alongside 419 distinct subagents visible in the `subagent.*` family. The
 * domain adapter keys `scope.agentId` off this field, so it is the whole chain.
 */
describe('token.accounted agent attribution', () => {
  const capture = (
    counter: DefaultTokenCounter,
    events: EventBus,
  ): Array<Record<string, unknown>> => {
    const seen: Array<Record<string, unknown>> = [];
    events.on('token.accounted', (e) => seen.push(e as unknown as Record<string, unknown>));
    counter.account({ input: 10, output: 5 }, 'some-model', 'some-provider');
    return seen;
  };

  it('stamps a static agentId onto every emission', () => {
    const events = new EventBus();
    const counter = new DefaultTokenCounter({
      events,
      sessionId: 'leader-session',
      agentId: 'explore-companion-abc123',
    });

    const seen = capture(counter, events);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      // The subagent's spend still rolls up to the leader's session…
      sessionId: 'leader-session',
      // …but is now attributable to the worker that incurred it.
      agentId: 'explore-companion-abc123',
      model: 'some-model',
      provider: 'some-provider',
    });
  });

  it('resolves a lazy agentId at emit time', () => {
    const events = new EventBus();
    let current = 'worker-1';
    const counter = new DefaultTokenCounter({
      events,
      sessionId: 'leader-session',
      agentId: () => current,
    });

    const first = capture(counter, events);
    expect(first[0]).toMatchObject({ agentId: 'worker-1' });

    current = 'worker-2';
    const second = capture(counter, events);
    expect(second[second.length - 1]).toMatchObject({ agentId: 'worker-2' });
  });

  it('omits agentId entirely for the leader', () => {
    const events = new EventBus();
    const counter = new DefaultTokenCounter({ events, sessionId: 'leader-session' });

    const seen = capture(counter, events);
    // Absent, not empty-string: consumers branch on presence, and Chronicle's
    // scope spread drops the key rather than writing a blank agent.
    expect(seen[0]).not.toHaveProperty('agentId');
    expect(seen[0]).toMatchObject({ sessionId: 'leader-session' });
  });
});
