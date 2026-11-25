import { describe, expect, it } from 'vitest';
import { buildCompactionPreview } from '../src/utils/compaction-preview.js';

describe('buildCompactionPreview circular null-prototype guard (F2286)', () => {
  it('handles circular null-prototype tool inputs without throwing TypeError', () => {
    const circ = Object.create(null);
    circ.self = circ;
    const out = buildCompactionPreview({
      role: 'assistant',
      content: [{ type: 'tool_use', id: '1', name: 'bash', input: circ }],
    } as never);
    expect(out).toContain('bash');
  });
});
