/**
 * Architecture gate: no file outside `packages/tools/src/_util.ts` may resolve
 * a TOOL-INPUT path with a bare `path.isAbsolute(<input>…)` passthrough.
 *
 * Security report 2026-09-01, Phase 3 item 13 (would have caught all four
 * path-confinement findings VF-06/VF-07): every one of the four tools that
 * resolved input paths this way skipped the realpath containment check its
 * 29 sibling file tools route through (`safeResolveReal`), because
 * `path.isAbsolute(x) ? x : path.resolve(root, x)` *looks* like a resolve
 * while being an escape hatch — an absolute or `../` input walks straight
 * out of the project root.
 *
 * The sanctioned resolvers live in `_util.ts`:
 *   - `safeResolveReal(input, ctx)` — session-cwd-relative + containment
 *     (the edit/grep/glob family contract);
 *   - `safeResolveProjectPath(input, ctx)` — project-root-relative +
 *     containment (the codebase-tool schema contract).
 *
 * A new tool that needs different semantics extends `_util.ts`, where the
 * containment logic is reviewed once — not its own private passthrough.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Module-relative so the suite passes from any vitest root.
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const PACKAGES = path.join(REPO_ROOT, 'packages');

/** The only file allowed to branch on `path.isAbsolute(<input>…)`, each with
 *  the reason its own containment makes the branch safe. Anything else is
 *  drift: route through safeResolveReal / safeResolveProjectPath. */
const ALLOWED_FILES: Record<string, string> = {
  'tools/src/_util.ts':
    'Home of the sanctioned resolvers (safeResolveReal / safeResolveProjectPath) — the branch IS the containment layer.',
  // Direct test callers pass relative paths; the only production caller
  // (codebase-ast-replace-tool) routes through safeResolveProjectPath first,
  // so opts.file arrives canonical and absolute.
  'tools/src/codebase-index/ast-symbol-mutator.ts':
    'Fallback resolve serves direct test callers only; the tool layer pre-validates via safeResolveProjectPath, so agent input never reaches this branch unchecked.',
  // detect.ts resolves options.cwd then feeds it to canonicalInside (its own
  // syntactic + realpath containment) before any filesystem use.
  'tools/src/languages/detect.ts':
    'cwd is re-contained via canonicalInside(…, projectRoot) immediately after the branch — the resolve is not used unchecked.',
  // plan.ts resolves workspace/target only to COMPARE against detected
  // candidate roots; the resolved values are match keys, not open targets.
  'tools/src/languages/plan.ts':
    'workspace/target resolves are comparison keys against detected candidate roots, never opened; cwd feeds the same detection pipeline as detect.ts.',
  // shell-open has its own layered containment (metachar guard, lexical
  // containment, realpath canonicalization) documented in-file.
  'webui-server/src/server/shell-open.ts':
    'Has its own layered containment (metachar guard → lexical containment → realpath canonicalization); webui-server cannot import the tools-private _util resolvers.',
};

/** Tool-input objects whose paths tempt a bare isAbsolute passthrough. */
const INPUT_ISABSOLUTE_RE =
  /path\.isAbsolute\(\s*(?:input|opts|opt|arg|params|options|req|msg|payload)\./;

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts'))
      out.push(full);
  }
  return out;
}

async function packageSources(): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(PACKAGES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = path.join(PACKAGES, entry.name, 'src');
    try {
      const stat = await fs.stat(src);
      if (stat.isDirectory()) await walk(src, out);
    } catch {
      // package without a src/ dir
    }
  }
  return out;
}

describe('tool-input path resolution convention (path.isAbsolute)', () => {
  it('no tool resolves input paths with a bare isAbsolute passthrough outside _util.ts', async () => {
    const offenders: string[] = [];
    const files = await packageSources();
    for (const file of files) {
      const rel = path.relative(PACKAGES, file).split(path.sep).join('/');
      if (ALLOWED_FILES[rel] !== undefined) continue;
      const text = await fs.readFile(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
        if (INPUT_ISABSOLUTE_RE.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `these files branch on path.isAbsolute(<input>…) — the exact shape that let ` +
        `absolute/../ tool input escape the project root (VF-06/VF-07). Route ` +
        `through safeResolveReal or safeResolveProjectPath in packages/tools/src/_util.ts, ` +
        `or extend that file if the semantics are genuinely new: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('the allowed-file reasons have no stale entries', async () => {
    const files = await packageSources();
    for (const [rel, reason] of Object.entries(ALLOWED_FILES)) {
      expect(reason.length, `${rel} needs a stated reason`).toBeGreaterThan(10);
      const file = path.join(PACKAGES, ...rel.split('/'));
      const exists = files.some((f) => f === file);
      expect(exists, `${rel} no longer exists — drop the entry`).toBe(true);
      // If the file stopped containing the pattern, the exemption is stale.
      const text = await fs.readFile(file, 'utf8');
      expect(
        text.includes('path.isAbsolute('),
        `${rel} no longer branches on path.isAbsolute — drop it from ALLOWED_FILES`,
      ).toBe(true);
    }
  });

  it('the allowed file still contains the sanctioned resolvers (non-vacuous gate)', async () => {
    const util = await fs.readFile(path.join(PACKAGES, 'tools', 'src', '_util.ts'), 'utf8');
    expect(util).toContain('export async function safeResolveReal');
    expect(util).toContain('export async function safeResolveProjectPath');
    // And it is itself the pattern's home — if it stops being so, the
    // ALLOWED_FILES entry is stale. (The ban regex narrows to `<input>.<prop>`
    // shapes; the helper's bare-parameter form is checked directly here.)
    expect(util).toContain('path.isAbsolute(input');
    expect(util).toContain('path.isAbsolute(');
  });
});
