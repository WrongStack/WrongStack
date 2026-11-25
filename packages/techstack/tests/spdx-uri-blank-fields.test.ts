import { describe, expect, it } from 'vitest';
import { toSpdx } from '../src/sbom.js';
import type { Snapshot } from '../src/types.js';

describe('toSpdx (F2187)', () => {
  it('URI-encodes snapshot.id and treats whitespace-only purl/license as NOASSERTION', () => {
    const doc = toSpdx({
      id: 'snap 1?x=2#frag',
      projectId: 'p1',
      createdAt: '2026-11-25T00:00:00Z',
      adapterVersion: '1.0.0',
      dependencies: [{ name: 'pkg', purl: '   ', license: '   ' }],
    } as unknown as Snapshot);

    expect(doc.documentNamespace).toBe('https://wrongstack.dev/spdx/snap%201%3Fx%3D2%23frag');
    expect(doc.packages[0]?.downloadLocation).toBe('NOASSERTION');
    expect(doc.packages[0]?.licenseDeclared).toBe('NOASSERTION');
    expect(doc.packages[0]?.licenseConcluded).toBe('NOASSERTION');
  });
});
