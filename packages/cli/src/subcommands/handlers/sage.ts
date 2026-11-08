/**
 * `wstack sage` — SAGE memory for other coding agents.
 *
 *   wstack sage connect <claude-code|codex|cursor|antigravity|all> [--dry-run] [--command <path>]
 *   wstack sage connect print        config snippets for any other MCP client
 *   wstack sage disconnect <client|all> [--dry-run]
 *   wstack sage mcp [--origin <name>]  the stdio server those clients run
 *
 * The server attaches to the SAGE daemon a WrongStack host already runs for
 * this project and never starts one: memory is available while wstack is open
 * here. It exposes the read tools plus proposals; a proposal becomes memory
 * only through WrongStack's review. Semantic (vector) recall is not included —
 * that fusion runs inside a WrongStack host, not in the daemon.
 */
import { accessSync, constants, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  isSageConnectTarget,
  type PlannedChange,
  planSageConnect,
  planSageDisconnect,
  renderSageConnectSnippets,
  resolveSageLaunch,
  SAGE_CONNECT_TARGETS,
  type SageConnectGuide,
  type SageConnectTarget,
} from '../../sage-connect.js';
import type { SubcommandHandler } from '../contracts.js';
import { restoreFlags } from '../flags.js';

const USAGE = [
  'Usage:',
  `  wstack sage connect <${SAGE_CONNECT_TARGETS.join('|')}|all> [--dry-run] [--command <path>]`,
  '  wstack sage connect print',
  `  wstack sage disconnect <${SAGE_CONNECT_TARGETS.join('|')}|all> [--dry-run]`,
  '  wstack sage mcp [--origin <name>]',
  '  wstack sage sync [--restart-service]',
  '  wstack sage doctor [--fix[=<ids>]] [--json]',
  '  wstack sage handoff [--yes] [--json]',
  '  wstack sage service status|install|use <local|wrongmemory|auto> [--yes]',
  '',
  'service: choose the memory service. `install` downloads WrongMemory (checksum',
  'verified) or installs it from --from <dir>; `use wrongmemory --yes` backs the',
  'store up, hands it to WrongMemory and sets Sage.service.mode in the active',
  'profile; `use local --yes` releases it again. Without --yes: the plan.',
  '',
  "handoff: hand this project's SAGE store to the WrongMemory service. Without",
  '--yes it prints the plan. With --yes it stops the running SAGE project server',
  '(authenticated shutdown), adopts the store in WrongMemory with write ownership,',
  'and leaves it locked so local SAGE refuses it; then set Sage.service.mode to',
  '"wrongmemory". Take a backup first (wrongmemory backup --store <path>).',
  '',
  'doctor: health report of the project SAGE store (expired memories,',
  'graph hubs, dangling edges, runtime-mode audiences, FTS, maintenance,',
  'injection precision). --fix applies the suggested repairs; none hard-deletes',
  'a memory. Fix ids: hygiene, graph-hubs, dangling-edges, audience-runtime-mode,',
  'fts-rebuild.',
  '',
  "Connects this project's SAGE memory to another coding agent over MCP. The",
  'server attaches to the SAGE daemon while wstack is open in this project; it',
  'never starts one. Tools: memory_search, memory_for_file, memory_for_path,',
  'memory_graph, and memory_candidates (list/propose only).',
].join('\n');

function optionValue(args: readonly string[], name: string): string | undefined {
  const flag = `--${name}`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === flag) {
      const next = args[i + 1];
      return next !== undefined && !next.startsWith('--') ? next : undefined;
    }
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

