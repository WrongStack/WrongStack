/**
 * F1211: `fleet.skillCompanion.probeTimeoutMs` documents "larger values are
 * honored", but the host deadline went to `setTimeout` unclamped. Node and Bun
 * fire any delay above 2^31-1 ms after ~1 ms, so a deadline past ~24.8 days
 * retired the judge as soon as it was assigned. Fake timers model the same
 * overflow (a delay above the maximum becomes 1 ms).
 */
import { EventBus } from '@wrongstack/contracts/kernel';
import type { SkillManifest, SubagentConfig } from '@wrongstack/contracts/types';
import type { Director } from '@wrongstack/coordination';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostSkillCompanion } from '../src/host-skill-companion.js';

const CATALOG: SkillManifest[] = [
  {
    name: 'frontend-design',
    description: 'Distinctive UI design.',
    path: '/s/a/SKILL.md',
    source: 'project',
  },
  {
    name: 'testing',
    description: 'Write and fix tests.',
    path: '/s/b/SKILL.md',
    source: 'project',
  },
];

const instances: HostSkillCompanion[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.stop();
  vi.useRealTimers();
});

function harness(probeTimeoutMs: number) {
  const events = new EventBus();
  const assignInternal = vi.fn(async (_task: { id: string; timeoutMs?: number }) => {});
  const terminate = vi.fn(async (_id: string) => {});
  const director = {
    spawnCompanion: vi.fn(async (_config: SubagentConfig) => 'worker'),
    assignInternal,
    terminate,
    status: () => ({ subagents: [{ id: 'worker' }] }),
    on: () => () => {},
  } as unknown as Director;
  const companion = new HostSkillCompanion({
    director,
    events,
    skillLoader: () => ({ list: async () => CATALOG }) as never,
    enabled: () => true,
    config: { probeTimeoutMs },
    scrub: (text) => text,
    note: vi.fn(),
  });
  instances.push(companion);
  events.emit('agent.run.started', {
    sessionId: 'S1',
    ctx: {
      meta: {},
      messages: [],
      session: { id: 'S1' },
      tools: [{ name: 'skill' }, { name: 'edit' }, { name: 'read' }],
    } as never,
    model: 'm',
    at: new Date().toISOString(),
    inputText: 'Redesign the settings page please',
  });
  return { assignInternal, terminate };
}

describe('Skill Companion host deadline above the timer maximum', () => {
  it('does not retire the judge at once when the deadline exceeds 2^31-1 ms', async () => {
    vi.useFakeTimers();
    const h = harness(3_000_000_000);
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.terminate).not.toHaveBeenCalled();
    // Host and worker share the deadline, capped at the longest a timer can wait.
    expect(h.assignInternal.mock.calls[0]![0]).toMatchObject({ timeoutMs: 2_147_483_647 });
  });

  it('still retires a judge that misses an ordinary deadline', async () => {
    vi.useFakeTimers();
    const h = harness(900_000);
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(899_000);
    expect(h.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.terminate).toHaveBeenCalledWith('worker');
  });
});
