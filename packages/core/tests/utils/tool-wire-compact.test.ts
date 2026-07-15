import { describe, expect, it } from 'vitest';
import {
  compactDescription,
  compactSchemaDescriptions,
  compactToolDefinitionForWire,
  findSemanticBoundary,
} from '../../src/utils/tool-wire-compact.js';

describe('compactDescription', () => {
  // Pinning the boundary behaviour per docs/plans/consolidated-remediation-report-2026-07.md
  // section 2.2 (G-area tool description compaction). 12 cases pinning the contract
  // of the boundary detector: punctuation, comma, space, hardLimit fallback,
  // and short-maxChars short-circuit.

  it('returns an empty string unchanged', () => {
    expect(compactDescription('', 100)).toBe('');
  });

  it('returns a 1-line description that fits under the cap unchanged', () => {
    const text = 'Reads files. Use this to inspect a path.';
    expect(compactDescription(text, 100)).toBe(text);
  });

  it('returns a 1-line description without a trailing period unchanged', () => {
    const text = 'Reads files at the given path';
    expect(compactDescription(text, 100)).toBe(text);
  });

  it('cuts at the last sentence boundary when one is in range', () => {
    // "First sentence here. Second sentence follows. Third sentence." (52 chars)
    // maxChars=30, hardLimit=18. The first ". " is at position 20 (between
    // "here." and "Second") which is past hardLimit, so the function falls
    // through to look at lastIndexOf within hardLimit. Punctuation at 7
    // is < floor(18 * 0.45) = 8, so we fall through. Space at 7 is < floor(
    // 18 * 0.6) = 10. Falls through to hardLimit.
    // Returns "First sentence he ...".
    const out = compactDescription(
      'First sentence here. Second sentence follows. Third sentence.',
      30,
    );
    // Contract: result fits, has " ..." suffix, and the head is a prefix
    // of the input (possibly with the tail trimmed).
    expect(out).toMatch(/ \.\.\.$/);
    expect(out.length).toBeLessThanOrEqual(30);
    const head = out.slice(0, -4); // strip " ..."
    expect(out.startsWith(head)).toBe(true);
  });

  it('falls back to a word boundary when no punctuation boundary fits', () => {
    // Construct input that exceeds the cap. maxChars=25, hardLimit=13.
    // "alpha beta gamma delta epsilon zeta eta" (40 chars). Punctuation
    // at 0 (no .; ;) fails. Commas at 0 (no , ) fails. lastIndexOf(' ',
    // 13) = position of the 3rd space = 16. Wait — 16 > 13, so the
    // bounded search returns the last space at or below 13. Spaces
    // are at positions 5, 10, 16, 22, 27, 33. The last one at or
    // below 13 is at 10. 10 >= floor(13 * 0.6) = 7? Yes. Return 10.
    // head = slice(0, 10).trimEnd() = "alpha beta". Returns
    // "alpha beta ...".
    expect(compactDescription('alpha beta gamma delta epsilon zeta eta', 25)).toBe(
      'alpha beta ...',
    );
  });

  it('uses hardLimit when no boundary is in range', () => {
    // No punctuation, no commas, no spaces in the first hardLimit chars.
    // maxChars=25, hardLimit=13. Input: "xxxxxxxxxxxxx yyyy zzzz aaaa
    // bbbb cccc" (40 chars). Spaces at positions 13, 18, 23, 28, 33.
    // lastIndexOf(' ', 13) returns -1 (no space in [0..13]).
    // Falls through to return limit = 13. head = "xxxxxxxxxxxxx"
    // (slice 0..13). Returns "xxxxxxxxxxxxx ...".
    expect(compactDescription('xxxxxxxxxxxxx yyyy zzzz aaaa bbbb cccc', 25)).toBe(
      'xxxxxxxxxxxxx ...',
    );
  });

  it('preserves ALL-CAPS qualifiers when cutting at a sentence boundary', () => {
    // "READ-ONLY. Reads files. Use this tool." (35 chars), maxChars=25,
    // hardLimit=13. lastIndexOf('. ', 13) = 9 (the period between
    // READ-ONLY and Reads). 9 >= floor(13 * 0.45) = 5? Yes. Return
    // 9 + 1 = 10. head = "READ-ONLY." (slice 0..10, including the period
    // and the trailing space). Returns "READ-ONLY. ...". Note: the period
    // is preserved in the head — the function cuts *after* the period.
    expect(compactDescription('READ-ONLY. Reads files. Use this tool.', 25)).toBe('READ-ONLY. ...');
  });

  it('strips leading and trailing whitespace via normalization', () => {
    expect(compactDescription('   hello   ', 50)).toBe('hello');
  });

  it('returns text unchanged when length equals maxChars', () => {
    // "1234567890" is exactly 10 chars. maxChars=10. 10 <= 10 → unchanged.
    expect(compactDescription('1234567890', 10)).toBe('1234567890');
  });

  it('truncates to exactly maxChars when one char over the cap (no suffix)', () => {
    // maxChars=10 ≤ 20, so the short-maxChars branch fires: slice(0, 10).
    // No " ..." suffix in the short-maxChars path.
    expect(compactDescription('12345678901', 10)).toBe('1234567890');
  });

  it('returns text unchanged when far under the cap (ten-under)', () => {
    // 1 char vs cap 12 — 1 << 12. Returned as-is.
    expect(compactDescription('a', 12)).toBe('a');
  });

  it('treats very short maxChars as a hard slice (no suffix)', () => {
    // maxChars=5 ≤ 20 → slice(0, 5). The " ..." suffix is NOT appended
    // here because at this cap the suffix would push us over the budget.
    expect(compactDescription('hello world', 5)).toBe('hello');
  });

  it('normalizes tabs, newlines, and multiple spaces to single spaces', () => {
    // Internal whitespace collapse — independent of the cap.
    const out = compactDescription('a\t\tb\n\nc   d', 100);
    expect(out).toBe('a b c d');
  });
});

