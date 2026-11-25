import { describe, expect, it } from 'vitest';
import { acpNativeCommand } from '../src/portable-commands/acp-native-commands.js';

describe('acpNativeCommand blank input guard (F2245)', () => {
  it('returns Usage message for whitespace-only input without calling listNativeCommands', async () => {
    let listed = false;
    const res = await acpNativeCommand('command', '   ', {
      model: 'demo',
      session: { id: 's1' },
      provider: {
        listNativeCommands: async () => {
          listed = true;
          return [];
        },
      },
    } as unknown as Parameters<typeof acpNativeCommand>[2]);
    expect(listed).toBe(false);
    expect(res.message).toContain('Usage:');
  });
});
