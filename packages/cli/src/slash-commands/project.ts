import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import type { SlashCommand } from '@wrongstack/core/types';
import {
  color,
  ensureProjectGitignore,
  ensureProjectIdentity,
  projectIdentityPath,
  readProjectIdentity,
  rekeyProjectIdentity,
} from '@wrongstack/core/utils';
import { runProjectPicker } from '../project-picker.js';
import type { SlashCommandContext } from './command-context.js';
import {
  ensureProjectDataDir,
  findProject,
  generateSlug,
  loadManifest,
  saveManifest,
} from './project-utils.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function fmtLastSeen(iso: string | undefined): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ── Command builder ──────────────────────────────────────────────────────

export function buildProjectCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'project',
    category: 'Session',
    aliases: ['projects'],
    description:
      'Open project picker or manage known projects. Arrow keys to select, Enter to confirm.',
    help: [
      'Usage:',
      '  /project                          Open interactive project picker (arrow keys)',
      '  /project ls|list                  List all known projects (text)',
      '  /project id                       Show this repository identity',
      '  /project init                     Create the committed project identity',
      '  /project rekey [--yes|-y]         Give an independent fork a new identity',
      '  /project add <path> [name]        Register a new project',
      '  /project rename <slug> <name>     Rename a project',
      '  /project remove <slug>            Remove a project from the list',
      '  /project switch <dir> [--name <n>]  Spawn wstack in target directory',
      '',
      'Projects are registered in ~/.wrongstack/projects.json.',
      'When a project is selected, running agents are stopped and a fresh',
      'wstack session spawns in the selected project directory.',
      'Each project has a name (user-friendly), root path, and slug.',
      'The slug is auto-generated and used for per-project data storage.',
    ].join('\n'),
    async run(args, ctx) {
      const trimmed = args.trim();
      const lower = trimmed.toLowerCase();

      if (!trimmed) {
        // Bare /project → launch interactive project picker (arrow keys)
        if (!process.stdin.isTTY) {
          return listProjectsCommand(opts, ctx);
        }
        return switchInteractiveCommand(opts, ctx);
      }

      if (lower === 'ls' || lower === 'list') {
        return listProjectsCommand(opts, ctx);
      }

      if (lower === 'id') {
        return projectIdentityCommand(opts, ctx, 'show', false);
      }

      if (lower === 'init') {
        return projectIdentityCommand(opts, ctx, 'init', false);
      }

      const [subcommand, ...subcommandArgs] = lower.split(/\s+/);
      if (subcommand === 'rekey') {
        const confirmed = subcommandArgs.some((arg) => arg === '--yes' || arg === '-y');
        return projectIdentityCommand(opts, ctx, 'rekey', confirmed);
      }

      if (lower.startsWith('add ') || lower === 'add') {
        const rest = trimmed.slice(lower === 'add' ? 3 : 4).trim();
        const spaceIdx = rest.indexOf(' ');
        const targetPath = spaceIdx >= 0 ? rest.slice(0, spaceIdx) : rest;
        const displayName = spaceIdx >= 0 ? rest.slice(spaceIdx + 1).trim() : undefined;
        if (!targetPath) return { message: 'Usage: /project add <path> [name]' };
        return addProjectCommand(opts, ctx, targetPath, displayName);
      }

      if (lower.startsWith('rename ') || lower === 'rename') {
        const rest = trimmed.slice(lower === 'rename' ? 6 : 7).trim();
        const spaceIdx = rest.indexOf(' ');
        const slug = spaceIdx >= 0 ? rest.slice(0, spaceIdx) : rest;
        const newName = spaceIdx >= 0 ? rest.slice(spaceIdx + 1).trim() : undefined;
        if (!slug || !newName) return { message: 'Usage: /project rename <slug> <new-name>' };
        return renameProjectCommand(opts, ctx, slug, newName);
      }

      if (lower.startsWith('remove ') || lower === 'remove') {
        const slug = trimmed.slice(lower === 'remove' ? 6 : 7).trim();
        if (!slug) return { message: 'Usage: /project remove <slug>' };
        return removeProjectCommand(opts, ctx, slug);
      }

      if (lower.startsWith('switch ') || lower === 'switch') {
        const rest = trimmed.slice(lower.startsWith('switch ') ? 7 : 6).trim();

        // Check for --interactive / -i flag (can appear anywhere in args)
        const interactiveFlag = /\s--interactive\b|\s-i\b|^--interactive\b|^-i\b/.test(rest);
        if (interactiveFlag) {
          if (!process.stdin.isTTY) {
            return {
              message: 'Usage: /project switch --interactive (interactive picker requires a TTY)',
            };
          }
          return switchInteractiveCommand(opts, ctx);
        }

        if (!rest) {
          // No args — launch interactive project picker
          if (!process.stdin.isTTY) {
            return {
              message:
                'Usage: /project switch <dir> [--name <name>] (interactive picker requires a TTY)',
            };
          }
          return switchInteractiveCommand(opts, ctx);
        }
        // Parse optional --name flag
        let target = rest;
        let displayName: string | undefined;
        const nameMatch = rest.match(/^(.*?)\s*--name\s+(.+)$/);
        if (nameMatch) {
          target = nameMatch[1]?.trim() ?? target;
          displayName = nameMatch[2]?.trim();
        }
        if (!target) return { message: 'Usage: /project switch <dir> [--name <name>]' };
        return switchProjectCommand(opts, ctx, target, displayName);
      }

      return {
        message: [
          `Unknown: "${trimmed}".`,
          'Usage: /project [ls|list|id|init|rekey|add|rename|remove|switch]',
        ].join('\n'),
      };
    },
  };
}

