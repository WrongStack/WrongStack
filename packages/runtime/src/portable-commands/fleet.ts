import type { SlashCommand } from '@wrongstack/contracts/types';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import type { FleetCommandHost, SpawnCommandOptions } from './host.js';

/** The conversation a command runs in, when the host passed one. */
export function askingSessionId(ctx: Parameters<SlashCommand['run']>[1]): string | undefined {
  const id = (ctx as { session?: { id?: unknown } } | undefined)?.session?.id;
  return typeof id === 'string' && id ? id : undefined;
}

interface SpawnFlags {
  description: string;
  opts: {
    provider?: string | undefined;
    model?: string | undefined;
    tools?: string[] | undefined;
    name?: string | undefined;
  };
}

/**
 * Parse `/spawn` flags from the args head. Supported:
 *   --provider=<id> / -p <id>   override the subagent's provider id
 *   --model=<id>    / -m <id>   override the subagent's model
 *   --name=<label>  / -n <label> display name
 *   --tools=a,b,c               restrict the subagent's tool slice
 *
 * All four value flags accept quoted values (`--model="gpt-4o"`); the
 * surrounding quotes are stripped. Without this, a habitually quoted id
 * flows into multiAgentHost.spawn() with the quote characters embedded.
 *
 * Anything after the last flag is the task description.
 */
export function parseSpawnFlags(input: string): SpawnFlags {
  const opts: SpawnFlags['opts'] = {};
  let rest = input;
  const consume = (re: RegExp): RegExpMatchArray | null => {
    const m = rest.match(re);
    if (m) {
      rest = rest.slice(m[0].length).replace(/^\s+/, '');
      return m;
    }
    return null;
  };
  while (rest.length > 0) {
    let m: RegExpMatchArray | null;
    m = consume(/^(?:--provider|-p)[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))\s*/);
    if (m) opts.provider = m[1] ?? m[2] ?? m[3];
    else {
      m = consume(/^(?:--model|-m)[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))\s*/);
      if (m) opts.model = m[1] ?? m[2] ?? m[3];
      else {
        m = consume(/^(?:--name|-n)[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))\s*/);
        if (m) opts.name = m[1] ?? m[2] ?? m[3];
        else {
          m = consume(/^(?:--tools|-t)[=\s]+(?:"([^"]+)"|'([^']+)'|(\S+))\s*/);
          if (m) {
            const rawTools = m[1] ?? m[2] ?? m[3] ?? '';
            opts.tools = rawTools
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean);
          } else break;
        }
      }
    }
  }
  return { description: rest.trim(), opts };
}

export function buildSpawnCommand(host: FleetCommandHost): SlashCommand {
  return {
    name: 'spawn',
    category: 'Agent',
    description: 'Spawn an isolated subagent to handle a task.',
    argsHint: '[--name=<label>] [--model=<id>] <task description>',
    help: [
      'Fire-and-forget subagent spawn. The subagent runs independently; check',
      'its status with /agents or /fleet.',
      '',
      'Usage:',
      '  /spawn <task description>',
      '  /spawn --name=<label> --model=<id> <task description>',
      '',
      'Flags:',
      '  --name=<label>   Display name for the subagent',
      '  --provider=<id>  Override the provider (defaults to leader provider)',
      '  --model=<id>     Override the model (defaults to leader model)',
      '  --tools=a,b,c    Comma-separated list of tool names to grant',
      '',
      'For smart routing (auto-picking the right agent role), use /delegate <task>.',
      'For explicit role assignment, use /delegate --role=<role> <task>.',
      '',
      'Director mode is always active — spawning is available.',
    ].join('\n'),
    async run(args, ctx) {
      const { description, opts: parsed } = parseSpawnFlags(args.trim());
      if (!description)
        return {
          message:
            'Usage: /spawn [--name=<label>] [--model=<id>] <task description>\n\nExamples:\n  /spawn "fix the auth bug in session.ts"\n  /spawn --name=fixer "audit core for null-deref bugs"\n\nDirector Mode is always active.',
        };
      if (!host.onSpawn) return { message: 'Multi-agent is not enabled in this session.' };
      const origin = askingSessionId(ctx);
      const options: SpawnCommandOptions = {
        ...parsed,
        ...(origin ? { originSessionId: origin } : {}),
      };
      try {
        const summary =
          Object.keys(options).length > 0
            ? await host.onSpawn(description, options)
            : await host.onSpawn(description);
        return { message: summary };
      } catch (err) {
        return { message: `Spawn failed: ${toErrorMessage(err)}` };
      }
    },
  };
}

