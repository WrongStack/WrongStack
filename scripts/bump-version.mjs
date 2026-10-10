import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

/**
 * Collect every package.json that should share the repo version: the root
 * manifest plus every workspace package under packages/* and apps/*.
 * Internal deps use `workspace:*`, so only the `version` field needs updating.
 */
function collectManifests() {
  const paths = [resolve(repoRoot, 'package.json')];
  for (const group of ['packages', 'apps']) {
    const groupDir = resolve(repoRoot, group);
    let entries;
    try {
      entries = readdirSync(groupDir, { withFileTypes: true });
    } catch {
      continue; // group dir may not exist
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = resolve(groupDir, entry.name, 'package.json');
      try {
        readFileSync(candidate); // existence check
        paths.push(candidate);
      } catch {
        // no package.json in this dir — skip
      }
    }
  }
  return paths;
}

/**
 * A manifest carrying git conflict markers (`<<<<<<< …`) makes JSON.parse
 * throw an opaque SyntaxError — and via pnpm, "Invalid package.json in
 * package.json" before this script even starts. When a stash pop or merge
 * leaves markers behind (2026-08-24 incident: 41 files at once), fail fast
 * and name every affected file so the fix — resolve the conflict — is
 * obvious. `=======` alone is not checked: it is legitimate content in some
 * file types and the outer markers are decisive on their own.
 */
const CONFLICT_MARKER_RE = /^(<{7}|>{7}|\|{7})/m;

function assertNoConflictMarkers(paths) {
  const affected = [];
  for (const path of paths) {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue; // absent files are skipped by their own handling
    }
    // Normalize to forward slashes so diagnostics are identical across platforms.
    if (CONFLICT_MARKER_RE.test(text))
      affected.push(relative(repoRoot, path).replaceAll('\\', '/'));
  }
  if (affected.length === 0) return;
  console.error(
    `error: git conflict markers present in ${affected.length} file(s) — resolve the conflicts before bumping the version:`,
  );
  for (const rel of affected) console.error(`  - ${rel}`);
  process.exit(1);
}

