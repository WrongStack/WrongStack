import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
assert(process.versions.bun, 'Run migration:check with Bun');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const lock = Bun.JSONC.parse(readFileSync(resolve(root, 'bun.lock'), 'utf8'));
assert.equal(
  manifest.packageManager,
  `bun@${readFileSync(resolve(root, '.bun-version'), 'utf8').trim()}`,
);
assert.deepEqual(manifest.overrides, lock.overrides);
for (const [name, patch] of Object.entries(manifest.patchedDependencies)) {
  assert(lock.patchedDependencies[name], `Missing locked patch: ${name}`);
  assert(existsSync(resolve(root, patch)), `Missing patch file: ${patch}`);
}
const oldCommand = /(?:^|&&\s*|\|\|\s*)(?:pnpm|npm|npx|node)(?:\s|$)/;
for (const file of readdirSync(resolve(root, 'scripts')).filter((name) =>
  /\.(mjs|mts)$/.test(name),
)) {
  const source = readFileSync(resolve(root, 'scripts', file), 'utf8');
  assert(
    !source.startsWith('#!/usr/bin/env node'),
    `${file} still selects Node when executed directly`,
  );
}
for (const line of readFileSync(resolve(root, '.githooks/pre-commit'), 'utf8').split('\n')) {
  assert(!oldCommand.test(line.trim()), 'pre-commit still invokes a legacy executable');
}
for (const dir of ['', ...Object.keys(lock.workspaces).filter(Boolean)]) {
  const pkg = JSON.parse(readFileSync(resolve(root, dir, 'package.json'), 'utf8'));
  for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
    assert(!oldCommand.test(script), `${dir || 'root'}:${name} still invokes a legacy executable`);
  }
}
for (const file of readdirSync(resolve(root, '.github/workflows')).filter((name) =>
  name.endsWith('.yml'),
)) {
  const workflow = Bun.YAML.parse(readFileSync(resolve(root, '.github/workflows', file), 'utf8'));
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      for (const line of (step.run ?? '').split('\n')) {
        assert(
          !/bun\s+(?:run\s+)?--filter\s+\S+\s+exec\s/.test(line),
          `${file}:${jobName} uses pnpm exec syntax with Bun`,
        );
        assert(
          !oldCommand.test(line.trim()),
          `${file}:${jobName} still invokes a legacy executable`,
        );
      }
    }
  }
}
function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
run(['install', '--frozen-lockfile', '--dry-run', '--ignore-scripts']);
const plan = run(['scripts/release-check-matrix.mjs', '--list']);
assert(!/\]\s+(?:pnpm|npm|node)\s/.test(plan), 'Release plan still invokes a legacy executable');
console.log(
  `Bun migration dry-run: PASS (${Object.keys(lock.workspaces).length - 1} workspaces, frozen install, patches, workflows, release plan).`,
);
console.log('Nothing was published. Run bun release:check for the full gate matrix.');
