/**
 * Contract test: the WebUI's `SageEntry` mirror vs the canonical SAGE model.
 *
 * `packages/webui/src/types/sage.ts` re-declares the Sage memory shape instead
 * of importing it, because `@wrongstack/sage` is a Node-side package and is
 * deliberately NOT a dependency of the browser bundle. A mirror without a guard
 * silently rots: this one had drifted by nine fields (`staleReason`, `useCount`,
 * `injectionCount`, `persistence`, `sources`, `feedback`, `legacyScope`,
 * `ownerSessionId`, `lastUsedAt`) before this test existed — and the UI was
 * already *writing* `persistence` against a type that lacked it.
 *
 * This test parses both files and compares the DECLARED PROPERTY NAMES of the
 * interfaces. Add or remove a field on either side and it fails. That failure
 * is the whole point: it is the feature.
 *
 * Deliberately compares NAMES, not types. The mirror intentionally widens
 * `kind` to `string` so the UI can render kinds sent by other server versions.
 *
 * WHY NOT THE TYPESCRIPT COMPILER API: the repo pins `typescript@7.0.2`, the
 * native (Go) port, which ships no JS parser — `require('typescript')` exposes
 * only `version` and `versionMajorMinor`, and `ts.createSourceFile` is
 * `undefined`. So the scanner below is a hand-written brace-balanced walk. That
 * makes the scanner itself the weak link, so `describe('field scanner')`
 * pins its behaviour on the constructs that actually appear in these files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The mirror moved to the surfaces package shared with the desktop app.
const WEBUI_SAGE_TYPES = path.resolve(HERE, '../../../project-surfaces/src/sage/types.ts');
const CANONICAL_SAGE_MODEL = path.resolve(HERE, '../../../sage/src/memory-model.ts');

/**
 * Replace comments with spaces, preserving length and newlines so that byte
 * offsets into the result still line up with the original source.
 *
 * Needed so a commented-out field, or a `{` inside a doc comment, cannot
 * corrupt the brace walk below.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (two === '/*') {
      while (i < source.length && source.slice(i, i + 2) !== '*/') {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    out += source[i];
    i++;
  }
  return out;
}

/**
 * Index of the first character AFTER the `{` opening `interfaceName`'s body,
 * or `null` when no such interface exists.
 *
 * The `\{` requirement means `Sage` cannot accidentally match `SageAnchor` or
 * `SageStatus`. Comments are already stripped, so a commented-out declaration
 * cannot match either.
 */
function findInterfaceBodyStart(source: string, interfaceName: string): number | null {
  const match = new RegExp(`(?:export\\s+)?interface\\s+${interfaceName}\\s*\\{`).exec(source);
  return match ? match.index + match[0].length : null;
}

/** Opening/closing pairs that nest. `<`/`>` are ignored — see `scanFieldNames`. */
const OPENERS = new Set(['{', '(', '[']);
const CLOSERS = new Set(['}', ')', ']']);

/**
 * Collect the top-level property names of an interface body.
 *
 * `body` starts just after the opening `{` and runs to the end of the file, so
 * the interface's own closing `}` is what drives the depth negative. Anything
 * nested (inline object types, `Array<{...}>`, tuple types) is skipped by depth,
 * so a property whose TYPE is an object still contributes exactly one name.
 *
 * `<`/`>` are deliberately NOT tracked: an untracked `>` in a type position
 * (an arrow function type, for example) would otherwise close the body early.
 * Generic angle brackets are always balanced with their own content nested
 * inside tracked delimiters, so ignoring them is safe for this input.
 */