export function buildDirectorCommand(host: FleetCommandHost): SlashCommand {
  return {
    name: 'director',
    category: 'Agent',
    description:
      'Promote this session to director mode, enabling fleet orchestration tools. Only works before any subagents are spawned.',
    help: [
      'Director Mode is permanently on — fleet commands are always available.',
      '',
      '  /fleet status|spawn|dispatch|kill|usage',
      '  /spawn "<task>"',
      '  /agents',
    ].join('\n'),
    async run() {
      if (!host.onDirector)
        return { message: 'Director promotion is not available in this session.' };
      const result = await host.onDirector();
      if (result === null) return { message: 'Director is not available in this session.' };
      return { message: result };
    },
  };
}

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

/**
 * /supervisor — inspect and toggle the brain-gated FleetSupervisor.
 *
 * The supervisor is the fleet's shadow watcher: it monitors queue shape and
 * worker activity while a Director fleet runs, and — through the tiered
 * Brain (policy → LLM → human, /brain risk ceiling) — rebalances pending
 * tasks off overloaded workers, spawns helpers on deep backlogs, steers
 * stuck or repeatedly-failing workers, and keeps the leader informed.
 */
export function buildSupervisorCommand(host: FleetCommandHost): SlashCommand {
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
      const supervisor = host.getFleetSupervisor?.() ?? null;
      const sub = (args.trim().split(/\s+/)[0] ?? '').toLowerCase();
      const say = (msg: string) => {
        host.renderer.write(msg);
        return { message: msg };
      };

      if (!supervisor) {
        host.renderer.writeWarning(NO_SUPERVISOR_MSG);
        return { message: NO_SUPERVISOR_MSG };
      }
      if (sub === 'on') {
        supervisor.start();
        return say(
          `Fleet supervisor ${color.green('armed')} — evaluating every ${Math.round(supervisor.configSnapshot().intervalMs / 1000)}s.`,
        );
      }
      if (sub === 'off') {
        supervisor.stop();
        return say(
          `Fleet supervisor ${color.yellow('disarmed')} — no further automatic interventions this session.`,
        );
      }
      if (sub === 'log') {
        const n = Math.max(1, Number.parseInt(args.trim().split(/\s+/)[1] ?? '10', 10) || 10);
        const entries = supervisor.history().slice(-n);
        if (entries.length === 0) return say('No supervision activity yet.');
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
        return say(lines.join('\n'));
      }

      // status (default)
      const cfg = supervisor.configSnapshot();
      const history = supervisor.history();
      const last = history[history.length - 1];
      return say(
        [
          `Fleet supervisor: ${supervisor.isRunning() ? color.green('armed') : color.yellow('disarmed')}`,
          `  interval ${Math.round(cfg.intervalMs / 1000)}s · cooldown ${Math.round(cfg.cooldownMs / 1000)}s · max ${cfg.maxInterventionsPerSubagent} interventions/agent`,
          `  signals: starvation>${Math.round(cfg.pinnedWaitMs / 1000)}s · overload≥${cfg.overloadPinnedThreshold} pinned · backlog>${cfg.backlogFactor}×workers · stuck>${Math.round(cfg.stuckMs / 1000)}s · failstreak≥${cfg.failureStreak}`,
          `  actions: retarget ✓ · spawn ${cfg.allowSpawn ? '✓' : '✗'} · steer ✓ · terminate ${cfg.allowTerminate ? '✓' : '✗ (config fleet.supervisor.allowTerminate)'}`,
          `  activity: ${history.length} engagement(s)${last ? ` — last: ${last.kind} → ${last.proposedAction} [${last.outcome}] ${fmtAge(last.at)}` : ''}`,
          color.dim('  decisions are gated by the Brain — see /brain (risk ceiling applies)'),
        ].join('\n'),
      );
    },
  };
}
