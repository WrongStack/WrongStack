import type { SlashCommand } from '@wrongstack/contracts/types';
import { getProcessRegistry } from '@wrongstack/tools';

const USAGE =
  'Usage:\n' +
  '  /kill             — list active processes + breaker state\n' +
  '  /kill list        — same as /kill\n' +
  '  /kill all         — kill all tracked processes (SIGTERM → SIGKILL)\n' +
  '  /kill force       — kill all with SIGKILL immediately\n' +
  '  /kill reset       — reset the circuit breaker to closed\n' +
  '  /kill <pid>       — kill a specific process by PID';

export function createKillSlashCommand(): SlashCommand {
  return {
    name: 'kill',
    description: 'List or kill active bash/exec processes managed by the process registry.',
    async run(args) {
      const trimmed = args.trim();
      const parts = trimmed.split(/\s+/);
      const sub = parts[0]?.toLowerCase() ?? '';

      if (sub === '' || sub === 'list') {
        return { message: renderList() };
      }

      if (sub === 'all') {
        const pids = getProcessRegistry().killAll();
        if (pids.length === 0) return { message: 'No processes to kill.' };
        return {
          message: `Killed ${pids.length} process${pids.length === 1 ? '' : 'es'}: ${pids.join(', ')}`,
        };
      }

      if (sub === 'force') {
        getProcessRegistry().forceBreakerOpen();
        const pids = getProcessRegistry().killAll({ force: true });
        if (pids.length === 0)
          return { message: 'Circuit breaker forced open. No processes to kill.' };
        return {
          message: `Force-killed ${pids.length} process${pids.length === 1 ? '' : 'es'}: ${pids.join(', ')}`,
        };
      }

      if (sub === 'reset') {
        getProcessRegistry().forceBreakerReset();
        return { message: 'Circuit breaker reset to closed. Bash/exec calls allowed.' };
      }

      const pid = Number.parseInt(sub, 10);
      if (!Number.isNaN(pid) && pid > 0) {
        const found = getProcessRegistry().kill(pid);
        if (found) return { message: `Killed process ${pid}.` };
        return { message: `Process ${pid} not found in registry.` };
      }

      return { message: `Unknown subcommand "${sub}".\n${USAGE}` };
    },
  };
}

function renderList(): string {
  const registry = getProcessRegistry();
  const stats = registry.stats();
  const all = registry.list();

  const breaker = stats.breaker;
  const stateLabel =
    breaker.state === 'closed'
      ? '🟢 closed'
      : breaker.state === 'half-open'
        ? '🟡 half-open'
        : `🔴 open (cooldown ${breaker.cooldownRemainingMs !== null ? `${(breaker.cooldownRemainingMs / 1000).toFixed(0)}s` : '—'})`;

  const breakerLine = [
    `  Circuit breaker: ${stateLabel}`,
    `    consecutive failures: ${breaker.consecutiveFailures}/5`,
    `    slow calls in window: ${breaker.slowCallsInWindow}/3`,
    `    calls in window: ${breaker.callsInWindow}/30`,
  ].join('\n');

  if (all.length === 0) {
    return `No active processes.\n\n${breakerLine}`;
  }

  const now = Date.now();
  const lines: string[] = [`Active processes (${all.length}):`];
  for (const p of all) {
    const age = ((now - p.startedAt) / 1000).toFixed(1);
    const killedTag = p.killed ? ' [killed]' : '';
    const cmd = p.command.length > 80 ? p.command.slice(0, 77) + '…' : p.command;
    lines.push(`  ${p.pid}  ${p.name}  ${age}s  ${cmd}${killedTag}`);
  }
  return [...lines, '', breakerLine].join('\n');
}
