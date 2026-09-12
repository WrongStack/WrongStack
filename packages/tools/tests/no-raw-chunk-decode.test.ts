import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard for the F1/F4 defect class: decoding a raw stream chunk with
 * `toString()` corrupts a multi-byte character that straddles a chunk
 * boundary (each half becomes U+FFFD). Every subprocess/stdout accumulator in
 * this package must use a streaming `StringDecoder` instead — see bash.ts,
 * exec.ts and git.ts for the established pattern.
 *
 * This is a source audit rather than a behavioural test: the affected spawn
 * sites run `rg`/`git`/`patch`/`go`/`python` by bare name and do not let a test
 * choose their chunk boundaries, so the split cannot be forced end-to-end.
 * It fails with the exact file:line of any reintroduced accumulator.
 */

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Accumulator / capture shapes that decode a raw chunk with `toString()`. */
const OFFENDING: RegExp[] = [
  // e.g. `stdout += chunk.toString()` / `stderr += c.toString()`
  /\b\w+\s*\+=\s*(?:c|chunk|stdout|stderr|buf|data)\s*\.toString\(\)/,
  // e.g. `const data = c.toString()` in a stream 'data' handler
  /const\s+data\s*=\s*c\s*\.toString\(\)/,
];

function isCommentOnly(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** True when a source line is a live (non-comment) raw-chunk accumulator. */
function isOffending(line: string): boolean {
  return !isCommentOnly(line) && OFFENDING.some((re) => re.test(line));
}

async function* tsFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* tsFiles(full);
    else if (entry.name.endsWith('.ts')) yield full;
  }
}

describe('stream chunk decoding (F1/F4 regression guard)', () => {
  it('detects the shapes it guards against (and ignores comments and non-chunk toString)', () => {
    for (const sample of [
      '      stdout += chunk.toString();',
      '      stderr += c.toString();',
      '      const data = c.toString();',
      '      buf += chunk.toString();',
    ]) {
      expect(isOffending(sample), `should be flagged: ${sample}`).toBe(true);
    }
    for (const safe of [
      '      stdout += stdoutDecoder.write(chunk);',
      '      stdout += stdoutDecoder.write(c);',
      '        // across two reads, so `chunk.toString()` would decode both',
      '       * halves as U+FFFD. The decoder carries the incomplete sequence into',
      '      const href = url.toString();',
      '      re.lastIndex = 0;',
    ]) {
      expect(isOffending(safe), `should NOT be flagged: ${safe}`).toBe(false);
    }
  });

  it('uses a streaming decoder instead of toString() for every stream chunk', async () => {
    const offenders: string[] = [];
    for await (const file of tsFiles(SRC_DIR)) {
      const lines = (await fs.readFile(file, 'utf8')).split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (isOffending(lines[i] as string)) {
          offenders.push(`${path.relative(SRC_DIR, file).replaceAll('\\', '/')}:${i + 1}`);
        }
      }
    }
    expect(
      offenders,
      'raw chunk.toString() reintroduced — use StringDecoder (see bash.ts / exec.ts / git.ts)',
    ).toEqual([]);
  });
});
