import { describe, expect, it, vi } from 'vitest';
import { buildAgentsCommand } from '../src/slash-commands/spawn-agents.js';

function ctx() {
  return {} as never;
}

describe('buildAgentsCommand', () => {
  it('reports multi-agent not enabled when onAgents missing', async () => {
    const cmd = buildAgentsCommand({} as never);
    const res = await cmd.run('', ctx());
    expect(res?.message).toContain('Multi-agent is not enabled');
  });

  it('/agents without id calls onAgents(undefined)', async () => {
    const onAgents = vi.fn().mockReturnValue('all agents summary');
    const cmd = buildAgentsCommand({ onAgents } as never);
    const res = await cmd.run('', ctx());
    expect(onAgents).toHaveBeenCalledWith(undefined);
    expect(res?.message).toBe('all agents summary');
  });

  it('/agents with id calls onAgents(subagentId)', async () => {
    const onAgents = vi.fn().mockReturnValue('Agent ab123\n  status: running');
    const cmd = buildAgentsCommand({ onAgents } as never);
    const res = await cmd.run('ab12345678', ctx());
    expect(onAgents).toHaveBeenCalledWith('ab12345678');
    expect(res?.message).toBe('Agent ab123\n  status: running');
  });

  it('/agents trims whitespace from id', async () => {
    const onAgents = vi.fn().mockReturnValue('ok');
    const cmd = buildAgentsCommand({ onAgents } as never);
    await cmd.run('  sub-1  ', ctx());
    expect(onAgents).toHaveBeenCalledWith('sub-1');
  });

  it('/agents with empty-ish id calls onAgents(undefined)', async () => {
    const onAgents = vi.fn().mockReturnValue('summary');
    const cmd = buildAgentsCommand({ onAgents } as never);
    const res = await cmd.run('   ', ctx());
    expect(onAgents).toHaveBeenCalledWith(undefined);
    expect(res?.message).toBe('summary');
  });

  it('/agents monitor opens the overlay (does not call onAgents)', async () => {
    const onAgents = vi.fn().mockReturnValue('summary');
    const setVisible = vi.fn();
    const cmd = buildAgentsCommand({
      onAgents,
      agentsMonitorController: { visible: false, setVisible },
    } as never);
    const res = await cmd.run('monitor', ctx());
    expect(setVisible).toHaveBeenCalledWith(true);
    expect(onAgents).not.toHaveBeenCalled();
    expect(res?.message).toBe('Agents monitor shown.');
  });

  it('/agents on sets visible=true on controller', async () => {
    const setVisible = vi.fn();
    const cmd = buildAgentsCommand({
      agentsMonitorController: { visible: false, setVisible },
    } as never);
    const res = await cmd.run('on', ctx());
    expect(setVisible).toHaveBeenCalledWith(true);
    expect(res?.message).toBe('Agents monitor shown.');
  });

  it('/agents off sets visible=false on controller', async () => {
    const setVisible = vi.fn();
    const cmd = buildAgentsCommand({
      agentsMonitorController: { visible: true, setVisible },
    } as never);
    const res = await cmd.run('off', ctx());
    expect(setVisible).toHaveBeenCalledWith(false);
    expect(res?.message).toBe('Agents monitor hidden.');
  });

  it('/agents on works without controller', async () => {
    const cmd = buildAgentsCommand({} as never);
    const res = await cmd.run('on', ctx());
    expect(res?.message).toContain('Agents monitor');
  });

  it('/agents off works without controller', async () => {
    const cmd = buildAgentsCommand({} as never);
    const res = await cmd.run('off', ctx());
    expect(res?.message).toContain('Agents monitor');
  });
});