async function projectIdentityCommand(
  opts: SlashCommandContext,
  ctx: Context | undefined,
  action: 'show' | 'init' | 'rekey',
  confirmed: boolean,
): Promise<{ message: string }> {
  const root = ctx?.projectRoot ?? opts.projectRoot ?? process.cwd();
  const filePath = projectIdentityPath(root);

  if (action === 'show') {
    const identity = await readProjectIdentity(root);
    return identity
      ? {
          message: `${color.bold('Project ID:')} ${color.cyan(identity.projectId)}\n${color.dim(filePath)}`,
        }
      : { message: `No committed project identity. Run ${color.cyan('/project init')}.` };
  }

  if (action === 'init') {
    const result = await ensureProjectIdentity(root);
    await ensureProjectGitignore(root);
    return {
      message: result.created
        ? `${color.green('Created')} ${filePath}\n${color.cyan(result.identity.projectId)}\n${color.dim('Commit this file so every clone and machine shares the same HQ project.')}`
        : `${color.dim('Project identity already exists:')} ${color.cyan(result.identity.projectId)}`,
    };
  }

  if (!confirmed && opts.confirm) {
    const promptConfirmed = await opts.confirm(
      'Rekey this repository? Existing HQ/Kanban history will remain under the previous project ID.',
      false,
    );
    if (promptConfirmed !== true) {
      return { message: 'Rekey cancelled.' };
    }
    confirmed = true;
  }
  if (!confirmed) {
    return {
      message: `Rekey requires confirmation. Pass ${color.cyan('--yes')} or ${color.cyan('-y')}.`,
    };
  }

  const result = await rekeyProjectIdentity(root);
  await ensureProjectGitignore(root);
  return {
    message: [
      result.previous
        ? color.dim(`Previous: ${result.previous.projectId}`)
        : color.dim('Previous: none'),
      `${color.green('New project ID:')} ${color.cyan(result.identity.projectId)}`,
      color.dim(`Commit ${filePath} to make this fork independent on every machine.`),
      color.dim('Restart WrongStack before publishing HQ or Kanban updates under the new ID.'),
    ].join('\n'),
  };
}

// ── List ────────────────────────────────────────────────────────────────

