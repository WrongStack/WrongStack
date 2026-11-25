import { describe, expect, it } from 'vitest';
import { triageCandidates } from '../src/research/triage.js';

describe('triageCandidates prototype-key guard', () => {
  it('ignores inherited Object.prototype keys in dependency status', () => {
    const out = triageCandidates([
      {
        ecosystem: 'npm',
        name: 'evil-pkg',
        status: 'toString' as never,
        direct: true,
        scope: 'runtime',
      } as never,
      {
        ecosystem: 'npm',
        name: 'real-vuln',
        status: 'vulnerable',
        direct: true,
        scope: 'runtime',
      } as never,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.dependency.name).toBe('real-vuln');
  });
});
