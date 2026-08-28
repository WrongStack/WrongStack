#!/usr/bin/env node
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildChildEnv, expectDefined } from '@wrongstack/core/utils';
import { commandExistsOnPath, resolveServerCommand } from './utils/command-resolver.js';

type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

interface LanguageInstall {
  npmPackages?: string[] | undefined;
  binary: string;
  toolchain?: {
    command: string;
    args: string[];
    label: string;
  };
}

const DEFAULT_LANGUAGES = ['typescript', 'python', 'json', 'html', 'css', 'yaml', 'shell'];

const INSTALLS: Record<string, LanguageInstall> = {
  typescript: {
    binary: 'typescript-language-server',
    npmPackages: ['typescript', 'typescript-language-server'],
  },
  python: {
    binary: 'pyright-langserver',
    npmPackages: ['pyright'],
  },
  json: {
    binary: 'vscode-json-language-server',
    npmPackages: ['vscode-langservers-extracted'],
  },
  html: {
    binary: 'vscode-html-language-server',
    npmPackages: ['vscode-langservers-extracted'],
  },
  css: {
    binary: 'vscode-css-language-server',
    npmPackages: ['vscode-langservers-extracted'],
  },
  yaml: {
    binary: 'yaml-language-server',
    npmPackages: ['yaml-language-server'],
  },
  shell: {
    binary: 'bash-language-server',
    npmPackages: ['bash-language-server'],
  },
  go: {
    binary: 'gopls',
    toolchain: {
      command: 'go',
      args: ['install', 'golang.org/x/tools/gopls@latest'],
      label: 'Go toolchain',
    },
  },
  rust: {
    binary: 'rust-analyzer',
    toolchain: {
      command: 'rustup',
      args: ['component', 'add', 'rust-analyzer'],
      label: 'Rust toolchain',
    },
  },
  ruby: {
    binary: 'ruby-lsp',
    toolchain: {
      command: 'gem',
      args: ['install', 'ruby-lsp'],
      label: 'RubyGems',
    },
  },
};

interface SetupOptions {
  cwd: string;
  languages: string[];
  dryRun: boolean;
  toolchains: boolean;
}

export interface SetupDeps {
  resolveServerCommand: typeof resolveServerCommand;
  commandExistsOnPath: typeof commandExistsOnPath;
  run: (command: string, args: string[], cwd: string) => Promise<void>;
  log: (message: string) => void;
  cwd: () => string;
  exit?: ((code: number) => never) | undefined;
}

/* v8 ignore start -- default process-bound deps are covered through injectable deps. */
const DEFAULT_DEPS: SetupDeps = {
  resolveServerCommand,
  commandExistsOnPath,
  run: runCommand,
  log: (message) => console.log(message),
  cwd: () => process.cwd(),
  exit: (code) => process.exit(code),
};
/* v8 ignore stop */

export async function runSetup(args: string[], deps: SetupDeps = DEFAULT_DEPS): Promise<void> {
  const opts = parseArgs(args, deps);
  const missing = opts.languages.filter((lang) => !INSTALLS[lang]);
  if (missing.length > 0) {
    throw new Error(`Unknown language preset(s): ${missing.join(', ')}`);
  }

  const alreadyInstalled: string[] = [];
  const npmPackages = new Set<string>();
  const toolchainInstalls: Array<NonNullable<LanguageInstall['toolchain']>> = [];

  for (const lang of opts.languages) {
    const install = expectDefined(INSTALLS[lang]);
    if (await deps.resolveServerCommand(install.binary, opts.cwd)) {
      alreadyInstalled.push(lang);
      continue;
    }
    for (const pkg of install.npmPackages ?? []) npmPackages.add(pkg);
    if (install.toolchain) toolchainInstalls.push(install.toolchain);
  }

  if (alreadyInstalled.length > 0) {
    deps.log(`Already available: ${alreadyInstalled.join(', ')}`);
  }

  if (npmPackages.size > 0) {
    const pm = await detectPackageManager(opts.cwd);
    const { command, args } = installCommand(pm, Array.from(npmPackages));
    await runOrPrint(
      command,
      args,
      opts.cwd,
      opts.dryRun,
      'Installing npm-based LSP servers',
      deps,
    );
  }

  for (const installer of toolchainInstalls) {
    if (!opts.toolchains) {
      deps.log(`Skipping ${installer.label}; rerun without --no-toolchains to install.`);
      continue;
    }
    if (!(await deps.commandExistsOnPath(installer.command))) {
      deps.log(`Missing ${installer.label}: command "${installer.command}" is not on PATH.`);
      continue;
    }
    await runOrPrint(
      installer.command,
      installer.args,
      opts.cwd,
      opts.dryRun,
      `Installing via ${installer.label}`,
      deps,
    );
  }

  deps.log('LSP setup finished.');
}

