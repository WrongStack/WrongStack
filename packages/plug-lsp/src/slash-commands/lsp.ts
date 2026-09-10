import * as path from 'node:path';
import type { SlashCommand } from '@wrongstack/core/types';
import { serverConfigPath } from '../config-persist.js';
import type { DocumentTracker } from '../document-tracker.js';
import { formatDiagnostics } from '../formatters/diagnostics.js';
import type { LSPRegistry } from '../registry.js';
import type { PlugLSPConfig, ServerConfig } from '../types.js';
import { pathToUri, uriKey } from '../utils/uri.js';
import { languageServerForWorkspace, SUPPORTED_LANGUAGES } from './install.js';

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
  | { type: 'add'; name: string; config: ServerConfig }
  | { type: 'start'; name?: string | undefined }
  | { type: 'stop'; name?: string | undefined }
  | { type: 'restart'; name?: string | undefined }
  | { type: 'diagnostics'; file?: string | undefined }
  | { type: 'remove'; name: string }
  | { type: 'enable'; name: string }
  | { type: 'disable'; name: string }
  | { type: 'help' };

function parseArgs(args: string): LspSubcommand {
  const parts = tokenizeArgs(args);
  if (parts.length === 0) return { type: 'list' };

  const sub = parts[0]!.toLowerCase();

  if (sub === 'list' || sub === 'ls') return { type: 'list' };
  if (sub === 'status' || sub === 'stat') return { type: 'status' };
  if (sub === 'help' || sub === 'h' || sub === '--help') return { type: 'help' };

  if (sub === 'install') {
    const lang = parts[1];
    if (!lang) return { type: 'help' };
    return { type: 'install', language: lang };
  }

  if (sub === 'add') {
    const name = parts[1];
    if (!name) return { type: 'help' };
    if (parts.length === 2 && SUPPORTED_LANGUAGES.includes(name.toLowerCase())) {
      return { type: 'install', language: name };
    }
    const values = optionValues(parts.slice(2));
    const command = values.single.get('command');
    const languages = splitCsv(values.single.get('languages'));
    if (!command || languages.length === 0 || values.invalid) return { type: 'help' };
    const timeout = Number.parseInt(values.single.get('timeout') ?? '15000', 10);
    if (!Number.isInteger(timeout) || timeout <= 0) return { type: 'help' };
    const extensions = values.multi.get('extension') ?? [];
    const fileExtensions = extensionMappings(extensions);
    if (extensions.length > 0 && !fileExtensions) return { type: 'help' };
    return {
      type: 'add',
      name,
      config: {
        command,
        args: values.multi.get('arg') ?? [],
        languages,
        ...(fileExtensions ? { fileExtensions } : {}),
        rootPatterns: values.multi.get('root') ?? [],
        startupTimeoutMs: timeout,
        enabled: true,
      },
    };
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

function tokenizeArgs(input: string): string[] {
  return [...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3]!,
  );
}

function optionValues(parts: string[]): {
  single: Map<string, string>;
  multi: Map<string, string[]>;
  invalid: boolean;
} {
  const single = new Map<string, string>();
  const multi = new Map<string, string[]>();
  let invalid = false;
  for (let index = 0; index < parts.length; index += 2) {
    const flag = parts[index];
    const value = parts[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      invalid = true;
      break;
    }
    const key = flag.slice(2);
    if (key === 'arg' || key === 'root' || key === 'extension') {
      multi.set(key, [...(multi.get(key) ?? []), value]);
    } else if (key === 'command' || key === 'languages' || key === 'timeout') {
      single.set(key, value);
    } else {
      invalid = true;
    }
  }
  return { single, multi, invalid };
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function extensionMappings(values: string[]): Record<string, string> | undefined {
  if (values.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) return undefined;
    const key = value.slice(0, separator).toLowerCase();
    out[key.startsWith('.') || !key.includes('.') ? key : `.${key}`] = value.slice(separator + 1);
  }
  return out;
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
      '  /lsp add <name> --command <binary> --languages <csv> [--arg <arg>] [--root <file>]',
      '           [--extension <.ext=languageId>] Register custom file types as needed',
      '                                Register and start any installed stdio LSP server',
      '  /lsp start [name]             Start all servers, or a specific one by name',
      '  /lsp stop [name]              Stop all servers, or a specific one by name',
      '  /lsp restart [name]           Restart all servers, or a specific one by name',
      '  /lsp diagnostics [file]      Show diagnostics for a file or the whole workspace',
      '  /lsp remove <name>            Stop the server and delete it from the config',
      '  /lsp enable|disable <name>    Flip a server on or off, now and on future sessions',
      '',
      'Examples:',
      '  /lsp                          (shows configured servers)',
      '  /lsp list',
      '  /lsp install typescript',
      '  /lsp install python',
      '  /lsp install go',
      '  /lsp add clangd --command clangd --languages c,cpp --root compile_commands.json',
      '  /lsp add vue --command vue-language-server --languages vue --extension .vue=vue --arg --stdio',
      '  /lsp start                    (start all enabled servers)',
      '  /lsp start gopls              (start a specific server)',
      '  /lsp diagnostics src/index.ts',
      '  /lsp status',
      '',
      '`/lsp install` saves the server to the project-private config and starts it',
      'right away — no restart and no hand-edited JSON.',
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
        case 'add':
          return runAddCommand(ctx, sub.name, sub.config);
        case 'start':
          return runStartCommand(ctx, sub.name);
        case 'stop':
          return runStopCommand(ctx, sub.name);
        case 'restart':
          return runRestartCommand(ctx, sub.name);
        case 'diagnostics':
          return runDiagnosticsCommand(ctx, sub.file);
        case 'remove':
          return runRemoveCommand(ctx, sub.name);
        case 'enable':
          return runSetEnabledCommand(ctx, sub.name, true);
        case 'disable':
          return runSetEnabledCommand(ctx, sub.name, false);
        default:
          return { message: this.help ?? this.description };
      }
    },
  };
}

