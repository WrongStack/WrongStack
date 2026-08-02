import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, '../src/lib/sage-block.ts'), 'utf8');
const canonicalSource = readFileSync(
  resolve(import.meta.dirname, '../../core/src/utils/sage-output-block.ts'),
  'utf8',
);

/** Pull a literal out of source text, so assertions compare both maintained copies. */
function extractLiteral(name: string, text: string): string {
  const match = new RegExp(`const ${name} =\\s*([^;]+);`).exec(text);
  expect(match, `${name} must exist in source`).not.toBeNull();
  return match![1]!.trim();
}

function headingSet(text: string): string[] {
  return [...text.matchAll(/'(--- SAGE: [^']+ ---)'/g)].map((match) => match[1]!).sort();
}

/**
 * SimpleUI deliberately ships WITHOUT a @wrongstack/core dependency (it is a
 * self-contained browser bundle), so the SAGE suffix splitter stays a local
 * copy instead of importing the canonical core parser. This drift test mirrors
 * the image-attachment-limits pattern: it fails when the SimpleUI copy stops
 * matching `packages/core/src/utils/sage-output-block.ts`.
 */
describe('SimpleUI SAGE block splitter stays in sync with the canonical core parser (2026-08-02)', () => {
  it('keeps the same injected headings as core', () => {
    expect(headingSet(source)).toEqual(headingSet(canonicalSource));
  });

  it('keeps the same memory-line regexes as core', () => {
    expect(extractLiteral('SAGE_MEMORY_LINE', source)).toBe(
      extractLiteral('SAGE_MEMORY_LINE', canonicalSource),
    );
    expect(extractLiteral('SAGE_MEMORY_LINE_TRUNCATED', source)).toBe(
      extractLiteral('SAGE_MEMORY_LINE_TRUNCATED', canonicalSource),
    );
  });
});