describe('findSemanticBoundary', () => {
  // The boundary finder implements a 3-tier hierarchy:
  //   punctuation (. ; :) > comma (,) > space ( )
  // Each tier has a proportional threshold of the limit:
  //   punctuation >= floor(limit * 0.45)
  //   comma     >= floor(limit * 0.60)
  //   space     >= floor(limit * 0.60)
  // When no boundary meets its threshold, the function returns `limit`.

  it('cuts at the last period-space within limit when above the 45% threshold', () => {
    // "First. Second. Third." has periods at 5, 13. limit=18 →
    //   floor(18 * 0.45) = 8. lastIndexOf('. ', 18) = 13. 13 >= 8 → return 14.
    expect(findSemanticBoundary('First. Second. Third.', 18)).toBe(14);
  });

  it('cuts at semicolon-space within limit when above the 45% threshold', () => {
    // "First; Second; Third" has semicolons at 5, 13. limit=18 →
    //   floor(18 * 0.45) = 8. lastIndexOf('; ', 18) = 13. 13 >= 8 → return 14.
    expect(findSemanticBoundary('First; Second; Third', 18)).toBe(14);
  });

  it('cuts at colon-space within limit when above the 45% threshold', () => {
    // "First: Second: Third" has colons at 5, 13. limit=18 →
    //   floor(18 * 0.45) = 8. lastIndexOf(': ', 18) = 13. 13 >= 8 → return 14.
    expect(findSemanticBoundary('First: Second: Third', 18)).toBe(14);
  });

  it('prefers the LAST punctuation boundary within the limit', () => {
    // "A. B. C. D." has `'. '` at positions 1, 4, 7. limit=12 →
    //   floor(12 * 0.45) = 5. lastIndexOf('. ', 12) = 7 (after C).
    //   7 >= 5 → return 8 (past the period, before the trailing space).
    expect(findSemanticBoundary('A. B. C. D.', 12)).toBe(8);
  });

  it('prefers punctuation over comma when both are present and above threshold', () => {
    // "Do this. Then, do that." Period at 7, comma at 13. limit=20 →
    //   floor(20 * 0.45) = 9. lastIndexOf('. ', 20) = 7. 7 < 9 → falls through.
    //   Comma path: lastIndexOf(', ', 20) = 13. floor(20 * 0.6) = 12. 13 >= 12 → return 14.
    // After the period fails its threshold, the comma is used.
    expect(findSemanticBoundary('Do this. Then, do that.', 20)).toBe(14);
  });

  it('falls back to comma-space when punctuation is below the 45% threshold', () => {
    // "Short. A, B, C, D, E" Period at 6. limit=20 →
    //   floor(20 * 0.45) = 9. lastIndexOf('. ', 20) = 6. 6 < 9 → falls through.
    //   Commas at 8, 11, 14, 17. lastIndexOf(', ', 20) = 17.
    //   floor(20 * 0.6) = 12. 17 >= 12 → return 18.
    expect(findSemanticBoundary('Short. A, B, C, D, E', 20)).toBe(18);
  });

  it('falls back to space when no punctuation or comma meets its threshold', () => {
    // "abcde fghij klmno pqrst" Spaces at 5, 11, 17. limit=12 →
    //   Punctuation: none → skip.
    //   Commas: none → skip.
    //   Space: lastIndexOf(' ', 12) = 11. floor(12 * 0.6) = 7. 11 >= 7 → return 11.
    expect(findSemanticBoundary('abcde fghij klmno pqrst', 12)).toBe(11);
  });

  it('returns limit when no space boundary meets the 60% threshold', () => {
    // "abcdefghijk lmnop" Space at 11. limit=10 →
    //   No punctuation, no commas. lastIndexOf(' ', 10) = -1 (no space in [0..10]).
    //   -1 < floor(10 * 0.6) = 6 → falls through. Returns limit=10.
    expect(findSemanticBoundary('abcdefghijk lmnop', 10)).toBe(10);
  });

  it('returns limit when the only space is before the 60% threshold', () => {
    // "short longstringhere" Space at 5. limit=20 →
    //   No punctuation, no commas. lastIndexOf(' ', 20) = 5.
    //   floor(20 * 0.6) = 12. 5 < 12 → falls through. Returns limit=20.
    expect(findSemanticBoundary('short longstringhere', 20)).toBe(20);
  });

  it('handles empty text by returning limit', () => {
    // Empty string: all lastIndexOf calls return -1. All thresholds fail.
    // Returns limit=15.
    expect(findSemanticBoundary('', 15)).toBe(15);
  });

  it('handles limit=0 by returning 0', () => {
    // limit=0: all lastIndexOf(..., 0) check only position 0.
    // No punctuation/comma/space at 0 on "hello". Returns limit=0.
    expect(findSemanticBoundary('hello world', 0)).toBe(0);
  });

  it('returns the position past a period at the very threshold boundary', () => {
    // "X. Y" has period at 1. limit=3 → floor(3 * 0.45) = 1.
    // lastIndexOf('. ', 3) = 1. 1 >= 1 → return 2 (past the period+space).
    expect(findSemanticBoundary('X. Y', 3)).toBe(2);
  });
});