export function parseArgs(
  args: string[],
  deps: Pick<SetupDeps, 'cwd' | 'exit' | 'log'> = DEFAULT_DEPS,
): SetupOptions {
  let cwd = deps.cwd();
  let languages = DEFAULT_LANGUAGES;
  let dryRun = false;
  let toolchains = true;

  for (let i = 0; i < args.length; i++) {
    const arg = expectDefined(args[i]);
    if (arg === '--cwd') {
      cwd = path.resolve(requiredValue(args, ++i, '--cwd'));
    } else if (arg === '--languages') {
      languages = requiredValue(args, ++i, '--languages')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--no-toolchains') {
      toolchains = false;
    } else if (arg === '--help' || arg === '-h') {
      printHelp(deps.log);
      deps.exit?.(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { cwd, languages, dryRun, toolchains };
}

export async function detectPackageManager(cwd: string): Promise<PackageManager> {
  if (await exists(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if ((await exists(path.join(cwd, 'bun.lockb'))) || (await exists(path.join(cwd, 'bun.lock'))))
    return 'bun';
  if (await exists(path.join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

export function installCommand(
  pm: PackageManager,
  packages: string[],
): { command: string; args: string[] } {
  if (pm === 'pnpm') return { command: 'pnpm', args: ['add', '-D', ...packages] };
  if (pm === 'yarn') return { command: 'yarn', args: ['add', '-D', ...packages] };
  if (pm === 'bun') return { command: 'bun', args: ['add', '-d', ...packages] };
  return { command: 'npm', args: ['install', '-D', ...packages] };
}

async function runOrPrint(
  command: string,
  args: string[],
  cwd: string,
  dryRun: boolean,
  label: string,
  deps: Pick<SetupDeps, 'run' | 'log'>,
): Promise<void> {
  const rendered = [command, ...args].join(' ');
  if (dryRun) {
    deps.log(`[dry-run] ${label}: ${rendered}`);
    return;
  }
  deps.log(`${label}: ${rendered}`);
  await deps.run(command, args, cwd);
}

export function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: buildChildEnv(),
      stdio: 'inherit',
      shell,
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${formatExitCode(code)}`));
    });
  });
}

function formatExitCode(code: number | null): string {
  return code === null ? 'null' : String(code);
}

/** Direct-module test seam; not re-exported by the package barrel. */
export const setupCoverage = { formatExitCode };

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function requiredValue(args: string[], index: number, name: string): string {
  const value = args[index];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function printHelp(log: (message: string) => void): void {
  log(`wrongstack-lsp-setup

Install Language Server Protocol binaries for @wrongstack/plug-lsp.

Options:
  --cwd <path>             Project directory. Defaults to current directory.
  --languages <list>       Comma list. Defaults to ${DEFAULT_LANGUAGES.join(',')}.
                           Available: ${Object.keys(INSTALLS).join(',')}.
  --dry-run                Print commands without running them.
  --no-toolchains          Skip Go/Rust/Ruby toolchain installers.
`);
}

/* v8 ignore start -- CLI process-exit wrapper is exercised by invoking the built bin, not unit imports. */
const isCliEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isCliEntrypoint) {
  runSetup(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
/* v8 ignore stop */
