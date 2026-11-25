import { describe, expect, it } from 'vitest';
import { HqBootstrapCodeStore } from '../src/bootstrap-store.js';

describe('HqBootstrapCodeStore capabilities isolation (F2226)', () => {
  it('clones capabilities array on issue so caller mutations cannot escalate stored privileges', () => {
    const store = new HqBootstrapCodeStore();
    const caps = ['read'];
    const code = store.issue({ tokenId: 'tok-1', capabilities: caps });
    caps.push('admin');
    const entry = store.consume(code);
    expect(entry?.capabilities).toEqual(['read']);
  });
});
