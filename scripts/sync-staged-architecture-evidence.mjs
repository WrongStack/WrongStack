#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = (command, args, cwd = process.cwd(), input) =>
  execFileSync(command, args, {
    cwd,
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
export function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: bun scripts/sync-staged-architecture-evidence.mjs');
    return;
  }
  if (process.argv.length > 2) throw new Error('This command does not accept arguments.');
  const repoRoot = path.resolve(run('git', ['rev-parse', '--show-toplevel']).trim());
  const reportFiles = [
    'architecture/hotspots.json',
    'architecture/test-only-exports.json',
    'docs/reports/architecture-health-current.json',
    'docs/reports/architecture-health-current.md',
  ];
  const inside = (root, target) => {
    const relative = path.relative(root, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const temporaryRoot = path.join(repoRoot, '.temp_files');
  mkdirSync(temporaryRoot, { recursive: true });
  const realRepoRoot = realpathSync(repoRoot);
  if (!inside(realRepoRoot, realpathSync(temporaryRoot))) {
    throw new Error('Architecture scratch directory must stay inside the repository.');
  }
  const work = mkdtempSync(path.join(temporaryRoot, 'staged-architecture-'));
  const errors = [];
  let tree;
  try {
    tree = run('git', ['write-tree'], repoRoot).trim();
    const archive = path.join(work, 'source.tar');
    const source = path.join(work, 'source');
    mkdirSync(source);
    run('git', ['archive', '--format=tar', `--output=${archive}`, tree], repoRoot);
    // GNU tar in Git for Windows treats a drive prefix as a remote host.
    run('tar', ['-xf', 'source.tar', '-C', 'source'], work);
    // The canonical checker anchors its root to its own location. Run the
    // unchanged checker from the index archive, never the mutable checkout.
    const checker = path.join(source, 'scripts/check-architecture-health.mjs');
    run(process.execPath, [checker, '--write-hotspot-baseline'], source);
    run(process.execPath, [checker, '--write', '--report-only'], source);
    if (run('git', ['write-tree'], repoRoot).trim() !== tree) {
      throw new Error('The git index changed during architecture generation; retry the commit.');
    }
    const modes = new Map();
    for (const line of run('git', ['ls-tree', '-r', tree, '--', ...reportFiles], repoRoot).split(
      /\r?\n/,
    )) {
      const match = /^(\d+) blob [a-f0-9]+\t(.+)$/.exec(line);
      if (match) modes.set(match[2], match[1]);
    }
    const dirty = new Set(
      run('git', ['diff', '--name-only', tree, '--', ...reportFiles], repoRoot)
        .trim()
        .split(/\r?\n/)
        .filter(Boolean),
    );
    const updates = reportFiles.map((file) => {
      const target = path.join(repoRoot, file);
      const generated = path.join(source, file);
      const info = lstatSync(target, { throwIfNoEntry: false });
      const copy = !info || (info.isFile() && modes.has(file) && !dirty.has(file));
      const original = copy && info ? readFileSync(target) : null;
      const mode = modes.get(file) ?? '100644';
      if (mode !== '100644' && mode !== '100755')
        throw new Error(`Generated output must be a regular file: ${file}`);
      const blob = run(
        'git',
        ['hash-object', '-w', '--stdin', `--path=${file}`],
        repoRoot,
        readFileSync(generated),
      ).trim();
      return { file, target, generated, copy, original, record: `${mode} ${blob}\t${file}\n` };
    });
    // Stage the generated blobs directly. git add would consume a peer's
    // working-tree edits in these same generated files.
    run(
      'git',
      ['update-index', '--index-info'],
      repoRoot,
      updates.map((item) => item.record).join(''),
    );
    const finalTree = run('git', ['write-tree'], repoRoot).trim();
    const unexpected = run('git', ['diff', '--name-only', tree, finalTree, '--'], repoRoot)
      .trim()
      .split(/\r?\n/)
      .filter((file) => file && !reportFiles.includes(file));
    if (unexpected.length)
      throw new Error(
        `The git index changed during architecture staging: ${unexpected.join(', ')}`,
      );
    for (const update of updates) {
      const current = lstatSync(update.target, { throwIfNoEntry: false });
      const unchanged =
        update.original === null
          ? !current
          : current?.isFile() && readFileSync(update.target).equals(update.original);
      let parent = path.dirname(update.target);
      while (!existsSync(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent);
      if (update.copy && unchanged && inside(realRepoRoot, realpathSync(parent))) {
        mkdirSync(path.dirname(update.target), { recursive: true });
        copyFileSync(update.generated, update.target);
      } else {
        console.log(`Preserved working-tree edits in ${update.file}.`);
      }
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    // Remove only this invocation's owned archive, after checking its real path.
    if (existsSync(work)) {
      if (path.dirname(work) !== temporaryRoot || !inside(realRepoRoot, realpathSync(work))) {
        throw new Error('Refusing to remove an architecture scratch path outside the repository.');
      }
      rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, 'Architecture generation and cleanup failed.');
  console.log(`Refreshed architecture evidence from staged tree ${tree}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
