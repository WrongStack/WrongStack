import { describe, expect, it } from 'vitest';
import { parseAnthropicRateLimitHeaders } from '../src/anthropic-rate-limits.js';

describe('parseAnthropicRateLimitHeaders (F2173)', () => {
  it('omits resetsAt when sub-second header truncates to 0', () => {
    const h1 = new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.5',
      'anthropic-ratelimit-unified-5h-reset': '0.5',
    });
    const s1 = parseAnthropicRateLimitHeaders('anthropic', h1, 1_700_000_000_000);
    expect(s1[0]?.windows[0]?.resetsAt).toBeUndefined();

    const h2 = new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.5',
      'anthropic-ratelimit-unified-5h-reset': '1700001000.9',
    });
    const s2 = parseAnthropicRateLimitHeaders('anthropic', h2, 1_700_000_000_000);
    expect(s2[0]?.windows[0]?.resetsAt).toBe(1_700_001_000);
  });
});
