import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { buildChildEnv } from '@wrongstack/core/utils';
import { commandExistsOnPath, resolveServerCommand } from '../utils/command-resolver.js';

interface LanguageServerConfig {
  binary: string;
  npmPackages?: string[];
  args?: string[];
  languages: string[];
  rootPatterns?: string[];
  toolchain?: {
    command: string;
    args: string[];
    label: string;
  };
}

export interface InstallResult {
  language: string;
  binary: string;
  alreadyInstalled: boolean;
  dryRun: boolean;
  installCommand?: string;
  packageManager?: string;
  error?: string;
}

export const LANGUAGE_SERVERS: Record<string, LanguageServerConfig> = {
  typescript: {
    binary: 'typescript-language-server',
    npmPackages: ['typescript', 'typescript-language-server'],
    args: ['--stdio'],
    languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    rootPatterns: ['tsconfig.json', 'jsconfig.json', 'package.json'],
  },
  python: {
    binary: 'pyright-langserver',
    npmPackages: ['pyright'],
    args: ['--stdio'],
    languages: ['python'],
    rootPatterns: ['pyproject.toml', 'pyrightconfig.json', 'setup.py', 'requirements.txt'],
  },
  json: {
    binary: 'vscode-json-language-server',
    npmPackages: ['vscode-langservers-extracted'],
    args: ['--stdio'],
    languages: ['json'],
    rootPatterns: ['package.json'],
  },
  html: {
    binary: 'vscode-html-language-server',
    npmPackages: ['vscode-langservers-extracted'],
    args: ['--stdio'],
    languages: ['html'],
    rootPatterns: ['package.json'],
  },
  css: {
    binary: 'vscode-css-language-server',
    npmPackages: ['vscode-langservers-extracted'],
    args: ['--stdio'],
    languages: ['css', 'scss'],
    rootPatterns: ['package.json'],
  },
  yaml: {
    binary: 'yaml-language-server',
    npmPackages: ['yaml-language-server'],
    args: ['--stdio'],
    languages: ['yaml'],
    rootPatterns: ['package.json', '.git'],
  },
  shell: {
    binary: 'bash-language-server',
    npmPackages: ['bash-language-server'],
    args: ['start'],
    languages: ['shellscript'],
    rootPatterns: ['package.json', '.git'],
  },
  go: {
    binary: 'gopls',
    toolchain: {
      command: 'go',
      args: ['install', 'golang.org/x/tools/gopls@latest'],
      label: 'Go toolchain',
    },
    languages: ['go'],
    rootPatterns: ['go.mod', 'go.work'],
  },
  rust: {
    binary: 'rust-analyzer',
    toolchain: {
      command: 'rustup',
      args: ['component', 'add', 'rust-analyzer'],
      label: 'Rust toolchain',
    },
    languages: ['rust'],
    rootPatterns: ['Cargo.toml'],
  },
  ruby: {
    binary: 'ruby-lsp',
    toolchain: {
      command: 'gem',
      args: ['install', 'ruby-lsp'],
      label: 'RubyGems',
    },
    languages: ['ruby'],
    rootPatterns: ['Gemfile', '.ruby-version'],
  },
};

export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGE_SERVERS);

/**
 * Install a language server for the given language.
 * Returns an InstallResult describing what happened.
 */
export async function installLang(
  language: string,
  server: LanguageServerConfig,
  cwd: string,
  dryRun = false,
): Promise<InstallResult> {
  // Check if already available on PATH or in node_modules/.bin
  const existing = await resolveServerCommand(server.binary, cwd);
  if (existing) {
    return { language, binary: server.binary, alreadyInstalled: true, dryRun: false };
  }

  // Toolchain-based install (Go, Rust, Ruby)
  if (server.toolchain) {
    const { command, args, label } = server.toolchain;

    if (!(await commandExistsOnPath(command))) {
      return {
        language,
        binary: server.binary,
        alreadyInstalled: false,
        dryRun,
        installCommand: `${command} ${args.join(' ')}`,
        error: `${label} (${command}) is not on your PATH. Install it first.`,
      };
    }

    const installCmd = `${command} ${args.join(' ')}`;

    if (dryRun) {
      return {
        language,
        binary: server.binary,
        alreadyInstalled: false,
        dryRun: true,
        installCommand: installCmd,
      };
    }

    await runCommand(command, args, cwd, label);
    return {
      language,
      binary: server.binary,
      alreadyInstalled: false,
      dryRun: false,
      packageManager: 'system',
      installCommand: installCmd,
    };
  }

  // npm-based install
  if (server.npmPackages && server.npmPackages.length > 0) {
    const { command, args } = npmInstallCommand(server.npmPackages, cwd);
    const installCmd = `${command} ${args.join(' ')}`;

    if (dryRun) {
      return {
        language,
        binary: server.binary,
        alreadyInstalled: false,
        dryRun: true,
        installCommand: installCmd,
      };
    }

    try {
      await runCommand(command, args, cwd, `Installing ${language} LSP server via npm`);
      return {
        language,
        binary: server.binary,
        alreadyInstalled: false,
        dryRun: false,
        installCommand: installCmd,
      };
    } catch (err) {
      return {
        language,
        binary: server.binary,
        alreadyInstalled: false,
        dryRun: false,
        installCommand: installCmd,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    language,
    binary: server.binary,
    alreadyInstalled: false,
    dryRun,
    error: 'No installation method available for this server.',
  };
}

type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

function npmInstallCommand(packages: string[], cwd: string): { command: string; args: string[] } {
  // Detect PM from lock files but fall back to pnpm as the default
  const pm = detectPackageManagerSync(cwd);
  if (pm === 'pnpm') return { command: 'pnpm', args: ['add', '-D', ...packages] };
  if (pm === 'yarn') return { command: 'yarn', args: ['add', '-D', ...packages] };
  if (pm === 'bun') return { command: 'bun', args: ['add', '-d', ...packages] };
  return { command: 'npm', args: ['install', '-D', ...packages] };
}

function detectPackageManagerSync(cwd: string): PackageManager {
  // Heuristic only — async version checks actual files
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(cwd, 'bun.lockb')) || existsSync(path.join(cwd, 'bun.lock')))
    return 'bun';
  if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function runCommand(command: string, args: string[], cwd: string, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const isWindowsBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const child = spawn(command, args, {
      cwd,
      env: buildChildEnv(),
      stdio: 'inherit',
      shell: isWindowsBatch,
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label}: ${command} exited with code ${code ?? 'null'}`));
    });
  });
}
