import { describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildPruneCommand } from '../src/slash-commands/prune.js';

function makeOpts(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    sessionStore: undefined,
    ...overrides,
  } as never as SlashCommandContext;
}

describe('buildPruneCommand', () => {
  it('returns yellow warning when no session store configured', async () => {
    const cmd = buildPruneCommand(makeOpts());
    const res = await cmd.run('7');
    expect(res?.message).toMatch(/No session store configured/);
  });

  it('prunes with default 30 days', async () => {
    const prune = vi.fn().mockResolvedValue(5);
    const cmd = buildPruneCommand(makeOpts({ sessionStore: { prune } } as never));
    const res = await cmd.run('');
    expect(prune).toHaveBeenCalledWith(30);
    expect(res?.message).toContain('Pruned');
    expect(res?.message).toContain('5');
  });

  it('prunes with custom day count', async () => {
    const prune = vi.fn().mockResolvedValue(3);
    const cmd = buildPruneCommand(makeOpts({ sessionStore: { prune } } as never));
    const res = await cmd.run('14');
    expect(prune).toHaveBeenCalledWith(14);
    expect(res?.message).toContain('14');
    expect(res?.message).toContain('3');
  });

  it('clamps days between 1 and 365', async () => {
    const prune = vi.fn().mockResolvedValue(0);
    const cmd = buildPruneCommand(makeOpts({ sessionStore: { prune } } as never));
    await cmd.run('999');
    expect(prune).toHaveBeenCalledWith(365);
    await cmd.run('0');
    expect(prune).toHaveBeenCalledWith(1);
  });

  it('returns dim message when 0 sessions pruned', async () => {
    const prune = vi.fn().mockResolvedValue(0);
    const cmd = buildPruneCommand(makeOpts({ sessionStore: { prune } } as never));
    const res = await cmd.run('');
    expect(res?.message).toMatch(/No sessions older than/);
  });

  it('returns singular for 1 session', async () => {
    const prune = vi.fn().mockResolvedValue(1);
    const cmd = buildPruneCommand(makeOpts({ sessionStore: { prune } } as never));
    const res = await cmd.run('');
    expect(res?.message).toMatch(/1 session/);
    expect(res?.message).not.toMatch(/sessions/);
  });

  it('supports dry-run with no stale sessions', async () => {
    const list = vi.fn().mockResolvedValue([]);
    const cmd = buildPruneCommand(makeOpts({ sessionStore: { list, prune: vi.fn() } } as never));
    const res = await cmd.run('--dry-run');
    expect(list).toHaveBeenCalledWith(1000);
    expect(res?.message).toMatch(/No sessions older than/);
  });

  it('supports dry-run with stale sessions', async () => {
    const now = Date.now();
    const oldDate = new Date(now - 40 * 86_400_000).toISOString();
    const list = vi
      .fn()
      .mockResolvedValue([{ id: 's1', startedAt: oldDate, title: 'old session' }]);
    const cmd = buildPruneCommand(makeOpts({ sessionStore: { list, prune: vi.fn() } } as never));
    const res = await cmd.run('--dry-run');
    expect(list).toHaveBeenCalled();
    expect(res?.message).toMatch(/Would delete 1 session/);
    expect(res?.message).toContain('s1');
  });

  it('supports --rebuild-index', async () => {
    const rebuildIndex = vi.fn().mockResolvedValue(10);
    const cmd = buildPruneCommand(makeOpts({ sessionStore: { rebuildIndex } } as never));
    const res = await cmd.run('--rebuild-index');
    expect(rebuildIndex).toHaveBeenCalled();
    expect(res?.message).toContain('10');
    expect(res?.message).toMatch(/sessions indexed/);
  });

  it('supports --rebuild shorthand', async () => {
    const rebuildIndex = vi.fn().mockResolvedValue(0);
    const cmd = buildPruneCommand(
      makeOpts({ sessionStore: { rebuildIndex, prune: vi.fn() } } as never),
    );
    const res = await cmd.run('--rebuild');
    expect(rebuildIndex).toHaveBeenCalled();
    expect(res?.message).toMatch(/No sessions found/);
  });

  it('returns yellow warning when sessionStore lacks rebuildIndex', async () => {
    const cmd = buildPruneCommand(makeOpts({ sessionStore: {} } as never));
    const res = await cmd.run('--rebuild-index');
    expect(res?.message).toMatch(/does not support index rebuild/);
  });
});
