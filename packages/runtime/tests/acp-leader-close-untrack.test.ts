import type { Config } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { closeAcpLeaderSessions } from '../src/acp-leader/acp-leader-host.js';
import { AcpLeaderProvider } from '../src/acp-leader/acp-leader-provider.js';

const STATE_KEY = Symbol.for('wrongstack.acp-leader.host');
const holder = globalThis as typeof globalThis & {
  [STATE_KEY]?: { liveLeaders: Set<{ closeAll(): Promise<void> }> };
};

describe('AcpLeaderProvider liveLeaders tracking', () => {
  it('untracks provider from liveLeaders when closeAll() is called', async () => {
    await closeAcpLeaderSessions();
    const provider = new AcpLeaderProvider({
      bootConfig: {} as Config,
      buildProvider: () => undefined,
    });
    expect(holder[STATE_KEY]?.liveLeaders.size).toBe(1);

    await provider.closeAll();
    expect(holder[STATE_KEY]?.liveLeaders.size).toBe(0);
  });
});
