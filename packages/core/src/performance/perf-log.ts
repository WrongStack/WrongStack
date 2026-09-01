/**
 * `PERF_LOG.md` — the ratchet's ledger.
 *
 * The log is markdown on purpose: it has to survive review, merge conflicts,
 * and being read by a human six months later. But it is parsed, not just
 * appended to, so the guard and the CLI can answer "what is the current value
 * of this workload?" without a model in the loop.
 *
 * Round shape (one workload, one sitting):
 *
 *     ## 2026-09-01 — parser throughput
 *     commit:   a1b2c3d
 *     machine:  M2 Pro / 16GB / macOS 15.2 / node24.13
 *     command:  pnpm bench --filter parser
 *     baseline: 412ms median, 84k allocs/op
 *
 *     - [KEPT]     preallocate token slice   -> 388ms, 61k allocs/op (-27%)
 *     - [REVERTED] map to sorted slice lookup -> 409ms, within noise
 *
 *     current:  301ms median (-27% wall vs baseline)
 *     failed hypotheses: map lookup was not the bottleneck; cost is bufio growth.
 *
 * Appends are atomic and never rewrite earlier rounds: a reverted experiment
 * stays in the record, because the list of hypotheses that did *not* work is
 * the part that stops the next round from retrying them.
 *
 * @module performance/perf-log
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, ensureDir } from '../utils/atomic-write.js';

export type PerfAttemptOutcome = 'KEPT' | 'REVERTED';

export interface PerfAttempt {
  outcome: PerfAttemptOutcome;
  /** What was changed, in one clause. No file lists — those live in git. */
  summary: string;
  /** The measured result: `301ms median (-22%)`, `within noise`, … */
  result: string;
}

export interface PerfRound {
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  /** Workload name. Stable across rounds so history stays greppable. */
  title: string;
  commit?: string;
  machine?: string;
  command?: string;
  baseline?: string;
  attempts: PerfAttempt[];
  current?: string;
  failedHypotheses?: string;
}

export interface PerfLogDocument {
  /** Everything above the first round heading, preserved verbatim. */
  preamble: string;
  rounds: PerfRound[];
}

const ROUND_HEADING = /^##\s+(\d{4}-\d{2}-\d{2})\s*(?:—|–|--|-)\s*(.+?)\s*$/;
const FIELD_LINE = /^(commit|machine|command|baseline|current|failed hypotheses):\s*(.*)$/i;
const ATTEMPT_LINE = /^-\s+\[(KEPT|REVERTED)\]\s+(.*)$/;
/** The arrow separating "what changed" from "what it measured". */
const RESULT_ARROW = /\s+(?:→|->)\s+/;

/** Label column width so `commit:` / `baseline:` / `current:` line up. */
const LABEL_WIDTH = 10;

function padLabel(label: string): string {
  return `${label}:`.padEnd(LABEL_WIDTH, ' ');
}

export const PERF_LOG_HEADER = [
  '# PERF_LOG',
  '',
  'The performance ratchet ledger. Every entry below was produced by running the',
  'command it names; nothing here is recorded from reading the code.',
  '',
  'Rules: one variable per attempt; a delta inside the run spread or under the',
  'noise floor is REVERTED, not kept; correctness gates everything.',
].join('\n');

/**
 * Parse a `PERF_LOG.md` body.
 *
 * Unknown lines inside a round are ignored rather than rejected — the log is a
 * human document first, and a stray note must never make the guard unreadable.
 */
export function parsePerfLog(text: string): PerfLogDocument {
  const lines = text.split(/\r?\n/);
  const preambleLines: string[] = [];
  const rounds: PerfRound[] = [];
  let current: PerfRound | undefined;

  for (const line of lines) {
    const heading = ROUND_HEADING.exec(line);
    if (heading) {
      if (current) rounds.push(current);
      current = { date: heading[1] as string, title: heading[2] as string, attempts: [] };
      continue;
    }
    if (!current) {
      preambleLines.push(line);
      continue;
    }
    const attempt = ATTEMPT_LINE.exec(line);
    if (attempt) {
      const rest = (attempt[2] ?? '').trim();
      const split = RESULT_ARROW.exec(rest);
      const summary = split ? rest.slice(0, split.index).trim() : rest;
      const result = split ? rest.slice(split.index + split[0].length).trim() : '';
      current.attempts.push({ outcome: attempt[1] as PerfAttemptOutcome, summary, result });
      continue;
    }
    const field = FIELD_LINE.exec(line);
    if (!field) continue;
    const value = (field[2] ?? '').trim();
    if (!value) continue;
    switch ((field[1] as string).toLowerCase()) {
      case 'commit':
        current.commit = value;
        break;
      case 'machine':
        current.machine = value;
        break;
      case 'command':
        current.command = value;
        break;
      case 'baseline':
        current.baseline = value;
        break;
      case 'current':
        current.current = value;
        break;
      case 'failed hypotheses':
        current.failedHypotheses = value;
        break;
    }
  }
  if (current) rounds.push(current);

  return { preamble: preambleLines.join('\n').replace(/\s+$/, ''), rounds };
}

