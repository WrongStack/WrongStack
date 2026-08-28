import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import type { TerminalRenderer } from '../../renderer.js';
import { checkForUpdate, type UpdatePackageName } from '../../update-check.js';
import { buildWin32CmdShimInvocation } from '../../utils/win32-cmd.js';
import type { SubcommandDeps, SubcommandHandler } from '../contracts.js';

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface ParsedUpdateArgs {
  checkOnly: boolean;
  packageManager: PackageManager | undefined;
  /** Default false — pass --ignore-scripts to the package manager. */
  allowScripts: boolean;
  error: string | undefined;
}

interface UpdateCommand {
  executable: string;
  args: string[];
  display: string;
  windowsVerbatimArguments?: true | undefined;
}

interface UpdateProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const MAX_UPDATE_OUTPUT_CHARS = 256 * 1024;

interface UpdateCommandDeps {
  cwd: string;
  userHome: string;
  renderer: Pick<TerminalRenderer, 'write'>;
  flags?: SubcommandDeps['flags'] | undefined;
  /** Test seam for a Windows PATH lookup; production uses process.env. */
  environment?: NodeJS.ProcessEnv | undefined;
}

/** `wrongstack update` — Update the CLI via the detected global package manager. */
export async function runUpdateCommand(args: string[], deps: UpdateCommandDeps): Promise<number> {
  const cwd = deps.cwd;

  if (deps.flags?.['help'] === true || deps.flags?.['help'] === 'true') {
    writeUpdateUsage(deps.renderer);
    return 0;
  }
  const unsupportedFlag = Object.keys(deps.flags ?? {}).find(
    (flag) =>
      ![
        'check-only',
        'c',
        'pm',
        'package-manager',
        'allow-scripts',
        'lifecycle-scripts',
        'npm',
        'pnpm',
        'yarn',
        'bun',
        'help',
        'no-banner',
        'verbose',
        'trace',
      ].includes(flag),
  );
  if (unsupportedFlag) {
    deps.renderer.write(`Unknown update option: --${unsupportedFlag}\n`);
    writeUpdateUsage(deps.renderer);
    return 1;
  }

  const parsed = parseUpdateArgs(mergeUpdateArgs(args, deps.flags));
  if (parsed.error) {
    deps.renderer.write(`${parsed.error}\n`);
    writeUpdateUsage(deps.renderer);
    return 1;
  }

  const packageName = detectUpdatePackageName();
  const info = await checkForUpdate({
    packageName,
    forceRefresh: true,
    homeFn: () => deps.userHome,
  });

  if (info.checkFailed) {
    deps.renderer.write(
      `Update check failed for ${packageName}. Check your internet connection and try again.\n`,
    );
    return 1;
  }

  if (parsed.checkOnly) {
    if (info.outdated) {
      deps.renderer.write(`Update available: v${info.current} → v${info.latest}\n`);
    } else {
      deps.renderer.write(`You are on the latest version: v${info.current}\n`);
    }
    return 0;
  }

  if (!info.outdated) {
    deps.renderer.write(`You are already on the latest version: v${info.current}\n`);
    return 0;
  }

  const packageManager = parsed.packageManager ?? detectUpdatePackageManager();
  let updateCommand: UpdateCommand;
  try {
    updateCommand = buildUpdateCommand(packageManager, packageName, info.latest, {
      allowScripts: parsed.allowScripts,
      cwd,
      env: deps.environment,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.renderer.write(`\nUpdate failed: ${msg}\n`);
    return 1;
  }

  deps.renderer.write(`Updating wrongstack from v${info.current} to v${info.latest}...\n`);
  deps.renderer.write(`Running: ${updateCommand.display}\n`);

  try {
    const result = await new Promise<UpdateProcessResult>((resolve, reject) => {
      const child = spawn(updateCommand.executable, updateCommand.args, {
        cwd,
        stdio: 'pipe',
        signal: AbortSignal.timeout(120_000),
        windowsHide: true,
        ...(updateCommand.windowsVerbatimArguments
          ? { windowsVerbatimArguments: updateCommand.windowsVerbatimArguments }
          : {}),
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (data) => {
        stdout = appendOutputTail(stdout, data);
      });
      child.stderr?.on('data', (data) => {
        stderr = appendOutputTail(stderr, data);
      });
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });

    if (result.code === 0 && result.signal === null) {
      deps.renderer.write(
        `\nUpdated to v${info.latest}. Restart wrongstack to use the new version.\n`,
      );
      const warning = installWarningSummary(`${result.stderr}\n${result.stdout}`);
      if (warning) deps.renderer.write(`\n${warning}\n`);
    } else {
      // A bare "exit code 243" is opaque — npm's actual reason (EACCES, a custom
      // prefix it can't write, a pnpm/yarn/bun global that npm doesn't own) lives
      // in stderr. Surface it, then show pinned equivalent commands.
      const termination =
        result.code === null
          ? `terminated by ${result.signal ?? 'an unknown signal'}`
          : `failed with exit code ${result.code}`;
      deps.renderer.write(`\nUpdate ${termination}.\n`);
      const detail = `${result.stderr}\n${result.stdout}`.trim();
      if (detail) deps.renderer.write(`\n${detail}\n`);
      const lockedFilesGuidance = windowsLockedFilesGuidance(detail);
      if (lockedFilesGuidance) deps.renderer.write(`\n${lockedFilesGuidance}\n`);
      deps.renderer.write(
        `\nTry the matching global update command manually:\n  ${updateCommand.display}\n` +
          otherManagerCommands(packageManager, packageName, info.latest, {
            allowScripts: parsed.allowScripts,
          }),
      );
    }
    return result.code ?? 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      deps.renderer.write(`\nUpdate failed: ${packageManager} not found in PATH.\n`);
      return 1;
    }
    deps.renderer.write(`\nUpdate failed: ${msg}\n`);
    return 1;
  }
}

export const updateCmd: SubcommandHandler = async (args, deps) => runUpdateCommand(args, deps);

function writeUpdateUsage(renderer: Pick<TerminalRenderer, 'write'>): void {
  renderer.write(
    'Usage: wstack update [--check-only] [--pm <manager>] [--allow-scripts (alias: --lifecycle-scripts)]\n',
  );
}

/** Rehydrate update flags stripped by the top-level parser before subcommand dispatch. */
function mergeUpdateArgs(args: string[], flags: SubcommandDeps['flags'] | undefined): string[] {
  const merged = [...args];
  if (!flags) return merged;

  const addBoolean = (name: string, alias = name): void => {
    if (flags[name] === true || flags[name] === 'true') merged.push(`--${alias}`);
  };
  addBoolean('check-only');
  if (flags['c'] === true || flags['c'] === 'true') merged.push('-c');
  addBoolean('allow-scripts');
  addBoolean('lifecycle-scripts');
  for (const pm of ['npm', 'pnpm', 'yarn', 'bun'] as const) addBoolean(pm);

  const pmFlag = flags['pm'] ?? flags['package-manager'];
  if (typeof pmFlag === 'string') merged.push('--pm', pmFlag);
  else if (pmFlag === true) merged.push('--pm');
  return merged;
}

function parseUpdateArgs(args: string[]): ParsedUpdateArgs {
  let checkOnly = false;
  let packageManager: PackageManager | undefined;
  let allowScripts = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--check-only' || arg === '-c') {
      checkOnly = true;
      continue;
    }
    if (arg === '--pm' || arg === '--package-manager') {
      const value = args[++i];
      const pm = parsePackageManager(value);
      if (!pm)
        return {
          checkOnly,
          packageManager,
          allowScripts,
          error: `Invalid package manager: ${value ?? '<missing>'}`,
        };
      packageManager = pm;
      continue;
    }
    const pmEq = arg.match(/^--(?:pm|package-manager)=(.+)$/)?.[1];
    if (pmEq) {
      const pm = parsePackageManager(pmEq);
      if (!pm)
        return {
          checkOnly,
          packageManager,
          allowScripts,
          error: `Invalid package manager: ${pmEq}`,
        };
      packageManager = pm;
      continue;
    }
    const shorthand = arg.match(/^--(npm|pnpm|yarn|bun)$/)?.[1];
    if (shorthand) {
      packageManager = shorthand as PackageManager;
    }
    if (arg === '--allow-scripts' || arg === '--lifecycle-scripts') {
      allowScripts = true;
    }
  }

  return { checkOnly, packageManager, allowScripts, error: undefined };
}

