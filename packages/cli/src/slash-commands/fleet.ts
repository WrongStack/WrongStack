import type { AgentPhase } from '@wrongstack/core/agent-catalog';
import { AGENTS_BY_PHASE } from '@wrongstack/core/agent-catalog';
import { dispatchAgent } from '@wrongstack/core/coordination';
import type { SlashCommand } from '@wrongstack/core/types';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import { formatFleetBudgetLines } from '../fleet/host-status.js';
import type { SlashCommandContext } from './command-context.js';

const PHASE_ORDER: { phase: AgentPhase; label: string }[] = [
  { phase: 'discovery', label: '1 · Discovery' },
  { phase: 'planning', label: '2 · Planning' },
  { phase: 'build', label: '3 · Build' },
  { phase: 'verify', label: '4 · Verify' },
  { phase: 'review', label: '5 · Review' },
  { phase: 'domain', label: '6 · Domain' },
  { phase: 'knowledge', label: '7 · Knowledge' },
  { phase: 'delivery', label: '8 · Delivery & Ops' },
  { phase: 'meta', label: '9 · Meta' },
];

/**
 * /fleet — live fleet observability and control.
 *
 * Requires a FleetManager or Director instance to be wired into SlashCommandContext.
 * Works during /autonomy parallel mode (when the engine is running) and for
 * any standalone director session.
 *
 * Usage:
 *   /fleet              — status table: subagent id / name / role / status / current task
 *   /fleet status       — same as /fleet (verbose)
 *   /fleet spawn <role> [count]  — spawn N subagents of a given role (default 1)
 *   /fleet terminate <subagentId>  — stop a specific subagent
 *   /fleet kill         — stop all running subagents
 *   /fleet usage        — token and cost breakdown across the fleet
 *   /fleet journal      — show recent journal entries from goal.json
 */
export function buildFleetCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'fleet',
    category: 'Agent',
    description: 'Inspect and control the agent fleet (subagents, parallel slots).',
    help: [
      'Usage:',
      '  /fleet              Show fleet status (default)',
      '  /fleet status       Same as /fleet (verbose status)',
      '  /fleet list         List the agent roster grouped by phase',
      '  /fleet dispatch <task>  Route a task to the best agent and spawn it',
      '  /fleet spawn <role> [count]  Spawn N subagents of a role (default 1)',
      '  /fleet terminate <subagentId>  Stop a specific subagent by id',
      '  /fleet kill         Stop all running subagents',
      '  /fleet usage        Token and cost breakdown across the fleet',
      '  /fleet concurrency [n]  Show or set the concurrent-subagent ceiling',
      '  /fleet journal      Show recent journal entries from /goal journal',
      '  /fleet retry [taskId]  Re-run interrupted task(s) (director mode only)',
      '',
      'In the TUI, press Ctrl+F to open the graphical fleet monitor.',
      'Works during /autonomy parallel mode and standalone director sessions.',
    ].join('\n'),
    async run(args) {
      const parts = args.trim().split(/\s+/);
      const cmd = parts[0]?.toLowerCase() ?? '';
      const subargs = parts.slice(1);

      switch (cmd) {
        // ── /fleet (default / status / manifest) ────────────────────────────
        case '':
        case 'status':
        case 'info':
        case 'manifest':
          return await handleStatus(opts, cmd);

        // ── /fleet usage ────────────────────────────────────────────────────
        case 'usage':
        case 'cost':
        case 'tokens':
          return await handleUsage(opts);

        // ── /fleet retry ─────────────────────────────────────────────────────
        case 'retry':
          return await handleRetry(opts, subargs);

        // ── /fleet journal / log ─────────────────────────────────────────────
        case 'journal':
        case 'log':
          return await handleJournal(opts, subargs);

        // ── /fleet kill ──────────────────────────────────────────────────────
        case 'kill':
        case 'stop-all':
          return await handleKill(opts, subargs);

        // ── /fleet terminate <subagentId> ────────────────────────────────────
        case 'terminate':
        case 'stop':
          return await handleTerminate(opts, subargs);

        // ── /fleet spawn <role> [count] ──────────────────────────────────────
        case 'spawn':
        case 'add':
          return await handleSpawn(opts, subargs);

        // ── /fleet list ──────────────────────────────────────────────────────
        case 'list':
        case 'roster':
        case 'agents':
          return handleList();

        // ── /fleet dispatch <task> ───────────────────────────────────────────
        case 'dispatch':
        case 'route':
          return await handleDispatch(opts, subargs);

        // ── /fleet concurrency [n] ───────────────────────────────────────────
        case 'concurrency':
        case 'slots':
        case 'parallel':
          return await handleConcurrency(opts, subargs);

        // ── /fleet help ──────────────────────────────────────────────────────
        case 'help':
        case '?':
          return handleFleetHelp(opts);

        // ── Unknown command ──────────────────────────────────────────────────
        default: {
          const valid = [
            'status',
            'list',
            'dispatch',
            'usage',
            'spawn',
            'terminate',
            'kill',
            'retry',
            'concurrency',
            'journal',
          ];
          const msg = `Unknown subcommand "${cmd}". Valid subcommands: ${valid.join(', ')}. Run /fleet with no args to see status, or /fleet help for usage.`;
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
      }
    },
  };
}