async function runAddCommand(
  ctx: LspContext,
  name: string,
  config: ServerConfig,
): Promise<{ message: string }> {
  const activation = await activateServer(ctx, name, config);
  return {
    message: [
      `${colorize('Registered:', 'green')} ${name}`,
      // `args` is optional on ServerConfig, but parseArgs always supplies an
      // array, so the `?? []` leg is unreachable from this caller.
      /* v8 ignore start */
      `  Command: ${colorize(config.command, 'cyan')} ${(config.args ?? []).join(' ')}`.trimEnd(),
      /* v8 ignore stop */
      `  Languages: ${config.languages.join(', ')}`,
      ...activation.lines,
    ].join('\n'),
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
          : state === 'disabled' || state === 'exited'
            ? 'dim'
            : 'yellow';
    // `exited` is also the initial lazy-start state. Calling an untouched
    // server EXITED makes a healthy, waiting server look like it crashed.
    const stateLabel = state === 'exited' ? '[IDLE]' : `[${state.toUpperCase()}]`;
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
  lines.push(
    'Configured does not mean running: IDLE servers start when an LSP tool targets their language.',
  );
  lines.push('Run `/lsp help` for usage, or `/lsp install <language>` to install a server.');

  return { message: lines.join('\n') };
}

function runStatusCommand(ctx: LspContext): { message: string } {
  const servers = ctx.registry.list();
  const ready = servers.filter((s) => s.state === 'ready').length;
  const failed = servers.filter((s) => s.state === 'failed').length;
  const idle = servers.filter((s) => s.state === 'exited').length;
  const starting = servers.filter(
    (s) => s.state === 'starting' || s.state === 'initializing',
  ).length;

  const lines: string[] = [
    `${colorize('LSP Status Report', 'bold')}`,
    '─'.repeat(60),
    `  ${colorize('Total servers:', 'dim')}  ${servers.length}`,
    `  ${colorize('Ready:', 'dim')}          ${colorize(String(ready), 'green')}`,
    `  ${colorize('Idle:', 'dim')}           ${colorize(String(idle), 'dim')}`,
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
  lines.push(`  ${colorize('Config file:', 'dim')} ${serverConfigPath(ctx.cwd)}`);
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
        'For a server not on this list, add it under',
        '`extensions["@wrongstack/plug-lsp"].servers` in your project config',
        `(${colorize('/lsp status', 'cyan')} prints the file path), then run \`/lsp restart\`.`,
      ].join('\n'),
    };
  }

  const server = (await languageServerForWorkspace(lang, ctx.cwd))!;

  try {
    const { installLang } = await import('./install.js');
    const result = await installLang(lang, server, ctx.cwd);

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

    const activation = await activateServer(ctx, lang, {
      command: server.binary,
      args: server.args ?? ['--stdio'],
      languages: server.languages,
      rootPatterns: server.rootPatterns ?? [],
      startupTimeoutMs: 15_000,
      enabled: true,
    });

    const header = result.alreadyInstalled
      ? `${colorize('Already installed:', 'green')} ${lang}`
      : `${colorize('Installed:', 'green')} ${lang}`;
    const method = result.alreadyInstalled
      ? undefined
      : `  Method:  ${result.packageManager === 'system' ? server.toolchain?.label : result.installCommand}`;

    return {
      message: [
        header,
        `  Binary:  ${colorize(server.binary, 'cyan')}`,
        ...(method ? [method] : []),
        ...activation.lines,
      ].join('\n'),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      message: `${colorize('Installation failed:', 'red')} ${lang}\n  ${msg}`,
    };
  }
}

/**
 * Write the server into the project-private config, mount it in the live
 * registry, and start it. Installing a binary and then telling the user to
 * hand-edit JSON and restart was the whole reason `/lsp install` never
 * actually activated anything.
 */