function parsePackageManager(value: string | undefined): PackageManager | undefined {
  if (value === 'npm' || value === 'pnpm' || value === 'yarn' || value === 'bun') return value;
  return undefined;
}

export function detectUpdatePackageManager(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): PackageManager {
  const forced = parsePackageManager(env.WRONGSTACK_UPDATE_PM);
  if (forced) return forced;

  const userAgent = env.npm_config_user_agent ?? '';
  if (/\bpnpm\//i.test(userAgent)) return 'pnpm';
  if (/\byarn\//i.test(userAgent)) return 'yarn';
  if (/\bbun\//i.test(userAgent)) return 'bun';
  if (/\bnpm\//i.test(userAgent)) return 'npm';

  const execPath = `${env.npm_execpath ?? ''} ${argv[1] ?? ''}`;
  const realPaths = [env.npm_execpath, argv[1]]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => {
      try {
        return existsSync(p) ? realpathSync(p) : p;
      } catch {
        return p;
      }
    })
    .join(' ');
  const hint = `${execPath} ${realPaths}`.replace(/\\/g, '/').toLowerCase();
  if (hint.includes('/pnpm/') || hint.includes('/.pnpm/') || hint.includes('pnpm-global'))
    return 'pnpm';
  if (hint.includes('/yarn/') || hint.includes('/.yarn/')) return 'yarn';
  if (hint.includes('/bun/') || hint.includes('/.bun/')) return 'bun';
  return 'npm';
}

/** Detect whether the running binary belongs to the umbrella or direct CLI package. */
export function detectUpdatePackageName(argv: string[] = process.argv): UpdatePackageName {
  const entry = (argv[1] ?? '').replace(/\\/g, '/').toLowerCase();
  return entry.includes('/node_modules/@wrongstack/cli/') || entry.includes('/packages/cli/dist/')
    ? '@wrongstack/cli'
    : 'wrongstack';
}

function buildUpdateCommand(
  packageManager: PackageManager,
  packageName: UpdatePackageName,
  version: string,
  opts: { allowScripts: boolean; cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined } = {
    allowScripts: false,
  },
): UpdateCommand {
  // Default to --ignore-scripts so a compromised `wrongstack@latest` cannot
  // run arbitrary code in the user's postinstall. Opt back in with
  // --allow-scripts for the legacy behavior. The flag is supported on all
  // four managers (`npm install -g`, `pnpm add -g`, `yarn global add`,
  // `bun add -g`).
  const ignoreScripts = !opts.allowScripts;
  const target = `${packageName}@${version}`;
  switch (packageManager) {
    case 'pnpm':
      return command(
        packageManager,
        ignoreScripts ? ['add', '-g', '--ignore-scripts', target] : ['add', '-g', target],
        opts.cwd,
        opts.env,
      );
    case 'yarn':
      return command(
        packageManager,
        ignoreScripts ? ['global', 'add', '--ignore-scripts', target] : ['global', 'add', target],
        opts.cwd,
        opts.env,
      );
    case 'bun':
      return command(
        packageManager,
        ignoreScripts ? ['add', '-g', '--ignore-scripts', target] : ['add', '-g', target],
        opts.cwd,
        opts.env,
      );
    case 'npm':
      return command(
        packageManager,
        ignoreScripts ? ['install', '-g', '--ignore-scripts', target] : ['install', '-g', target],
        opts.cwd,
        opts.env,
      );
  }
}

function command(
  pm: PackageManager,
  args: string[],
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
): UpdateCommand {
  const display = `${pm} ${args.join(' ')}`;
  const resolvedExecutable = cwd ? resolveWin32PackageManagerPath(pm, cwd, env) : undefined;
  if (process.platform === 'win32' && cwd && !resolvedExecutable) {
    throw new Error(
      `Could not find ${pm} outside the current project directory. ` +
        `Install ${pm} globally or put its global executable directory on PATH.`,
    );
  }
  const executable = resolvedExecutable ?? pm;
  if (process.platform === 'win32' && (pm !== 'bun' || /\.(?:cmd|bat)$/i.test(executable))) {
    const shim = buildWin32CmdShimInvocation(executable, args);
    return {
      executable: shim.command,
      args: shim.args,
      display,
      windowsVerbatimArguments: shim.windowsVerbatimArguments,
    };
  }
  return { executable, args, display };
}

/**
 * Resolve a global package-manager executable without consulting the project
 * directory. `cmd.exe` searches its cwd before PATH, so `call npm` can pick a
 * stale `node_modules/.bin/npm.cmd` and then look for npm below that project.
 * A self-update must never use a project's package-manager shim.
 */
function resolveWin32PackageManagerPath(
  packageManager: PackageManager,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  pathExists: (candidate: string) => boolean = existsSync,
): string | undefined {
  if (process.platform !== 'win32') return undefined;

  const pathValue = environmentValue(env, 'PATH');
  if (!pathValue) return undefined;
  const cwdPath = path.win32.resolve(cwd).toLowerCase();
  const extensions = packageManager.includes('.')
    ? ['']
    : (environmentValue(env, 'PATHEXT')?.split(';').filter(Boolean) ?? [
        '.COM',
        '.EXE',
        '.BAT',
        '.CMD',
      ]);

  for (const rawEntry of pathValue.split(';')) {
    const entry = rawEntry.trim().replace(/^"|"$/g, '');
    // Empty and relative PATH entries resolve through the project cwd, exactly
    // the shadowing route this helper is meant to avoid.
    if (!entry || !path.win32.isAbsolute(entry)) continue;
    const directory = path.win32.resolve(entry);
    if (isPathInsideWin32(directory, cwdPath)) continue;
    for (const extension of extensions) {
      const candidate = path.win32.join(directory, `${packageManager}${extension}`);
      if (pathExists(candidate)) return candidate;
    }
  }
  return undefined;
}

function environmentValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const match = Object.entries(env).find(([name]) => name.toUpperCase() === key);
  return typeof match?.[1] === 'string' ? match[1] : undefined;
}

function isPathInsideWin32(candidate: string, parent: string): boolean {
  const normalizedCandidate = path.win32.resolve(candidate).toLowerCase();
  const normalizedParent = path.win32.resolve(parent).toLowerCase();
  const relative = path.win32.relative(normalizedParent, normalizedCandidate);
  return (
    relative === '' ||
    (!relative.startsWith('..\\') && relative !== '..' && !path.win32.isAbsolute(relative))
  );
}

function otherManagerCommands(
  selected: PackageManager,
  packageName: UpdatePackageName,
  version: string,
  opts: { allowScripts: boolean } = { allowScripts: false },
): string {
  const commands = (['npm', 'pnpm', 'yarn', 'bun'] as const)
    .filter((pm) => pm !== selected)
    .map((pm) => `  ${buildUpdateCommand(pm, packageName, version, opts).display}`);
  return commands.length > 0 ? `\nOther package managers:\n${commands.join('\n')}\n` : '';
}

function appendOutputTail(current: string, chunk: unknown): string {
  const next = current + String(chunk);
  return next.length <= MAX_UPDATE_OUTPUT_CHARS
    ? next
    : next.slice(next.length - MAX_UPDATE_OUTPUT_CHARS);
}

function installWarningSummary(output: string): string | null {
  if (!/allow-scripts|allowScripts/i.test(output)) return null;
  return (
    'Install completed, but npm reported blocked lifecycle scripts. If a native optional ' +
    'feature is missing, rerun the update with npm script approval for the named package.'
  );
}

function windowsLockedFilesGuidance(output: string): string | null {
  if (process.platform !== 'win32') return null;
  const hasLockError = /\b(?:EBUSY|EPERM|EACCES|ENOTEMPTY)\b/i.test(output);
  const isWrongStackNativeFile =
    /(?:\.wrongstack-|wrongstack[\\/]node_modules|electron\.exe|dd_pprof\.node|node-pty)/i.test(
      output,
    );
  if (!hasLockError || !isWrongStackNativeFile) return null;
  return (
    'Windows could not replace a native file held by a running WrongStack process. ' +
    'Stop any WrongStack WebUI, Desktop, or background process, then rerun the same update command. ' +
    'Do not remove npm’s .wrongstack-* staging directory until those processes have stopped.'
  );
}
