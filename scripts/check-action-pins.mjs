#!/usr/bin/env bun
/**
 * Fail if a GitHub Actions `uses:` reference is not pinned to a commit SHA.
 *
 * A tag (`@v4`) or a branch (`@main`) can be moved to other code after the
 * workflow was reviewed, and a workflow with write access (release, pages,
 * attestations) then runs whatever the ref points at. Every action in this
 * repository is pinned to a full commit SHA with the tag as a comment
 * (WS-041, SECURITY.md) — this check keeps it that way, because nothing else
 * did: the policy was a habit, and the next `@v5` would have passed review.
 *
 * Pinned:  40 or 64 hex characters after `@`.
 * Exempt:  a local action (`./.github/actions/x`) and a container
 *          (`docker://image`), which have no commit to pin.
 *
 * Scans `.github/workflows/*.y{a,}ml` and `.github/actions/<name>/action.y{a,}ml`.
 *
 *   node scripts/check-action-pins.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** `uses: owner/repo[/path]@ref`, quoted or not, as a step or a job (`- uses:` too). */
const USES_RE = /^\s*(?:-\s+)?uses:\s*['"]?([^'"\s#]+)['"]?/;
const PINNED_REF = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * @param {string} dir
 * @returns {string[]}
 */
function yamlFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join(dir, f));
}

/**
 * @param {string} root
 * @returns {string[]}
 */
export function workflowFiles(root) {
  const files = yamlFiles(join(root, '.github', 'workflows'));
  const actionsDir = join(root, '.github', 'actions');
  if (existsSync(actionsDir)) {
    for (const entry of readdirSync(actionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const name of ['action.yml', 'action.yaml']) {
        const p = join(actionsDir, entry.name, name);
        if (existsSync(p)) files.push(p);
      }
    }
  }
  return files;
}

/**
 * Every unpinned `uses:` of one file.
 * @param {string} text
 * @returns {Array<{ line: number; ref: string }>}
 */
export function unpinnedUses(text) {
  const found = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    const m = USES_RE.exec(line);
    if (!m) continue;
    const target = m[1];
    if (target.startsWith('./') || target.startsWith('docker://')) continue;
    const at = target.lastIndexOf('@');
    const ref = at >= 0 ? target.slice(at + 1) : '';
    if (!PINNED_REF.test(ref)) found.push({ line: i + 1, ref: target });
  }
  return found;
}

function main() {
  const files = workflowFiles(repoRoot);
  const problems = [];
  for (const file of files) {
    for (const { line, ref } of unpinnedUses(readFileSync(file, 'utf8'))) {
      problems.push(`${relative(repoRoot, file).replaceAll('\\', '/')}:${line}  ${ref}`);
    }
  }
  if (problems.length > 0) {
    console.error(`❌ ${problems.length} GitHub Actions reference(s) not pinned to a commit SHA:`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      '\nPin each to the full commit SHA of its tag, with the tag as a comment:\n' +
        '  uses: actions/checkout@<40-hex-sha> # v5.0.0\n' +
        'Resolve a tag with: gh api repos/<owner>/<repo>/commits/<tag> --jq .sha',
    );
    process.exit(1);
  }
  console.log(`✓ ${files.length} workflow file(s): every action is pinned to a commit SHA.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
