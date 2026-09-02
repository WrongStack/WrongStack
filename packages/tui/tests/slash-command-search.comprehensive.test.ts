import type { SlashCommand } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { buildSlashCommandMatches, selectedSlashCommandLine } from '../src/slash-command-search.js';

function command(overrides: Partial<SlashCommand> & Pick<SlashCommand, 'name'>): SlashCommand {
  return {
    description: `${overrides.name} command`,
    async run() {},
    ...overrides,
  };
}

describe('selectedSlashCommandLine', () => {
  it('returns null when picker is not open', () => {
    expect(selectedSlashCommandLine({ open: false, matches: [], selected: 0 })).toBeNull();
  });

  it('returns null when matches array is empty', () => {
    expect(selectedSlashCommandLine({ open: true, matches: [], selected: 0 })).toBeNull();
  });

  it('returns /name of the selected match', () => {
    const matches = [
      { name: 'settings', description: 'Config', isBuiltin: true, category: 'Config' as const },
    ];
    expect(selectedSlashCommandLine({ open: true, matches, selected: 0 })).toBe('/settings');
  });

  it('returns null when selected index is out of bounds', () => {
    const matches = [
      { name: 'settings', description: 'Config', isBuiltin: true, category: 'Config' as const },
    ];
    expect(selectedSlashCommandLine({ open: true, matches, selected: 5 })).toBeNull();
  });
});

describe('buildSlashCommandMatches', () => {
  const entries = [
    { cmd: command({ name: 'settings', category: 'Config' }), owner: 'core', fullName: 'settings' },
    {
      cmd: command({ name: 'telegram-settings', aliases: ['tg-settings'], category: 'Config' }),
      owner: 'core',
      fullName: 'telegram-settings',
    },
    {
      cmd: command({ name: 'session', aliases: ['resume'], category: 'Session' }),
      owner: 'core',
      fullName: 'session',
    },
    { cmd: command({ name: 'f1', hidden: true, category: 'App' }), owner: 'core', fullName: 'f1' },
    {
      cmd: command({ name: 'plugin', aliases: ['pl'], category: 'App' }),
      owner: 'myplugin',
      fullName: 'myplugin:plugin',
    },
    {
      cmd: command({ name: 'help', category: 'App', aliases: ['?'] }),
      owner: 'core',
      fullName: 'help',
    },
  ];

  it('uses prefix matching, so settings does not match telegram-settings', () => {
    const matches = buildSlashCommandMatches(entries, 'settings');
    expect(matches.map((m) => m.name)).toEqual(['settings']);
  });

  it('still matches long commands by their real prefix', () => {
    const matches = buildSlashCommandMatches(entries, 'telegram');
    expect(matches.map((m) => m.name)).toEqual(['telegram-settings']);
  });

  it('matches aliases by prefix and marks the matched alias', () => {
    const matches = buildSlashCommandMatches(entries, 'tg');
    expect(matches).toMatchObject([{ name: 'telegram-settings', matchedAlias: 'tg-settings' }]);
  });

  it('orders exact aliases before name-prefix matches', () => {
    const matches = buildSlashCommandMatches(
      [
        {
          cmd: command({ name: 'settings', aliases: ['set'] }),
          owner: 'core',
          fullName: 'settings',
        },
        {
          cmd: command({ name: 'setmodel', category: 'Config' }),
          owner: 'core',
          fullName: 'setmodel',
        },
        {
          cmd: command({ name: 'tool', aliases: ['settings-tool'] }),
          owner: 'core',
          fullName: 'tool',
        },
      ],
      'set',
    );
    expect(matches.map((m) => m.name)).toEqual(['settings', 'setmodel', 'tool']);
  });

  it('keeps hidden commands out of the empty picker but searchable by prefix', () => {
    expect(buildSlashCommandMatches(entries, '').map((m) => m.name)).not.toContain('f1');
    expect(buildSlashCommandMatches(entries, 'f').map((m) => m.name)).toContain('f1');
  });

  it('matches non-core owner commands by prefixed alias', () => {
    const matches = buildSlashCommandMatches(entries, 'myplugin:pl');
    expect(matches).toMatchObject([{ name: 'myplugin:plugin', matchedAlias: 'myplugin:pl' }]);
  });

  it('returns empty array for no matches', () => {
    const matches = buildSlashCommandMatches(entries, 'zzzzzz');
    expect(matches).toEqual([]);
  });

  it('handles empty query with empty entries', () => {
    expect(buildSlashCommandMatches([], '')).toEqual([]);
  });

  it('displays non-core command names correctly when fullName has a colon', () => {
    const pluginEntry = {
      cmd: command({ name: 'mycmd' }),
      owner: 'myplugin',
      fullName: 'myplugin:mycmd',
    };
    const matches = buildSlashCommandMatches([pluginEntry], 'myplugin');
    expect(matches[0]?.name).toBe('myplugin:mycmd');
  });

  it('displays non-core command names as cmd.name when no colon in fullName', () => {
    const pluginEntry = { cmd: command({ name: 'mycmd' }), owner: 'myplugin', fullName: 'simple' };
    const matches = buildSlashCommandMatches([pluginEntry], 'my');
    expect(matches[0]?.name).toBe('mycmd');
  });

  it('filters alias candidates when fullName has colon', () => {
    const pluginEntry = {
      cmd: command({ name: 'mycmd', aliases: ['mc', 'mcm'] }),
      owner: 'myplugin',
      fullName: 'myplugin:mycmd',
    };
    const matches = buildSlashCommandMatches([pluginEntry], 'myplugin:mc');
    expect(matches).toMatchObject([{ name: 'myplugin:mycmd', matchedAlias: 'myplugin:mc' }]);
  });

  it('normalizes query by stripping leading slashes', () => {
    const matches = buildSlashCommandMatches(entries, '/set');
    expect(matches.map((m) => m.name)).toContain('settings');
  });

  it('matches exact alias for non-core owner with prefixed alias', () => {
    const pluginEntry = {
      cmd: command({ name: 'mycmd', aliases: ['mc'] }),
      owner: 'myplugin',
      fullName: 'myplugin:mycmd',
    };
    // "myplugin:mc" should match the prefixed alias
    const matches = buildSlashCommandMatches([pluginEntry], 'myplugin:mc');
    expect(matches).toMatchObject([{ name: 'myplugin:mycmd', matchedAlias: 'myplugin:mc' }]);
  });
});
