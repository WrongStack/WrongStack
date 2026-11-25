import { describe, expect, it } from 'vitest';
import { VerdictCache } from '../src/adversary-mode/evaluator.js';

describe('VerdictCache non-finite timestamp guard (F1976)', () => {
  it('does not create immortal entries when set receives NaN timestamp', () => {
    const cache = new VerdictCache();
    cache.set('k', { verdict: 'ALLOW', reason: 'ok' }, Number.NaN);
    const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000;
    expect(cache.get('k', farFuture)).toBeNull();
  });

  it('still serves valid unexpired entries', () => {
    const cache = new VerdictCache();
    cache.set('k', { verdict: 'BLOCK', reason: 'no' }, 1000);
    expect(cache.get('k', 2000)?.verdict).toBe('BLOCK');
  });
});
