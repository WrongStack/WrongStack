import { join } from 'node:path';
import type { Tool, ToolStreamEvent } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import {
  detectEcosystem as detectPackageEcosystem,
  recordPackageAction,
} from '@wrongstack/core/coordination';
import { spawnStream } from './_spawn-stream.js';
import { detectPackageManager, normalizeCommandOutput, safeResolveReal } from './_util.js';
import { detectNonJsEcosystem, tryLegacyPackageOperation } from './languages/legacy-bridge.js';

export type InstallSaveType = 'dependency' | 'dev' | 'optional';

export interface InstallInput {
  packages?: string | string[] | undefined;
  save?: InstallSaveType | undefined;
  cwd?: string | undefined;
  dry_run?: boolean | undefined;
  global?: boolean | undefined;
  /**
   * Allow package lifecycle scripts (`preinstall`, `install`, `postinstall`,
   * `prepare`, …) to run during the install. Defaults to `false` — installs
   * pass `--ignore-scripts` so a malicious package cannot execute arbitrary
   * code at install time. Setting `true` opts in to the legacy behavior.
   */
  lifecycleScripts?: boolean | undefined;
}

export interface InstallOutput {
  packages: string[];
  exit_code: number;
  output: string;
  dry_run: boolean;
  truncated: boolean;
}

export type InstallContext = Parameters<Tool<InstallInput, InstallOutput>['execute']>[1];

