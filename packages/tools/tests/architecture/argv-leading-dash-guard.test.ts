/**
 * S9 (architecture): every tool that builds an argv by spreading a
 * model-controlled array of paths/refs (`input.a`, `input.b`, `input.files`,
 * etc.) MUST guard against leading-dash entries. Without the guard, a
 * payload like `--config=.cache/evil.js` is parsed as a CLI option by
 * eslint/prettier, and `--output=…` is parsed as a git option, both
 * ending in code execution (C1, H-5, AT-01, etc.).
 *
 * This test greps for the two patterns together and fails the build if
 * a future tool ships the spread without the guard. It runs at test
 * time, not at lint time, so it can use Node's `fs` and `path` modules
 * without a Biome plugin.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_SRC = path.resolve(__dirname, '../../src');

// Match `args.push(...<model-controlled-array>)`. The variable on the
// right is anything that flows from the tool's `input` — common names
// are `files`, `a`, `b`, `args` (in nested callers), `paths`.
const SPREAD_RE = /args\.push\(\s*\.\.\.([A-Za-z_][A-Za-z0-9_]*)/g;

function listSourceFiles(): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(TOOLS_SRC, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    out.push(path.join(TOOLS_SRC, entry.name));
  }
  return out;
}

describe('S9: argv-building tools guard against leading-dash injection', () => {
  for (const file of listSourceFiles()) {
    const content = fs.readFileSync(file, 'utf8');
    const spreads: string[] = [];
    for (const m of content.matchAll(SPREAD_RE)) {
      spreads.push(m[1] ?? '');
    }
    if (spreads.length === 0) continue;

    it(`${path.basename(file)} guards spread vars: ${[...new Set(spreads)].join(', ')}`, () => {
      // Heuristic: every spread var must be filtered/checked for
      // `startsWith('-')` *somewhere* in the same file. We accept both
      // the strict literal `'-'` and the escape `'\-'` so a future
      // refactor to a single-quoted string does not break the test.
      for (const v of new Set(spreads)) {
        const guardRe = new RegExp(
          `(?:\\.filter\\([^)]*\\b${v}\\b[^)]*\\bstartsWith\\s*\\(\\s*['"]\\\\?-|\\bstartsWith\\s*\\(\\s*['"]\\\\?-[^'"]*['"]\\s*\\)[^;]*;.*\\b${v}\\b)`,
          's',
        );
        expect(
          guardRe.test(content),
          `file ${path.basename(file)} spreads ...${v} into argv without a leading-dash guard — see C1 (CMDI-005) / H-5 (API-011) / AT-01 for the pattern of bugs this prevents`,
        ).toBe(true);
      }
    });
  }
});
