/**
 * F1213: `fleet.exploreCompanion.probeTimeoutMs` is the hard host deadline per
 * probe and has no upper bound, but it went to `setTimeout` unclamped. Node and
 * Bun fire a delay above 2^31-1 ms after ~1 ms, so every probe was cancelled
 * and its resident retired as soon as it started. Fake timers model the same
 * overflow (a delay above the maximum becomes 1 ms).
 */
import { EventBus } from '@wrongstack/contracts/kernel';
import type { SubagentConfig, TaskSpec } from '@wrongstack/contracts/types';
import { type Director, type ExploreCompanion, FLEET_ROSTER } from '@wrongstack/coordination';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostExploreCompanion } from '../src/host-explore-companion.js';

vi.mock('@wrongstack/coordination', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/coordination')>()),
  // A test must not reach the project mailbox daemon.
  getSharedProjectMailbox: vi.fn(() => ({ query: vi.fn(async () => []), ack: vi.fn() })),
  postSessionNote: vi.fn(),
}));

const instances: ExploreCompanion[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.stop();
  vi.useRealTimers();
});

function harness(probeTimeoutMs: number) {
  const events = new EventBus();
  const workers: Array<{ id: string; status: 'idle' }> = [];
  const spawn = vi.fn(async (cfg: SubagentConfig) => {
    workers.push({ id: cfg.id!, status: 'idle' });
    return cfg.id!;
  });
  const assign = vi.fn(async (task: TaskSpec) => task.id);
  const terminate = vi.fn(async (_id: string) => {});
  const companion = createHostExploreCompanion({
    events,
    sessionId: 'leader-session',
    mailboxProjectDir: '/mailbox',
    projectRoot: process.cwd(),
    roster: FLEET_ROSTER,
    config: { probeTimeoutMs, signals: { mailboxAsk: false } },
    companionsAllowed: () => true,
    director: {
      status: () => ({ subagents: workers }),
      spawnCompanion: spawn,
      assignInternal: assign,
      terminate,
      on: () => () => {},
    } as unknown as Director,
  });
  if (companion) instances.push(companion);
  events.emit('tool.executed', {
    id: 'edit:src/a.ts',
    sessionId: 'leader-session',
    name: 'edit',
    ok: true,
    durationMs: 1,
    input: { path: 'src/a.ts' },
  });
  return { spawn, assign, terminate };
}

describe('Explore Companion probe deadline above the timer maximum', () => {
  it('does not cancel the probe at once when the deadline exceeds 2^31-1 ms', async () => {
    vi.useFakeTimers();
    const h = harness(3_000_000_000);
    await vi.waitFor(() => expect(h.assign).toHaveBeenCalledTimes(1));
    expect(h.spawn.mock.calls[0]![0].timeoutMs).toBe(3_000_000_000);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('still cancels a probe that misses an ordinary deadline', async () => {
    vi.useFakeTimers();
    const h = harness(120_000);
    await vi.waitFor(() => expect(h.assign).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(119_000);
    expect(h.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.terminate).toHaveBeenCalledTimes(1);
  });
});