export const installTool: Tool<InstallInput, InstallOutput> = {
  name: 'install',
  category: 'Package Management',
  description:
    'Install, update or manage packages using the detected package manager (pnpm/npm/yarn). ' +
    'Strongly preferred over raw shell commands for dependency management because it is structured and safer.',
  usageHint:
    'ALWAYS USE THIS INSTEAD OF BASH FOR PACKAGE WORK:\n\n' +
    '- Empty `packages` → normal `install` (respects lockfile).\n' +
    '- Provide names → adds/updates specific packages.\n' +
    '- `dry_run: true` for safe preview.\n' +
    '- Set `save` appropriately.\n' +
    'This tool has proper capability declaration and is heavily recommended in the security posture of the project.',
  permission: 'confirm',
  // WS-046: gives permission decisions something to key on.
  // What gets installed is the subject — installing a package runs its
  // lifecycle scripts, so `express` and `evil-pkg` must not be interchangeable.
  subjectKey: 'packages',
  // Running lifecycle scripts executes package code, and a global install
  // writes outside the project: an approval for the default (scripts off,
  // project-local) install must not cover either.
  subjectFields: ['lifecycleScripts', 'global'],
  mutating: true,
  riskTier: 'standard',
  icon: 'package',
  timeoutMs: 120_000,
  capabilities: ['package.install', 'shell.restricted'],
  inputSchema: {
    type: 'object',
    properties: {
      packages: {
        type: 'string',
        description:
          'Package(s) to install: single name, comma-separated list, or empty for all deps',
      },
      save: {
        type: 'string',
        enum: ['dependency', 'dev', 'optional'],
        description:
          'Where to save the package(s): "dependency", "devDependencies", or "optionalDependencies".',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the install command (must stay inside project).',
      },
      dry_run: {
        type: 'boolean',
        description:
          'If true, show what would be installed without actually modifying package.json or node_modules.',
      },
      global: {
        type: 'boolean',
        description: 'Whether to perform a global install (use with caution).',
      },
      lifecycleScripts: {
        type: 'boolean',
        description:
          'Opt in to running package lifecycle scripts (preinstall / install / postinstall / prepare / …). Default: false — installs pass --ignore-scripts so a malicious package cannot execute arbitrary code at install time. Set true to opt back in to the legacy npm/pnpm/yarn default.',
      },
    },
  },
  async execute(input: InstallInput, ctx: InstallContext, opts?: { signal: AbortSignal }) {
    let final: InstallOutput | undefined;
    const executeStream = installTool.executeStream;
    if (!executeStream) throw new Error('installTool: stream execution unavailable');
    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    for await (const ev of executeStream(input, ctx, { signal })) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) throw new Error('install: stream ended without final event');
    return final;
  },
  async *executeStream(
    input: InstallInput,
    ctx: InstallContext,
    opts?: { signal: AbortSignal },
  ): AsyncGenerator<ToolStreamEvent<InstallOutput>> {
    if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !input.cwd.trim())) {
      throw new ToolValidationError({
        message: 'install: cwd must be a non-empty string when provided.',
        field: 'cwd',
      });
    }

    let cwd: string;
    try {
      cwd =
        input.cwd || ctx.workingDir
          ? await safeResolveReal(input.cwd ?? ctx.workingDir!, ctx)
          : ctx.cwd;
    } catch (err) {
      throw new ToolValidationError({
        message: `install: ${(err as Error).message}`,
        field: 'cwd',
      });
    }
    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    signal.throwIfAborted();

    if (
      input.packages !== undefined &&
      typeof input.packages !== 'string' &&
      !Array.isArray(input.packages)
    ) {
      throw new ToolValidationError({
        message: 'install: packages must be a string or array of strings',
        field: 'packages',
      });
    }

    const VALID_SAVES: ReadonlySet<string> = new Set(['dependency', 'dev', 'optional']);
    if (input.save !== undefined && !VALID_SAVES.has(input.save)) {
      throw new ToolValidationError({
        message: `install: invalid save option "${input.save}". Allowed: dependency, dev, optional`,
        field: 'save',
      });
    }

    // A dry run must not install. yarn 1 silently ignores `--dry-run` and
    // installs (package.json and yarn.lock rewritten), and the language
    // planner below has no dry-run mode at all (`cargo fetch`,
    // `go mod download`, … ran for real). Refuse instead.
    const refuseDryRun = (manager: string): never => {
      throw new ToolValidationError({
        message: `install: dry_run is not supported for ${manager} projects — it has no dry-run mode, so nothing was run.`,
        field: 'dry_run',
      });
    };
    if (input.dry_run && !input.global) {
      const nonJs = await detectNonJsEcosystem(cwd, ctx.projectRoot);
      if (nonJs) refuseDryRun(nonJs);
    }

    // Delegate to the language planner for non-JS ecosystems (Go, Rust, PHP, C#).
    if (!input.global) {
      const rawList = input.packages
        ? (Array.isArray(input.packages) ? input.packages : input.packages.split(','))
            .filter((p): p is string => typeof p === 'string')
            .map((p) => p.trim())
            .filter(Boolean)
        : [];
      const pkgList = Array.from(new Set(rawList));
      const bridge = await tryLegacyPackageOperation(
        'package-install',
        {
          cwd,
          projectRoot: ctx.projectRoot,
          signal,
        },
        pkgList,
      );
      if (bridge?.outcome) {
        const outcome = bridge.outcome;
        const run = outcome.run;
        if (outcome.status !== 'passed') {
          throw new Error(
            `install: ${bridge.language} package install ${outcome.status}` +
              `${run?.exitCode != null ? ` (exit ${run.exitCode})` : ''}` +
              `${run?.error ? `: ${run.error}` : ''}${failureTail(run?.output ?? '')}`,
          );
        }
        yield {
          type: 'final',
          output: {
            exit_code: run?.exitCode ?? 0,
            packages: pkgList,
            output: normalizeCommandOutput(
              run?.output || outcome.manifestsChanged.join(', ') || 'ok',
            ),
            truncated: run?.truncated ?? false,
            dry_run: input.dry_run ?? false,
          },
        };
        return;
      }
    }

    const pkgManager = await detectPackageManager(cwd, ctx.projectRoot);
    if (input.dry_run && pkgManager === 'yarn') refuseDryRun(pkgManager);
    yield { type: 'log', text: `Resolving with ${pkgManager}…`, data: { phase: 'resolve' } };

    const globalFlag = input.global ? ['-g'] : [];
    // Default to ignoring lifecycle scripts. A package's `postinstall`
    // runs with full shell access inside the project; without this gate a
    // typo-squatted or compromised dependency can execute arbitrary code
    // the moment it lands in `node_modules`. Opt-in only.
    const ignoreScripts = input.lifecycleScripts !== true;

    const rawList = input.packages
      ? (Array.isArray(input.packages) ? input.packages : input.packages.split(','))
          .filter((p): p is string => typeof p === 'string')
          .map((p) => p.trim())
          .filter(Boolean)
      : [];
    const pkgList = Array.from(new Set(rawList));

    // Validate package specs to prevent flag injection and path traversal.
    // A name like "--ignore-scripts=false" would be interpreted as a flag;
    // "file:../../etc/passwd" as a local path specifier. An optional trailing
    // `@<version-ish>` suffix (e.g. `react@18`, `@scope/pkg@^1.2.3`,
    // `vitest@latest`) is allowed; whitespace and shell metacharacters are not.
    // Cap at 200 chars to prevent ReDoS on the regex engine (npm's max is 214).
    const PKG_NAME_RE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[a-z0-9^~><=*.+-]+)?$/i;
    for (const pkg of pkgList) {
      // A spec starting with "." is a directory to npm/pnpm/yarn (`..` installs
      // the parent folder); no registry name starts with one.
      if (
        !PKG_NAME_RE.test(pkg) ||
        pkg.startsWith('-') ||
        pkg.startsWith('.') ||
        pkg.length > 200
      ) {
        throw new ToolValidationError({
          message: `install: Invalid package name "${pkg}". Names must match ${PKG_NAME_RE} and not start with "-" or ".".`,
          field: 'packages',
        });
      }
    }

    const hasPkgs = pkgList.length > 0;
    // Yarn 2+ has no `--ignore-scripts` ("Unsupported option name"); its
    // equivalent is `--mode=skip-build` on the subcommand.
    const yarnBerry = pkgManager === 'yarn' && (await isYarnBerry(cwd, ctx.projectRoot));
    const args: string[] = [];
    if (input.dry_run) args.push('--dry-run');
    if (ignoreScripts && !yarnBerry) args.push('--ignore-scripts');
    if (pkgManager === 'pnpm') {
      if (hasPkgs) {
        if (input.save === 'dev') args.push('-D');
        else if (input.save === 'optional') args.push('-O');
        args.push('add', ...globalFlag);
      } else {
        // Bare `pnpm add` with no packages errors; an empty list means
        // "install everything from the lockfile".
        args.push('install', ...globalFlag);
      }
    } else if (pkgManager === 'yarn') {
      if (hasPkgs) {
        args.push('add', ...globalFlag);
        if (input.save === 'dev') args.push('--dev');
        else if (input.save === 'optional') args.push('--optional');
      } else {
        // Bare `yarn add` with no packages errors; use `yarn install`.
        args.push('install', ...globalFlag);
      }
      if (ignoreScripts && yarnBerry) args.push('--mode=skip-build');
    } else {
      args.push('install', ...globalFlag);
      if (hasPkgs) {
        if (input.save === 'dev') args.push('--save-dev');
        else if (input.save === 'optional') args.push('--save-optional');
      }
    }

    if (hasPkgs) args.push(...pkgList);

    yield {
      type: 'log',
      text: `Fetching ${pkgList.length || 'all'} packages…`,
      data: { phase: 'fetch' },
    };

    const result = yield* spawnStream({
      cmd: pkgManager,
      args,
      cwd,
      signal,
      maxBytes: 100_000,
    });
    // Package manager could not be started at all.
    if (result.error) {
      throw new Error(`install: could not run ${pkgManager}: ${result.error}`);
    }

    const rawOutput =
      result.stdout && result.stderr
        ? `${result.stdout}\n${result.stderr}`
        : result.stdout || result.stderr || result.error || '';

    const output: InstallOutput = {
      packages: pkgList,
      exit_code: result.exitCode,
      output: normalizeCommandOutput(rawOutput),
      dry_run: args.includes('--dry-run'),
      truncated: result.truncated,
    };

    // Record package authorship after a successful, non-dry-run install.
    // Skip global installs (no manifest modification) and dry runs.
    const isSuccess = result.exitCode === 0 && !output.dry_run && !input.global;
    if (isSuccess && pkgList.length > 0) {
      const trackerOpts = ctx.meta?.['packageTrackerOpts'] as
        | {
            storageDir: string;
            projectRoot: string;
          }
        | undefined;
      if (trackerOpts) {
        const manifestPath = resolveManifestPath(cwd, pkgManager);
        for (const pkg of pkgList) {
          try {
            await recordPackageAction(trackerOpts, {
              manifestPath,
              packageName: pkg,
              versionSpec: 'latest', // exact version resolved by package manager at install time
              ecosystem: detectPackageEcosystem(manifestPath),
              agentId: ctx.agentId,
              agentName: ctx.agentName,
              sessionId: ctx.session?.id,
            });
          } catch {
            // Best-effort — a failed record doesn't fail the install
          }
        }
      }
    }

    // P2 #5: record the package operation as a structured side effect.
    ctx.recordSideEffect?.({
      toolUseId: `install-${Date.now()}`,
      toolName: 'install',
      ts: new Date().toISOString(),
      input: { packages: pkgList, cwd, dry_run: Boolean(input.dry_run) },
      outcome: output.dry_run
        ? 'dry run'
        : result.exitCode === 0
          ? `installed ${pkgList.length || 'all'} packages`
          : `failed (exit ${result.exitCode})`,
      risk: 'package',
    });

    // The install did not happen (resolution error, network, 404 …). Throw so
    // the executor records a failed call; the side effect above is kept.
    if (result.exitCode !== 0) {
      throw new Error(
        `install: ${pkgManager} ${args.filter((a) => !a.startsWith('-')).join(' ')} failed ` +
          `(exit ${result.exitCode})${failureTail(output.output)}`,
      );
    }

    yield { type: 'final', output };
  },
} satisfies Tool<InstallInput, InstallOutput>;