async function listProjectsCommand(opts: SlashCommandContext, ctx: Context | undefined) {
  const manifest = await loadManifest(opts.paths?.globalConfig);
  const currentRoot = ctx?.projectRoot;

  if (manifest.projects.length === 0) {
    return {
      message: color.dim('No projects registered. Add one: /project add <path> [name]'),
    };
  }

  // Sort by lastSeen descending
  const sorted = [...manifest.projects].sort((a, b) => {
    if (a.lastSeen && b.lastSeen) return b.lastSeen.localeCompare(a.lastSeen);
    if (a.lastSeen) return -1;
    if (b.lastSeen) return 1;
    return a.name.localeCompare(b.name);
  });

  const lines: string[] = [`Projects (${sorted.length}) registered in projects.json:`, ''];
  for (const p of sorted) {
    const isCurrent = p.root === currentRoot;
    const marker = isCurrent ? color.green('●') : color.dim('○');
    const name = isCurrent ? color.bold(p.name) : p.name;
    const slug = color.dim(`[${p.slug}]`);
    const last = color.dim(fmtLastSeen(p.lastSeen));
    lines.push(`  ${marker} ${name} ${slug}  ${last}`);
    lines.push(`       ${p.root}`);
    if (isCurrent) {
      lines.push(`       ${color.green('← active session')}`);
    }
    lines.push('');
  }
  lines.push(
    color.dim(
      'Commands: add <path> [name]  |  rename <slug> <name>  |  remove <slug>  |  switch [dir] (no args = picker)',
    ),
  );

  return { message: lines.join('\n') };
}

// ── Add ─────────────────────────────────────────────────────────────────

async function addProjectCommand(
  opts: SlashCommandContext,
  ctx: Context | undefined,
  targetPath: string,
  displayName?: string,
) {
  const resolved = path.resolve(ctx?.projectRoot ?? ctx?.cwd ?? process.cwd(), targetPath);

  try {
    await fs.access(resolved);
  } catch {
    return { message: color.red(`Directory not found: ${resolved}`) };
  }
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    return { message: color.red(`Not a directory: ${resolved}`) };
  }

  const manifest = await loadManifest(opts.paths?.globalConfig);
  const existing = manifest.projects.find((p) => p.root === resolved);
  if (existing) {
    return {
      message: color.yellow(`Project already registered: "${existing.name}" (${existing.slug})`),
    };
  }

  const name = displayName?.trim() || path.basename(resolved);
  const slug = generateSlug(resolved);
  const now = new Date().toISOString();

  // Ensure the per-project data directory exists
  await ensureProjectDataDir(slug, opts.paths?.globalConfig);

  manifest.projects.push({ name, root: resolved, slug, lastSeen: now, createdAt: now });
  await saveManifest(manifest, opts.paths?.globalConfig);

  return {
    message: [
      '',
      color.green(`  Added project: ${name}`),
      color.dim(`    Root: ${resolved}`),
      color.dim(`    Slug: ${slug}`),
      '',
    ].join('\n'),
  };
}

// ── Rename ──────────────────────────────────────────────────────────────

async function renameProjectCommand(
  opts: SlashCommandContext,
  _ctx: Context | undefined,
  slugOrName: string,
  newName: string,
) {
  const manifest = await loadManifest(opts.paths?.globalConfig);
  const project = findProject(manifest, slugOrName);
  if (!project) {
    return {
      message: color.red(
        `Project not found: "${slugOrName}". Use /project list to see available projects.`,
      ),
    };
  }

  const oldName = project.name;
  project.name = newName;
  await saveManifest(manifest, opts.paths?.globalConfig);

  return { message: color.green(`Renamed: "${oldName}" → "${newName}" (${project.slug})`) };
}

// ── Remove ──────────────────────────────────────────────────────────────

async function removeProjectCommand(
  opts: SlashCommandContext,
  _ctx: Context | undefined,
  slugOrName: string,
) {
  const manifest = await loadManifest(opts.paths?.globalConfig);
  const idx = manifest.projects.findIndex(
    (p) => p.slug === slugOrName || p.name.toLowerCase() === slugOrName.toLowerCase(),
  );
  if (idx === -1) {
    return {
      message: color.red(
        `Project not found: "${slugOrName}". Use /project list to see available projects.`,
      ),
    };
  }

  const removed = manifest.projects.at(idx)!;
  manifest.projects.splice(idx, 1);
  await saveManifest(manifest, opts.paths?.globalConfig);

  return {
    message: color.dim(
      `Removed: "${removed.name}" (${removed.root}) — data directory kept at ~/.wrongstack/projects/${removed.slug}/`,
    ),
  };
}