/** Render one round in the canonical layout, with the result arrows aligned. */
export function renderRound(round: PerfRound): string {
  const out: string[] = [`## ${round.date} — ${round.title}`];
  if (round.commit) out.push(`${padLabel('commit')}${round.commit}`);
  if (round.machine) out.push(`${padLabel('machine')}${round.machine}`);
  if (round.command) out.push(`${padLabel('command')}${round.command}`);
  if (round.baseline) out.push(`${padLabel('baseline')}${round.baseline}`);

  if (round.attempts.length > 0) {
    out.push('');
    // Align the arrow column so a round reads as a table without being one.
    const tagWidth = Math.max(...round.attempts.map((a) => a.outcome.length + 2));
    const summaryWidth = Math.max(...round.attempts.map((a) => a.summary.length));
    for (const attempt of round.attempts) {
      const tag = `[${attempt.outcome}]`.padEnd(tagWidth + 1, ' ');
      const body = attempt.result
        ? `${attempt.summary.padEnd(summaryWidth, ' ')} → ${attempt.result}`
        : attempt.summary;
      out.push(`- ${tag}${body}`.replace(/\s+$/, ''));
    }
  }

  if (round.current || round.failedHypotheses) out.push('');
  if (round.current) out.push(`${padLabel('current')}${round.current}`);
  if (round.failedHypotheses) out.push(`failed hypotheses: ${round.failedHypotheses}`);
  return out.join('\n');
}

export function renderPerfLog(doc: PerfLogDocument): string {
  const preamble = doc.preamble.trim();
  const body = doc.rounds.map(renderRound).join('\n\n');
  const parts = [preamble, body].filter((part) => part.length > 0);
  return `${parts.join('\n\n')}\n`;
}

async function readOrSeed(file: string): Promise<PerfLogDocument> {
  try {
    return parsePerfLog(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { preamble: PERF_LOG_HEADER, rounds: [] };
  }
}

/**
 * Append a new round, creating the file (with its header) when missing.
 *
 * Rounds are keyed by `date + title`: re-running the same workload on the same
 * day merges into the existing round instead of forking the history, which is
 * what a ratchet loop actually does when it tries several hypotheses in one
 * sitting. The original `baseline` is never overwritten by a merge — the whole
 * point of the round is the distance travelled from it.
 */
export async function appendPerfRound(file: string, round: PerfRound): Promise<PerfLogDocument> {
  const doc = await readOrSeed(file);
  const existing = doc.rounds.find((r) => r.date === round.date && r.title === round.title);
  if (existing) {
    existing.attempts.push(...round.attempts);
    if (round.commit) existing.commit = round.commit;
    if (round.machine) existing.machine = round.machine;
    if (round.command) existing.command = round.command;
    if (round.baseline && !existing.baseline) existing.baseline = round.baseline;
    if (round.current) existing.current = round.current;
    if (round.failedHypotheses) existing.failedHypotheses = round.failedHypotheses;
  } else {
    doc.rounds.push(round);
  }
  await ensureDir(path.dirname(file));
  await atomicWrite(file, renderPerfLog(doc));
  return doc;
}

/**
 * Append one attempt to the most recent round, or to a named one.
 *
 * Throws when the target round does not exist: recording a keep/revert verdict
 * against a baseline that was never written down is exactly the "trust me, it's
 * faster" failure the ledger exists to prevent.
 */
export async function appendPerfAttempt(
  file: string,
  attempt: PerfAttempt,
  options: { title?: string } = {},
): Promise<PerfLogDocument> {
  const doc = await readOrSeed(file);
  const target = options.title
    ? [...doc.rounds].reverse().find((r) => r.title === options.title)
    : doc.rounds[doc.rounds.length - 1];
  if (!target) {
    throw new Error(
      options.title
        ? `PERF_LOG has no round titled "${options.title}"; record a baseline first`
        : 'PERF_LOG has no rounds yet; record a baseline before logging an attempt',
    );
  }
  target.attempts.push(attempt);
  await ensureDir(path.dirname(file));
  await atomicWrite(file, renderPerfLog(doc));
  return doc;
}

/** The latest round for a workload title, or `undefined` if never measured. */
export function latestRound(doc: PerfLogDocument, title: string): PerfRound | undefined {
  return [...doc.rounds].reverse().find((round) => round.title === title);
}

/** Compact one-line-per-round digest for `/perf log` and status surfaces. */
export function summarizePerfLog(doc: PerfLogDocument): string[] {
  return doc.rounds.map((round) => {
    const kept = round.attempts.filter((a) => a.outcome === 'KEPT').length;
    const reverted = round.attempts.length - kept;
    const state = round.current ?? round.baseline ?? 'no measurement recorded';
    return `${round.date}  ${round.title} — ${kept} kept / ${reverted} reverted — ${state}`;
  });
}