/**
 * Yarn 2+ ("Berry") is selected by `packageManager: "yarn@2+"` or a
 * `.yarnrc.yml`; without either, the yarn on PATH runs as Yarn 1 (classic).
 * Walks from `cwd` up to `stopAt`, nearest declaration wins.
 */
async function isYarnBerry(cwd: string, stopAt: string): Promise<boolean> {
  const { readFile, stat } = await import('node:fs/promises');
  const { dirname, isAbsolute, relative, resolve, sep } = await import('node:path');
  let dir = resolve(cwd);
  const stop = resolve(stopAt);
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
        packageManager?: unknown;
      };
      if (typeof manifest.packageManager === 'string') {
        const major = /^yarn@(\d+)/.exec(manifest.packageManager)?.[1];
        if (major) return Number(major) >= 2;
      }
    } catch {
      // no/invalid package.json here — keep looking
    }
    if (
      await stat(join(dir, '.yarnrc.yml')).then(
        () => true,
        () => false,
      )
    )
      return true;
    const parent = dirname(dir);
    const rel = relative(stop, parent);
    if (
      dir === stop ||
      parent === dir ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel)
    ) {
      return false;
    }
    dir = parent;
  }
}

/** Last few KB of the package-manager output, for an actionable error message. */
function failureTail(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return '';
  const MAX = 4_000;
  return `:\n${trimmed.length > MAX ? `…${trimmed.slice(-MAX)}` : trimmed}`;
}

function resolveManifestPath(cwd: string, pkgManager: string): string {
  switch (pkgManager) {
    case 'pnpm':
    case 'yarn':
    case 'npm':
      return join(cwd, 'package.json');
    /* v8 ignore next 2 -- pkgManager is always pnpm/yarn/npm; the default is defensive. */
    default:
      return join(cwd, 'package.json');
  }
}