// ── Switch ──────────────────────────────────────────────────────────────

async function switchProjectCommand(
  opts: SlashCommandContext,
  ctx: Context | undefined,
  target: string,
  displayName?: string,
) {
  const resolved = path.resolve(ctx?.projectRoot ?? ctx?.cwd ?? process.cwd(), target);

  try {
    await fs.access(resolved);
  } catch {
    return { message: color.red(`Directory not found: ${resolved}`) };
  }
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    return { message: color.red(`Not a directory: ${resolved}`) };
  }

  // Try to resolve the CLI binary
  let cliPath: string;
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('@wrongstack/cli/package.json');
    const pkgDir = path.dirname(pkgPath);
    cliPath = path.join(pkgDir, 'dist', 'index.js');
    await fs.access(cliPath);
  } catch {
    cliPath = process.argv[1] ?? '';
    if (!cliPath) {
      return {
        message: color.red(
          'Could not locate the CLI entry point. Run `wstack` manually in the target directory.',
        ),
      };
    }
  }

  // Update the manifest with the new lastSeen before spawning
  const manifest = await loadManifest(opts.paths?.globalConfig);
  const existing = manifest.projects.find((p) => p.root === resolved);
  if (existing) {
    existing.lastSeen = new Date().toISOString();
  } else {
    // Auto-register if not in manifest
    const name = displayName?.trim() || path.basename(resolved);
    const slug = generateSlug(resolved);
    manifest.projects.push({ name, root: resolved, slug, lastSeen: new Date().toISOString() });
    await ensureProjectDataDir(slug, opts.paths?.globalConfig);
  }
  await saveManifest(manifest, opts.paths?.globalConfig);

  // Confirm before switching if agents are running
  const targetName = displayName?.trim() || path.basename(resolved);
  const canSwitch = await confirmProjectSwitch(opts, targetName);
  if (!canSwitch) return { message: '' };

  const nodeExe = process.execPath;
  const child = spawn(nodeExe, [cliPath, '--no-interactive'], {
    cwd: resolved,
    stdio: 'inherit',
    detached: false,
    // NO abort signal: this child is a long-lived INTERACTIVE session that
    // is meant to outlive the spawn call. The 30 s timeout fired 30 seconds
    // after "Switched to <project> … (current session stays open)" and
    // SIGTERM'd the new session mid-typing, with no message. Sibling
    // long-lived spawns pass no signal (slash-commands/mailbox-serve.ts:98),
    // and boot/tui-project-spawn.ts documents this exact bug being removed.
  });

  child.on('error', (err) => {
    console.error(color.red(`Failed to spawn wstack: ${err.message}`));
  });

  child.unref();

  return {
    message: [
      '',
      color.green(`  Spawning wstack in ${resolved} ...`),
      color.dim('  (current session stays open — Ctrl+C to return)'),
      '',
    ].join('\n'),
  };
}

// ── Interactive Switch ────────────────────────────────────────────────────

/**
 * Check for running agents/brain/fleet and warn the user before switching.
 * Returns `true` if the switch should proceed, `false` if cancelled.
 */