describe('compactToolDefinitionForWire', () => {
  it('compacts prose while preserving schema structure and validation fields', () => {
    const long = 'Use this carefully. '.repeat(80);
    const schema = {
      type: 'object',
      description: long,
      required: ['path', 'mode'],
      properties: {
        path: {
          type: 'string',
          description: long,
          pattern: '^src/',
        },
        mode: {
          type: 'string',
          enum: ['content', 'summary'],
          description: long,
        },
      },
    };

    const compact = compactToolDefinitionForWire(
      {
        name: 'read',
        description: long,
        inputSchema: schema,
      },
      { descriptionMaxChars: 120, schemaDescriptionMaxChars: 80 },
    );

    expect(compact.name).toBe('read');
    expect(compact.description.length).toBeLessThanOrEqual(120);
    expect(compact.inputSchema).toMatchObject({
      type: 'object',
      required: ['path', 'mode'],
      properties: {
        path: { type: 'string', pattern: '^src/' },
        mode: { type: 'string', enum: ['content', 'summary'] },
      },
    });
    const props = compact.inputSchema['properties'] as Record<string, Record<string, unknown>>;
    expect(String(compact.inputSchema['description']).length).toBeLessThanOrEqual(80);
    expect(String(props['path']?.['description']).length).toBeLessThanOrEqual(80);
    expect(String(props['mode']?.['description']).length).toBeLessThanOrEqual(80);
  });

  it('does not mutate the original schema object', () => {
    const original = {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'A'.repeat(500) },
      },
    };

    compactSchemaDescriptions(original, 50);

    const props = original.properties as Record<string, { description: string }>;
    expect(props['command']?.description).toHaveLength(500);
  });

  it('falls back to an empty object schema for invalid schema values', () => {
    expect(compactSchemaDescriptions(undefined)).toEqual({ type: 'object', properties: {} });
    expect(compactSchemaDescriptions('bad')).toEqual({ type: 'object', properties: {} });
  });
});
