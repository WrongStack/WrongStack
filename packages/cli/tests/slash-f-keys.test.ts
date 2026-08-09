import { describe, expect, it, vi } from 'vitest';
import { buildFKeyAliasCommands, buildFKeysCommand } from '../src/slash-commands/f-keys.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

function makeOpts(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    onPanelOpen: { current: null },
    ...overrides,
  } as never as SlashCommandContext;
}

describe('buildFKeysCommand', () => {
  it('shows numbered list when no args given', async () => {
    const cmd = buildFKeysCommand(makeOpts());
    const res = await cmd.run('');
    expect(res?.message).toContain('F-key panels');
    expect(res?.message).toContain('/f 1');
    expect(res?.message).toContain('/f 12');
    expect(res?.message).toContain('project switcher');
    expect(res?.message).toContain('/f1 … /f12');
  });

  it('opens panel for valid F-key number via onPanelOpen', async () => {
    const onPanelOpen = vi.fn().mockReturnValue(true);
    const cmd = buildFKeysCommand(makeOpts({ onPanelOpen: { current: onPanelOpen } }));
    const res = await cmd.run('1');
    expect(onPanelOpen).toHaveBeenCalledWith('projectPickerOpen');
    expect(res?.message).toBeUndefined();
  });

  it('falls back to REPL message when onPanelOpen returns false', async () => {
    const onPanelOpen = vi.fn().mockReturnValue(false);
    const cmd = buildFKeysCommand(makeOpts({ onPanelOpen: { current: onPanelOpen } }));
    const res = await cmd.run('2');
    expect(onPanelOpen).toHaveBeenCalledWith('toggleMonitor');
    expect(res?.message).toMatch(/Opening fleet orchestration monitor/);
  });

  it('falls back to REPL message when onPanelOpen is null', async () => {
    const cmd = buildFKeysCommand(makeOpts());
    const res = await cmd.run('5');
    expect(res?.message).toMatch(/Opening autonomy settings/);
  });

  it('returns error for unknown F-key number', async () => {
    const cmd = buildFKeysCommand(makeOpts());
    const res = await cmd.run('99');
    expect(res?.message).toMatch(/Unknown F-key: 99/);
  });

  it('returns error for non-numeric argument', async () => {
    const cmd = buildFKeysCommand(makeOpts());
    const res = await cmd.run('xyz');
    expect(res?.message).toMatch(/Unknown F-key: xyz/);
  });

  it('handles all 12 F-keys', async () => {
    const labels = [
      'project switcher',
      'fleet orchestration monitor',
      'agents live monitor',
      'worktree monitor',
      'autonomy settings',
      'todos monitor overlay',
      'queue panel',
      'process list overlay',
      'goal panel',
      'live sessions panel',
      'coordinator monitor',
      'status line picker',
    ];
    for (let i = 1; i <= 12; i++) {
      const cmd = buildFKeysCommand(makeOpts());
      const res = await cmd.run(String(i));
      expect(res?.message).toMatch(new RegExp(`Opening ${labels[i - 1]}`));
    }
  });
});

describe('buildFKeyAliasCommands', () => {
  it('creates 12 hidden alias commands', () => {
    const aliases = buildFKeyAliasCommands(makeOpts());
    expect(aliases).toHaveLength(12);
  });

  it('each alias has correct hidden name and is hidden', () => {
    const aliases = buildFKeyAliasCommands(makeOpts());
    for (let i = 0; i < 12; i++) {
      expect(aliases[i]?.name).toBe(`f${i + 1}`);
      expect(aliases[i]?.hidden).toBe(true);
    }
  });

  it('alias opens panel via onPanelOpen', async () => {
    const onPanelOpen = vi.fn().mockReturnValue(true);
    const aliases = buildFKeyAliasCommands(makeOpts({ onPanelOpen: { current: onPanelOpen } }));
    const res = await aliases[0]!.run('');
    expect(onPanelOpen).toHaveBeenCalledWith('projectPickerOpen');
    expect(res?.message).toBeUndefined();
  });

  it('alias falls back to message when no TUI', async () => {
    const aliases = buildFKeyAliasCommands(makeOpts());
    const res = await aliases[1]!.run('');
    expect(res?.message).toMatch(/Opening fleet orchestration monitor/);
  });
});