function scanFieldNames(body: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let memberStart = 0;

  const flush = (end: number) => {
    const member = body.slice(memberStart, end).trim();
    if (!member) return;
    // An index signature (`[key: string]: unknown`) or a call signature is not
    // a named field.
    if (member.startsWith('[') || member.startsWith('(')) return;
    const name = /^([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(member);
    if (name) names.push(name[1]);
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (OPENERS.has(ch)) {
      depth++;
      continue;
    }
    if (CLOSERS.has(ch)) {
      depth--;
      if (depth < 0) {
        // The interface's own closing brace.
        flush(i);
        return names;
      }
      continue;
    }
    if (depth === 0 && (ch === ';' || ch === ',')) {
      flush(i);
      memberStart = i + 1;
    }
  }
  flush(body.length);
  return names;
}

/**
 * Parse `file` and return the sorted, de-duplicated property names of
 * `interfaceName`, or `null` when that interface is absent.
 */
function readInterfaceFields(file: string, interfaceName: string): string[] | null {
  const source = stripComments(fs.readFileSync(file, 'utf8'));
  const bodyStart = findInterfaceBodyStart(source, interfaceName);
  if (bodyStart === null) return null;
  return [...new Set(scanFieldNames(source.slice(bodyStart)))].sort();
}

/** Fields present in `canonical` but absent from `mirror` — the drift we fear. */
function missingFrom(mirror: string[], canonical: string[]): string[] {
  return canonical.filter((field) => !mirror.includes(field));
}

/** Fields in `mirror` that canonical no longer declares — stale leftovers. */
function notInCanonical(mirror: string[], canonical: string[]): string[] {
  return mirror.filter((field) => !canonical.includes(field));
}

// ── The scanner's own tests ───────────────────────────────────────────────
// A guard that silently mis-parses is worse than no guard, so pin the
// constructs that appear in the two files under contract.
describe('SAGE contract field scanner', () => {
  const scan = (src: string) => {
    const bodyStart = findInterfaceBodyStart(stripComments(src), 'Probe');
    expect(bodyStart, 'probe interface not found').not.toBeNull();
    return scanFieldNames(stripComments(src).slice(bodyStart!));
  };

  it('reads plain fields', () => {
    expect(scan('interface Probe {\n  id: string;\n  count: number;\n}')).toEqual(['id', 'count']);
  });

  it('keeps reading past an inline object-typed field', () => {
    // The regression this scanner originally had: it stopped at the first
    // `audience?: { ... }` and dropped every field declared after it. Order
    // matters here — it proves the walk neither stopped nor reordered.
    expect(
      scan(
        'interface Probe {\n' +
          '  id: string;\n' +
          '  audience?: { roles?: string[] } | undefined;\n' +
          '  afterTheObject: number;\n' +
          '}',
      ),
    ).toEqual(['id', 'audience', 'afterTheObject']);
  });

  it('handles optional markers, nested generics and tuples', () => {
    expect(
      scan(
        'interface Probe {\n' +
          '  id: string;\n' +
          '  tags?: string[] | undefined;\n' +
          '  sources?: Array<{ type: string }> | undefined;\n' +
          '  pair: [string, number];\n' +
          '  last: number;\n' +
          '}',
      ),
    ).toEqual(['id', 'tags', 'sources', 'pair', 'last']);
  });

  it('skips index and call signatures', () => {
    expect(scan('interface Probe {\n  [key: string]: unknown;\n  named: boolean;\n}')).toEqual([
      'named',
    ]);
  });

  it('ignores commented-out fields and braces inside comments', () => {
    expect(
      scan(
        'interface Probe {\n' +
          '  /** not a field: { brace in a doc comment } */\n' +
          '  id: string;\n' +
          '  // ghost: number;\n' +
          '  real: boolean;\n' +
          '}',
      ),
    ).toEqual(['id', 'real']);
  });

  it('does not match a longer interface name as a prefix', () => {
    expect(findInterfaceBodyStart('export interface SageAnchor {', 'Sage')).toBeNull();
  });

  it('returns null for an absent interface', () => {
    expect(findInterfaceBodyStart('export interface Other { a: string }', 'Probe')).toBeNull();
  });
});

// ── The contract itself ───────────────────────────────────────────────────
describe('SAGE WebUI type mirror contract', () => {
  it('locates both sides of the contract', () => {
    expect(fs.existsSync(WEBUI_SAGE_TYPES)).toBe(true);
    expect(fs.existsSync(CANONICAL_SAGE_MODEL)).toBe(true);
  });

  it('mirrors every field of the canonical Sage interface', () => {
    const canonical = readInterfaceFields(CANONICAL_SAGE_MODEL, 'Sage');
    const mirror = readInterfaceFields(WEBUI_SAGE_TYPES, 'SageEntry');

    expect(canonical, 'canonical `Sage` interface not found in memory-model.ts').not.toBeNull();
    expect(mirror, '`SageEntry` interface not found in webui types/sage.ts').not.toBeNull();

    // Anchors the comparison itself: a renamed/renamed-away interface on
    // either side shows up here rather than as a confusing empty diff.
    expect(canonical).toEqual(expect.arrayContaining(['id', 'text', 'status', 'anchors']));
    expect(mirror).toEqual(expect.arrayContaining(['id', 'text', 'status', 'anchors']));
    expect(missingFrom(mirror!, canonical!)).toEqual([]);
  });

  it('mirrors every field of the canonical MemoryAnchor interface', () => {
    const canonical = readInterfaceFields(CANONICAL_SAGE_MODEL, 'MemoryAnchor');
    const mirror = readInterfaceFields(WEBUI_SAGE_TYPES, 'SageAnchor');

    expect(canonical, 'canonical `MemoryAnchor` not found in memory-model.ts').not.toBeNull();
    expect(mirror, '`SageAnchor` interface not found in webui types/sage.ts').not.toBeNull();

    expect(missingFrom(mirror!, canonical!)).toEqual([]);
  });

  it('carries no fields the canonical model no longer declares', () => {
    // The other direction: renaming a field in sage would otherwise leave a
    // dead field in the mirror that nothing ever populates.
    const canonicalSage = readInterfaceFields(CANONICAL_SAGE_MODEL, 'Sage');
    const mirrorSage = readInterfaceFields(WEBUI_SAGE_TYPES, 'SageEntry');
    expect(notInCanonical(mirrorSage!, canonicalSage!)).toEqual([]);

    const canonicalAnchor = readInterfaceFields(CANONICAL_SAGE_MODEL, 'MemoryAnchor');
    const mirrorAnchor = readInterfaceFields(WEBUI_SAGE_TYPES, 'SageAnchor');
    expect(notInCanonical(mirrorAnchor!, canonicalAnchor!)).toEqual([]);
  });

  it('exposes the fields the Memory views depend on', () => {
    // The specific drift this contract was written for. Named explicitly so a
    // future refactor that drops one fails with a clear message rather than a
    // generic field-set diff.
    const mirror = readInterfaceFields(WEBUI_SAGE_TYPES, 'SageEntry') ?? [];
    for (const field of [
      'staleReason',
      'useCount',
      'injectionCount',
      'persistence',
      'lastUsedAt',
      'ownerSessionId',
    ]) {
      expect(mirror, `SageEntry is missing "${field}"`).toContain(field);
    }
  });
});
