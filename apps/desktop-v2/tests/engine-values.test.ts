import { describe, expect, it } from 'vitest';
import { byteText, durationText, markdownExcerpt } from '../src/engine-values';

describe('engine values in words', () => {
  it('reads Markdown as one line of plain text for previews', () => {
    expect(
      markdownExcerpt(
        '## Plan\n\n**Ship** the _fix_ now. See [docs](https://x.y/z) and `npm test`.\n\n- one\n- [x] two\n1. three',
      ),
    ).toBe('Plan · Ship the fix now. See docs and npm test. one two three');
    expect(markdownExcerpt('# Investigation\nPlease review.')).toBe(
      'Investigation · Please review.',
    );
    expect(markdownExcerpt('# Done.\nShipped.')).toBe('Done. Shipped.');
    expect(markdownExcerpt('Text\n\n## Trailing')).toBe('Text Trailing');
    expect(markdownExcerpt('## Closed ##\nBody')).toBe('Closed · Body');
    // Long blank runs stay linear and outside the preview window.
    expect(markdownExcerpt(`#${' '.repeat(20_000)}x\n${'\t'.repeat(20_000)}`)).toBe('');
    expect(markdownExcerpt('```ts\nconst a = 1;\n```\nDone.')).toBe('const a = 1; Done.');
    expect(markdownExcerpt('| a | b |\n|---|:-:|\n| 1 | 2 |')).toBe('a b 1 2');
    expect(markdownExcerpt('snake_case_name and 2*3*4 stay')).toBe(
      'snake_case_name and 2*3*4 stay',
    );
    expect(markdownExcerpt('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('states sizes in binary units and spans in the largest unit', () => {
    expect(byteText(512, 'en')).toBe('512 B');
    expect(byteText(1024, 'en')).toBe('1 KiB');
    expect(byteText(64 * 1024 * 1024, 'en')).toBe('64 MiB');
    expect(byteText(1536, 'de')).toBe('1,5 KiB');
    expect(durationText(600_000, 'en')).toBe('10 min');
    expect(durationText(10_000, 'en')).toBe('10 sec');
  });
});
