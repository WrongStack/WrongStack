import type { AgentPhase } from '@wrongstack/agent-catalog';
import { AGENT_CATALOG, AGENTS_BY_PHASE } from '@wrongstack/agent-catalog';
import type { SlashCommand } from '@wrongstack/contracts/types';
import { dispatchAgent } from '@wrongstack/coordination';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import { askingSessionId } from './fleet.js';
import type { FleetCommandHost } from './host.js';

/**
 * /delegate — user-facing counterpart to the AI's `delegate` tool.
 *
 * Hands a task to a subagent. With --role, spawns that specific role.
 * Without --role, uses smart dispatch (heuristic + LLM classifier) to
 * pick the best agent — same engine as /fleet dispatch.
 *
 * Usage:
 *   /delegate [--role=<role>] [--name=<label>] <task description>
 *   /delegate list                      List available roles
 *
 * Director Mode is permanently on — delegate is always available.
 */
export function buildDelegateCommand(host: FleetCommandHost): SlashCommand {
  return {
    name: 'delegate',
    category: 'Agent',
    description:
      'Hand a task to a specialist subagent. /delegate [--role=<role>] <task>. Auto-dispatches if no role given.',
    argsHint: '[--role=<role>] [--name=<label>] <task description>',
    help: [
      "User-facing counterpart to the AI's `delegate` tool.",
      '',
      'Usage:',
      '  /delegate <task description>                  Auto-dispatch to best agent',
      '  /delegate --role=<role> <task description>    Spawn a specific role',
      '  /delegate --role=<role> --name=<label> <task> Spawn with custom name',
      '  /delegate list                                 List available roles',
      '',
      'Examples:',
      '  /delegate "audit packages/core for null-deref bugs"',
      '  /delegate --role=bug-hunter "find the race condition in session.ts"',
      '  /delegate --role=security-scanner --name=sec-audit "scan configs for secrets"',
      '',
      'Smart dispatch uses the same engine as /fleet dispatch: heuristic keyword',
      'matching with LLM fallback when ambiguous. The chosen agent is shown before',
      'spawning so you can confirm or cancel.',
      '',
      'Requires director mode — Director Mode is always active in this session.',
      '',
      'Related: /spawn (fire-and-forget), /fleet dispatch (smart routing with fleet status).',
    ].join('\n'),

    async run(args, ctx) {
      const trimmed = args.trim();

      // ── /delegate list — show available roles ──────────────────────────
      if (trimmed === 'list' || trimmed === 'roles' || trimmed === 'ls') {
        return listRoles();
      }

      if (!trimmed) {
        return {
          message: [
            `${color.bold('/delegate')} — Hand a task to a specialist subagent`,
            '',
            'Usage:',
            `  ${color.cyan('/delegate <task>')}                    Auto-dispatch to best agent`,
            `  ${color.cyan('/delegate --role=<role> <task>')}     Spawn a specific role`,
            `  ${color.cyan('/delegate list')}                     List available roles`,
            '',
            'Requires director mode — Director Mode is always active in this session.',
          ].join('\n'),
        };
      }

      // Parse --role and --name flags, extract the task text
      let role: string | undefined;
      const taskParts: string[] = [];

      const tokens = trimmed.split(/\s+/);
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i] ?? '';
        if (t.startsWith('--role=')) {
          role = t.slice('--role='.length);
        } else if (t === '--role' && tokens[i + 1]) {
          role = tokens[++i];
        } else if (t === '--name' && tokens[i + 1]) {
          // The label is not part of the task; the roster role names the worker.
          i++;
        } else if (!t.startsWith('-')) {
          taskParts.push(t);
        }
      }

      const task = taskParts.join(' ').trim();
      if (!task) {
        return {
          message: `${color.amber('Usage:')} /delegate [--role=<role>] [--name=<label>] <task description>`,
        };
      }
      const origin = askingSessionId(ctx);

      // ── Explicit role → validate and spawn ─────────────────────────────
      if (role) {
        const normalized = role.toLowerCase();
        const def = AGENT_CATALOG[normalized];
        if (!def) {
          const available = Object.keys(AGENT_CATALOG).sort().join(', ');
          return {
            message: `${color.red('Unknown role')} "${role}". Available roles:\n  ${color.dim(available)}\n\nUse ${color.cyan('/delegate list')} to browse by phase.`,
          };
        }

        return await spawnAgent(
          host,
          normalized,
          origin,
          `${color.green('✓')} Delegating to ${color.bold(normalized)}: ${color.dim(task)}`,
        );
      }

      // ── Smart dispatch → classify + spawn ──────────────────────────────
      const decision = await dispatchAgent(task, {
        classifier: host.onDispatchClassify,
      });
      const pct = Math.round(decision.confidence * 100);

      const decisionMsg = [
        `${color.bold('→ ' + decision.role)} ${color.dim(`(${decision.method}, ${pct}% confidence)`)}`,
        `  ${color.dim(decision.definition.capability.summary)}`,
        `  ${color.dim('why:')} ${decision.reason}`,
        decision.alternatives.length > 0
          ? `  ${color.dim('alternatives:')} ${decision.alternatives
              .slice(0, 3)
              .map((a) => a.role)
              .join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      host.renderer.write(decisionMsg);

      return await spawnAgent(host, decision.role, origin, decisionMsg);
    },
  };
}

async function spawnAgent(
  host: FleetCommandHost,
  role: string,
  origin: string | undefined,
  header: string,
): Promise<{ message: string }> {
  if (!host.onFleetSpawn) {
    const msg = `${color.amber('⚠ No fleet active.')} Try spawning a task first.`;
    host.renderer.writeWarning(msg);
    return { message: msg };
  }

  try {
    const id = origin ? await host.onFleetSpawn(role, origin) : await host.onFleetSpawn(role);
    const msg = [header, `  ${color.green('✓ spawned')} as ${color.dim(id)}`].join('\n');
    host.renderer.write(msg);
    return { message: msg };
  } catch (err) {
    const msg = `${color.red('✗ Spawn failed')}: ${toErrorMessage(err)}`;
    host.renderer.writeWarning(msg);
    return { message: msg };
  }
}

function listRoles(): { message: string } {
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

  const totalRoles = Object.keys(AGENT_CATALOG).length;
  const lines: string[] = [
    `${color.bold('Available Agent Roles')} ${color.dim(`(${totalRoles} total)`)}`,
    '',
    `${color.dim('Use /delegate --role=<role> <task> to pick one,')}`,
    `${color.dim('or /delegate <task> for smart dispatch.')}`,
    '',
  ];

  for (const { phase, label } of PHASE_ORDER) {
    const agents = AGENTS_BY_PHASE[phase];
    if (!agents || agents.length === 0) continue;
    lines.push(color.cyan(`  Phase ${label}`));
    for (const def of agents.sort((a, b) =>
      (a.config.role ?? '').localeCompare(b.config.role ?? ''),
    )) {
      const role = (def.config.role ?? 'unknown').padEnd(20);
      lines.push(`    ${color.bold(role)} ${color.dim(def.capability.summary)}`);
    }
  }

  return { message: lines.join('\n') };
}
