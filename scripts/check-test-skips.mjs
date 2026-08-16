#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { buildArchitectureHealth, loadArchitectureInputs } from './lib/architecture-health.mjs';
import { collectSkipDeclarations, validateSkipBudget } from './lib/test-skip-budget.mjs';

const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => arg !== '--print-baseline')) {
  console.error('Usage: node scripts/check-test-skips.mjs [--print-baseline]');
  process.exit(2);
}

const repoRoot = process.cwd();
const { registry, exceptions, hotspots } = await loadArchitectureInputs(repoRoot);
const architecture = await buildArchitectureHealth({ repoRoot, registry, exceptions, hotspots });
const declarations = [];
for (const assignment of architecture.testOwnership.runtimeAssignments) {
  const source = await readFile(path.join(repoRoot, assignment.file), 'utf8');
  declarations.push(...collectSkipDeclarations(source, assignment.file));
}
declarations.sort(
  (a, b) =>
    a.file.localeCompare(b.file) ||
    a.kind.localeCompare(b.kind) ||
    a.fingerprint.localeCompare(b.fingerprint),
);

if (args.has('--print-baseline')) {
  console.log(JSON.stringify({ schemaVersion: 1, declarations }, null, 2));
  process.exit(0);
}

const baseline = JSON.parse(
  await readFile(path.join(repoRoot, 'architecture/test-skip-budget.json'), 'utf8'),
);
const errors = validateSkipBudget(declarations, baseline);
const byKind = Object.entries(Object.groupBy(declarations, (item) => item.kind))
  .map(([kind, rows]) => `${kind}=${rows.length}`)
  .join(', ');
console.log(`Test skip budget: ${declarations.length} declarations (${byKind})`);
if (errors.length > 0) {
  console.error('Test skip budget FAILED');
  for (const error of errors) console.error(`- ${error}`);
  console.error(
    'Every skip declaration change requires an explicit budget review. After review, refresh with: pnpm test-skips:sync (also part of pnpm release:prepare)',
  );
  process.exit(1);
}
console.log('PASS — no test skip declaration was added, changed, or left stale without review.');
