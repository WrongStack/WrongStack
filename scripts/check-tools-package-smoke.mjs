#!/usr/bin/env bun
/**
 * Verify that the packed @wrongstack/tools artifact contains and can load its
 * vendored Tree-sitter WASM grammars. The build gate runs first, so this check
 * exercises the package contents rather than the source tree.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(repoRoot, '.temp_files', `tools-package-smoke-${process.pid}`);
const packDir = path.join(tempRoot, 'pack');
const installRoot = path.join(tempRoot, 'install');
const installedTools = path.join(installRoot, 'node_modules', '@wrongstack', 'tools');

function run(command, args, cwd = repoRoot) {
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

function listWasmFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listWasmFiles(absolute).map((file) => `${entry.name}/${file}`));
    } else if (entry.name.endsWith('.wasm')) {
      files.push(entry.name);
    }
  }
  return files;
}

async function main() {
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installedTools, { recursive: true });

  try {
    run(
      process.execPath,
      ['pm', 'pack', '--destination', packDir],
      path.join(repoRoot, 'packages', 'tools'),
    );
    const tarball = readdirSync(packDir).find((entry) => entry.endsWith('.tgz'));
    if (!tarball) throw new Error('Tools package packing produced no .tgz artifact.');

    // A GNU/MSYS tar on PATH reads a leading `D:` as a remote host spec and
    // mangles backslashes, so the archive is extracted from inside the target
    // directory with a POSIX-style relative path — no drive letter, no
    // backslashes. Windows' own bsdtar accepts the same form.
    const relativeTarball = path
      .relative(installedTools, path.join(packDir, tarball))
      .split(path.sep)
      .join('/');
    run('tar', ['-xzf', relativeTarball, '--strip-components=1'], installedTools);

    // The parser is imported from the extracted package, while its declared
    // runtime dependency is linked from this workspace's installed modules.
    // CI's frozen install provides this dependency before release:check runs.
    const toolsPackageRoot = path.join(repoRoot, 'packages', 'tools');
    const resolvedTreeSitterEntry = require.resolve('web-tree-sitter', {
      paths: [toolsPackageRoot],
    });
    let treeSitterPackage = path.dirname(resolvedTreeSitterEntry);
    while (path.basename(treeSitterPackage) !== 'web-tree-sitter') {
      const parent = path.dirname(treeSitterPackage);
      if (parent === treeSitterPackage) {
        throw new Error(
          `Could not locate web-tree-sitter package root from ${resolvedTreeSitterEntry}`,
        );
      }
      treeSitterPackage = parent;
    }
    const dependencyTarget = path.join(installRoot, 'node_modules', 'web-tree-sitter');
    mkdirSync(path.dirname(dependencyTarget), { recursive: true });
    symlinkSync(treeSitterPackage, dependencyTarget, 'junction');
    // The parser locates its grammars through @wrongstack/persistence's
    // standalone-binary-aware `moduleUrlFor`, so link that declared workspace
    // dependency (built by `pnpm build` earlier in release:check) as well.
    const persistenceTarget = path.join(installRoot, 'node_modules', '@wrongstack', 'persistence');
    mkdirSync(path.dirname(persistenceTarget), { recursive: true });
    symlinkSync(path.join(repoRoot, 'packages', 'persistence'), persistenceTarget, 'junction');

    const wasmDir = path.join(installedTools, 'dist', 'wasm');
    if (!existsSync(wasmDir)) throw new Error(`Packed tools artifact is missing ${wasmDir}.`);
    const wasmFiles = listWasmFiles(wasmDir);
    if (wasmFiles.length < 14) {
      throw new Error(
        `Packed tools artifact contains only ${wasmFiles.length} WASM files; expected at least 14.`,
      );
    }

    const parserChunk = readdirSync(path.join(installedTools, 'dist')).find((entry) =>
      /^tree-sitter-parser-.+\.js$/u.test(entry),
    );
    if (!parserChunk) throw new Error('Packed tools artifact has no tree-sitter parser chunk.');
    const parser = await import(pathToFileURL(path.join(installedTools, 'dist', parserChunk)).href);
    const grammarPath = parser.getGrammarWasmPath('c');
    if (!grammarPath || !existsSync(grammarPath)) {
      throw new Error(`Installed parser resolved a missing C grammar: ${grammarPath ?? '(none)'}`);
    }
    await parser.loadTreeSitterLanguage('c');
    console.log(
      `[tools-package-smoke] PASS — extracted @wrongstack/tools contains ${wasmFiles.length} WASM files and loaded the C grammar.`,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();
