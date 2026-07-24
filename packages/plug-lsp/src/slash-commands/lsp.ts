import * as path from 'node:path';
import type { SlashCommand } from '@wrongstack/core/types';
import type { DocumentTracker } from '../document-tracker.js';
import { formatDiagnostics } from '../formatters/diagnostics.js';
import type { LSPRegistry } from '../registry.js';
import type { PlugLSPConfig } from '../types.js';
import { LANGUAGE_SERVERS, SUPPORTED_LANGUAGES } from './install.js';

// Re-export for use from the plugin entry
export { installLang, LANGUAGE_SERVERS, SUPPORTED_LANGUAGES } from './install.js';

interface LspContext {
  registry: LSPRegistry;
  tracker: DocumentTracker;
  cfg: PlugLSPConfig;
  cwd: string;
}

type LspSubcommand =
  | { type: 'list' }
  | { type: 'status' }
  | { type: 'install'; language: string }
  | { type: 'start'; name?: string | undefined }
  | { type: 'stop'; name?: string | undefined }
  | { type: 'restart'; name?: string | undefined }
  | { type: 'diagnostics'; file?: string | undefined }
  | { type: 'remove'; name: string }
  | { type: 'enable'; name: string }
  | { type: 'disable'; name: string }
  | { type: 'help' };

function parseArgs(args: string): LspSubcommand {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { type: 'list' };

  const sub = parts[0]!.toLowerCase();

  if (sub === 'list' || sub === 'ls') return { type: 'list' };
  if (sub === 'status' || sub === 'stat') return { type: 'status' };
  if (sub === 'help' || sub === 'h' || sub === '--help') return { type: 'help' };

  if (sub === 'install' || sub === 'add') {
    const lang = parts[1];
    if (!lang) return { type: 'help' };
    return { type: 'install', language: lang };
  }

  if (sub === 'start') return { type: 'start', name: parts[1] };
  if (sub === 'stop') return { type: 'stop', name: parts[1] };
  if (sub === 'restart' || sub === 'reload') return { type: 'restart', name: parts[1] };

  if (sub === 'diagnostics' || sub === 'diag') {
    return { type: 'diagnostics', file: parts[1] };
  }

  if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
    const name = parts[1];
    if (!name) return { type: 'help' };
    return { type: 'remove', name };
  }

  if (sub === 'enable') {
    const name = parts[1];
    if (!name) return { type: 'help' };
    return { type: 'enable', name };
  }

  if (sub === 'disable') {
    const name = parts[1];
    if (!name) return { type: 'help' };
    return { type: 'disable', name };
  }

  return { type: 'help' };
}

function colorize(text: string, code: string): string {
  const colors: Record<string, string> = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    reset: '\x1b[0m',
  };
  return `${colors[code] ?? ''}${text}${colors.reset}`;
}

export function buildLspCommand(ctx: LspContext): SlashCommand {
  return {
    name: 'lsp',
    category: 'Inspect',
    aliases: ['lsplsp'],
    description:
      'Manage LSP language servers: /lsp [list|install <lang>|start [name]|stop [name]|restart [name]|diagnostics [file]|add|remove|enable|disable]',
    argsHint: '[list|install <lang>|start [name]|stop [name]|restart [name]|diagnostics [file]]',

    help: [
      'Usage:',
      '  /lsp                          Show server list and status (alias for list)',
      '  /lsp list                     List all configured servers and their states',
      '  /lsp status                   Detailed status report for all servers',
      '  /lsp install <language>      Install the language server for a given language',
      '                                Supported: ' + SUPPORTED_LANGUAGES.join(', '),
      '  /lsp start [name]             Start all servers, or a specific one by name',
      '  /lsp stop [name]              Stop all servers, or a specific one by name',
      '  /lsp restart [name]           Restart all servers, or a specific one by name',
      '  /lsp diagnostics [file]      Show diagnostics for a file or the whole workspace',
      '',
      'Examples:',
      '  /lsp                          (shows configured servers)',
      '  /lsp list',
      '  /lsp install typescript',
      '  /lsp install python',
      '  /lsp install go',
      '  /lsp start                    (start all enabled servers)',
      '  /lsp start gopls              (start a specific server)',
      '  /lsp diagnostics src/index.ts',
      '  /lsp status',
      '',
      'After installing, add the server to your WrongStack config under:',
      '  extensions["@wrongstack/plug-lsp"].servers',
      'Then restart your WrongStack session.',
    ].join('\n'),

    async run(args) {
      const sub = parseArgs(args);

      switch (sub.type) {
        case 'list':
          return runListCommand(ctx);
        case 'status':
          return runStatusCommand(ctx);
        case 'install':
          return runInstallCommand(ctx, sub.language);
        case 'start':
          return runStartCommand(ctx, sub.name);
        case 'stop':
          return runStopCommand(ctx, sub.name);
        case 'restart':
          return runRestartCommand(ctx, sub.name);
        case 'diagnostics':
          return runDiagnosticsCommand(ctx, sub.file);
        case 'remove':
          return {
            message:
              'To remove a server, remove its entry from `extensions["@wrongstack/plug-lsp"].servers`\nin your WrongStack config, then restart.',
          };
        case 'enable':
          return {
            message:
              'To enable a server, ensure `enabled: true` is set (or absent — it defaults to true)\nin its config entry, then run `/lsp start <name>`.',
          };
        case 'disable':
          return {
            message:
              'To disable a server, set `enabled: false` in its config entry,\nthen run `/lsp stop <name>` to stop it.',
          };
        default:
          return { message: this.help ?? this.description };
      }
    },
  };
}

