import { describe, expect, it } from 'vitest';
import { SpecParser } from '../src/spec-parser.js';

describe('SpecParser empty tag-only requirement guard (F1998)', () => {
  it('skips lines that leave an empty description after stripping tags', () => {
    const parser = new SpecParser();
    const spec = parser.parse(
      '# Spec\n\n## Requirements\n[security] [high]\n- [security] Real requirement\n',
    );
    expect(spec.requirements).toHaveLength(1);
    expect(spec.requirements[0]?.description).toContain('Real requirement');
  });
});