/** Positional words, skipping flags and the values of valued flags. */
function positionals(args: readonly string[], valued: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      if (valued.includes(arg.slice(2)) && !arg.includes('=')) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** PATH lookup with PATHEXT on Windows; an explicit path is checked as written. */
export function findExecutableOnPath(cmd: string): string | null {
  const exists = (p: string): boolean => {
    try {
      accessSync(p, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (cmd.includes('/') || cmd.includes('\\')) return exists(cmd) ? path.resolve(cmd) : null;
  const suffixes =
    process.platform === 'win32' && path.extname(cmd) === ''
      ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  for (const rawDir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    // cmd.exe and libuv accept a quoted Windows entry; joined verbatim it
    // named no file and an installed wstack.cmd looked absent.
    const dir = process.platform === 'win32' ? rawDir.trim().replace(/^"|"$/g, '') : rawDir;
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(dir, cmd + suffix);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function readIfExists(absPath: string): string | undefined {
  try {
    return readFileSync(absPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function applyChange(change: PlannedChange, projectRoot: string): Promise<void> {
  if (change.action === 'delete') {
    await fs.rm(change.path, { force: true });
    // Walk up and drop directories the connect created and left empty
    // (`.cursor/rules`, `.claude/skills/<name>`, ...). `rmdir` refuses a
    // non-empty directory, so anything else living there stops the walk.
    const root = path.resolve(projectRoot);
    let dir = path.dirname(path.resolve(change.path));
    while (dir !== root && dir.startsWith(root + path.sep)) {
      try {
        await fs.rmdir(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
    return;
  }
  if (change.action === 'create' || change.action === 'update') {
    await fs.mkdir(path.dirname(change.path), { recursive: true });
    await fs.writeFile(change.path, change.content ?? '', 'utf8');
  }
}

async function loadGuide(): Promise<SageConnectGuide> {
  // Literal specifier: the standalone binary cannot resolve a computed one.
  const mcp = await import('@wrongstack/sage-mcp');
  return {
    serverName: mcp.SAGE_MCP_SERVER_NAME,
    skillName: mcp.SAGE_SKILL_NAME,
    skillDescription: mcp.SAGE_SKILL_DESCRIPTION,
    skillBody: mcp.SAGE_SKILL_BODY,
  };
}

function targetsFrom(word: string | undefined): SageConnectTarget[] | null {
  if (word === 'all') return [...SAGE_CONNECT_TARGETS];
  if (word && isSageConnectTarget(word)) return [word];
  return null;
}

export const sageCmd: SubcommandHandler = async (rawArgs, deps) => {
  const args = restoreFlags(rawArgs, deps, [
    'origin',
    'command',
    'dry-run',
    'restart-service',
    'fix',
    'json',
    'yes',
    'release',
    'from',
    'stop-daemon',
    'keep-mode',
  ]);
  const words = positionals(args, ['origin', 'command', 'fix']);
  const sub = words[0];
  const out = (line: string) => deps.renderer.write(`${line}\n`);

  if (sub === 'service') {
    const { runSageServiceCommand } = await import('./sage-service.js');
    return runSageServiceCommand(args.slice(args.indexOf('service') + 1), deps);
  }

  if (sub === 'sync') {
    const { runSageHqSyncCommand } = await import('./sage-sync.js');
    return runSageHqSyncCommand(deps, args.includes('--restart-service'));
  }

  if (sub === 'doctor') {
    const { runSageDoctorCommand } = await import('./sage-doctor.js');
    const fixValue = optionValue(args, 'fix');
    const wantsFix = args.some((arg) => arg === '--fix' || arg.startsWith('--fix='));
    return runSageDoctorCommand(
      deps,
      wantsFix ? (fixValue ?? true) : undefined,
      args.includes('--json'),
    );
  }

  if (sub === 'handoff') {
    const { handOffSageToWrongMemory } = await import('@wrongstack/sage');
    try {
      const report = await handOffSageToWrongMemory({
        projectRoot: deps.projectRoot,
        directory: deps.config.Sage?.storage?.directory,
        service: deps.config.Sage?.service,
        apply: args.includes('--yes'),
      });
      if (args.includes('--json')) {
        out(JSON.stringify(report, null, 2));
      } else {
        out(
          report.applied
            ? 'SAGE handoff to WrongMemory: done'
            : 'SAGE handoff to WrongMemory: plan (rerun with --yes)',
        );
        for (const step of report.steps) out(`  - ${step}`);
        if (report.applied) {
          out(
            `  project ${report.projectId} (${report.admission}); owner lock held: ${report.ownerLocked}`,
          );
          out(
            `  Next: set Sage.service.mode to "wrongmemory" in your user or profile configuration.`,
          );
        }
      }
      return report.applied && !report.ownerLocked ? 1 : 0;
    } catch (error) {
      out(`wstack sage handoff: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  if (sub === 'mcp' || sub === 'connect') {
    const { wrongMemorySageOwner, wrongMemoryBridgeHint, serveWrongMemoryMcp } = await import(
      '../../sage-mcp-owner.js'
    );
    const owner = await wrongMemorySageOwner(deps.projectRoot, deps.config.Sage?.service);
    if (owner && sub === 'mcp') {
      // stdout is the client's JSON-RPC channel: WrongMemory's bridge owns it.
      return serveWrongMemoryMcp(
        owner,
        deps.projectRoot,
        deps.config.Sage?.service,
        optionValue(args, 'origin')?.trim() || 'mcp-client',
        'wstack sage mcp',
      );
    }
    if (owner) {
      // Client configuration belongs to WrongMemory's own `connect`.
      out(wrongMemoryBridgeHint(owner, `wstack sage ${sub}`));
      return 3;
    }
  }

  if (sub === 'mcp') {
    // stdout is the JSON-RPC channel from here on; everything else goes to stderr.
    const client = optionValue(args, 'origin')?.trim() || 'mcp-client';
    const { serveAttachedSageMcpStdio } = await import('@wrongstack/sage-mcp');
    await serveAttachedSageMcpStdio({
      projectRoot: deps.projectRoot,
      directory: deps.config.Sage?.storage?.directory,
      origin: client,
    });
    return 0;
  }

  if (sub !== 'connect' && sub !== 'disconnect') {
    out(USAGE);
    return sub === undefined || sub === 'help' ? 0 : 1;
  }

  const guide = await loadGuide();
  const dryRun = args.includes('--dry-run');
  const command = optionValue(args, 'command');

  if (sub === 'connect' && words[1] === 'print') {
    const { launch, warning } = resolveSageLaunch('mcp-client', {
      command,
      findOnPath: findExecutableOnPath,
    });
    out(renderSageConnectSnippets(launch, guide.serverName));
    if (warning) out(`\nwarning: ${warning}`);
    return 0;
  }

  const targets = targetsFrom(words[1]);
  if (!targets) {
    out(USAGE);
    return words[1] === undefined ? 0 : 1;
  }

  let failed = false;
  const warnings = new Set<string>();
  out(
    `${dryRun ? 'Preview (nothing written)' : sub === 'connect' ? 'Connecting' : 'Disconnecting'} SAGE memory — project ${deps.projectRoot}`,
  );
  for (const target of targets) {
    out(`\n${target}:`);
    try {
      let plan: ReturnType<typeof planSageConnect>;
      if (sub === 'connect') {
        const { launch, warning } = resolveSageLaunch(target, {
          command,
          findOnPath: findExecutableOnPath,
        });
        if (warning) warnings.add(warning);
        plan = planSageConnect(target, {
          projectRoot: deps.projectRoot,
          launch,
          guide,
          read: readIfExists,
        });
      } else {
        plan = planSageDisconnect(target, {
          projectRoot: deps.projectRoot,
          guide,
          read: readIfExists,
        });
      }
      if (plan.changes.length === 0) out('  nothing to remove');
      for (const change of plan.changes) {
        const rel = path.relative(deps.projectRoot, change.path) || change.path;
        out(`  ${change.action.padEnd(9)} ${rel} — ${change.summary}`);
        if (!dryRun) await applyChange(change, deps.projectRoot);
      }
      if (sub === 'connect') for (const note of plan.notes) out(`  note: ${note}`);
    } catch (error) {
      failed = true;
      deps.renderer.writeError(`  ${target}: ${toErrorMessage(error)}`);
    }
  }
  for (const warning of warnings) out(`\nwarning: ${warning}`);
  if (sub === 'connect' && !dryRun && !failed) {
    out(
      '\nMemory is served while wstack is open in this project. Restart the client (or reload its MCP servers) to pick the server up.',
    );
  }
  return failed ? 1 : 0;
};
