import { describe, expect, it } from 'vitest';
import { SpecParser } from '../src/spec-parser.js';

describe('SpecParser HTML comment fence precedence (F1827)', () => {
  const parser = new SpecParser();

  it('ignores code fence markers inside multi-line HTML comments when extracting structure', () => {
    const parsed = parser.parse(
      [
        '<!--',
        '```ts',
        'const draft = true;',
        '-->',
        '# Real Spec Title',
        'Version: 2.3.4',
        '',
        '## Overview',
        'Real overview text.',
        '```md',
        '## Not A Real Section',
        '```',
        '',
        '## Requirements',
        '- [functional] [high] Must parse requirements after commented fence',
      ].join('\n'),
    );

    expect(parsed.title).toBe('Real Spec Title');
    expect(parsed.version).toBe('2.3.4');
    expect(parsed.overview).toContain('Real overview text.');
    expect(parsed.overview).toContain('## Not A Real Section');
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.requirements).toHaveLength(1);
  });

  it('does not let an HTML comment opener inside a real code fence swallow later structure', () => {
    const parsed = parser.parse(
      [
        '```html',
        '<!-- unclosed comment inside code example',
        '```',
        '# After Fence Title',
        'Version: 3.0.0',
        '',
        '## Overview',
        'Visible after fence.',
      ].join('\n'),
    );

    expect(parsed.title).toBe('After Fence Title');
    expect(parsed.version).toBe('3.0.0');
    expect(parsed.overview).toBe('Visible after fence.');
  });
});
