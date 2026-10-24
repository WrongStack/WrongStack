/**
 * /supervisor — inspect and toggle the brain-gated FleetSupervisor.
 *
 * The supervisor is the fleet's shadow watcher: it monitors queue shape and
 * worker activity while a Director fleet runs, and — through the tiered
 * Brain (policy → LLM → human, /brain risk ceiling) — rebalances pending
 * tasks off overloaded workers, spawns helpers on deep backlogs, steers
 * stuck or repeatedly-failing workers, and keeps the leader informed.
 *
 *   /supervisor              status — running state, config, recent activity
 *   /supervisor status       same
 *   /supervisor on|off       arm / disarm the evaluation loop for this session
 *   /supervisor log [n]      show the last n signal→decision→action entries
 */
import type { SlashCommand } from '@wrongstack/contracts/types';
import { color } from '@wrongstack/core/utils';
import { getActiveFleetSupervisor } from '../fleet/supervisor-registry.js';
import type { SlashCommandContext } from './command-context.js';

function fmtAge(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  // Promote at the rounding boundary: 59m50s is "1h ago", not "60m ago".
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.max(1, Math.round(s / 3600))}h ago`;
}

const NO_SUPERVISOR_MSG =
  'No fleet supervisor is active. It starts automatically with the Director fleet ' +
  'when a Brain is available and config fleet.supervisor.enabled is not false.';

export function buildSupervisorCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'supervisor',
    category: 'Agent',
    argsHint: '[status|on|off|log [n]]',
    description: 'Inspect or toggle the fleet supervisor (brain-gated rebalance/steer watcher).',
    help: [
      'Usage:',
      '  /supervisor            Show supervisor status (running state, config, last activity)',
      '  /supervisor status     Same as /supervisor',
      '  /supervisor on         Arm the supervision loop for this session',
      '  /supervisor off        Disarm it (no further automatic interventions)',
      '  /supervisor log [n]    Show the last n supervision entries (default 10)',
      '',
      'The supervisor watches the Director fleet and, gated by the Brain',
      '(/brain risk), rebalances pending tasks off busy workers, spawns',
      'helpers on deep backlogs, and steers stuck or failing workers.',
      'Configure via the active profile config → fleet.supervisor.',
    ].join('\n'),
    async run(args) {
      const supervisor = getActiveFleetSupervisor();
      const sub = (args.trim().split(/\s+/)[0] ?? '').toLowerCase();

      if (!supervisor) {
        opts.renderer.writeWarning(NO_SUPERVISOR_MSG);
        return { message: NO_SUPERVISOR_MSG };
      }

      if (sub === 'on') {
        supervisor.start();
        const msg = `Fleet supervisor ${color.green('armed')} — evaluating every ${Math.round(supervisor.configSnapshot().intervalMs / 1000)}s.`;
        opts.renderer.write(msg);
        return { message: msg };
      }

      if (sub === 'off') {
        supervisor.stop();
        const msg = `Fleet supervisor ${color.yellow('disarmed')} — no further automatic interventions this session.`;
        opts.renderer.write(msg);
        return { message: msg };
      }

      if (sub === 'log') {
        const n = Math.max(1, Number.parseInt(args.trim().split(/\s+/)[1] ?? '10', 10) || 10);
        const entries = supervisor.history().slice(-n);
        if (entries.length === 0) {
          const msg = 'No supervision activity yet.';
          opts.renderer.write(msg);
          return { message: msg };
        }
        const lines = entries.map((e) => {
          const who = e.subagentId ? ` ${color.cyan(e.subagentId)}` : '';
          const task = e.taskId ? ` task=${e.taskId.slice(0, 8)}` : '';
          const outcome =
            e.outcome === 'approved'
              ? color.green(e.outcome)
              : e.outcome === 'denied' || e.outcome === 'error'
                ? color.red(e.outcome)
                : color.yellow(e.outcome);
          return `${color.dim(fmtAge(e.at))} ${e.kind}${who}${task} → ${e.proposedAction} [${outcome}] ${color.dim(e.detail)}`;
        });
        const msg = lines.join('\n');
        opts.renderer.write(msg);
        return { message: msg };
      }

      // status (default)
      const cfg = supervisor.configSnapshot();
      const history = supervisor.history();
      const last = history[history.length - 1];
      const lines = [
        `Fleet supervisor: ${supervisor.isRunning() ? color.green('armed') : color.yellow('disarmed')}`,
        `  interval ${Math.round(cfg.intervalMs / 1000)}s · cooldown ${Math.round(cfg.cooldownMs / 1000)}s · max ${cfg.maxInterventionsPerSubagent} interventions/agent`,
        `  signals: starvation>${Math.round(cfg.pinnedWaitMs / 1000)}s · overload≥${cfg.overloadPinnedThreshold} pinned · backlog>${cfg.backlogFactor}×workers · stuck>${Math.round(cfg.stuckMs / 1000)}s · failstreak≥${cfg.failureStreak}`,
        `  actions: retarget ✓ · spawn ${cfg.allowSpawn ? '✓' : '✗'} · steer ✓ · terminate ${cfg.allowTerminate ? '✓' : '✗ (config fleet.supervisor.allowTerminate)'}`,
        `  activity: ${history.length} engagement(s)${last ? ` — last: ${last.kind} → ${last.proposedAction} [${last.outcome}] ${fmtAge(last.at)}` : ''}`,
        color.dim('  decisions are gated by the Brain — see /brain (risk ceiling applies)'),
      ];
      const msg = lines.join('\n');
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}
