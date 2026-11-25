import { describe, expect, it } from 'vitest';
import { parseChatGPTAppQuota } from '../src/chatgpt-account-quota.js';

describe('parseChatGPTAppQuota integer resetsAt', () => {
  it('floors fractional reset_after_seconds to whole epoch seconds', () => {
    const snaps = parseChatGPTAppQuota('openai', 'client-1', {
      items: [
        {
          id: 'client-1',
          windows: [
            {
              used_percent: 25,
              limit_window_seconds: 3600,
              reset_after_seconds: 12.7,
            },
          ],
        },
      ],
    });
    expect(Number.isInteger(snaps[0]?.windows[0]?.resetsAt)).toBe(true);
  });
});
