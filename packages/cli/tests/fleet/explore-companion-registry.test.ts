import type { ExploreCompanion } from '@wrongstack/core/coordination';
import { describe, expect, it } from 'vitest';
import { createExploreCompanionRegistry } from '../../src/fleet/host-explore-companion-registry.js';

/**
 * One explore companion per live conversation.
 *
 * The host builds once, for the session the process booted with, so a single
 * companion pinned to that session filtered out every signal from the WebUI's
 * other three tabs (fail-closed — nothing ever leaked, it simply explored for
 * nobody). The registry opens one per session and bounds the set the way the
 * rest of the per-session state in this codebase is bounded: four slots,
 * least-recently-active evicted, idle entries swept.
 */

function fakeCompanion(): ExploreCompanion & { stopped: number } {
  const c = {
    stopped: 0,
    stop() {
      c.stopped += 1;
    },
  };
  return c as unknown as ExploreCompanion & { stopped: number };
}

function registryWithClock(max = 4, idleMs = 15 * 60_000) {
  let clock = 1_000;
  const built: Array<{ sessionId: string; companion: ExploreCompanion & { stopped: number } }> = [];
  const registry = createExploreCompanionRegistry({
    max,
    idleMs,
    now: () => clock,
    create: (sessionId) => {
      const companion = fakeCompanion();
      built.push({ sessionId, companion });
      return companion;
    },
  });
  return {
    registry,
    built,
    advance: (ms: number) => {
      clock += ms;
    },
    companionFor: (sessionId: string) =>
      built.find((entry) => entry.sessionId === sessionId)?.companion,
  };
}

describe('explore companion registry', () => {
  it('opens one companion per session and reuses it', () => {
    const { registry, built } = registryWithClock();

    registry.ensure('tab-1');
    registry.ensure('tab-2');
    registry.ensure('tab-1');

    expect(built.map((b) => b.sessionId)).toEqual(['tab-1', 'tab-2']);
    expect(registry.ids()).toEqual(['tab-2', 'tab-1']); // most recent last
  });

  it('ignores an unstamped session rather than opening a nameless companion', () => {
    const { registry, built } = registryWithClock();

    registry.ensure('');

    expect(built).toEqual([]);
  });

  it('evicts the least recently active when a fifth tab runs', () => {
    const { registry, companionFor } = registryWithClock();

    for (const id of ['t1', 't2', 't3', 't4']) registry.ensure(id);
    registry.ensure('t1'); // t2 is now the oldest
    registry.ensure('t5');

    expect(registry.ids()).toEqual(['t3', 't4', 't1', 't5']);
    expect(companionFor('t2')?.stopped).toBe(1);
  });

  it('sweeps a conversation that has not run for a long time', () => {
    const { registry, advance, companionFor } = registryWithClock();

    registry.ensure('stale');
    advance(16 * 60_000);
    registry.ensure('fresh');

    expect(registry.ids()).toEqual(['fresh']);
    expect(companionFor('stale')?.stopped).toBe(1);
  });

  it('keeps a session alive as long as it keeps running', () => {
    const { registry, advance, companionFor } = registryWithClock();

    registry.ensure('busy');
    advance(10 * 60_000);
    registry.ensure('busy');
    advance(10 * 60_000);
    registry.ensure('other');

    expect(registry.ids()).toEqual(['busy', 'other']);
    expect(companionFor('busy')?.stopped).toBe(0);
  });

  it('stops everything on host teardown, once each', () => {
    const { registry, companionFor } = registryWithClock();
    registry.ensure('a');
    registry.ensure('b');

    registry.disposeAll();
    registry.disposeAll();

    expect(registry.ids()).toEqual([]);
    expect(companionFor('a')?.stopped).toBe(1);
    expect(companionFor('b')?.stopped).toBe(1);
  });

  it('stays empty when the feature is off, without caching the refusal', () => {
    let asked = 0;
    const registry = createExploreCompanionRegistry({
      create: () => {
        asked += 1;
        return null;
      },
    });

    registry.ensure('t1');
    registry.ensure('t1');

    expect(registry.ids()).toEqual([]);
    expect(asked).toBe(2);
  });

  it('survives a companion whose stop() throws', () => {
    const registry = createExploreCompanionRegistry({
      max: 1,
      create: () =>
        ({
          stop() {
            throw new Error('boom');
          },
        }) as unknown as ExploreCompanion,
    });
    registry.ensure('t1');

    expect(() => registry.ensure('t2')).not.toThrow();
    expect(registry.ids()).toEqual(['t2']);
  });
});
