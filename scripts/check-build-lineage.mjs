#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  collectScopedDistFiles,
  createBuildManifest,
  validateBuildManifest,
} from './lib/build-lineage.mjs';

const [mode, manifestArg] = process.argv.slice(2);
const supported = new Set(['--assert-clean', '--write', '--verify']);
if (!supported.has(mode) || ((mode === '--write' || mode === '--verify') && !manifestArg)) {
  console.error(
    'Usage: node scripts/check-build-lineage.mjs --assert-clean | --write <manifest> | --verify <manifest>',
  );
  process.exit(2);
}

const repoRoot = process.cwd();
const files = await collectScopedDistFiles(repoRoot);

if (mode === '--assert-clean') {
  if (files.length > 0) {
    console.error(
      `Clean-build lineage FAILED — found ${files.length} pre-existing in-scope dist file(s).`,
    );
    for (const file of files.slice(0, 20)) console.error(`- ${file}`);
    if (files.length > 20) console.error(`- … and ${files.length - 20} more`);
    process.exit(1);
  }
  console.log('PASS — no pre-existing in-scope dist artifacts.');
  process.exit(0);
}

const manifestPath = path.resolve(repoRoot, manifestArg);
if (mode === '--write') {
  if (files.length === 0) {
    console.error('Build-lineage manifest cannot be empty; run the workspace build first.');
    process.exit(1);
  }
  const manifest = await createBuildManifest(repoRoot, files, {
    generatedAt: new Date().toISOString(),
    revision: process.env.GITHUB_SHA ?? null,
  });
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(
    `Wrote lineage for ${files.length} artifacts to ${path.relative(repoRoot, manifestPath)}.`,
  );
  process.exit(0);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const errors = await validateBuildManifest(repoRoot, manifest, files);
if (errors.length > 0) {
  console.error(`Build-lineage verification FAILED with ${errors.length} violation(s).`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`PASS — ${files.length} build artifacts match the lineage manifest.`);
