import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

interface SimpleUiDistDeps {
  resolvePackageJson?: (id: string) => string;
  exists?: (file: string) => boolean;
}

/** Resolve the independent SimpleUI frontend and fail closed if it is unbuilt. */
export function resolveSimpleUiDistDir(deps: SimpleUiDistDeps = {}): string {
  const requireFromHere = createRequire(import.meta.url);
  const resolvePackageJson =
    deps.resolvePackageJson ?? ((id: string) => requireFromHere.resolve(id));
  const exists = deps.exists ?? existsSync;

  let packageJson: string;
  try {
    packageJson = resolvePackageJson('@wrongstack/simpleui/package.json');
  } catch {
    throw new Error(
      'SimpleUI package could not be resolved. Install workspace dependencies and rebuild the CLI.',
    );
  }

  const distDir = path.join(path.dirname(packageJson), 'dist');
  if (!exists(path.join(distDir, 'index.html'))) {
    throw new Error(
      'SimpleUI frontend is not built. Run `pnpm --filter @wrongstack/simpleui build`.',
    );
  }
  return distDir;
}

interface EnsureSimpleUiDistDeps extends SimpleUiDistDeps {
  /** Override the build command runner (tests). Receives the workspace root cwd. */
  runBuild?: (cwd: string) => void | Promise<void>;
  /** Override the workspace-root finder (tests). Receives the simpleui package dir. */
  findWorkspaceRoot?: (packageDir: string) => string;
}

/**
 * Resolve the SimpleUI dist, auto-building it when missing.
 *
 * Cold-start recovery: after a fresh clone, `git clean`, or dependency
 * update the `dist/` directory (gitignored) may not exist. Instead of
 * failing with an opaque error, this function runs the Vite build
 * automatically (~600 ms) and retries resolution. The build output is
 * printed to stderr so the user sees what happened.
 */
export async function ensureSimpleUiDistDir(deps: EnsureSimpleUiDistDeps = {}): Promise<string> {
  try {
    return resolveSimpleUiDistDir(deps);
  } catch {
    // dist missing — attempt an auto-build before giving up.
  }

  const requireFromHere = createRequire(import.meta.url);
  const resolvePackageJson =
    deps.resolvePackageJson ?? ((id: string) => requireFromHere.resolve(id));

  let packageDir: string;
  try {
    packageDir = path.dirname(resolvePackageJson('@wrongstack/simpleui/package.json'));
  } catch {
    throw new Error(
      'SimpleUI package could not be resolved. Install workspace dependencies and rebuild the CLI.',
    );
  }

  const findRoot =
    deps.findWorkspaceRoot ??
    ((pkgDir: string): string => {
      let dir = pkgDir;
      for (let i = 0; i < 10; i++) {
        if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      // Fallback: assume the standard monorepo layout (packages/simpleui → root).
      return path.resolve(pkgDir, '..', '..');
    });

  const workspaceRoot = findRoot(packageDir);
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'simpleui.auto_build',
      message: 'Frontend not built — building now',
      timestamp: new Date().toISOString(),
    }),
  );

  const runBuild =
    deps.runBuild ?? ((cwd: string) => runPnpmBuild(cwd, '@wrongstack/simpleui', 120_000));

  try {
    await runBuild(workspaceRoot);
  } catch (err) {
    throw new Error(
      `SimpleUI auto-build failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'Run `pnpm --filter @wrongstack/simpleui build` manually.',
    );
  }

  // Retry resolution — throws the original descriptive error if still missing.
  return resolveSimpleUiDistDir(deps);
}

function runPnpmBuild(cwd: string, workspace: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['--filter', workspace, 'build'], {
      cwd,
      shell: process.platform === 'win32',
      stdio: 'inherit',
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`build timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`pnpm build exited with code ${String(code)}`));
    });
  });
}
