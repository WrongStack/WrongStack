import {
  asRecord,
  type EvidenceFinding,
  exists,
  type JsonRecord,
  type ProjectCollectContext,
  type ProjectCollection,
  readJson,
  readText,
  resolveWorkspaces,
} from '../evidence-analyzer/project.js';

const MAX_ENTRIES = 80;
/** Longest doc comment (plus blank/decorator lines) walked back over. */
const MAX_DOC_LINES = 200;
/** Longer lines (minified bundles) are never matched against export rules. */
const MAX_EXPORT_LINE = 2000;
const BUILD_DIR = /^(?:\.\/)?(?:dist|build|lib|out|esm|cjs)\//;

/**
 * Exported declarations without a doc comment directly above them.
 * Decorators and blank lines between the comment and the declaration are
 * allowed; a `//` line comment does not count as public documentation.
 */
export function undocumentedExports(content: string): EvidenceFinding[] {
  const lines = content.split('\n');
  const findings: EvidenceFinding[] = [];
  const declaration =
    /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|const|let|enum|namespace)\s+([A-Za-z_$][\w$]*)/;
  lines.forEach((raw, index) => {
    // Top-level declarations only; minified lines are skipped so the regex
    // never runs over a megabyte-long line.
    if (raw.length > MAX_EXPORT_LINE || !raw.startsWith('export')) return;
    if (!declaration.test(raw)) return;
    // Every walk back is bounded: a stray `*/` with no opener (or a long run
    // of blank lines) must not make a large paste quadratic.
    const floor = Math.max(-1, index - 1 - MAX_DOC_LINES);
    let cursor = index - 1;
    while (
      cursor > floor &&
      (lines[cursor]!.trim() === '' || lines[cursor]!.trim().startsWith('@'))
    )
      cursor -= 1;
    if (cursor > floor && lines[cursor]!.trim().endsWith('*/')) {
      // Walk back to the opening of this block comment; it must be a doc comment.
      let open = cursor;
      while (open > floor && !lines[open]!.includes('/*')) open -= 1;
      if (open > floor && lines[open]!.includes('/**')) return;
    }
    findings.push({
      rule: 'undocumented exported declaration',
      severity: 'warning',
      line: index + 1,
      excerpt: raw.trim().slice(0, 240),
      advice: 'Add a /** */ contract comment: what it does, inputs, failure behaviour.',
    });
  });
  return findings;
}

function exportTargets(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (!value.includes('*')) out.add(value);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const nested of Object.values(record)) exportTargets(nested, out);
}

/** Map a built target to its likely source (`./dist/foo.js` → `src/foo.ts`). */
function sourceCandidates(dir: string, target: string): string[] {
  const clean = target.replace(/^\.\//, '');
  const prefix = dir === '.' ? '' : `${dir}/`;
  if (!BUILD_DIR.test(clean)) return [`${prefix}${clean}`];
  const stem = clean.replace(BUILD_DIR, '').replace(/\.d\.[cm]?ts$|\.[cm]?js$/, '');
  return ['ts', 'tsx', 'mts', 'js', 'mjs'].flatMap((ext) => [
    `${prefix}src/${stem}.${ext}`,
    `${prefix}src/${stem}/index.${ext}`,
  ]);
}

/** Audit the public entry points declared by package manifests. */
export async function collectPublicApi(context: ProjectCollectContext): Promise<ProjectCollection> {
  const { root, signal } = context;
  const rootPkg = await readJson(root, 'package.json');
  if (rootPkg === undefined) {
    throw new Error(
      'public_api_analyze found no package.json at the project root; pass an entry file as path instead',
    );
  }
  const manifests: Array<{ dir: string; pkg: JsonRecord }> = [];
  if (rootPkg) manifests.push({ dir: '.', pkg: rootPkg });
  for (const dir of (await resolveWorkspaces(root, rootPkg)).packages) {
    const pkg = await readJson(root, `${dir}/package.json`);
    // A private package with publishConfig is still published by a release script.
    if (pkg && (pkg['private'] !== true || asRecord(pkg['publishConfig'])))
      manifests.push({ dir, pkg });
  }
  const findings: EvidenceFinding[] = [];
  const entries = new Set<string>();
  for (const { dir, pkg } of manifests) {
    signal.throwIfAborted();
    const file = dir === '.' ? 'package.json' : `${dir}/package.json`;
    const targets = new Set<string>();
    exportTargets(pkg['exports'], targets);
    for (const field of ['main', 'module', 'types', 'typings']) exportTargets(pkg[field], targets);
    for (const target of targets) {
      if (!/\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/.test(target)) continue;
      const candidates = sourceCandidates(dir, target);
      let found: string | undefined;
      for (const candidate of candidates) {
        if (await exists(root, candidate)) {
          found = candidate;
          break;
        }
      }
      if (found) {
        if (!found.endsWith('.d.ts')) entries.add(found);
      } else if (!BUILD_DIR.test(target.replace(/^\.\//, ''))) {
        findings.push({
          rule: 'export map target missing',
          severity: 'error',
          file,
          line: 0,
          excerpt: `${target} is declared but does not exist`,
          advice:
            'Consumers importing this subpath fail at resolution time; fix the path or create the file.',
        });
      }
    }
  }
  const entryList = [...entries].slice(0, MAX_ENTRIES);
  for (const entry of entryList) {
    signal.throwIfAborted();
    const text = await readText(root, entry, 1024 * 1024);
    if (text === null) continue;
    for (const finding of undocumentedExports(text)) findings.push({ ...finding, file: entry });
    text.split('\n').forEach((line, index) => {
      if (line.length <= MAX_EXPORT_LINE && /^export\s.*['"][^'"]*\/internal\//.test(line)) {
        findings.push({
          rule: 'internal path exported',
          severity: 'warning',
          file: entry,
          line: index + 1,
          excerpt: line.trim().slice(0, 240),
          advice: 'Expose a stable facade instead of leaking internal module paths.',
        });
      }
    });
  }
  return {
    findings,
    inspected: entryList,
    facts: {
      publicPackages: manifests.length,
      entryPoints: entries.size,
      ...(entries.size > MAX_ENTRIES ? { auditedEntryPoints: MAX_ENTRIES } : {}),
    },
    limitation:
      'Read entry files mapped from package.json exports/main/types (dist paths mapped to src); re-exported symbols are not followed into their modules.',
  };
}
