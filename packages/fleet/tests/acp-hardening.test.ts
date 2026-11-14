import { getProviderQuota } from '@wrongstack/core/quota';
import { describe, expect, it } from 'vitest';
import { wrongstackAcpPermissionPolicy } from '../src/acp-permission-bridge.js';
import { recordAcpRateLimit } from '../src/acp-quota-reading.js';

describe('ACP hardening regressions (F240, F241)', () => {
  it('ignores Object.prototype keys in recordAcpRateLimit unifiedWindows (F240)', () => {
    const agentId = `claude-f240-${Date.now()}`;
    recordAcpRateLimit(agentId, {
      unifiedWindows: {
        constructor: { utilization: 0.5 },
        toString: { utilization: 0.8 },
      },
    });
    expect(getProviderQuota(agentId)).toEqual([]);
  });

  it('uses single-quoted POSIX escaping for delete and move commands (F241)', async () => {
    const captured: string[] = [];
    const policy = wrongstackAcpPermissionPolicy({
      projectRoot: '/tmp/proj',
      getTool: (name) => ({ name, permission: 'confirm' }) as never,
      evaluate: async (_tool, input) => {
        captured.push(String((input as { command?: unknown }).command ?? ''));
        return { permission: 'auto', source: 'default' } as never;
      },
    });

    await policy({
      sessionId: 's1',
      signal: new AbortController().signal,
      toolCall: {
        toolCallId: 'tc1',
        kind: 'delete',
        rawInput: { path: '$(touch /tmp/pwned)' },
      },
      options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }],
    } as never);

    await policy({
      sessionId: 's1',
      signal: new AbortController().signal,
      toolCall: {
        toolCallId: 'tc2',
        kind: 'move',
        rawInput: { path: "a'b", destination: '`id`' },
      },
      options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }],
    } as never);

    expect(captured).toEqual(["rm '$(touch /tmp/pwned)'", "mv 'a'\\''b' '`id`'"]);
  });
});
