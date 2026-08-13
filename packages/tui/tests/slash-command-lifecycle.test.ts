import { SlashCommandRegistry } from '@wrongstack/core/registry';
import type { SlashCommand } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { registerSlashCommandLifecycle } from '../src/slash-command-lifecycle.js';
import { createAppJourney, waitForJourney } from './helpers/app-journey-harness.js';

function command(
  name: string,
  aliases: string[] = [],
  run: SlashCommand['run'] = vi.fn(async () => ({ message: name })),
): SlashCommand {
  return { name, aliases, description: name, run };
}

describe('registerSlashCommandLifecycle', () => {
  it('restores a displaced core command and its aliases on teardown', () => {
    const registry = new SlashCommandRegistry();
    const canonical = command('model', ['provider']);
    const tui = command('model', ['provider', 'switch']);
    registry.register(canonical);

    const cleanup = registerSlashCommandLifecycle(registry, tui, {
      owner: 'tui',
      official: true,
    });

    expect(registry.get('model')).toBe(tui);
    expect(registry.get('provider')).toBe(tui);
    expect(registry.get('switch')).toBe(tui);
    expect(registry.get('tui:model')).toBe(tui);

    cleanup();

    expect(registry.get('model')).toBe(canonical);
    expect(registry.get('provider')).toBe(canonical);
    expect(registry.get('switch')).toBeUndefined();
    expect(registry.get('tui:model')).toBeUndefined();
  });

  it('restores a displaced official plugin with its ownership intact', () => {
    const registry = new SlashCommandRegistry();
    const canonical = command('theme', ['palette']);
    const tui = command('theme');
    registry.register(canonical, 'official-theme', { official: true });

    const cleanup = registerSlashCommandLifecycle(registry, tui, {
      owner: 'tui',
      official: true,
    });
    cleanup();

    expect(registry.get('theme')).toBe(canonical);
    expect(registry.get('palette')).toBe(canonical);
    expect(registry.get('official-theme:theme')).toBe(canonical);
    expect(registry.ownerOf('theme')).toBe('official-theme');
  });

  it('does not remove an existing core command when duplicate core registration is a no-op', () => {
    const registry = new SlashCommandRegistry();
    const canonical = command('connections');
    const duplicate = command('connections');
    registry.register(canonical);

    const cleanup = registerSlashCommandLifecycle(registry, duplicate);
    expect(registry.get('connections')).toBe(canonical);

    cleanup();
    cleanup();

    expect(registry.get('connections')).toBe(canonical);
  });

  it('does not overwrite a newer official owner during stale teardown', () => {
    const registry = new SlashCommandRegistry();
    const canonical = command('agents');
    const tui = command('agents');
    const newer = command('agents');
    registry.register(canonical);

    const cleanup = registerSlashCommandLifecycle(registry, tui, {
      owner: 'tui',
      official: true,
    });
    registry.register(newer, 'new-owner', { official: true });

    cleanup();

    expect(registry.get('agents')).toBe(newer);
    expect(registry.ownerOf('agents')).toBe('new-owner');
    expect(registry.get('tui:agents')).toBeUndefined();
  });

  it('supports setup, cleanup, remount, and final cleanup without losing the host command', () => {
    const registry = new SlashCommandRegistry();
    const canonical = command('statusline', ['sl']);
    const first = command('statusline', ['sl']);
    const second = command('statusline', ['sl']);
    registry.register(canonical);

    registerSlashCommandLifecycle(registry, first, { owner: 'tui', official: true })();
    expect(registry.get('statusline')).toBe(canonical);

    const cleanupSecond = registerSlashCommandLifecycle(registry, second, {
      owner: 'tui',
      official: true,
    });
    expect(registry.get('statusline')).toBe(second);
    cleanupSecond();

    expect(registry.get('statusline')).toBe(canonical);
    expect(registry.get('sl')).toBe(canonical);
  });
});

describe('TUI slash-command lifecycle integration', () => {
  it('delegates typed /agents and restores it while removing /connections on unmount', async () => {
    const journey = createAppJourney();
    const canonicalRun = vi.fn(async (args: string) => ({ message: `canonical:${args}` }));
    const canonicalAgents = command('agents', [], canonicalRun);
    journey.props.slashRegistry.register(canonicalAgents);

    const view = journey.mount();
    await waitForJourney(() => journey.props.slashRegistry.ownerOf('agents') === 'tui');
    await waitForJourney(() => journey.props.slashRegistry.get('connections') !== undefined);

    const typed = await journey.props.slashRegistry.dispatch('/agents list', {} as never);
    expect(canonicalRun).toHaveBeenCalledWith('list', expect.anything());
    expect(typed?.message).toBe('canonical:list');

    const bare = await journey.props.slashRegistry.dispatch('/agents', {} as never);
    expect(bare?.message).toBeUndefined();
    expect(canonicalRun).toHaveBeenCalledTimes(1);

    view.unmount();

    expect(journey.props.slashRegistry.get('agents')).toBe(canonicalAgents);
    expect(journey.props.slashRegistry.ownerOf('agents')).toBe('core');
    expect(journey.props.slashRegistry.get('connections')).toBeUndefined();
  });
});
