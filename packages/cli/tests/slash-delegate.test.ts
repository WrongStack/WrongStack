import { describe, expect, it, vi } from 'vitest';
import { buildDelegateCommand } from '../src/slash-commands/delegate.js';

function ctx(extra: Record<string, unknown> = {}) {
  return {
    session: { id: 's1' },
    renderer: { write: () => {}, writeWarning: () => {} },
    projectRoot: '/tmp',
    cwd: '/tmp',
    ...extra,
  } as never;
}

describe('buildDelegateCommand', () => {
  it('shows usage when no args', async () => {
    const cmd = buildDelegateCommand(ctx());
    const res = await cmd.run('');
    expect(res?.message).toContain('Hand a task to a specialist subagent');
  });

  it('lists available roles with /delegate list', async () => {
    const cmd = buildDelegateCommand(ctx());
    const res = await cmd.run('list');
    expect(res?.message).toContain('Available Agent Roles');
    expect(res?.message).toContain('debugger');
    expect(res?.message).toContain('bug-hunter');
    expect(res?.message).toContain('Phase 1');
  });

  it('ls alias also lists roles', async () => {
    const cmd = buildDelegateCommand(ctx());
    const res = await cmd.run('ls');
    expect(res?.message).toContain('Available Agent Roles');
  });

  it('roles alias also lists', async () => {
    const cmd = buildDelegateCommand(ctx());
    const res = await cmd.run('roles');
    expect(res?.message).toContain('Available Agent Roles');
  });

  it('rejects unknown role', async () => {
    const cmd = buildDelegateCommand(ctx());
    const res = await cmd.run('--role=nonexistent do something');
    expect(res?.message).toContain('Unknown role');
    expect(res?.message).toContain('nonexistent');
  });

  it('shows usage when no task', async () => {
    const cmd = buildDelegateCommand(ctx());
    const res = await cmd.run('--role=bug-hunter');
    expect(res?.message).toContain('Usage:');
  });

  it('reports no fleet when onFleetSpawn not wired', async () => {
    const cmd = buildDelegateCommand(ctx());
    const res = await cmd.run('fix the bug');
    expect(res?.message).toContain('No fleet active');
    expect(res?.message).toContain('spawning a task');
  });

  it('spawns explicit role when --role is given', async () => {
    const onFleetSpawn = vi.fn().mockResolvedValue('sub-abc');
    const cmd = buildDelegateCommand(ctx({ onFleetSpawn } as never as Record<string, unknown>));
    const res = await cmd.run('--role=bug-hunter find the race condition');
    expect(onFleetSpawn).toHaveBeenCalledWith('bug-hunter');
    expect(res?.message).toContain('bug-hunter');
    expect(res?.message).toContain('sub-abc');
  });

  it('parses --role with space separator', async () => {
    const onFleetSpawn = vi.fn().mockResolvedValue('sub-xyz');
    const cmd = buildDelegateCommand(ctx({ onFleetSpawn } as never as Record<string, unknown>));
    await cmd.run('--role security-scanner scan configs');
    expect(onFleetSpawn).toHaveBeenCalledWith('security-scanner');
  });

  it('parses --name flag', async () => {
    const onFleetSpawn = vi.fn().mockResolvedValue('sub-1');
    const cmd = buildDelegateCommand(ctx({ onFleetSpawn } as never as Record<string, unknown>));
    const res = await cmd.run('--role=bug-hunter --name="My Fixer" fix it');
    expect(onFleetSpawn).toHaveBeenCalledWith('bug-hunter');
    expect(res?.message).toContain('bug-hunter');
  });

  it('auto-dispatches when no --role given', async () => {
    const onFleetSpawn = vi.fn().mockResolvedValue('sub-disp');
    const cmd = buildDelegateCommand(ctx({ onFleetSpawn } as never as Record<string, unknown>));
    const res = await cmd.run('fix the crash when the app starts');
    // Heuristic dispatcher should route crash/fix → debugger
    expect(onFleetSpawn).toHaveBeenCalledWith('debugger');
    expect(res?.message).toContain('debugger');
    expect(res?.message).toContain('spawned');
  });

  it('surfaces spawn errors', async () => {
    const onFleetSpawn = vi.fn().mockRejectedValue(new Error('Provider timeout'));
    const cmd = buildDelegateCommand(ctx({ onFleetSpawn } as never as Record<string, unknown>));
    const res = await cmd.run('--role=bug-hunter fix it');
    expect(res?.message).toContain('Spawn failed');
    expect(res?.message).toContain('Provider timeout');
  });

  it('appears in help output with correct name', () => {
    const cmd = buildDelegateCommand(ctx());
    expect(cmd.name).toBe('delegate');
    expect(cmd.category).toBe('Agent');
    expect(cmd.description).toContain('Hand a task');
    expect(cmd.help).toBeTruthy();
  });
});
