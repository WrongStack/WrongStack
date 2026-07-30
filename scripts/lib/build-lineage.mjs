import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

async function pathExists(file) {
  try {
    await stat(file);
    return true;
    /* istanbul ignore next -- filesystem disappearance/permission race */
  } catch {
    return false;
  }
}

async function walkFiles(root) {
  /* istanbul ignore if -- callers preflight roots; recursive entries are known directories */
  if (!(await pathExists(root))) return [];
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(target)));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function repoRelative(repoRoot, file) {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

export async function collectScopedDistFiles(repoRoot, workspaceRoots = ['packages', 'apps']) {
  const files = [];
  for (const workspaceRoot of workspaceRoots) {
    const root = path.join(repoRoot, workspaceRoot);
    if (!(await pathExists(root))) continue;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      files.push(...(await walkFiles(path.join(root, entry.name, 'dist'))));
    }
  }
  return files.map((file) => repoRelative(repoRoot, file)).sort();
}

async function fingerprint(repoRoot, file) {
  const bytes = await readFile(path.join(repoRoot, file));
  return {
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function createBuildManifest(repoRoot, files, metadata = {}) {
  const entries = {};
  for (const file of [...files].sort()) entries[file] = await fingerprint(repoRoot, file);
  return {
    schemaVersion: 1,
    scope: ['packages', 'apps'],
    excludedPaths: ['website'],
    ...metadata,
    files: entries,
  };
}

export async function validateBuildManifest(repoRoot, manifest, actualFiles) {
  const expected = Object.keys(manifest.files ?? {}).sort();
  const actual = [...actualFiles].sort();
  const errors = [];
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);

  for (const file of expected) {
    if (!actualSet.has(file)) {
      errors.push(`${file}: missing build artifact`);
      continue;
    }
    const current = await fingerprint(repoRoot, file);
    const recorded = manifest.files[file];
    if (current.bytes !== recorded.bytes || current.sha256 !== recorded.sha256) {
      errors.push(`${file}: build artifact differs from the lineage manifest`);
    }
  }
  for (const file of actual) {
    if (!expectedSet.has(file)) errors.push(`${file}: untracked build artifact`);
  }
  return errors;
}