// ─── Subcommand Handlers ─────────────────────────────────────────────────────

function runListCommand(ctx: LspContext): { message: string } {
  const servers = ctx.registry.list();
  if (servers.length === 0) {
    return {
      message: [
        `${colorize('LSP Servers', 'bold')}`,
        'No servers configured.',
        '',
        'Enable @wrongstack/plug-lsp in your config and add server definitions under',
        '`extensions["@wrongstack/plug-lsp"].servers`, or run `/lsp install <language>`',
        'to install a preset server.',
      ].join('\n'),
    };
  }

  const lines: string[] = [`${colorize('LSP Servers', 'bold')}  (${servers.length} configured)`];
  lines.push('─'.repeat(60));

  for (const srv of servers) {
    const state = srv.state;
    const enabled = srv.config.enabled ?? true;

    const stateColor =
      state === 'ready'
        ? 'green'
        : state === 'failed'
          ? 'red'
          : state === 'disabled'
            ? 'dim'
            : 'yellow';
    const stateLabel = `[${state.toUpperCase()}]`;
    const enabledLabel = enabled ? '' : colorize(' (disabled)', 'dim');

    const langs = srv.config.languages?.join(', ') ?? '';
    lines.push(
      `  ${colorize(srv.name, 'cyan')}  ${colorize(stateLabel, stateColor)}${enabledLabel}`,
    );
    lines.push(`    ${colorize('Languages:', 'dim')} ${langs}`);
    lines.push(
      `    ${colorize('Command:', 'dim')} ${srv.config.command} ${(srv.config.args ?? []).join(' ')}`,
    );
    lines.push('');
  }

  lines.push('─'.repeat(60));
  lines.push('Run `/lsp help` for usage, or `/lsp install <language>` to install a server.');

  return { message: lines.join('\n') };
}

function runStatusCommand(ctx: LspContext): { message: string } {
  const servers = ctx.registry.list();
  const ready = servers.filter((s) => s.state === 'ready').length;
  const failed = servers.filter((s) => s.state === 'failed').length;
  const starting = servers.filter(
    (s) => s.state === 'starting' || s.state === 'initializing',
  ).length;

  const lines: string[] = [
    `${colorize('LSP Status Report', 'bold')}`,
    '─'.repeat(60),
    `  ${colorize('Total servers:', 'dim')}  ${servers.length}`,
    `  ${colorize('Ready:', 'dim')}          ${colorize(String(ready), 'green')}`,
    `  ${colorize('Starting:', 'dim')}       ${colorize(String(starting), 'yellow')}`,
    `  ${colorize('Failed:', 'dim')}         ${colorize(String(failed), 'red')}`,
    '',
  ];

  if (failed > 0) {
    lines.push(`${colorize('Failed servers:', 'red')}`);
    for (const srv of servers.filter((s) => s.state === 'failed')) {
      const err = srv.lastStderr || 'unknown error';
      lines.push(`  ${colorize(srv.name, 'cyan')} — ${err}`);
    }
    lines.push('');
  }

  const activeFiles = ctx.tracker.list().length;
  lines.push(`  ${colorize('Active files tracked:', 'dim')} ${activeFiles}`);
  lines.push(`  ${colorize('Auto-start mode:', 'dim')} ${ctx.cfg.autoStart}`);
  lines.push('');
  lines.push('─'.repeat(60));
  lines.push('Use `/lsp diagnostics` to check for problems, or `/lsp restart <name>` to recover.');

  return { message: lines.join('\n') };
}

