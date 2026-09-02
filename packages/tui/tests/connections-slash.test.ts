import { describe, expect, it } from 'vitest';
import type { Context } from '@wrongstack/core/agent';
import type { SlashCommand } from '@wrongstack/core/types';
import { createConnectionsSlashCommand } from '../src/connections-slash.js';

/** Run a slash command and return its message string (or undefined for void). */
async function runMessage(cmd: SlashCommand, args: string): Promise<string | undefined> {
  const res = await cmd.run(args, undefined as Context | undefined);
  if (res === undefined || res === null) return undefined;
  return res.message;
}

describe('createConnectionsSlashCommand', () => {
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
