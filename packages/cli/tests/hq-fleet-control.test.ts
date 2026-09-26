/**
 * HQ `abort fleet` scoping.
 *
 * The CLI host ignored the command's session and swept every subagent the
 * Director held — in the WebUI host, a Stop aimed at one tab's fleet killed
 * every tab's workers. WebUI tabs had no fleet hooks at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { createHqFleetControl, killHqSessionFleet } from '../src/hq-fleet-control.js';

function fakeDirector(bySession: Record<string, string[]>) {
  const all = Object.values(bySession).flat();
  return {
    subagentIdsForSession: vi.fn((sessionId: string) => bySession[sessionId] ?? []),
    terminateSession: vi.fn(async () => undefined),
    status: () => ({ subagents: all.map((id) => ({ id, status: 'running' })) }),
    remove: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
  };
}

describe('killHqSessionFleet', () => {
  it('stops only the named session when it owns workers', async () => {
    const director = fakeDirector({ 'tab-1': ['a', 'b'], 'tab-2': ['c'] });
    const killed = await killHqSessionFleet(director as never, 'tab-1', {
      multiConversation: true,
    });
    expect(killed).toBe(2);
    expect(director.terminateSession).toHaveBeenCalledWith('tab-1');
    expect(director.remove).not.toHaveBeenCalled();
  });

  it('never reaches another conversation when several share the Director', async () => {
    const director = fakeDirector({ 'tab-2': ['c'] });
    const killed = await killHqSessionFleet(director as never, 'tab-1', {
      multiConversation: true,
    });
    expect(killed).toBe(0);
    expect(director.terminateSession).not.toHaveBeenCalled();
    expect(director.remove).not.toHaveBeenCalled();
  });

  it('keeps the process-wide sweep for a single-conversation host', async () => {
    // After /resume the leader's older workers carry the boot session id.
    const director = fakeDirector({ boot: ['x', 'y'] });
    const killed = await killHqSessionFleet(director as never, 'resumed', {
      multiConversation: false,
    });
    expect(killed).toBe(2);
    expect(director.remove).toHaveBeenCalledTimes(2);
  });
});

describe('createHqFleetControl', () => {
  it('binds lazily to a Director that appears after wiring', async () => {
    let director: ReturnType<typeof fakeDirector> | null = null;
    const control = createHqFleetControl(
      () => director as never,
      () => 'boot',
      { multiConversation: true },
    );
    expect(await control.killFleet('tab-1')).toBe(0);
    director = fakeDirector({ 'tab-1': ['a'] });
    expect(await control.killFleet('tab-1')).toBe(1);
    expect(await control.terminateAgent('a')).toBe(true);
  });
});
