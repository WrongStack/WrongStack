import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { buildChildEnv } from '@wrongstack/core/utils';
import { treeKill } from '@wrongstack/core/utils/tree-kill';
import { resolveExecInvocation } from '@wrongstack/plugins/runtime';
import { errorResult, globalPluginsRoot, upsertPlugin } from './config.js';
import type {
  PackageManagerRunResult,
  PluginManagementDeps,
  PluginManagementResult,
} from './types.js';

// ---------------------------------------------------------------------------
// `wstack plugin add --install` — fetch a third-party plugin via a package
// manager into ~/.wrongstack/plugins and register it with an explicit path.
// ---------------------------------------------------------------------------

type PackageManagerId = 'npm' | 'pnpm' | 'yarn' | 'bun';

function detectPackageManager(args: string[]): PackageManagerId {
  const override = args.find((a) => a.startsWith('--pm='));
  if (override) {
    const pm = override.slice(5) as PackageManagerId;
    if (pm === 'npm' || pm === 'pnpm' || pm === 'yarn' || pm === 'bun') return pm;
  }
  const idx = args.indexOf('--pm');
  if (idx >= 0 && args[idx + 1]) {
    const pm = args[idx + 1] as PackageManagerId;
    if (pm === 'npm' || pm === 'pnpm' || pm === 'yarn' || pm === 'bun') return pm;
  }
  const ua = process.env.npm_config_user_agent ?? '';
  if (ua.startsWith('pnpm')) return 'pnpm';
  if (ua.startsWith('yarn')) return 'yarn';
  if (ua.startsWith('bun')) return 'bun';
  return 'npm';
}

/**
 * Extract the package name from an npm specifier. Handles scoped packages
 * and `name@range` / `name@tag` suffixes (`@scope/pkg@1.2.3`, `pkg@next`).
 */
function packageNameFromSpec(spec: string): string {
  const stripped = spec.trim();
  if (stripped.startsWith('@')) {
    const scopedEnd = stripped.indexOf('/', 1);
    if (scopedEnd === -1) return stripped.split('@')[0] ?? stripped;
    const rest = stripped.slice(scopedEnd + 1);
    const at = rest.lastIndexOf('@');
    return at === -1 ? stripped : stripped.slice(0, scopedEnd + 1 + at);
  }
  const at = stripped.indexOf('@');
  return at === -1 ? stripped : stripped.slice(0, at);
}

function buildInstallArgs(
  pm: PackageManagerId,
  targetDir: string,
  runScripts: boolean,
  spec: string,
): string[] {
  const ignoreScripts = runScripts ? [] : ['--ignore-scripts'];
  switch (pm) {
    case 'pnpm':
      return ['add', '--dir', targetDir, ...ignoreScripts, spec];
    case 'yarn':
      // Yarn classic honours --ignore-scripts; Berry users relying on
      // build scripts must pass --run-scripts and configure scripts policy.
      return ['add', '--cwd', targetDir, ...ignoreScripts, spec];
    case 'bun':
      return ['add', '--cwd', targetDir, ...ignoreScripts, spec];
    default:
      return ['install', '--prefix', targetDir, '--no-audit', '--no-fund', ...ignoreScripts, spec];
  }
}

function runPackageManagerInstall(
  pm: string,
  args: readonly string[],
  cwd: string,
): Promise<PackageManagerRunResult> {
  return new Promise((resolvePromise) => {
    let invocation: { cmd: string; args: string[]; windowsVerbatimArguments: boolean };
    try {
      invocation = resolveExecInvocation(pm, args);
    } catch (err) {
      resolvePromise({
        code: 127,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(
      invocation.cmd,
      invocation.args,
      {
        cwd,
        // H-8 (security report VF-09): this runs npm/pnpm install — including
        // untrusted package lifecycle scripts — with the full inherited
        // environment. Strip credentials via the shared child env.
        env: buildChildEnv(),
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      },
      (err, stdout, stderr) => {
        settled = true;
        clearTimeout(timer);
        const code = err ? ((err as NodeJS.ErrnoException).code ?? 1) : 0;
        resolvePromise({
          code: typeof code === 'number' && !timedOut ? code : 1,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        });
      },
    );
    // Not execFile's `timeout`: on the Windows `.cmd` shim it kills only
    // cmd.exe, and the real install kept writing into the plugins root after
    // the command had already reported failure. Kill the tree, drop the pipes.
    if (!settled) {
      timer = setTimeout(() => {
        timedOut = true;
        treeKill(child);
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 300_000);
    }
  });
}

export async function installPluginPackage(
  spec: string,
  args: string[],
  deps: PluginManagementDeps,
): Promise<PluginManagementResult> {
  const pm = detectPackageManager(args);
  const runScripts = args.includes('--run-scripts');
  const targetDir = globalPluginsRoot(deps);
  try {
    await fs.mkdir(targetDir, { recursive: true });
    // Bootstrap a minimal manifest so --prefix installs have a root to
    // record dependencies against.
    const pkgJsonPath = join(targetDir, 'package.json');
    try {
      await fs.access(pkgJsonPath);
    } catch {
      await fs.writeFile(
        pkgJsonPath,
        `${JSON.stringify({ name: 'wrongstack-user-plugins', private: true, version: '0.0.0' }, null, 2)}\n`,
        'utf8',
      );
    }
  } catch (err) {
    return errorResult(
      `Could not prepare plugin directory ${targetDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const run = deps.runPackageManager ?? runPackageManagerInstall;
  const pmArgs = buildInstallArgs(pm, targetDir, runScripts, spec);
  let result: PackageManagerRunResult;
  try {
    result = await run(pm, pmArgs, targetDir);
  } catch (err) {
    return errorResult(
      `${pm} failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (result.code !== 0) {
    const tail = (result.stderr || result.stdout).trim().split('\n').slice(-8).join('\n');
    return errorResult(`${pm} ${pmArgs.join(' ')} failed (exit ${result.code}):\n${tail}`);
  }

  const pkgName = packageNameFromSpec(spec);
  const installPath = join(targetDir, 'node_modules', ...pkgName.split('/'));
  try {
    await fs.access(installPath);
  } catch {
    return errorResult(
      `${pm} reported success but "${installPath}" does not exist — check the package name "${pkgName}".`,
    );
  }

  const upsert = await upsertPlugin(
    pkgName,
    { enabled: !args.includes('--disabled'), path: installPath },
    deps,
    'Installed',
  );
  if (upsert.code !== 0) return upsert;
  return {
    ...upsert,
    message:
      `${upsert.message} Loaded from ${installPath}. It will be trusted (pinned) on first load.` +
      (runScripts
        ? ''
        : ' Install scripts were skipped (default --ignore-scripts; pass --run-scripts if the package needs build steps).'),
  };
}