async function runInstallCommand(ctx: LspContext, language: string): Promise<{ message: string }> {
  const lang = language.toLowerCase().trim();

  if (!SUPPORTED_LANGUAGES.includes(lang)) {
    return {
      message: [
        `${colorize('Unknown language:', 'red')} ${lang}`,
        `Supported languages: ${SUPPORTED_LANGUAGES.join(', ')}`,
        '',
        'If the language server is already installed on your system, you can add it',
        'manually to your WrongStack config under `extensions["@wrongstack/plug-lsp"].servers`.',
        'Run `/lsp help` for instructions.',
      ].join('\n'),
    };
  }

  const server = LANGUAGE_SERVERS[lang]!;

  try {
    const { installLang } = await import('./install.js');
    const result = await installLang(lang, server, ctx.cwd);

    if (result.alreadyInstalled) {
      return {
        message: [
          `${colorize('Already installed:', 'green')} ${lang}`,
          `  Binary: ${colorize(server.binary, 'cyan')}`,
          '',
          'The server is already available. Add it to your config to activate:',
          '',
          '```json',
          JSON.stringify(
            {
              extensions: {
                '@wrongstack/plug-lsp': {
                  servers: {
                    [lang]: {
                      command: server.binary,
                      args: server.args ?? ['--stdio'],
                      languages: server.languages,
                      rootPatterns: server.rootPatterns ?? [],
                    },
                  },
                },
              },
            },
            null,
            2,
          ),
          '```',
          '',
          'Then restart your WrongStack session to load the server.',
        ].join('\n'),
      };
    }

    if (result.dryRun) {
      return {
        message: [
          `${colorize('Dry run — would install:', 'yellow')} ${lang}`,
          `  ${result.installCommand}`,
          '',
          'Run without --dry-run to actually install.',
        ].join('\n'),
      };
    }

    return {
      message: [
        `${colorize('Installed:', 'green')} ${lang}`,
        `  Binary: ${colorize(server.binary, 'cyan')}`,
        `  Method:  ${result.packageManager === 'system' ? server.toolchain!.label : result.installCommand}`,
        '',
        'Add this to your WrongStack config to activate the server:',
        '',
        '```json',
        JSON.stringify(
          {
            extensions: {
              '@wrongstack/plug-lsp': {
                servers: {
                  [lang]: {
                    command: server.binary,
                    args: server.args ?? ['--stdio'],
                    languages: server.languages,
                    rootPatterns: server.rootPatterns ?? [],
                  },
                },
              },
            },
          },
          null,
          2,
        ),
        '```',
        '',
        `Restart your WrongStack session to load the server, then run \`/lsp start \${lang}\`.`,
      ].join('\n'),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      message: `${colorize('Installation failed:', 'red')} ${lang}\n  ${msg}`,
    };
  }
}

