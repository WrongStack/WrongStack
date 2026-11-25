import { describe, expect, it } from 'vitest';
import { isHqAcpConfigResult, parseHqAcpConfig } from '../src/command-acp-config.js';

describe('command-acp-config (F2193)', () => {
  it('rejects whitespace-only sessionId/agentId and circular result objects', () => {
    expect(parseHqAcpConfig({ sessionId: '   ', agentId: 'a1', action: 'inspect' })).toBeNull();
    expect(parseHqAcpConfig({ sessionId: 's1', agentId: '   ', action: 'inspect' })).toBeNull();

    const circular: Record<string, unknown> = { agentId: 'a1', applied: {}, options: [] };
    circular.self = circular;
    expect(isHqAcpConfigResult(circular)).toBe(false);
  });
});
