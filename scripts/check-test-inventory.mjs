#!/usr/bin/env bun

import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { buildArchitectureHealth, loadArchitectureInputs } from './lib/architecture-health.mjs';
import { parseVitestFileList, validateRuntimeTestInventory } from './lib/test-inventory.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const { registry, exceptions, hotspots } = await loadArchitectureInputs(repoRoot);
const architecture = await buildArchitectureHealth({ repoRoot, registry, exceptions, hotspots });
const vitestCli = path.join(repoRoot, 'node_modules/vitest/vitest.mjs');
const collectedByProject = new Map();

for (const project of registry.testProjects) {
  const cwd = path.resolve(repoRoot, project.cwd);
  const config = path.resolve(repoRoot, project.config);
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      process.execPath,
      [vitestCli, 'list', '--config', config, '--filesOnly', '--json', '--staticParse'],
      { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`${project.id}: Vitest collection failed: ${detail}`);
    process.exitCode = 1;
    continue;
  }
  collectedByProject.set(project.id, parseVitestFileList(repoRoot, stdout));
}

if (process.exitCode) process.exit();

const result = validateRuntimeTestInventory(
  architecture.testOwnership.runtimeAssignments,
  collectedByProject,
  registry.testProjects.map((project) => project.id),
);

console.log('Runtime test inventory');
for (const project of result.projects) {
  console.log(
    `- ${project.projectId}: ${project.collected}/${project.expected} test files collected`,
  );
}
console.log(
  `- total: ${result.projects.reduce((total, project) => total + project.collected, 0)} test files collected`,
);

if (result.errors.length > 0) {
  console.error('\nRuntime test inventory FAILED');
  for (const error of result.errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    'PASS — every in-scope test file is collected by exactly one non-empty Vitest project.',
  );
}