async function runStartCommand(ctx: LspContext, name?: string): Promise<{ message: string }> {
  const targetName = name?.trim();

  if (targetName) {
    const srv = ctx.registry.list().find((s) => s.name === targetName);
    if (!srv) {
      const available = ctx.registry.list().map((s) => s.name);
      return {
        message: [
          `${colorize('Server not found:', 'red')} ${targetName}`,
          available.length > 0 ? `Available: ${available.join(', ')}` : 'No servers configured.',
          'Run `/lsp install <language>` to install a server.',
        ].join('\n'),
      };
    }

    try {
      await ctx.registry.start(targetName);
      return { message: `${colorize('Started:', 'green')} ${targetName}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { message: `${colorize('Failed to start:', 'red')} ${targetName}\n  ${msg}` };
    }
  }

  // Start all enabled servers
  const allServers = ctx.registry.list();
  const started: string[] = [];
  const failed: string[] = [];

  for (const srv of allServers) {
    if (!srv.config.enabled) continue;
    if (srv.state === 'ready') {
      started.push(srv.name);
      continue;
    }
    if (srv.state === 'disabled') continue;
    try {
      await ctx.registry.start(srv.name);
      started.push(srv.name);
    } catch {
      failed.push(srv.name);
    }
  }

  const lines: string[] = [];
  if (started.length > 0) lines.push(`${colorize('Started:', 'green')} ${started.join(', ')}`);
  if (failed.length > 0) lines.push(`${colorize('Failed to start:', 'red')} ${failed.join(', ')}`);
  if (started.length === 0 && failed.length === 0) {
    lines.push('No servers to start. Run `/lsp list` to see configured servers.');
  }

  return { message: lines.join('\n') };
}

async function runStopCommand(ctx: LspContext, name?: string): Promise<{ message: string }> {
  const targetName = name?.trim();

  if (targetName) {
    const srv = ctx.registry.list().find((s) => s.name === targetName);
    if (!srv) {
      return { message: `${colorize('Server not found:', 'red')} ${targetName}` };
    }
    ctx.registry.stop(targetName);
    return { message: `${colorize('Stopped:', 'yellow')} ${targetName}` };
  }

  // Stop all servers
  const allServers = ctx.registry.list();
  for (const srv of allServers) {
    ctx.registry.stop(srv.name);
  }

  return {
    message: `${colorize('Stopped', 'yellow')} ${allServers.length} server(s): ${allServers.map((s) => s.name).join(', ')}`,
  };
}

async function runRestartCommand(ctx: LspContext, name?: string): Promise<{ message: string }> {
  const targetName = name?.trim();

  if (targetName) {
    const srv = ctx.registry.list().find((s) => s.name === targetName);
    if (!srv) {
      return { message: `${colorize('Server not found:', 'red')} ${targetName}` };
    }

    ctx.registry.stop(targetName);
    try {
      await ctx.registry.start(targetName);
      return { message: `${colorize('Restarted:', 'green')} ${targetName}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { message: `${colorize('Restart failed:', 'red')} ${targetName}\n  ${msg}` };
    }
  }

  // Restart all enabled servers
  const allServers = ctx.registry.list().filter((s) => s.config.enabled);
  const restarted: string[] = [];
  const failed: string[] = [];

  for (const srv of allServers) {
    ctx.registry.stop(srv.name);
    try {
      await ctx.registry.start(srv.name);
      restarted.push(srv.name);
    } catch {
      failed.push(srv.name);
    }
  }

  const lines: string[] = [];
  if (restarted.length > 0)
    lines.push(`${colorize('Restarted:', 'green')} ${restarted.join(', ')}`);
  if (failed.length > 0)
    lines.push(`${colorize('Failed to restart:', 'red')} ${failed.join(', ')}`);

  return { message: lines.join('\n') };
}

async function runDiagnosticsCommand(ctx: LspContext, file?: string): Promise<{ message: string }> {
  const lines: string[] = [`${colorize('LSP Diagnostics', 'bold')}`, '─'.repeat(60)];

  // Aggregate diagnostics from all ready servers
  const allDiags = collectServerDiagnostics(ctx.registry);

  if (file) {
    const resolved = path.resolve(ctx.cwd, file);
    const fileDiags = allDiags.get(resolved);
    if (!fileDiags || fileDiags.length === 0) {
      return { message: lines.join('\n') + `\nNo diagnostics for ${file}` };
    }
    lines.push(`File: ${resolved}`);
    const diagMap = new Map([[resolved, fileDiags]]);
    lines.push(
      formatDiagnostics(diagMap, {
        cwd: ctx.cwd,
        severityFilter: ctx.cfg.severityFilter,
        maxPerFile: ctx.cfg.maxDiagnosticsPerFile,
        maxTotal: ctx.cfg.maxDiagnosticsTotal,
      }),
    );
    return { message: lines.join('\n') };
  }

  // Workspace overview
  if (allDiags.size === 0) {
    lines.push('No diagnostics reported by any LSP server.');
    lines.push('');
    lines.push('LSP diagnostics are reported by language servers after you open/edit files.');
    lines.push('Open a file and run `/lsp diagnostics <file>` to check specific files.');
    return { message: lines.join('\n') };
  }

  const total = Array.from(allDiags.values()).reduce((sum, d) => sum + d.length, 0);
  lines.push(`Showing diagnostics for ${allDiags.size} file(s) (${total} total)`);
  lines.push('');

  for (const [fpath, diags] of allDiags) {
    lines.push(`${colorize(fpath, 'cyan')}`);
    const fdiagMap = new Map([[fpath, diags]]);
    lines.push(
      formatDiagnostics(fdiagMap, {
        cwd: ctx.cwd,
        severityFilter: ctx.cfg.severityFilter,
        maxPerFile: ctx.cfg.maxDiagnosticsPerFile,
        maxTotal: ctx.cfg.maxDiagnosticsTotal,
      }),
    );
    lines.push('');
  }

  return { message: lines.join('\n') };
}

/** Collect diagnostics from all ready LSP servers, keyed by file path. */
function collectServerDiagnostics(
  registry: LSPRegistry,
): Map<string, import('vscode-languageserver-protocol').Diagnostic[]> {
  const result = new Map<string, import('vscode-languageserver-protocol').Diagnostic[]>();
  for (const srv of registry.list()) {
    if (srv.state !== 'ready') continue;
    for (const [uri, diags] of srv.diagnostics) {
      // Convert file:// URIs to paths
      const filePath = uri.startsWith('file://') ? uri.slice(7) : uri;
      const existing = result.get(filePath) ?? [];
      result.set(filePath, [...existing, ...diags]);
    }
  }
  return result;
}

/** Direct-module test seam; not re-exported by the package barrel. */
export const lspCommandCoverage = { colorize, collectServerDiagnostics, parseArgs };
