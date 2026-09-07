import type { ServerConfig } from './types.js';

export const PRESETS: Record<string, ServerConfig> = {
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    rootPatterns: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    startupTimeoutMs: 15_000,
    enabled: true,
  },
  /**
   * TypeScript 7's native binary is its own language server. It is picked over
   * `typescript` only when the workspace TypeScript is 7 or newer — see
   * `typescript-flavor.ts`; the two presets claim the same languages.
   */
  'typescript-native': {
    command: 'tsc',
    args: ['--lsp', '--stdio'],
    languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    rootPatterns: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    startupTimeoutMs: 15_000,
    enabled: true,
  },
  gopls: {
    command: 'gopls',
    args: ['serve'],
    languages: ['go'],
    rootPatterns: ['go.mod', 'go.work'],
    startupTimeoutMs: 15_000,
    enabled: true,
  },
  'rust-analyzer': {
    command: 'rust-analyzer',
    languages: ['rust'],
    rootPatterns: ['Cargo.toml'],
    startupTimeoutMs: 15_000,
    enabled: true,
  },
  pyright: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    languages: ['python'],
    rootPatterns: ['pyproject.toml', 'pyrightconfig.json', 'setup.py', 'requirements.txt'],
    startupTimeoutMs: 15_000,
    enabled: true,
  },
  json: {
    command: 'vscode-json-language-server',
    args: ['--stdio'],
    languages: ['json'],
    rootPatterns: ['package.json'],
    startupTimeoutMs: 15_000,
    enabled: true,
  },
  html: {
    command: 'vscode-html-language-server',
    args: ['--stdio'],
    languages: ['html'],
    rootPatterns: ['package.json'],
    startupTimeoutMs: 15_000,
    enabled: true,
  },
  css: {
    command: 'vscode-css-language-server',
    args: ['--stdio'],
    languages: ['css', 'scss'],
    rootPatterns: ['package.json'],
    startupTimeoutMs: 15_000,
    enabled: true,
  },
  yaml: {
    command: 'yaml-language-server',
    args: ['--stdio'],
    languages: ['yaml'],
    rootPatterns: ['package.json', '.git'],
    startupTimeoutMs: 15_000,
    enabled: true,
  },
  bash: {
    command: 'bash-language-server',
    args: ['start'],
    languages: ['shellscript'],
    rootPatterns: ['package.json', '.git'],
    startupTimeoutMs: 15_000,
    enabled: true,
  },
  'ruby-lsp': {
    command: 'ruby-lsp',
    languages: ['ruby'],
    rootPatterns: ['Gemfile', '.ruby-version'],
    startupTimeoutMs: 15_000,
    enabled: true,
  },
};
