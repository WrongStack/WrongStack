/**
 * `/provider-status` — view the live health status of every tracked
 * provider/model pair: which are healthy, degraded, or blocked, with
 * failure counts and last-error details.
 *
 * Persistence: the data is held in-memory by the
 * {@link ProviderModelStatusTracker} created at boot. The view is a
 * snapshot; it refreshes every time you run the command.
 *
 * Usage:
 *   /provider-status           Show all tracked statuses
 *   /provider-status blocked   Show only blocked entries
 *   /provider-status waiting   Alias for blocked entries
 *   /provider-status degraded  Show only degraded entries
 *   /provider-status healthy   Show only healthy entries
 *   /provider-status clear     Reset all tracking
 *   /provider-status clear <provider> <model>  Reset one pair
 *   /provider-status retry <provider> <model>  Release one pair for a half-open probe
 */

import * as fs from 'node:fs/promises';
import type { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import type { SlashCommand } from '@wrongstack/core/types';
import { color, resolveWstackPaths } from '@wrongstack/core/utils';

export function buildProviderStatusCommand(tracker: ProviderModelStatusTracker): SlashCommand {
  const help = [
    'Usage:',
    '  /provider-status                  Show all tracked provider/model statuses',
    '  /provider-status blocked           Show only blocked entries',
    '  /provider-status waiting           Show the limit-reset waiting room',
    '  /provider-status degraded          Show only degraded entries',
    '  /provider-status healthy           Show only healthy entries',
    '  /provider-status history [N]       Tail the last N audit entries (default 20)',
    '  /provider-status clear             Reset all tracking data',
    '  /provider-status clear <p> <m>     Reset one provider/model pair',
    '  /provider-status retry <p> <m>     Release one pair for its next-use probe',
    '',
    'Each entry shows the state, failure counts, and last error details.',
  ].join('\n');

  function formatAgoShort(ts: number): string {
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hours = Math.floor(min / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  /**
   * Tail the durable block/open audit trail without making the operator open
   * the JSONL file. Reads the profile's provider-status-audit.jsonl via the
   * same paths the wiring writes to.
   */
  async function renderAuditHistory(count: number): Promise<string> {
    const paths = resolveWstackPaths({ projectRoot: process.cwd() });
    const auditFile = paths.profileProviderAudit(paths.profileName);
    let raw: string;
    try {
      raw = await fs.readFile(auditFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return color.dim(
          'No provider audit history yet — entries appear when a model is blocked or reopened.',
        );
      }
      throw error;
    }
    const entries: Array<Record<string, unknown>> = [];
    for (const line of raw.trim().split('\n')) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Skip torn/corrupt lines — the audit trail is best-effort by design.
      }
    }
    const recent = entries.slice(-count).reverse();
    if (recent.length === 0) {
      return color.dim('No provider audit history yet.');
    }
    const out = [
      `${color.bold('WrongStack')} ${color.dim(`— Provider Audit History (last ${recent.length} of ${entries.length})`)}`,
      '',
    ];
    for (const entry of recent) {
      const to = String(entry['to'] ?? '?');
      const arrow =
        to === 'blocked'
          ? color.red(`${String(entry['from'] ?? '?')} → ${to}`)
          : color.green(`${String(entry['from'] ?? '?')} → ${to}`);
      const err = entry['error'] as Record<string, unknown> | null | undefined;
      const errorText = err
        ? ` · ${color.red(String(err['kind'] ?? 'unknown'))}${err['status'] != null ? ` ${String(err['status'])}` : ''}`
        : '';
      const who = [err?.['sessionId'], err?.['agentId']]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .map((value) => `${value.slice(0, 12)}…`)
        .join(' / ');
      out.push(
        `  ${color.dim(formatAgoShort(Number(entry['ts']) || 0))}  ` +
          `${color.cyan(`${String(entry['providerId'] ?? '?')}/${String(entry['model'] ?? '?')}`)}  ` +
          `${arrow}  ${String(entry['reason'] ?? '').replaceAll('_', ' ')}${errorText}` +
          (who ? `  ${color.dim(who)}` : ''),
      );
    }
    out.push('', color.dim(`source: ${auditFile}`));
    return out.join('\n');
  }

  function formatDuration(ms: number | null): string {
    if (ms === null) return '—';
    const sec = Math.round((Date.now() - ms) / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ${sec % 60}s ago`;
    const hours = Math.floor(min / 60);
    return `${hours}h ${min % 60}m ago`;
  }

  function formatExpiry(ms: number | null): string {
    if (ms === null) return '—';
    const remaining = Math.max(0, ms - Date.now());
    if (remaining <= 0) return `${color.green('expired')} (will auto-recover)`;
    const sec = Math.round(remaining / 1000);
    if (sec < 60) return `${sec}s remaining`;
    const min = Math.floor(sec / 60);
    return `${min}m ${sec % 60}s remaining`;
  }

  function stateColor(state: 'healthy' | 'degraded' | 'blocked'): string {
    switch (state) {
      case 'healthy':
        return color.green('healthy');
      case 'degraded':
        return color.amber('degraded');
      case 'blocked':
        return color.red('blocked');
    }
  }

  function renderStatuses(only?: 'healthy' | 'degraded' | 'blocked'): string {
    const snapshot = tracker.getSnapshot();
    const statuses = only
      ? snapshot.statuses.filter((status) => status.state === only)
      : snapshot.statuses;
    const lines = [
      `${color.bold('WrongStack')} ${color.dim('— Provider/Model Status')}`,
      '',
      `  ${color.bold('Summary')}: ${snapshot.healthy} healthy · ${snapshot.degraded} degraded · ${snapshot.blocked} blocked`,
      `  Total failures: ${snapshot.totalFailures} · Rate limits: ${snapshot.totalRateLimits}`,
      '',
    ];

    if (statuses.length === 0) {
      lines.push(`  ${color.dim('No tracked providers — no failures recorded yet.')}`);
      return lines.join('\n');
    }

    for (const s of statuses) {
      const state = stateColor(s.state);
      const title = `${color.cyan(`${s.providerId}/${s.model}`)} ${state}`;
      lines.push(`  ${title}`);

      if (s.totalFailures > 0 || s.totalSuccesses > 0) {
        const failures = `${color.red(String(s.totalFailures))} failures`;
        const successes = `${color.green(String(s.totalSuccesses))} successes`;
        const rateLimits =
          s.rateLimitHits > 0 ? ` · ${color.amber(`${s.rateLimitHits} rate-limited`)}` : '';
        lines.push(`    ${color.dim('totals:')} ${failures} · ${successes}${rateLimits}`);

        if (s.consecutiveFailures > 0) {
          lines.push(
            `    ${color.dim('consecutive failures:')} ${color.red(String(s.consecutiveFailures))}`,
          );
        }

        if (s.lastFailureAt !== null) {
          const sessionInfo = s.lastSessionId
            ? ` session: ${color.dim(s.lastSessionId.slice(0, 12))}…`
            : '';
          const agentInfo = s.lastAgentId
            ? ` agent: ${color.dim(s.lastAgentId.slice(0, 16))}…`
            : '';
          lines.push(
            `    ${color.dim('last error:')} ${formatDuration(s.lastFailureAt)}${sessionInfo}${agentInfo}`,
          );
          if (s.lastErrorMessage) {
            lines.push(`      ${color.red(s.lastErrorMessage.slice(0, 200))}`);
          }
        }

        if (s.stateExpiresAt !== null) {
          lines.push(`    ${color.dim('cooldown:')} ${formatExpiry(s.stateExpiresAt)}`);
        }
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  return {
    name: 'provider-status',
    category: 'Inspect',
    description:
      'View the live health status of all providers/models (healthy, degraded, blocked).',
    argsHint: '[waiting | blocked | degraded | healthy | history | retry | clear]',
    help,
    async run(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? '').toLowerCase();

      if (sub === 'help' || sub === '--help') return { message: this.help ?? '' };

      if (sub === 'blocked' || sub === 'waiting') {
        const blocked = tracker.getBlocked();
        if (blocked.length === 0) {
          return { message: `${color.green('No blocked providers/models.')}` };
        }
        return { message: renderStatuses('blocked') };
      }

      if (sub === 'degraded') {
        const degraded = tracker.getDegraded();
        if (degraded.length === 0) {
          return { message: `${color.green('No degraded providers/models.')}` };
        }
        return { message: renderStatuses('degraded') };
      }

      if (sub === 'healthy') {
        const all = tracker.getAllStatuses().filter((s) => s.state === 'healthy');
        if (all.length === 0) {
          return {
            message: `${color.dim('No healthy tracked providers — no failures recorded yet.')}`,
          };
        }
        return { message: renderStatuses('healthy') };
      }

      if (sub === 'history') {
        const count = Math.min(Math.max(Number.parseInt(parts[1] ?? '20', 10) || 20, 1), 200);
        return { message: await renderAuditHistory(count) };
      }

      if (sub === 'retry') {
        const provider = parts[1];
        const model = parts[2];
        if (!provider || !model) {
          return { message: `${color.red('Usage:')} /provider-status retry <provider> <model>` };
        }
        const released = tracker.retryNow(provider, model);
        if (!released) {
          return { message: `${color.dim(`${provider}/${model} is not currently waiting.`)}` };
        }
        return {
          message: `${color.green('✓')} Released ${color.cyan(`${provider}/${model}`)} for a half-open probe on its next use.`,
        };
      }

      if (sub === 'clear') {
        const provider = parts[1];
        const model = parts[2];
        if (provider && model) {
          tracker.clear(provider, model);
          return {
            message: `${color.green('✓')} Cleared tracking for ${color.cyan(`${provider}/${model}`)}.`,
          };
        }
        tracker.clear();
        return { message: `${color.green('✓')} Cleared all provider/model tracking data.` };
      }

      if (sub && sub !== '') {
        return {
          message: `${color.red('Unknown subcommand')} "${sub}". Try ${color.dim('/provider-status')}, ${color.dim('/provider-status blocked')}, or ${color.dim('/provider-status help')}.`,
        };
      }

      return { message: renderStatuses() };
    },
  };
}