async function confirmProjectSwitch(
  opts: SlashCommandContext,
  targetName: string,
): Promise<boolean> {
  // Check fleet status for running subagents
  const fleetStatus = opts.onFleetStatus?.();
  const fleetRunning = fleetStatus?.subagents.filter((a) => a.status === 'running').length ?? 0;

  // Check for eternal/parallel engine activity
  const eternalEngine = opts.getEternalEngine?.();
  const parallelEngine = opts.getParallelEngine?.();
  const eternalActive = eternalEngine?.currentState === 'running';
  const parallelActive = parallelEngine?.currentState === 'running';

  const hasActiveAgents = fleetRunning > 0 || eternalActive || parallelActive;

  if (!hasActiveAgents) return true;

  // Build the warning message
  const parts: string[] = [color.yellow(`⚠  Switching projects will stop all running agents.`), ''];
  if (fleetRunning > 0) {
    parts.push(color.dim(`  • ${fleetRunning} subagent(s) currently running`));
  }
  if (eternalActive) {
    parts.push(color.dim('  • Eternal engine is active'));
  }
  if (parallelActive) {
    parts.push(color.dim('  • Parallel engine is active'));
  }
  parts.push('');
  parts.push(color.dim(`  Target: ${targetName}`));

  // Print the warning (already inside a slash command context, can write to renderer)
  opts.renderer.write(`\n${parts.join('\n')}\n`);

  // Ask for confirmation — if no confirm callback wired, proceed anyway (non-interactive)
  if (!opts.confirm) return true;

  const confirmed = await opts.confirm(
    color.yellow(`Stop all agents and switch to "${targetName}"?`),
    false, // default to No for safety
  );

  if (!confirmed) {
    opts.renderer.write(color.dim('  Switch cancelled.\n'));
    return false;
  }

  // Kill all running agents
  if (fleetRunning > 0) {
    const killed = opts.onFleetKill ? await opts.onFleetKill() : 0;
    if (killed > 0) {
      opts.renderer.write(color.dim(`  Stopped ${killed} subagent(s).\n`));
    }
  }
  if (eternalActive) {
    eternalEngine?.stop();
    opts.renderer.write(color.dim('  Stopped eternal engine.\n'));
  }
  if (parallelActive) {
    parallelEngine?.stop();
    opts.renderer.write(color.dim('  Stopped parallel engine.\n'));
  }

  return true;
}

async function switchInteractiveCommand(
  opts: SlashCommandContext,
  ctx: Context | undefined,
): Promise<{ message: string }> {
  const manifest = await loadManifest(opts.paths?.globalConfig);
  const currentRoot = ctx?.projectRoot;

  // Open the interactive picker
  const result = await runProjectPicker({
    globalConfigPath: opts.paths?.globalConfig,
    currentProjectRoot: currentRoot,
  });

  if (!result) {
    return { message: color.dim('Cancelled.') };
  }

  switch (result.kind) {
    case 'project': {
      // Find the project by slug
      const project = manifest.projects.find((p) => p.slug === result.key);
      if (!project) {
        return { message: color.red(`Project not found: ${result.key}`) };
      }

      // If already in the selected project, don't respawn
      if (project.root === currentRoot) {
        return { message: color.dim(`Already in ${project.name} (${project.root})`) };
      }

      // Confirm before switching if agents are running
      const canSwitch = await confirmProjectSwitch(opts, project.name);
      if (!canSwitch) return { message: '' };

      return spawnInProject(opts, ctx, project.root, project.name);
    }

    case 'action': {
      switch (result.action) {
        case 'new-session':
          return handleNewSession(opts, ctx);
        case 'prev-sessions':
          return handlePrevSessions(opts, ctx);
        default:
          return { message: color.dim('Cancelled.') };
      }
    }

    default:
      return { message: color.dim('Cancelled.') };
  }
}

/**
 * Spawn a new wstack process in the given project root.
 */
async function spawnInProject(
  opts: SlashCommandContext,
  _ctx: Context | undefined,
  root: string,
  projectName: string,
): Promise<{ message: string }> {
  // Try to resolve the CLI binary
  let cliPath: string;
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('@wrongstack/cli/package.json');
    const pkgDir = path.dirname(pkgPath);
    cliPath = path.join(pkgDir, 'dist', 'index.js');
    await fs.access(cliPath);
  } catch {
    cliPath = process.argv[1] ?? '';
    if (!cliPath) {
      return {
        message: color.red(
          'Could not locate the CLI entry point. Run `wstack` manually in the target directory.',
        ),
      };
    }
  }

  // Update the manifest with the new lastSeen before spawning
  const manifest = await loadManifest(opts.paths?.globalConfig);
  const existing = manifest.projects.find((p) => p.root === root);
  if (existing) {
    existing.lastSeen = new Date().toISOString();
  } else {
    // Auto-register if not in manifest
    const name = projectName || path.basename(root);
    const slug = generateSlug(root);
    manifest.projects.push({ name, root, slug, lastSeen: new Date().toISOString() });
    await ensureProjectDataDir(slug, opts.paths?.globalConfig);
  }
  await saveManifest(manifest, opts.paths?.globalConfig);

  const nodeExe = process.execPath;
  const child = spawn(nodeExe, [cliPath, '--no-interactive'], {
    cwd: root,
    stdio: 'inherit',
    detached: false,
    // NO abort signal: this child is a long-lived INTERACTIVE session that
    // is meant to outlive the spawn call. The 30 s timeout fired 30 seconds
    // after "Switched to <project> … (current session stays open)" and
    // SIGTERM'd the new session mid-typing, with no message. Sibling
    // long-lived spawns pass no signal (slash-commands/mailbox-serve.ts:98),
    // and boot/tui-project-spawn.ts documents this exact bug being removed.
  });

  child.on('error', (err) => {
    console.error(color.red(`Failed to spawn wstack: ${err.message}`));
  });

  child.unref();

  return {
    message: [
      '',
      color.green(`  Switched to ${projectName}`),
      color.dim(`  Root: ${root}`),
      color.dim('  (current session stays open — Ctrl+C to return)'),
      '',
    ].join('\n'),
  };
}

