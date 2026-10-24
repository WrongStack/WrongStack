import type { SlashCommand } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import { SlashCommandRegistry } from '@wrongstack/core/registry';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionsSlashCommand } from '../src/connections-slash.js';

const { executeConnectionAction } = vi.hoisted(() => ({ executeConnectionAction: vi.fn() }));
vi.mock('../src/connection-actions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/connection-actions.js')>()),
  executeConnectionAction,
}));

beforeEach(() => {
  executeConnectionAction.mockReset().mockImplementation(async (serviceId: string) => ({
    serviceId,
    action: 'restart',
    success: true,
    message: 'Restart verified',
  }));
});

/** Run a slash command and return its message string (or undefined for void). */
async function runMessage(cmd: SlashCommand, args: string): Promise<string | undefined> {
  const res = await cmd.run(args, undefined as Context | undefined);
  if (res === undefined || res === null) return undefined;
  return res.message;
}

describe('createConnectionsSlashCommand', () => {
  const ctx = { projectRoot: '/active-project' } as Context;

  it.each(['connections', 'conn', 'conns'])(
    'dispatches /%s restart through the registry',
    async (name) => {
      const registry = new SlashCommandRegistry();
      const open = vi.fn();
      registry.register(createConnectionsSlashCommand({ onPanelOpen: { current: open } }));
      const result = await registry.dispatch(`/${name} restart`, ctx);
      expect(result?.message).toContain('Restarted 6/6');
      expect(executeConnectionAction).toHaveBeenCalledTimes(6);
      expect(open).not.toHaveBeenCalled();
    },
  );

  it('restarts all supported daemons in the active project without opening the panel', async () => {
    const open = vi.fn();
    const cmd = createConnectionsSlashCommand({ onPanelOpen: { current: open } });
    const result = await cmd.run(' RESTART ', ctx);
    expect(executeConnectionAction.mock.calls).toEqual([
      ['session-catalog', 'restart', '/active-project'],
      ['chronicle', 'restart', '/active-project'],
      ['codebase-index', 'restart', '/active-project'],
      ['sage', 'restart', '/active-project'],
      ['kanban', 'restart', '/active-project'],
      ['mailbox', 'restart', '/active-project'],
    ]);
    expect(result?.message).toContain('Restarted 6/6');
    expect(result?.message).toContain('Governance skipped');
    expect(open).not.toHaveBeenCalled();
  });

  it('continues after returned failures and thrown errors and reports both', async () => {
    executeConnectionAction.mockResolvedValueOnce({ success: false, message: 'Busy owner' });
    executeConnectionAction.mockRejectedValueOnce(new Error('Transport failed'));
    const cmd = createConnectionsSlashCommand({});
    const result = await cmd.run('restart', ctx);
    expect(executeConnectionAction).toHaveBeenCalledTimes(6);
    expect(result?.message).toContain('Restarted 4/6');
    expect(result?.message).toContain('FAILED session-catalog: Busy owner');
    expect(result?.message).toContain('FAILED chronicle: Transport failed');
    expect(result?.message).toContain('OK mailbox');
  });

  it('does not restart anything without an active project', async () => {
    expect(await runMessage(createConnectionsSlashCommand({}), 'restart')).toContain(
      'No active project',
    );
    expect(executeConnectionAction).not.toHaveBeenCalled();
  });

  it('prevents overlapping restart batches and permits a later retry', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    executeConnectionAction.mockImplementationOnce(async () => {
      await pending;
      return { success: true, message: 'Restart verified' };
    });
    const cmd = createConnectionsSlashCommand({});
    const first = cmd.run('restart', ctx);
    expect((await cmd.run('restart', ctx))?.message).toContain('already in progress');
    release();
    await first;
    await cmd.run('restart', ctx);
    expect(executeConnectionAction).toHaveBeenCalledTimes(12);
  });

  it('opens panel on bare /connections and returns empty message', async () => {
    let dispatched = '';
    const cmd = createConnectionsSlashCommand({
      onPanelOpen: {
        current: (action: string) => {
          dispatched = action;
          return true;
        },
      },
    });
    const message = await runMessage(cmd, '');
    expect(dispatched).toBe('toggleConnectionsPanel');
    expect(message).toBe('');
  });

  it('opens panel on /connections open', async () => {
    let dispatched = '';
    const cmd = createConnectionsSlashCommand({
      onPanelOpen: {
        current: (action: string) => {
          dispatched = action;
          return true;
        },
      },
    });
    const message = await runMessage(cmd, 'open');
    expect(dispatched).toBe('toggleConnectionsPanel');
    expect(message).toBe('');
  });

  it('opens panel on /connections --open', async () => {
    const cmd = createConnectionsSlashCommand({
      onPanelOpen: { current: () => true },
    });
    const message = await runMessage(cmd, '--open');
    expect(message).toBe('');
  });

  it('returns usage hint for unknown argument', async () => {
    const cmd = createConnectionsSlashCommand({
      onPanelOpen: { current: () => true },
    });
    const message = await runMessage(cmd, 'status');
    expect(message).toContain('Usage');
  });

  it('returns fallback message when panel bridge is unavailable', async () => {
    const cmd = createConnectionsSlashCommand({
      onPanelOpen: { current: () => false },
    });
    const message = await runMessage(cmd, '');
    expect(message).toContain('unavailable');
  });

  it('returns fallback message when onPanelOpen is undefined', async () => {
    const cmd = createConnectionsSlashCommand({});
    const message = await runMessage(cmd, '');
    expect(message).toContain('unavailable');
  });

  it('registers with name and aliases', () => {
    const cmd = createConnectionsSlashCommand({});
    expect(cmd.name).toBe('connections');
    expect(cmd.aliases).toEqual(['conn', 'conns']);
    expect(cmd.category).toBe('Inspect');
  });
});