// ── Fleet subcommand handlers ───────────────────────────────────────────────

async function handleStatus(opts: SlashCommandContext, cmd: string): Promise<{ message: string }> {
  if (opts.onFleetStatus) {
    const status = opts.onFleetStatus();
    if (!status) {
      const msg = `${color.amber('⚠ No fleet active.')} Try spawning a task first.`;
      opts.renderer.write(msg);
      return { message: msg };
    }
    const lines: string[] = [];
    lines.push(`${color.bold('Fleet Status')}`);
    lines.push(
      color.dim(
        `  coordinator: ${status.coordinatorId}  ·  pending: ${status.pendingTasks}  ·  done: ${status.completedTasks}`,
      ),
    );
    if (status.subagents.length === 0) {
      lines.push(color.dim('  No active subagents.'));
    } else {
      lines.push('');
      lines.push(
        `  ${color.bold('ID').padEnd(36)} ${color.bold('NAME').padEnd(16)} ${color.bold('STATUS').padEnd(10)} ${color.bold('TASK')}`,
      );
      lines.push(color.dim('  ' + '─'.repeat(80)));
      for (const sa of status.subagents) {
        const id = sa.id?.padEnd(36) ?? ''.padEnd(36);
        const name = (sa.name ?? 'worker').padEnd(16);
        const statusColor =
          sa.status === 'running'
            ? color.green(sa.status.padEnd(10))
            : sa.status === 'idle'
              ? color.dim(sa.status.padEnd(10))
              : color.dim(sa.status.padEnd(10));
        const ext =
          sa.extensions && sa.extensions > 0 ? `${color.yellow(`⚡×${sa.extensions}`)} ` : '';
        const task = sa.currentTask ?? color.dim('—');
        lines.push(`  ${id} ${name} ${statusColor} ${ext}${task}`);
      }
    }
    const budget = opts.onFleetBudget?.();
    if (budget) {
      lines.push(
        '',
        ...formatFleetBudgetLines(budget, {
          bold: color.bold,
          dim: color.dim,
          amber: color.amber,
        }),
      );
    }
    const msg = lines.join('\n');
    opts.renderer.write(msg);
    return { message: msg };
  }
  if (opts.onFleet) {
    const msg = await opts.onFleet(
      (cmd || 'status') as
        | 'status'
        | 'usage'
        | 'kill'
        | 'manifest'
        | 'concurrency'
        | 'retry'
        | 'log',
      undefined,
    );
    return { message: msg };
  }
  const msg = `${color.amber('⚠ No fleet active.')} Try spawning a task first.`;
  opts.renderer.write(msg);
  return { message: msg };
}