/**
 * Start a new session in the current project.
 */
async function handleNewSession(
  _opts: SlashCommandContext,
  _ctx: Context | undefined,
): Promise<{ message: string }> {
  // Restart in the current directory — spawn a fresh wstack
  let cliPath: string;
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('@wrongstack/cli/package.json');
    const pkgDir = path.dirname(pkgPath);
    cliPath = path.join(pkgDir, 'dist', 'index.js');
    await fs.access(cliPath);
  } catch {
    cliPath = process.argv[1] ?? '';
    if (!cliPath) {
      return {
        message: color.red('Could not locate the CLI entry point. Run `wstack` manually.'),
      };
    }
  }

  const nodeExe = process.execPath;
  const child = spawn(nodeExe, [cliPath, '--no-interactive'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    detached: false,
    // NO abort signal: this child is a long-lived INTERACTIVE session that
    // is meant to outlive the spawn call. The 30 s timeout fired 30 seconds
    // after "Switched to <project> … (current session stays open)" and
    // SIGTERM'd the new session mid-typing, with no message. Sibling
    // long-lived spawns pass no signal (slash-commands/mailbox-serve.ts:98),
    // and boot/tui-project-spawn.ts documents this exact bug being removed.
  });

  child.on('error', (err) => {
    console.error(color.red(`Failed to spawn wstack: ${err.message}`));
  });

  child.unref();

  return {
    message: [
      '',
      color.green('  Starting new session ...'),
      color.dim('  (current session stays open — Ctrl+C to return)'),
      '',
    ].join('\n'),
  };
}

/**
 * Show previously saved sessions (delegates to the /sessions command output).
 */
async function handlePrevSessions(
  opts: SlashCommandContext,
  _ctx: Context | undefined,
): Promise<{ message: string }> {
  if (!opts.sessionStore) {
    return { message: 'No session store configured. Start the REPL first.' };
  }

  const list = await opts.sessionStore.list(15);
  if (list.length === 0) {
    return { message: color.dim('No saved sessions.') };
  }

  const currentId = opts.context?.session?.id;
  const lines = [color.bold(`Recent sessions (${list.length}):`), ''];
  for (const s of list) {
    const isCurrent = s.id === currentId;
    const marker = isCurrent ? color.cyan('●') : ' ';
    const date = color.dim(s.startedAt.slice(0, 16).replace('T', ' '));
    const stats = [
      color.dim(`${s.tokenTotal.toLocaleString()} tok`),
      s.toolCallCount ? color.cyan(`${s.toolCallCount} calls`) : '',
      s.iterationCount ? color.dim(`${s.iterationCount} iter`) : '',
    ]
      .filter(Boolean)
      .join(' ');
    const outcome =
      s.outcome === 'completed'
        ? color.green('✓')
        : s.outcome === 'aborted'
          ? color.yellow('⚠')
          : s.outcome === 'error'
            ? color.red('✗')
            : color.dim('?');

    lines.push(`  ${marker} ${color.bold(s.id)}  ${date}`);
    lines.push(`       ${stats}  ${outcome}  ${color.dim(s.title)}`);
    lines.push('');
  }
  lines.push(color.dim('Resume: /sessions or wstack resume <id>'));

  return { message: lines.join('\n') };
}
