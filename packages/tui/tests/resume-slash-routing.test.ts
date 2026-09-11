// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { SlashCommandRegistry } from '@wrongstack/core/registry';
import type { SlashCommand } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { useSessionSlashCommands } from '../src/hooks/use-session-slash-commands.js';

/**
 * `/resume` must open the interactive picker, not print the host's text list.
 *
 * The existing enumeration test (slash-registration-enumeration.test.ts) runs
 * against a hand-rolled fake registry that has no trust tiers and no built-ins
 * loaded, so it asserted the TUI's *intent* and never the outcome: against the
 * REAL registry, with the host's `/sessions` (aliases resume, load) already
 * registered by core, the TUI's bare write was refused as a core-owned-alias
 * collision and every key kept routing to the host's text command — the
 * ten-session gray dump the picker exists to replace.
 */

/**
 * Faithful stand-in for the host command (packages/cli/src/slash-commands/session.ts).
 *
 * A stub, because tui must not import cli. The shape it copies is pinned on the
 * other side by packages/cli/tests/slash-session.test.ts ("exposes name
 * \"sessions\" with backward-compat aliases") — if the host is ever renamed,
 * that test fails first and this file is what it points at.
 */
function makeHostSessionsCommand(): SlashCommand & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: 'sessions',
    aliases: ['resume', 'load'],
    description: 'List, resume, archive, or recover sessions.',
    calls,
    async run(args: string) {
      calls.push(args);
      return { message: 'Recent sessions (10):' };
    },
  };
}

function renderTail(registry: SlashCommandRegistry, dispatch = vi.fn()) {
  const listSessions = vi.fn(async () => [
    { id: 's1', title: 'one', startedAt: '2026-09-01T00:00:00.000Z' },
  ]);
  const opts = {
    agent: { ctx: {} },
    slashRegistry: registry,
    dispatch,
    setMailboxPanelOpen: vi.fn(),
    switchAutonomy: vi.fn(),
    listSessions,
  } as never;
  const view = renderHook(() => useSessionSlashCommands(opts, 'tail'));
  return { view, dispatch, listSessions };
}

describe('/resume routing against the real registry', () => {
  it('claims every key the host command answered to', async () => {
    const registry = new SlashCommandRegistry();
    const host = makeHostSessionsCommand();
    registry.register(host, 'core');

    const { dispatch } = renderTail(registry);

    const picker = registry.get('sessions');
    expect(picker).not.toBe(host);
    expect(registry.get('resume')).toBe(picker);
    expect(registry.get('load')).toBe(picker);

    await picker?.run('');
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'resumePickerOpen' }));
  });

  it('delegates text subcommands back to the host command', async () => {
    const registry = new SlashCommandRegistry();
    const host = makeHostSessionsCommand();
    registry.register(host, 'core');

    const { dispatch } = renderTail(registry);

    const res = await registry.get('sessions')?.run('status');
    expect(host.calls).toEqual(['status']);
    expect(res).toEqual({ message: 'Recent sessions (10):' });
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'resumePickerOpen' }),
    );
  });

  it('restores the host command on unmount', () => {
    const registry = new SlashCommandRegistry();
    const host = makeHostSessionsCommand();
    registry.register(host, 'core');

    const { view } = renderTail(registry);
    view.unmount();

    expect(registry.get('sessions')).toBe(host);
    expect(registry.get('resume')).toBe(host);
  });
});
