/**
 * Brain status, stats, ledger, rules, and heuristics display formatters.
 *
 * @module slash-commands/brain-status
 */

import { readFile } from 'node:fs/promises';
import { type BrainLedgerEntry, DETERMINISTIC_BRAIN_TIERS } from '@wrongstack/core/coordination';
import { color } from '@wrongstack/core/utils';
import { judgeSummary } from './brain-council.js';

/**
 * Deliberation is the one council setting that silently multiplies cost, so
 * the status line names it whenever it is on — an operator reading "3 seats"
 * would otherwise budget for three calls and get six.
 */
function councilRoundsSummary(snapshot: {
  council: { deliberationRounds?: number | undefined };
}): string {
  const rounds = snapshot.council.deliberationRounds ?? 2;
  return rounds > 1 ? `, ${rounds} rounds` : ', no deliberation';
}

import type { SlashCommandContext } from './command-context.js';

export function fmtAge(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function formatBrainStatus(opts: SlashCommandContext): string {
  const lines: string[] = [];
  const ceiling = opts.brainSettings?.maxAutoRisk ?? 'unknown';
  const mode = opts.brainSettings?.mode ?? 'interactive';
  lines.push(`${color.bold('Brain')} — policy → LLM/council → escalation decision chain`);
  lines.push(
    `  escalation mode:  ${color.cyan(mode)} ${color.dim(mode === 'headless' ? '(never blocks on a human — /brain mode interactive to change)' : '(/brain mode headless for fully unattended)')}`,
  );
  lines.push(
    `  autonomy ceiling: ${color.cyan(ceiling)} ${color.dim('(/brain risk <level> to change)')}`,
  );
  const snapshot = opts.brainRuntime?.getSnapshot();
  const pool = opts.brainSettings?.poolLabels ?? [];
  lines.push(
    `  LLM pool:         ${pool.length > 0 ? color.cyan(pool.join(' → ')) : color.dim('session model (/brain model <ref> or /brain models <refs>)')}${snapshot && pool.length > 1 ? color.dim(` (strategy: ${snapshot.strategy})`) : ''}`,
  );
  if (snapshot?.decisionTimeoutMs) {
    lines.push(`  decision timeout: ${color.cyan(`${snapshot.decisionTimeoutMs}ms`)}`);
  }
  if (snapshot?.humanTimeoutMs) {
    lines.push(
      `  human timeout:    ${color.cyan(`${snapshot.humanTimeoutMs}ms`)} ${color.dim('(then terminal policy)')}`,
    );
  }
  const councilSeats = opts.brainSettings?.councilLabels ?? [];
  if (councilSeats.length > 0) {
    lines.push(
      `  council:          ${color.cyan(councilSeats.join(', '))}${snapshot ? color.dim(` (minRisk: ${snapshot.council.minRisk}${judgeSummary(snapshot)}${councilRoundsSummary(snapshot)})`) : ''}`,
    );
  } else if (snapshot) {
    lines.push(`  council:          ${color.dim('disabled (/brain council on + voters)')}`);
  }
  if (opts.brainSettings?.ledgerPath) {
    lines.push(
      `  ledger:           ${color.dim(`${opts.brainSettings.ledgerPath} (/brain ledger to view)`)}`,
    );
  }
  if (opts.brainRuntime) {
    lines.push(color.dim('  setters apply live and persist to the active profile config'));
  }
  const log = opts.getBrainLog?.() ?? [];
  if (log.length === 0) {
    lines.push(color.dim('  no decisions recorded yet this session'));
  } else {
    lines.push(`  recent decisions (${log.length}):`);
    for (const entry of log.slice(-10)) {
      const q = entry.question.length > 70 ? `${entry.question.slice(0, 67)}…` : entry.question;
      lines.push(
        `  ${color.dim(fmtAge(entry.at).padEnd(8))} ${entry.kind.padEnd(12)} ${q}${entry.outcome ? color.dim(` → ${entry.outcome}`) : ''}`,
      );
    }
  }
  return lines.join('\n');
}

export function formatBrainStats(opts: SlashCommandContext): string {
  const log = opts.getBrainLog?.() ?? [];
  const councilWarnings = log.filter((entry) => entry.kind === 'council_warn');

  // Prefer the session-lifetime counter. The ring buffer holds 20 entries, so
  // counting it answers "what did the Brain do in the last few minutes", not
  // "how often does the Brain burn a provider call" — which is the whole
  // point of the tier split.
  const lifetime = opts.brainTierStats?.();
  const counts = new Map<string, number>();
  if (lifetime) {
    for (const [tier, n] of Object.entries(lifetime.byTier)) counts.set(tier, n ?? 0);
    if (lifetime.unattributed > 0) counts.set('unattributed', lifetime.unattributed);
  } else {
    for (const entry of log) {
      if (entry.kind === 'council_warn') continue;
      counts.set(entry.tier ?? 'unattributed', (counts.get(entry.tier ?? 'unattributed') ?? 0) + 1);
    }
  }
  let free = lifetime?.deterministic ?? 0;
  let paid = lifetime?.llmBacked ?? 0;
  if (!lifetime) {
    for (const [tier, n] of counts) {
      // The set lives in core next to the tier union: a hand-copied list here
      // silently mis-buckets every tier added upstream.
      if ((DETERMINISTIC_BRAIN_TIERS as ReadonlySet<string>).has(tier)) free += n;
      else if (tier === 'llm' || tier === 'council') paid += n;
    }
  }
  const lines = [color.bold('Brain decision tiers'), ''];
  if (counts.size === 0) {
    lines.push(color.dim('  No decisions recorded yet this session.'));
  } else {
    for (const [tier, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${tier.padEnd(14)} ${color.cyan(String(n))}`);
    }
    const decided = free + paid;
    const pct =
      decided > 0 ? color.dim(` (${Math.round((free / decided) * 100)}% of decided)`) : '';
    lines.push('');
    lines.push(`  ${'deterministic'.padEnd(14)} ${color.cyan(String(free))}${pct}`);
    lines.push(`  ${'model-backed'.padEnd(14)} ${color.cyan(String(paid))}`);
  }
  const snapshot = opts.brainRuntime?.getSnapshot();
  if (snapshot?.cache.enabled) {
    lines.push(
      '',
      color.dim(`  cache: ${snapshot.cache.hits} hit / ${snapshot.cache.misses} miss`),
    );
  }
  if (snapshot?.circuit && snapshot.circuit.state !== 'closed') {
    lines.push(color.dim(`  circuit: ${snapshot.circuit.state}`));
  }
  if (councilWarnings.length > 0) {
    lines.push('', color.bold(`  Council panel integrity (${councilWarnings.length})`));
    for (const w of councilWarnings.slice(-3)) {
      lines.push(color.dim(`  ${fmtAge(w.at).padEnd(8)} ${w.outcome}`));
    }
  }
  lines.push(
    '',
    color.dim(
      lifetime
        ? `  ${lifetime.total} decision(s) this session.`
        : `  Based on the last ${log.length} logged decision(s) of this session.`,
    ),
  );
  return lines.join('\n');
}

export async function readLedgerEntries(ledgerPath: string, limit: number): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath, 'utf8');
  } catch {
    return `No ledger entries yet (${ledgerPath}).`;
  }
  const rows = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l) as BrainLedgerEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is BrainLedgerEntry => e !== null);
  const lines = [
    `${color.bold('Brain ledger')} — ${color.dim(ledgerPath)}`,
    ...rows.map((e) => {
      const what =
        e.kind === 'outcome'
          ? `outcome:${e.outcome}`
          : e.kind === 'answered' && e.optionId
            ? `answered [${e.optionId}]`
            : e.kind;
      const detail = e.question ?? e.detail ?? '';
      const trimmed = detail.length > 70 ? `${detail.slice(0, 67)}…` : detail;
      return `  ${color.dim(fmtAge(e.at).padEnd(8))} ${what.padEnd(20)} ${trimmed}`;
    }),
  ];
  if (rows.length === 0) lines.push(color.dim('  (empty)'));
  return lines.join('\n');
}
