#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = new Set(process.argv.slice(2));
const supported = new Set(['--json', '--print-baseline', '--report-only']);
for (const arg of args) {
  if (!supported.has(arg)) {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}

const repoRoot = process.cwd();
const registry = JSON.parse(
  await readFile(path.join(repoRoot, 'architecture/registry.json'), 'utf8'),
);
const tscEntry = path.join(repoRoot, 'node_modules/typescript/bin/tsc');

function toPosix(value) {
  return value.replaceAll(path.sep, '/');
}

async function pathExists(value) {
  try {
    await readFile(value);
    return true;
  } catch {
    return false;
  }
}

async function discoverProjects() {
  const projects = [];
  for (const workspaceRoot of registry.scope.workspaceRoots) {
    const root = path.join(repoRoot, workspaceRoot);
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const packageDir = path.join(root, entry.name);
      const packageRelative = toPosix(path.relative(repoRoot, packageDir));
      if (
        registry.scope.excludedPaths.some(
          (excluded) => packageRelative === excluded || packageRelative.startsWith(`${excluded}/`),
        )
      )
        continue;
      const config = path.join(packageDir, 'tsconfig.test.json');
      if (!(await pathExists(config))) continue;
      const testDir = path.join(packageDir, 'tests');
      let hasTests = false;
      try {
        const testEntries = await readdir(testDir, { recursive: true });
        hasTests = testEntries.some((item) => /\.test\.(?:ts|tsx|mts|cts)$/.test(String(item)));
      } catch {
        hasTests = false;
      }
      if (hasTests) projects.push({ id: packageRelative, config });
    }
  }
  return projects.sort((a, b) => a.id.localeCompare(b.id));
}

async function loadBaselineCounts() {
  const baselineDir = path.join(repoRoot, 'architecture/test-typecheck-baseline');
  const counts = new Map();
  let entries = [];
  try {
    entries = await readdir(baselineDir, { withFileTypes: true });
  } catch {
    return counts;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const document = JSON.parse(await readFile(path.join(baselineDir, entry.name), 'utf8'));
    for (const [id, count] of Object.entries(document.diagnostics ?? {})) {
      if (counts.has(id))
        throw new Error(`Duplicate test-type diagnostic id '${id}' in ${entry.name}`);
      counts.set(id, count);
    }
  }
  return counts;
}

function runTsc(project) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [tscEntry, '--noEmit', '--pretty', 'false', '-p', project.config],
      { cwd: repoRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) =>
      resolve({ project, exitCode: -1, output: `${stdout}\n${stderr}\n${error.message}` }),
    );
    child.on('close', (exitCode) =>
      resolve({ project, exitCode: exitCode ?? -1, output: `${stdout}\n${stderr}` }),
    );
  });
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runNext() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runNext()));
  return results;
}

function normalizeFile(file) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(repoRoot, file);
  return toPosix(path.relative(repoRoot, absolute));
}

// Diagnostic messages (e.g. TS6059 "File '<abs>' is not under rootDir '<abs>'"
// or TS2307/TS2352 that quote resolved module paths) embed ABSOLUTE repo paths.
// Those differ per platform/checkout (D:/... on Windows, /home/runner/... on
// Linux CI, backslash vs forward slash), so hashing the raw message makes the
// baseline non-portable. Rewrite any absolute repoRoot path inside the message
// to a stable repo-relative POSIX form so the hash is environment-independent.
function normalizeMessage(message) {
  const rootPosix = toPosix(repoRoot);
  const rootWin = repoRoot.replaceAll('/', '\\');
  return message
    .split(rootPosix)
    .join('<repo>')
    .split(rootWin)
    .join('<repo>')
    .replaceAll('\\', '/');
}

function parseDiagnostics(result) {
  const diagnostics = [];
  const lines = result.output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  let current = null;
  function finish() {
    if (!current) return;
    current.message = normalizeMessage(current.message.replace(/\s+/g, ' ').trim());
    current.key = `${current.project}|${current.file}|${current.code}|${current.message}`;
    diagnostics.push(current);
    current = null;
  }
  for (const line of lines) {
    const withFile = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
    const global = line.match(/^error (TS\d+): (.*)$/);
    if (withFile) {
      finish();
      current = {
        project: result.project.id,
        file: normalizeFile(withFile[1]),
        code: withFile[4],
        message: withFile[5],
      };
    } else if (global) {
      finish();
      current = {
        project: result.project.id,
        file: '<project>',
        code: global[1],
        message: global[2],
      };
    } else if (current && line.trim()) current.message += ` ${line.trim()}`;
  }
  finish();
  return diagnostics;
}