async function handleUsage(opts: SlashCommandContext): Promise<{ message: string }> {
  if (opts.onFleetUsage) {
    const usage = opts.onFleetUsage();
    if (!usage) {
      const msg = `${color.amber('⚠ No fleet usage data.')} Start /autonomy parallel first.`;
      opts.renderer.write(msg);
      return { message: msg };
    }
    const totalCost = usage.total?.cost ?? 0;
    const totalIn = usage.total?.input ?? 0;
    const totalOut = usage.total?.output ?? 0;
    const lines: string[] = [];
    lines.push(`${color.bold('Fleet Usage')}`);
    lines.push(
      `  ${color.dim('Total:')} ${color.green(`${totalCost.toFixed(4)}`)} · ${color.cyan(totalIn.toLocaleString())} in · ${color.cyan(totalOut.toLocaleString())} out`,
    );
    const subagents = Object.values(usage.perSubagent);
    if (subagents.length > 0) {
      lines.push('');
      for (const sa of subagents) {
        const name = (sa.subagentId ?? '?').padEnd(20);
        const cost = `${(sa.cost ?? 0).toFixed(4)}`.padStart(10);
        const tokens = `${sa.input ?? 0} in / ${sa.output ?? 0} out`.padEnd(30);
        lines.push(`  ${color.dim(name)} ${color.cyan(cost)} ${color.dim(tokens)}`);
      }
    }
    // Retired subagents stay in `total` but lose their per-agent row, so
    // without this line the itemized rows visibly fail to add up to the total.
    const retired = usage.retired;
    if (retired && retired.subagents > 0) {
      if (subagents.length === 0) lines.push('');
      const retiredLabel = `retired (${retired.subagents})`.padEnd(20);
      const retiredCost = `${retired.cost.toFixed(4)}`.padStart(10);
      const retiredTokens = `${retired.input} in / ${retired.output} out`.padEnd(30);
      lines.push(
        `  ${color.dim(retiredLabel)} ${color.cyan(retiredCost)} ${color.dim(retiredTokens)}`,
      );
    }
    const msg = lines.join('\n');
    opts.renderer.write(msg);
    return { message: msg };
  }
  if (opts.onFleet) {
    const msg = await opts.onFleet('usage', undefined);
    return { message: msg };
  }
  const msg = `${color.amber('⚠ No fleet usage data.')} Start /autonomy parallel first.`;
  opts.renderer.write(msg);
  return { message: msg };
}

async function handleRetry(
  opts: SlashCommandContext,
  subargs: string[],
): Promise<{ message: string }> {
  if (opts.onFleetRetry) {
    const targetId = subargs[0];
    const msg = await opts.onFleetRetry(targetId);
    return { message: msg };
  }
  if (opts.onFleet) {
    const msg = await opts.onFleet('retry', subargs[0]);
    return { message: msg };
  }
  const msg = `Retry is only available when director mode is active.`;
  opts.renderer.writeWarning(msg);
  return { message: msg };
}

async function handleJournal(
  opts: SlashCommandContext,
  subargs: string[],
): Promise<{ message: string }> {
  if (opts.onFleetLog) {
    const subagentId = subargs[0];
    const mode = subargs[1] === 'raw' ? 'raw' : 'summary';
    const msg = await opts.onFleetLog(subagentId, mode);
    return { message: msg };
  }
  if (opts.onFleet) {
    const msg = await opts.onFleet('log', subargs[0]);
    return { message: msg };
  }
  const msg = `${color.dim('No journal entries yet.')}`;
  opts.renderer.write(msg);
  return { message: msg };
}

