import { describe, expect, it } from 'vitest';
import { parseHqAcpConfig } from '../src/command-acp-config.js';

describe('parseHqAcpConfig trimmed prototype-key guard (F2298)', () => {
  it('rejects whitespace-padded __proto__ agentId and trims valid ids', () => {
    expect(
      parseHqAcpConfig({ sessionId: 's1', agentId: ' __proto__ ', action: 'inspect' }),
    ).toBeNull();
    expect(parseHqAcpConfig({ sessionId: ' s1 ', agentId: ' claude ', action: 'inspect' })).toEqual(
      {
        type: 'acp-config',
        action: 'inspect',
        agentId: 'claude',
        sessionId: 's1',
      },
    );
  });
});
