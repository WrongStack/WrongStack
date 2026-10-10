#!/usr/bin/env bun
/** Run selected package suites without changing the full release gate. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const available = new Map();
for (const group of ['packages', 'apps']) {
  for (const entry of readdirSync(path.join(root, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = `${group}/${entry.name}`;
    const manifest = path.join(root, directory, 'package.json');
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
    available.set(directory, { name, directory, short: entry.name });
  }
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
if (argv.includes('--list')) {
  for (const item of available.values()) console.log(`${item.directory} (${item.name})`);
  process.exit(0);
}
const selectors = argv.filter((arg) => arg !== '--dry-run');
if (!selectors.length || selectors.some((arg) => arg.startsWith('--'))) {
  console.error('Usage: bun test:package <package> [package ...] [--dry-run] | --list');
  process.exit(1);
}

const selected = new Map();
for (const selector of selectors) {
  const matches = [...available.values()].filter((item) =>
    [item.name, item.directory, item.short].includes(selector),
  );
  if (matches.length !== 1) {
    console.error(`Unknown or ambiguous package: ${selector}. Use bun test:package --list.`);
    process.exit(1);
  }
  selected.set(matches[0].directory, matches[0]);
}

const plan = [];
for (const item of selected.values()) {
  if (item.directory === 'packages/webui') {
    plan.push({ cwd: item.directory, args: ['--config', 'vitest.config.ts'] });
  } else {
    // Keep root aliases, isolation, setup and exclusions authoritative.
    plan.push({ cwd: '.', args: [`${item.directory}/`] });
    if (item.directory === 'packages/cli') {
      plan.push({ cwd: item.directory, args: ['--config', 'vitest.hqdash.config.ts'] });
    }
    if (item.directory === 'packages/tui') {
      plan.push({ cwd: item.directory, args: ['--config', 'vitest.status-bar-sgr.config.ts'] });
    }
  }
}

for (const step of plan) {
  const args = ['--bun', 'run', 'vitest', 'run', ...step.args];
  console.log(`[${step.cwd}] bun ${args.join(' ')}`);
  if (dryRun) continue;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(root, step.cwd),
      stdio: 'inherit',
      env: process.env,
    });
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) process.exit(code);
}