function writeVersion(path, version) {
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * Keep the marketing site (`website/`, outside the pnpm workspace) in lockstep
 * too. It carries its own `package.json`/`package-lock.json` version plus a
 * `META.version` constant rendered on the page. These are NOT covered by the
 * workspace scan above, which is exactly how they drifted in the past — so the
 * single bump entry point owns them. Each step is guarded: if the site isn't
 * present (or its shape changed), we skip silently rather than fail the bump.
 * Returns the number of website files updated.
 */
function updateWebsite(version) {
  const websiteDir = resolve(repoRoot, 'website');
  let updated = 0;

  // package.json (+ package-lock.json self-version) — JSON, safe to rewrite.
  for (const rel of ['package.json', 'package-lock.json']) {
    const p = resolve(websiteDir, rel);
    try {
      const json = JSON.parse(readFileSync(p, 'utf8'));
      json.version = version;
      // package-lock.json mirrors the version under packages[""].
      if (json.packages?.['']) json.packages[''].version = version;
      writeFileSync(p, `${JSON.stringify(json, null, 2)}\n`);
      updated++;
    } catch {
      // file absent or unparseable — skip
    }
  }

  // src/lib/utils.ts — the `META.version` string shown in the UI. Replace only
  // the first `version: '…'` after `META = {` so unrelated values are untouched.
  const utilsPath = resolve(websiteDir, 'src', 'lib', 'utils.ts');
  try {
    const src = readFileSync(utilsPath, 'utf8');
    const next = src.replace(/(META\s*=\s*\{[\s\S]*?version:\s*)'[^']*'/, `$1'${version}'`);
    if (next !== src) {
      writeFileSync(utilsPath, next);
      updated++;
    }
  } catch {
    // file absent — skip
  }

  // src/data/content.ts — shared homepage/product content exports a second
  // current-version constant. Keep it aligned with META and package metadata.
  const contentPath = resolve(websiteDir, 'src', 'data', 'content.ts');
  try {
    const src = readFileSync(contentPath, 'utf8');
    const next = src.replace(/(export\s+const\s+version\s*=\s*)'[^']*'/, `$1'${version}'`);
    if (next !== src) {
      writeFileSync(contentPath, next);
      updated++;
    }
  } catch {
    // file absent — skip
  }

  // index.html — the JSON-LD `"softwareVersion"` in the SoftwareApplication
  // structured-data block (drives the version shown to search engines).
  const indexPath = resolve(websiteDir, 'index.html');
  try {
    const html = readFileSync(indexPath, 'utf8');
    const next = html.replace(/("softwareVersion":\s*)"[^"]*"/, `$1"${version}"`);
    if (next !== html) {
      writeFileSync(indexPath, next);
      updated++;
    }
  } catch {
    // file absent — skip
  }

  return updated;
}

const [, , type, arg] = process.argv;

const rootPath = resolve(repoRoot, 'package.json');
assertNoConflictMarkers([rootPath]); // guards the first JSON.parse below
const rootPkg = JSON.parse(readFileSync(rootPath, 'utf8'));
const parts = rootPkg.version.split('.').map(Number);

// The bump arithmetic below indexes and re-joins exactly three numeric
// components. A root version carrying a prerelease/build suffix (e.g.
// `1.2.3-beta.1`, which `set` deliberately accepts) splits into a NaN
// component, and this script would then silently write `1.2.NaN...` into
// EVERY manifest in one pass — a corruption the version-drift check in
// publish-workspace.mjs cannot catch, because all manifests drift together.
if (type !== 'set' && !(parts.length === 3 && parts.every((n) => Number.isInteger(n) && n >= 0))) {
  console.error(
    `error: cannot ${type}-bump "${rootPkg.version}" — version bumps require exactly X.Y.Z. ` +
      'Use `set <version>` explicitly to carry a prerelease or build suffix.',
  );
  process.exit(1);
}

let newVersion;
if (type === 'patch') {
  parts[2] += 1;
  newVersion = parts.join('.');
} else if (type === 'minor') {
  parts[1] += 1;
  parts[2] = 0;
  newVersion = parts.join('.');
} else if (type === 'major') {
  parts[0] += 1;
  parts[1] = 0;
  parts[2] = 0;
  newVersion = parts.join('.');
} else if (type === 'set') {
  if (!arg || !/^\d+\.\d+\.\d+/.test(arg)) {
    console.error('Usage: bun bump-version.mjs set <version>');
    process.exit(1);
  }
  newVersion = arg;
} else {
  console.error('Usage: bun bump-version.mjs [patch|minor|major|set <version>]');
  process.exit(1);
}

const manifests = collectManifests();
// Same guard for everything parsed below: the workspace manifests plus the
// website JSON files — a marked-up website/package.json would otherwise be
// silently skipped by updateWebsite's catch block, leaving versions drifting.
assertNoConflictMarkers([
  ...manifests,
  resolve(repoRoot, 'website', 'package.json'),
  resolve(repoRoot, 'website', 'package-lock.json'),
]);
for (const path of manifests) {
  writeVersion(path, newVersion);
}

const websiteUpdated = updateWebsite(newVersion);

// Schemas include the package version. Use their canonical writer rather than
// patching generated JSON, and do not report success if regeneration failed.
if (existsSync(resolve(repoRoot, 'packages/webui-protocol/package.json'))) {
  const generated = spawnSync(
    process.execPath,
    [resolve(repoRoot, 'scripts/generate-protocol-schema.mjs')],
    { cwd: repoRoot, stdio: 'inherit', windowsHide: true },
  );
  if (generated.status !== 0) {
    console.error(
      'error: manifests were updated, but protocol schema regeneration failed. ' +
        'Fix the generator failure and rerun scripts/generate-protocol-schema.mjs before releasing.',
    );
    process.exit(generated.status ?? 1);
  }
}

console.log(
  `Version ${type === 'set' ? 'set' : 'bumped'} to ${newVersion} across ${manifests.length} package(s)` +
    (websiteUpdated > 0 ? ` + ${websiteUpdated} website file(s).` : '.'),
);
