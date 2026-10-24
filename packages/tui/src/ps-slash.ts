import type { SlashCommand } from '@wrongstack/contracts/types';
import { getProcessRegistry } from '@wrongstack/tools';

/**
 * `/ps` — pure process list, no side effects.
 * `/kill` handles listing AND killing.
 */
export function createPsSlashCommand(): SlashCommand {
  return {
    name: 'ps',
    description: 'List all active bash/exec processes tracked by the process registry.',
    async run(_args) {
      return { message: renderList() };
    },
  };
}

function renderList(): string {
  const registry = getProcessRegistry();
  const stats = registry.stats();
  const all = registry.list();
  if (all.length === 0) return 'No active processes.';

  const breaker = stats.breaker;
  const stateLabel =
    breaker.state === 'closed'
      ? '🟢 closed'
      : breaker.state === 'half-open'
        ? '🟡 half-open'
        : `🔴 open`;

  const now = Date.now();
  const lines: string[] = [
    `Active processes (${all.length}) — breaker ${stateLabel}`,
    `  failure=${breaker.consecutiveFailures}/5  slow=${breaker.slowCallsInWindow}/3  rate=${breaker.callsInWindow}/30`,
    '',
  ];
  for (const p of all) {
    const age = ((now - p.startedAt) / 1000).toFixed(1);
    const killedTag = p.killed ? ' [killed]' : '';
    const backgroundTag = p.background ? ' [background · preserved on exit]' : '';
    const cmd = p.command.length > 80 ? p.command.slice(0, 77) + '…' : p.command;
    lines.push(`  ${p.pid}  ${p.name}  ${age}s  ${cmd}${backgroundTag}${killedTag}`);
  }
  return lines.join('\n');
}
