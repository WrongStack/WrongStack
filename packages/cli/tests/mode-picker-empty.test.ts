import { describe, expect, it } from 'vitest';
import { buildModeCommand } from '../src/slash-commands/mode.js';

describe('mode picker empty list guard', () => {
  it('returns cancelled immediately without awaiting readKey when no modes exist', async () => {
    let readKeyCalls = 0;
    const cmd = buildModeCommand({
      modeStore: {
        listModes: async () => [],
        getActiveMode: async () => undefined,
        setActiveMode: async () => {},
      },
      inputReader: {
        readKey: async () => {
          readKeyCalls += 1;
          return 'quit';
        },
      },
    } as never);

    const res = await cmd.run('', undefined);
    expect(readKeyCalls).toBe(0);
    expect(res && res.message).toBe('Mode selection cancelled.');
  });
});
