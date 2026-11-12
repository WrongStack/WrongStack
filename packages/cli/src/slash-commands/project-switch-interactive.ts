import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { canonicalProjectRoot, cliSpawnArgs, color } from '@wrongstack/core/utils';
import { runProjectPicker } from '../project-picker.js';
import type { SlashCommandContext } from './command-context.js';
import {
  ensureProjectDataDir,
  generateSlug,
  loadManifest,
  updateManifest,
} from './project-utils.js';

// ── Interactive Switch ────────────────────────────────────────────────────

/**
 * Check for running agents/brain/fleet and warn the user before switching.
 * Returns `true` if the switch should proceed, `false` if cancelled.
 */
export async function confirmProjectSwitch(
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

export async function switchInteractiveCommand(
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

      // If already in the selected project, don't respawn. Identity is the
      // canonical root: a session inside a linked worktree (or a differently
      // cased spelling) of the picked project is already in it.
      if (
        currentRoot !== undefined &&
        canonicalProjectRoot(project.root) === canonicalProjectRoot(currentRoot)
      ) {
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
  let registeredSlug: string | undefined;
  const identityRoot = canonicalProjectRoot(root);
  await updateManifest(opts.paths?.globalConfig, (manifest) => {
    const existing = manifest.projects.find((p) => canonicalProjectRoot(p.root) === identityRoot);
    if (existing) {
      existing.lastSeen = new Date().toISOString();
      return true;
    }
    // Auto-register if not in manifest
    const name = projectName || path.basename(root);
    registeredSlug = generateSlug(root);
    manifest.projects.push({
      name,
      root,
      slug: registeredSlug,
      lastSeen: new Date().toISOString(),
    });
    return true;
  });
  if (registeredSlug) await ensureProjectDataDir(registeredSlug, opts.paths?.globalConfig);

  const nodeExe = process.execPath;
  const child = spawn(nodeExe, cliSpawnArgs(cliPath, ['--no-interactive']), {
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
  const child = spawn(nodeExe, cliSpawnArgs(cliPath, ['--no-interactive']), {
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
      (s.branchCount ?? 0) > 1
        ? color.magenta(
            `⎇ ${s.branchCount} branches${s.activeBranchName ? ` · active: ${s.activeBranchName}` : ''}`,
          )
        : '',
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

    lines.push(
      `  ${marker} ${color.bold(s.id)}${s.name ? ` ${color.cyan(`(${s.name})`)}` : ''}  ${date}`,
    );
    lines.push(`       ${stats}  ${outcome}  ${color.dim(s.title)}`);
    lines.push('');
  }
  lines.push(color.dim('Resume: /sessions or wstack resume <id>'));

  return { message: lines.join('\n') };
}
