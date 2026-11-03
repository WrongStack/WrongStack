import { describe, expect, it, vi } from 'vitest';
import { wrongMemoryBridgeHint, wrongMemorySageOwner } from '../src/sage-mcp-owner.js';

describe('SAGE MCP owner guard (WM-407)', () => {
  it('local mode keeps the SAGE MCP server and never probes', async () => {
    const probe = vi.fn();
    expect(await wrongMemorySageOwner('/p', undefined, probe)).toBeUndefined();
    expect(await wrongMemorySageOwner('/p', { mode: 'local' }, probe)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it('wrongmemory mode is always owned by WrongMemory', async () => {
    const probe = vi.fn();
    expect(
      await wrongMemorySageOwner('/p', { mode: 'wrongmemory', projectId: 'p_1' }, probe),
    ).toEqual({
      projectId: 'p_1',
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('auto mode is owned by WrongMemory only when the project is registered', async () => {
    const registered = vi.fn(async () => ({ projectId: 'p_9' }) as never);
    expect(await wrongMemorySageOwner('/p', { mode: 'auto' }, registered)).toEqual({
      projectId: 'p_9',
    });
    const absent = vi.fn(async () => undefined);
    expect(await wrongMemorySageOwner('/p', { mode: 'auto' }, absent)).toBeUndefined();
  });

  it('points at the scoped WrongMemory bridge, never a host credential', () => {
    const hint = wrongMemoryBridgeHint({ projectId: 'p_1' }, 'wstack sage connect');
    expect(hint).toContain('wrongmemory connect');
    expect(hint).toContain('--project p_1 --create-grant');
    expect(hint).toContain('wstack sage disconnect');
  });
});
