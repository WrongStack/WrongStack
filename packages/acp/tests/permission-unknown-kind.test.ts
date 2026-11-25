import { describe, expect, it } from 'vitest';
import { defaultPermissionPolicy } from '../src/client/permission.js';
import type { PermissionOption } from '../src/types/acp-v1.js';

describe('ACP pickAllow strict kind allowlist (F1836)', () => {
  it('returns cancelled instead of selecting an unrecognized permission option kind', async () => {
    const signal = new AbortController().signal;
    const outcome = await defaultPermissionPolicy({
      toolCall: { toolCallId: 'tc-1', title: 'Read', kind: 'read' },
      options: [
        {
          optionId: 'custom-deny',
          name: 'Custom Deny',
          kind: 'deny_forever' as unknown as PermissionOption['kind'],
        },
      ],
      signal,
    });
    expect(outcome).toEqual({ outcome: 'cancelled' });
  });
});
