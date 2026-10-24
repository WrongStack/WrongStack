import type { Context } from '@wrongstack/core/agent';
import { getHistoryRetention } from '@wrongstack/core/execution';
import {
  CACHE_LANE_HINTS,
  CACHE_LANE_LABELS,
  CACHE_LANE_ORDER,
  CACHE_VERDICT_LABELS,
  type CacheLane,
  color,
  getRequestResidency,
  type HistoryRetention,
  RESIDENCY_SEGMENT_LABELS,
  RETENTION_CLASSES,
  RETENTION_LABELS,
  type RequestResidency,
} from '@wrongstack/core/utils';

/**
 * `/context residency` — what the last request looked like on the wire and
 * what the cache did with it, plus what the next compaction keeps. Both halves
 * come from core (`getRequestResidency` / `getHistoryRetention`), so the CLI,
 * TUI and WebUI describe the same request the same way.
 */

const K = (n: number): string => n.toLocaleString('en-US');
const PCT = (n: number, total: number): string =>
  total > 0 ? `${((n / total) * 100).toFixed(0)}%` : '0%';

const SEGMENT_LABELS = RESIDENCY_SEGMENT_LABELS;
const LANE_LABELS = CACHE_LANE_LABELS;
const VERDICT_LABELS = CACHE_VERDICT_LABELS;

function laneColor(lane: CacheLane, text: string): string {
  return lane === 'cached'
    ? color.green(text)
    : lane === 'written'
      ? color.yellow(text)
      : color.dim(text);
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Two-line summary for the default `/context` output. */
export function renderResidencySummary(ctx: Context): string[] {
  const r = safe(() => getRequestResidency(ctx));
  if (!r) return [];
  const lanes = CACHE_LANE_ORDER.filter((lane) => r.lanes[lane] > 0)
    .map((lane) => laneColor(lane, `${LANE_LABELS[lane]} ${K(r.lanes[lane])}`))
    .join('  ·  ');
  const out = [`  last request: ${lanes} ${color.dim('(est. tokens)')}`];
  const actual = r.actual
    ? `  ·  provider read ${K(r.actual.cacheRead)} of ${K(r.actual.total)} (${PCT(r.actual.cacheRead, r.actual.total)})`
    : '';
  out.push(`  cache:        ${VERDICT_LABELS[r.verdict]}${actual}`);
  return out;
}

function renderSegments(r: RequestResidency): string[] {
  const width = Math.max(...Object.values(SEGMENT_LABELS).map((l) => l.length));
  const out: string[] = [];
  for (const seg of r.segments) {
    const label = SEGMENT_LABELS[seg.kind].padEnd(width);
    const lane = laneColor(seg.lane, LANE_LABELS[seg.lane].padEnd(10));
    out.push(`    ${label}  ${K(seg.tokens).padStart(9)}  ${lane} ${color.dim(`×${seg.count}`)}`);
    if (seg.parts && seg.parts.length > 0) {
      out.push(`      ${color.dim(seg.parts.map((p) => `${p.source} ${K(p.tokens)}`).join(', '))}`);
    }
  }
  return out;
}

function renderRetention(h: HistoryRetention): string[] {
  const out = [
    `${color.bold('History retention')} ${color.dim(`(preserve last ${h.preserveK} turns · elide tool results > ${K(h.eliseThreshold)} tokens)`)}`,
  ];
  for (const c of RETENTION_CLASSES) {
    const bucket = h.classes[c];
    if (bucket.messages === 0) continue;
    out.push(
      `    ${RETENTION_LABELS[c].padEnd(26)} ${K(bucket.tokens).padStart(9)}  ${color.dim(`${bucket.messages} msg · ${PCT(bucket.tokens, h.total)}`)}`,
    );
  }
  if (h.total === 0) out.push(`    ${color.dim('no conversation yet')}`);
  return out;
}

/** Full `/context residency` report. */
export function renderResidencyReport(ctx: Context): string {
  const lines: string[] = [];
  const r = safe(() => getRequestResidency(ctx));
  if (r) {
    lines.push(
      `${color.bold('Last request')} ${color.dim(`#${r.seq} · ${r.providerId}/${r.model} · ${r.mechanism} cache`)}`,
      ...renderSegments(r),
      `    ${'total'.padEnd(Math.max(...Object.values(SEGMENT_LABELS).map((l) => l.length)))}  ${K(r.total).padStart(9)}  ${color.dim(`expected cache ${PCT(r.lanes.cached, r.total)}`)}`,
    );
    if (r.actual) {
      lines.push(
        `  provider:  read ${K(r.actual.cacheRead)}, write ${K(r.actual.cacheWrite)}, fresh ${K(r.actual.input)} ${color.dim(`(${PCT(r.actual.cacheRead, r.actual.total)} from cache)`)}`,
      );
    }
    lines.push(`  verdict:   ${VERDICT_LABELS[r.verdict]}`);
    for (const b of r.breakers)
      lines.push(`  ${color.yellow('broke:')}     ${b.kind} — ${b.detail}`);
    lines.push(
      r.next.rewritten
        ? `  next:      history was rewritten since — the next request re-writes the cache`
        : `  next:      +${r.next.pendingMessages} msg (${K(r.next.pendingTokens)} tokens) will be new`,
    );
  } else {
    lines.push(`${color.bold('Last request')}`, `    ${color.dim('no request sent yet')}`);
  }
  const h = safe(() => getHistoryRetention(ctx));
  if (h) lines.push('', ...renderRetention(h));
  lines.push(
    '',
    color.dim(
      CACHE_LANE_ORDER.map((lane) => `${LANE_LABELS[lane]} = ${CACHE_LANE_HINTS[lane]}`).join(
        ' · ',
      ),
    ),
  );
  return lines.join('\n');
}
