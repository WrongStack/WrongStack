import { describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildPluginCommand } from '../src/slash-commands/plugin.js';

function makeOpts(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    onPanelOpen: { current: null },
    ...overrides,
  } as never as SlashCommandContext;
}

describe('buildPluginCommand', () => {
  it('returns unavailable message when onPlugin is not wired', async () => {
    const cmd = buildPluginCommand(makeOpts());
    const res = await cmd.run('list');
    expect(res?.message).toBe('Plugin management is not available in this session.');
  });

  it('delegates args to onPlugin and returns result', async () => {
    const onPlugin = vi.fn().mockResolvedValue('plugins: read, write');
    const cmd = buildPluginCommand(makeOpts({ onPlugin }));
    const res = await cmd.run('list');
    expect(onPlugin).toHaveBeenCalledWith('list');
    expect(res?.message).toBe('plugins: read, write');
  });

  it('delegates with complex args', async () => {
    const onPlugin = vi.fn().mockResolvedValue('done');
    const cmd = buildPluginCommand(makeOpts({ onPlugin }));
    const res = await cmd.run('install telegram');
    expect(onPlugin).toHaveBeenCalledWith('install telegram');
    expect(res?.message).toBe('done');
  });

  it('opens plugin menu when menu arg and onPanelOpen is wired', async () => {
    const onPlugin = vi.fn();
    const onPanelOpen = vi.fn().mockReturnValue(true);
    const cmd = buildPluginCommand(makeOpts({ onPlugin, onPanelOpen: { current: onPanelOpen } }));
    const res = await cmd.run('menu');
    expect(onPanelOpen).toHaveBeenCalledWith('pluginPickerOpen');
    expect(res?.message).toBe('Opened plugin menu.');
    expect(onPlugin).not.toHaveBeenCalled();
  });

  it('opens plugin menu on bare /plugin when onPanelOpen is wired', async () => {
    const onPlugin = vi.fn();
    const onPanelOpen = vi.fn().mockReturnValue(true);
    const cmd = buildPluginCommand(makeOpts({ onPlugin, onPanelOpen: { current: onPanelOpen } }));
    const res = await cmd.run('');
    expect(onPanelOpen).toHaveBeenCalledWith('pluginPickerOpen');
    expect(res?.message).toBe('Opened plugin menu.');
  });

  it('falls through to onPlugin when TUI menu callback returns false', async () => {
    const onPlugin = vi.fn().mockResolvedValue('fallback result');
    const onPanelOpen = vi.fn().mockReturnValue(false);
    const cmd = buildPluginCommand(makeOpts({ onPlugin, onPanelOpen: { current: onPanelOpen } }));
    const res = await cmd.run('menu');
    expect(onPanelOpen).toHaveBeenCalledWith('pluginPickerOpen');
    expect(onPlugin).toHaveBeenCalledWith('menu');
    expect(res?.message).toBe('fallback result');
  });

  it('delegates menu arg even when onPanelOpen is null', async () => {
    const onPlugin = vi.fn().mockResolvedValue('menu output');
    const cmd = buildPluginCommand(makeOpts({ onPlugin }));
    const res = await cmd.run('menu');
    expect(onPlugin).toHaveBeenCalledWith('menu');
    expect(res?.message).toBe('menu output');
  });

  it('delegates status alias', async () => {
    const onPlugin = vi.fn().mockResolvedValue('status output');
    const cmd = buildPluginCommand(makeOpts({ onPlugin }));
    const res = await cmd.run('status');
    expect(onPlugin).toHaveBeenCalledWith('status');
    expect(res?.message).toBe('status output');
  });
});