async function handleKill(
  opts: SlashCommandContext,
  subargs: string[],
): Promise<{ message: string }> {
  const targetId = subargs[0];
  if (targetId) {
    if (opts.onFleet) {
      const msg = await opts.onFleet('kill', targetId);
      return { message: msg };
    }
    const msg = `${color.amber('⚠ /fleet kill <id> is not wired in this session.')}`;
    opts.renderer.writeWarning(msg);
    return { message: msg };
  }
  if (opts.onFleetKill) {
    const killed = await opts.onFleetKill();
    const msg = `${color.red('✗ Killed')} ${killed} subagent(s).`;
    opts.renderer.write(msg);
    return { message: msg };
  }
  const msg = `${color.amber('⚠ /fleet kill is not wired in this session.')}`;
  opts.renderer.writeWarning(msg);
  return { message: msg };
}

async function handleTerminate(
  opts: SlashCommandContext,
  subargs: string[],
): Promise<{ message: string }> {
  const targetId = subargs[0];
  if (!targetId) {
    const msg = `${color.amber('⚠ /fleet terminate requires a subagentId.')} Use /fleet to see active ids.`;
    opts.renderer.writeWarning(msg);
    return { message: msg };
  }
  if (!opts.onFleetTerminate) {
    const msg = `${color.amber('⚠ /fleet terminate is not wired in this session.')}`;
    opts.renderer.writeWarning(msg);
    return { message: msg };
  }
  const ok = await opts.onFleetTerminate(targetId);
  if (ok) {
    const msg = `${color.green('✓ Terminated')} subagent ${color.bold(targetId)}.`;
    opts.renderer.write(msg);
    return { message: msg };
  }
  const msg = `${color.red('✗ Failed')} to terminate ${color.bold(targetId)}. Subagent may already be stopped.`;
  opts.renderer.writeWarning(msg);
  return { message: msg };
}

async function handleSpawn(
  opts: SlashCommandContext,
  subargs: string[],
): Promise<{ message: string }> {
  const role = subargs[0] ?? 'worker';
  const count = Math.min(16, Math.max(1, Number.parseInt(subargs[1] ?? '1', 10) || 1));
  if (!opts.onFleetSpawn) {
    const msg = `${color.amber('⚠ /fleet spawn is not wired in this session.')}`;
    opts.renderer.writeWarning(msg);
    return { message: msg };
  }
  const spawned: string[] = [];
  for (let i = 0; i < count; i++) {
    try {
      const id = await opts.onFleetSpawn(role);
      spawned.push(id);
    } catch (err) {
      const warnMsg = `${color.red('✗ Spawn failed')} for slot ${i + 1}: ${toErrorMessage(err)}`;
      opts.renderer.writeWarning(warnMsg);
    }
  }
  if (spawned.length === count) {
    const msg = `${color.green('✓ Spawned')} ${count} subagent(s) of role ${color.bold(role)}.`;
    opts.renderer.write(msg);
    return { message: msg };
  }
  const msg = `${color.amber('⚠ Spawned')} ${spawned.length}/${count} subagent(s). Check /fleet for details.`;
  opts.renderer.writeWarning(msg);
  return { message: msg };
}

function handleList(): { message: string } {
  const lines: string[] = [
    `${color.bold('Agent Roster')} ${color.dim('(spawn with /fleet spawn <role>)')}`,
  ];
  for (const { phase, label } of PHASE_ORDER) {
    const defs = AGENTS_BY_PHASE[phase];
    if (!defs || defs.length === 0) continue;
    lines.push('');
    lines.push(color.cyan(`  Phase ${label}`));
    for (const def of defs) {
      const role = (def.config.role ?? '').padEnd(18);
      lines.push(`    ${color.bold(role)} ${color.dim(def.capability.summary)}`);
    }
  }
  return { message: lines.join('\n') };
}