async function activateServer(
  ctx: LspContext,
  name: string,
  cfg: ServerConfig,
): Promise<{ lines: string[] }> {
  const { persistServerConfig } = await import('../config-persist.js');
  const { resolveServerCommand } = await import('../utils/command-resolver.js');

  // Store the resolved path when we can find one: a bare name is not
  // spawnable on Windows even when it is on PATH.
  const resolved = (await resolveServerCommand(cfg.command, ctx.cwd)) ?? cfg.command;
  const entry: ServerConfig = { ...cfg, command: resolved };

  let target: string;
  try {
    target = await persistServerConfig(ctx.cwd, name, entry);
  } catch (err) {
    return {
      lines: [
        '',
        `${colorize('Could not save the server to your config:', 'red')} ${toMessage(err)}`,
        'The binary is installed; add it manually and run `/lsp start`.',
      ],
    };
  }

  await ctx.registry.upsertServer(name, entry);
  ctx.cfg.servers[name] = entry;

  const lines = ['', `  Saved to: ${colorize(target, 'dim')}`];
  try {
    await ctx.registry.start(name);
    lines.push(`${colorize('Started:', 'green')} ${name} — LSP tools are live for this session.`);
  } catch (err) {
    lines.push(
      `${colorize('Saved, but the server did not start:', 'yellow')} ${toMessage(err)}`,
      `Run ${colorize(`/lsp restart ${name}`, 'cyan')} to retry.`,
    );
  }
  return { lines };
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
    // Diagnostics are buffered under `uriKey(pathToUri(...))` by
    // `LSPServer.setDiagnostics`, which folds case on Windows. Look up in that
    // same space — the raw resolved path never matches the stored key there.
    const fileDiags = allDiags.get(uriKey(pathToUri(resolved)));
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

  // Buffer keys are canonical (`uriKey`), which folds case on Windows. Map
  // them back to the paths the user actually opened so the overview shows
  // on-disk casing; an untracked key keeps the canonical form.
  const realPathByKey = new Map<string, string>();
  for (const doc of ctx.tracker.list()) {
    realPathByKey.set(uriKey(doc.uri), doc.path);
  }

  const total = Array.from(allDiags.values()).reduce((sum, d) => sum + d.length, 0);
  lines.push(`Showing diagnostics for ${allDiags.size} file(s) (${total} total)`);
  lines.push('');

  for (const [key, diags] of allDiags) {
    const display = realPathByKey.get(key) ?? key;
    lines.push(`${colorize(display, 'cyan')}`);
    const fdiagMap = new Map([[display, diags]]);
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
    for (const [key, diags] of srv.diagnostics) {
      // Keys are already `uriKey(uri)` output — a normalized filesystem path,
      // never a URL — so they are used as-is. Slicing them as if they were
      // URIs is the same wrong assumption that made `/diagnostics` throw.
      const existing = result.get(key) ?? [];
      result.set(key, [...existing, ...diags]);
    }
  }
  return result;
}

/** Direct-module test seam; not re-exported by the package barrel. */
export const lspCommandCoverage = {
  colorize,
  collectServerDiagnostics,
  extensionMappings,
  optionValues,
  parseArgs,
  splitCsv,
  tokenizeArgs,
};

async function runRemoveCommand(ctx: LspContext, name: string): Promise<{ message: string }> {
  if (!ctx.cfg.servers[name]) {
    return { message: `${colorize('No such server:', 'red')} ${name}` };
  }
  const { persistServerConfig } = await import('../config-persist.js');
  try {
    await persistServerConfig(ctx.cwd, name, null);
  } catch (err) {
    return { message: `${colorize('Could not update the config:', 'red')} ${toMessage(err)}` };
  }
  await ctx.registry.removeServer(name);
  delete ctx.cfg.servers[name];
  return {
    message: [
      `${colorize('Removed:', 'green')} ${name}`,
      // Auto-discovery re-adds any preset whose binary is still installed, so
      // say so rather than letting the server reappear next session unexplained.
      ctx.cfg.autoDiscover
        ? `${colorize('Note:', 'dim')} autoDiscover is on — a preset server whose binary is still installed will be rediscovered next session. Use \`/lsp disable ${name}\` to keep it off.`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

async function runSetEnabledCommand(
  ctx: LspContext,
  name: string,
  enabled: boolean,
): Promise<{ message: string }> {
  const current = ctx.cfg.servers[name];
  if (!current) {
    return { message: `${colorize('No such server:', 'red')} ${name}` };
  }
  const next: ServerConfig = { ...current, enabled };
  const { persistServerConfig } = await import('../config-persist.js');
  try {
    await persistServerConfig(ctx.cwd, name, next);
  } catch (err) {
    return { message: `${colorize('Could not update the config:', 'red')} ${toMessage(err)}` };
  }
  await ctx.registry.setServerEnabled(name, enabled);
  ctx.cfg.servers[name] = next;

  if (!enabled) {
    return { message: `${colorize('Disabled:', 'green')} ${name} — stopped and it stays off.` };
  }
  try {
    await ctx.registry.start(name);
    return { message: `${colorize('Enabled:', 'green')} ${name} — started.` };
  } catch (err) {
    return {
      message: [
        `${colorize('Enabled:', 'green')} ${name}`,
        `${colorize('But it did not start:', 'yellow')} ${toMessage(err)}`,
      ].join('\n'),
    };
  }
}
