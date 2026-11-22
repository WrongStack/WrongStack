import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Raw NUL (U+0000) bytes make a source file binary to git, ripgrep, and text
// readers: diffs become unreviewable and formatters skip the file. Write
// separators as the \u0000 escape sequence instead (sweep r2-nul-source-sweep,
// 2026-09-15).
const FILES = ['../../codebase/src/writer-mutations.ts'];

describe('source hygiene: no raw NUL bytes', () => {
  for (const rel of FILES) {
    it(`${rel} contains no raw NUL bytes`, () => {
      const bytes = readFileSync(fileURLToPath(new URL(rel, import.meta.url)));
      expect(
        bytes.includes(0),
        `raw NUL byte in ${rel} — write the separator as the \\u0000 escape, not a literal U+0000`,
      ).toBe(false);
    });
  }
});