const projects = await discoverProjects();
// TypeScript 7's native compiler launcher is not reliably concurrent on all
// supported developer machines. Sequential project execution keeps baseline
// generation deterministic and still completes quickly for this workspace.
const results = await runWithConcurrency(projects, 1, runTsc);
const rawDiagnostics = results.flatMap(parseDiagnostics).sort((a, b) => a.key.localeCompare(b.key));
const diagnosticMap = new Map();
for (const diagnostic of rawDiagnostics) {
  const id = createHash('sha256').update(diagnostic.key).digest('hex').slice(0, 16);
  const existing = diagnosticMap.get(id);
  if (existing) existing.count += 1;
  else diagnosticMap.set(id, { ...diagnostic, id, count: 1 });
}
const diagnostics = [...diagnosticMap.values()].sort((a, b) => a.key.localeCompare(b.key));
const unparsedFailures = results
  .filter((result) => result.exitCode !== 0 && parseDiagnostics(result).length === 0)
  .map((result) => ({
    project: result.project.id,
    exitCode: result.exitCode,
    output: result.output.trim(),
  }));

const baselineCounts = await loadBaselineCounts();
const currentCounts = new Map(diagnostics.map((item) => [item.id, item.count]));
const newDiagnostics = diagnostics
  .filter((item) => item.count > (baselineCounts.get(item.id) ?? 0))
  .map((item) => ({ ...item, added: item.count - (baselineCounts.get(item.id) ?? 0) }));
const resolvedDiagnostics = [...baselineCounts]
  .filter(([id, count]) => count > (currentCounts.get(id) ?? 0))
  .map(([id, count]) => ({ id, count, resolved: count - (currentCounts.get(id) ?? 0) }));
const byProject = projects.map((project) => ({
  project: project.id,
  diagnostics: diagnostics
    .filter((item) => item.project === project.id)
    .reduce((total, item) => total + item.count, 0),
  newDiagnostics: newDiagnostics
    .filter((item) => item.project === project.id)
    .reduce((total, item) => total + item.added, 0),
}));

const report = {
  schemaVersion: 1,
  projects: projects.length,
  diagnostics: rawDiagnostics.length,
  uniqueDiagnostics: diagnostics.length,
  baselineDiagnostics: [...baselineCounts.values()].reduce((total, count) => total + count, 0),
  newDiagnostics,
  resolvedDiagnostics,
  unparsedFailures,
  byProject,
};

if (args.has('--print-baseline')) {
  if (unparsedFailures.length > 0) {
    console.error(
      'Refusing to print an incomplete baseline because a project failed without parseable diagnostics.',
    );
    for (const failure of unparsedFailures)
      console.error(`  ${failure.project}: exit ${failure.exitCode}\n${failure.output}`);
    process.exit(1);
  }
  const projectEntries = {};
  for (const item of diagnostics) {
    projectEntries[item.project] ??= {};
    projectEntries[item.project][item.id] = item.count;
  }
  const baselines = Object.entries(projectEntries).map(([project, diags]) => ({
    schemaVersion: 1,
    project,
    hashAlgorithm: 'sha256-64bit',
    diagnostics: diags,
  }));
  console.log(JSON.stringify(baselines, null, 2));
} else if (args.has('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Test TypeScript projects: ${projects.length}`);
  console.log(`Current diagnostics: ${rawDiagnostics.length} (${diagnostics.length} unique)`);
  console.log(
    `Baseline diagnostics: ${[...baselineCounts.values()].reduce((total, count) => total + count, 0)}`,
  );
  console.log(`New diagnostics: ${newDiagnostics.reduce((total, item) => total + item.added, 0)}`);
  console.log(
    `Resolved baseline diagnostics: ${resolvedDiagnostics.reduce((total, item) => total + item.resolved, 0)}`,
  );
  for (const item of byProject.filter((entry) => entry.diagnostics > 0)) {
    console.log(`  ${item.project}: ${item.diagnostics} (${item.newDiagnostics} new)`);
  }
  // A count alone is not actionable: the whole point of this gate is that a
  // NEW diagnostic must be fixed, and the author cannot fix what the gate will
  // not name. Print the offending file/code/message (the same fields --json
  // carries) so the failure is self-explanatory in a CI log.
  if (newDiagnostics.length > 0) {
    console.error('');
    console.error('New test-type diagnostics (fix these, or they are not allowed in):');
    for (const item of newDiagnostics) {
      const times = item.added > 1 ? ` (x${item.added})` : '';
      console.error(`  ${item.file}${times}`);
      console.error(`    ${item.code}: ${item.message}`);
    }
  }
  if (unparsedFailures.length > 0) {
    console.error('TypeScript projects failed without parseable diagnostics:');
    for (const failure of unparsedFailures)
      console.error(`  ${failure.project}: exit ${failure.exitCode}\n${failure.output}`);
  }
}

if (
  (newDiagnostics.length > 0 || unparsedFailures.length > 0) &&
  !args.has('--report-only') &&
  !args.has('--print-baseline')
) {
  process.exitCode = 1;
}
