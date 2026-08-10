import { describe, expect, it } from 'vitest';
import { SlashCommandRegistry } from '@wrongstack/core/registry';
import { buildThemeCommand } from '../src/slash-commands/theme.js';

describe('/theme slash command', () => {
  it('registers in SlashCommandRegistry and lists theme options when no arg is passed', async () => {
    const reg = new SlashCommandRegistry();
    const cmd = buildThemeCommand({} as never);
    reg.register(cmd);

    expect(reg.get('theme')).toBeDefined();
    const res = await reg.dispatch('/theme', {} as never);
    expect(res).not.toBeNull();
    expect(res?.message).toContain('Available Theme Presets:');
    expect(res?.message).toContain('catppuccin');
    expect(res?.message).toContain('tokyo-night');
    expect(res?.message).toContain('nord');
    expect(res?.message).toContain('cyberpunk');
    expect(res?.message).toContain('dracula');
  });

  it('switches theme to a valid preset and rejects unknown presets', async () => {
    let updatedConfig: Record<string, unknown> | null = null;
    const fakeConfigStore = {
      get: () => ({ themePreset: 'catppuccin' }),
      update: (patch: Record<string, unknown>) => {
        updatedConfig = patch;
      },
    };
    const reg = new SlashCommandRegistry();
    const cmd = buildThemeCommand({ configStore: fakeConfigStore } as never);
    reg.register(cmd);

    const validRes = await reg.dispatch('/theme cyberpunk', {} as never);
    expect(validRes).not.toBeNull();
    expect(validRes?.message).toContain('Switched TUI theme preset to "cyberpunk"');
    expect(validRes?.metadata?.themePreset).toBe('cyberpunk');
    expect(updatedConfig).toEqual({ themePreset: 'cyberpunk' });

    const invalidRes = await reg.dispatch('/theme invalid-preset', {} as never);
    expect(invalidRes).not.toBeNull();
    expect(invalidRes?.message).toContain('Unknown theme preset "invalid-preset"');
  });
});