async function handleDispatch(
  opts: SlashCommandContext,
  subargs: string[],
): Promise<{ message: string }> {
  const skipConfirm = subargs.includes('--yes') || subargs.includes('-y');
  const task = subargs
    .filter((t) => t !== '--yes' && t !== '-y')
    .join(' ')
    .trim();
  if (!task) {
    const msg = `Usage: /fleet dispatch <task description> — routes the task to the best agent.`;
    opts.renderer.writeWarning(msg);
    return { message: msg };
  }
  const decision = await dispatchAgent(task, { classifier: opts.onDispatchClassify });
  const pct = Math.round(decision.confidence * 100);
  const lines: string[] = [];
  lines.push(
    `${color.bold('→ ' + decision.role)} ${color.dim(`(${decision.method}, ${pct}% confidence)`)}`,
  );
  lines.push(`  ${color.dim(decision.definition.capability.summary)}`);
  lines.push(`  ${color.dim('why:')} ${decision.reason}`);
  if (decision.alternatives.length > 0) {
    const alts = decision.alternatives
      .slice(0, 3)
      .map((a) => a.role)
      .join(', ');
    lines.push(`  ${color.dim('alternatives:')} ${alts}`);
  }
  if (opts.onFleetSpawn) {
    // Low-confidence routing is easy to get wrong — confirm before spawning
    // unless the user passed --yes or there's no interactive prompt available.
    const LOW_CONFIDENCE = 60;
    if (pct < LOW_CONFIDENCE && opts.confirm && !skipConfirm) {
      opts.renderer.write(lines.join('\n'));
      const ok = await opts.confirm(
        `Low confidence (${pct}%). Spawn ${decision.role} anyway?`,
        false,
      );
      if (ok !== true) {
        const msg = `${color.dim('Dispatch cancelled — re-run with a clearer task or /fleet spawn <role> to choose.')}`;
        opts.renderer.write(msg);
        return { message: `${lines.join('\n')}\n${msg}` };
      }
    }
    try {
      const id = await opts.onFleetSpawn(decision.role);
      lines.push(`  ${color.green('✓ spawned')} ${color.bold(decision.role)} as ${color.dim(id)}`);
    } catch (err) {
      lines.push(`  ${color.amber('⚠ spawn failed:')} ${toErrorMessage(err)}`);
    }
  } else {
    lines.push(`  ${color.dim('(no fleet active — try spawning a task)')}`);
  }
  const msg = lines.join('\n');
  opts.renderer.write(msg);
  return { message: msg };
}

async function handleConcurrency(
  opts: SlashCommandContext,
  subargs: string[],
): Promise<{ message: string }> {
  if (opts.onFleet) {
    const n = subargs[0];
    const msg = await opts.onFleet('concurrency', n || undefined);
    return { message: msg };
  }
  const msg = `${color.amber('⚠ /fleet concurrency is not wired in this session.')}`;
  opts.renderer.writeWarning(msg);
  return { message: msg };
}

function handleFleetHelp(opts: SlashCommandContext): { message: string } {
  const msg = [
    `${color.bold('Fleet Commands')}`,
    `  ${color.dim('/fleet')}              Show fleet status (default)`,
    `  ${color.dim('/fleet status')}       Same as /fleet (verbose status)`,
    `  ${color.dim('/fleet list')}         List the agent roster grouped by phase`,
    `  ${color.dim('/fleet dispatch <task>')}  Route a task to the best agent and spawn it`,
    `  ${color.dim('/fleet spawn <role> [count]')}  Spawn N subagents of a role (default 1)`,
    `  ${color.dim('/fleet terminate <subagentId>')}  Stop a specific subagent by id`,
    `  ${color.dim('/fleet kill')}         Stop all running subagents`,
    `  ${color.dim('/fleet usage')}        Token and cost breakdown across the fleet`,
    `  ${color.dim('/fleet concurrency [n]')}  Show or set the concurrent-subagent ceiling`,
    `  ${color.dim('/fleet journal')}      Show recent journal entries from /goal journal`,
    `  ${color.dim('/fleet retry [taskId]')}  Re-run interrupted task(s) (director mode only)`,
  ].join('\n');
  opts.renderer.write(msg);
  return { message: msg };
}
