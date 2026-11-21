import { describe, expect, it } from 'vitest';
import { parseAuthFlags } from '../src/arg-parser.js';

describe('parseAuthFlags missing-value guard', () => {
  it('does not swallow a following flag when --label, --family, --base-url, or --env has no value', () => {
    const res1 = parseAuthFlags(['openai', '--label', '--audit']);
    expect(res1.label).toBeUndefined();
    expect(res1.audit).toBe(true);

    const res2 = parseAuthFlags(['custom', '--base-url', '--family', 'openai']);
    expect(res2.baseUrl).toBeUndefined();
    expect(res2.family).toBe('openai');
    expect(res2.positional).toEqual(['custom']);

    const res3 = parseAuthFlags(['openai', '--label=-explicit', '--env=KEY_A,KEY_B']);
    expect(res3.label).toBe('-explicit');
    expect(res3.envVars).toEqual(['KEY_A', 'KEY_B']);
  });
});
