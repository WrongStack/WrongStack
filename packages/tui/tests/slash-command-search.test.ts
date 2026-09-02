import type { SlashCommand } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { buildSlashCommandMatches } from '../src/slash-command-search.js';

function command(overrides: Partial<SlashCommand> & Pick<SlashCommand, 'name'>): SlashCommand {
  return {
    description: `${overrides.name} command`,
    async run() {},
    ...overrides,
  };
}

describe('buildSlashCommandMatches', () => {
  const entries = [
    { cmd: command({ name: 'settings', category: 'Config' }), owner: 'core', fullName: 'settings' },
    {
      cmd: command({
        name: 'telegram-settings',
        aliases: ['tg-settings'],
        category: 'Config',
      }),
      owner: 'core',
      fullName: 'telegram-settings',
    },
    {
      cmd: command({ name: 'session', aliases: ['resume'], category: 'Session' }),
      owner: 'core',
      fullName: 'session',
    },
    { cmd: command({ name: 'f1', hidden: true, category: 'App' }), owner: 'core', fullName: 'f1' },
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
});
