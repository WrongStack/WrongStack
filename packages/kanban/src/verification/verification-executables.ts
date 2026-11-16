import * as fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { scriptSpawnArgs } from '@wrongstack/persistence';

/**
 * Path and executable resolution for verification commands: keeping a file
 * argument inside the project root, turning an allowlisted bare command into
 * something spawn can run, and finding the project's local test runner.
 */

export interface TestRunnerInvocation {
  command: string;
  args: string[];
  kind: 'vitest' | 'jest';
}

export async function resolveProjectPath(
  projectRoot: string,
  filePath: string,
): Promise<string | null> {
  if (path.isAbsolute(filePath)) return null;
  const root = await fsp.realpath(projectRoot);
  const candidate = path.resolve(root, filePath);
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  try {
    const real = await fsp.realpath(candidate);
    const realRelative = path.relative(root, real);
    return realRelative === '..' ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)
      ? null
      : real;
  } catch {
    const parent = await fsp.realpath(path.dirname(candidate)).catch(() => null);
    if (!parent) return null;
    const parentRelative = path.relative(root, parent);
    return parentRelative === '..' ||
      parentRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(parentRelative)
      ? null
      : candidate;
  }
}

/**
 * Resolve an allowlisted base command to something spawn can execute.
 * Bare tokens like `tsc` are not executables — they are npm bin shims.
 * Resolution order mirrors detectTestRunner:
 *   1. Local package bin (`<base>/package.json` `bin` entry): JS entries
 *      run under this process's node (fully cross-platform, no shell);
 *      native binaries spawn directly.
 *   2. node_modules/.bin shims. POSIX shebang scripts spawn directly.
 *      Windows `.cmd` shims require cmd.exe, so they spawn with
 *      `shell: true`. Node emits DEP0190 for args+shell (args are
 *      concatenated, not escaped) — acceptable here only because the
 *      caller's command already passed the operator/expansion gates, so
 *      no `& | ; < > ` $() %..% $VAR !..!` can reach the shell, and cmd
 *      only ever receives the resolved absolute shim path plus gated
 *      args.
 *   3. The raw token (POSIX PATH lookup).
 */
export async function resolveConfiguredExecutable(
  projectRoot: string,
  base: string,
  localOnly = false,
): Promise<{ command: string; args: string[]; shell?: boolean } | undefined> {
  // 1. Local package bin, e.g. `vitest` → vitest/bin/vitest.js under node.
  try {
    const req = createRequire(path.join(projectRoot, 'package.json'));
    const pkgJsonPath = req.resolve(`${base}/package.json`);
    const pkg = JSON.parse((await fsp.readFile(pkgJsonPath, 'utf8')).replace(/^\uFEFF/, '')) as {
      bin?: string | Record<string, string>;
    };
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[base];
    if (rel && !path.isAbsolute(rel)) {
      const packageDir = path.dirname(pkgJsonPath);
      const entry = path.resolve(packageDir, rel);
      // Canonical escape test: `..hidden` is a legal in-root first segment;
      // a bare `startsWith('..')` misreads it as a parent traversal and
      // wrongly rejects legitimate local-bin resolutions. Same predicate
      // as resolveProjectPath above (lines 521/525/530) and the design
      // tool's materialize/verify guards.
      const relToPkg = path.relative(packageDir, entry);
      if (
        relToPkg !== '..' &&
        !relToPkg.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relToPkg)
      ) {
        await fsp.access(entry);
        const isJsEntry = /\.(?:c|m)?js$/.test(entry);
        return isJsEntry
          ? { command: process.execPath, args: scriptSpawnArgs(entry, []) }
          : { command: entry, args: [] };
      }
    }
  } catch {
    // Not a locally installed package — fall through to the .bin shims.
  }
  // 2. node_modules/.bin shims (.cmd first on Windows — the extensionless
  // shims some package managers also create cannot spawn without a shell).
  const binShim = path.join(projectRoot, 'node_modules', '.bin', base);
  if (process.platform === 'win32') {
    const cmdShim = `${binShim}.cmd`;
    try {
      await fsp.access(cmdShim);
      return { command: cmdShim, args: [], shell: true };
    } catch {
      // fall through
    }
  }
  try {
    await fsp.access(binShim);
    return { command: binShim, args: [] };
  } catch {
    // fall through
  }
  // Constrained pnpm-exec commands must resolve a project-local binary; do
  // not turn a missing dependency into a PATH lookup.
  if (localOnly) return undefined;
  // 3. Raw token — resolved by PATH on POSIX.
  return { command: base, args: [] };
}

export async function detectTestRunner(cwd: string): Promise<TestRunnerInvocation | null> {
  let preferred: 'vitest' | 'jest' = 'vitest';
  try {
    const pkg = (await fsp.readFile(path.join(cwd, 'package.json'), 'utf8')).replace(/^\uFEFF/, '');
    const json = JSON.parse(pkg) as Record<string, unknown>;
    const scripts = json['scripts'];
    const testScript =
      typeof scripts === 'object' && scripts !== null
        ? (scripts as Record<string, unknown>)['test']
        : undefined;
    if (typeof testScript === 'string' && testScript.includes('jest')) preferred = 'jest';
  } catch {
    // Fall back to Vitest discovery below.
  }

  const candidates: Array<'vitest' | 'jest'> =
    preferred === 'jest' ? ['jest', 'vitest'] : ['vitest', 'jest'];
  let requireFromProject: ReturnType<typeof createRequire>;
  try {
    requireFromProject = createRequire(path.resolve(cwd, 'package.json'));
  } catch {
    return null;
  }
  for (const runner of candidates) {
    try {
      const packageJsonPath = requireFromProject.resolve(`${runner}/package.json`);
      const packageJson = JSON.parse(
        (await fsp.readFile(packageJsonPath, 'utf8')).replace(/^\uFEFF/, ''),
      ) as {
        bin?: string | Record<string, string>;
      };
      const relativeBin =
        typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.[runner];
      if (!relativeBin || path.isAbsolute(relativeBin)) continue;
      const packageDir = path.dirname(packageJsonPath);
      const entry = path.resolve(packageDir, relativeBin);
      // Canonical escape test: `..hidden` is a legal in-root first segment;
      // a bare `startsWith('..')` misreads it as a parent traversal and
      // wrongly rejects legitimate local-runner binaries (forcing a
      // fallthrough to the next candidate or to PATH). Same predicate as
      // resolveConfiguredExecutable above and resolveProjectPath at
      // lines 521/525/530.
      const relToPkg = path.relative(packageDir, entry);
      if (relToPkg === '..' || relToPkg.startsWith(`..${path.sep}`) || path.isAbsolute(relToPkg)) {
        continue;
      }
      await fsp.access(entry);
      return { command: process.execPath, args: scriptSpawnArgs(entry, []), kind: runner };
    } catch {
      // Try the next locally installed runner. Never download one during verification.
    }
  }
  return null;
}
