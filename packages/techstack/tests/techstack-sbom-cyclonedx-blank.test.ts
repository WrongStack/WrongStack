import { describe, expect, it } from 'vitest';
import { toCycloneDX } from '../src/sbom.js';

describe('toCycloneDX whitespace trimming', () => {
  it('omits whitespace-only purl and license fields and trims valid values', () => {
    const bom = toCycloneDX({
      id: 's1',
      projectId: 'p1',
      createdAt: '2026-01-01T00:00:00Z',
      adapterVersion: '1.0.0',
      dependencies: [
        {
          id: 'd1',
          workspaceId: 'w1',
          ecosystem: 'npm',
          name: 'foo',
          direct: true,
          status: 'ok',
          purl: '   ',
          license: '   ',
        },
        {
          id: 'd2',
          workspaceId: 'w1',
          ecosystem: 'npm',
          name: 'bar',
          direct: true,
          status: 'ok',
          purl: '  pkg:npm/bar@1.0.0  ',
          license: ' MIT ',
        },
      ],
    } as never);

    expect(bom.components[0]?.purl).toBeUndefined();
    expect(bom.components[0]?.licenses).toBeUndefined();
    expect(bom.components[1]?.purl).toBe('pkg:npm/bar@1.0.0');
    expect(bom.components[1]?.licenses).toEqual([{ license: { id: 'MIT' } }]);
  });
});
