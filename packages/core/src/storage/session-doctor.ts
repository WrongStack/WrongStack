/**
 * Session doctor — diagnose a project's whole session corpus, and repair the
 * parts of it that are DERIVED.
 *
 * Split the same way `config-doctor` is: {@link diagnoseSessions} never writes,
 * {@link repairSessionSummaries} writes only files that can be regenerated from
 * the journal it read them from.
 *
 * ## What it will not do
 *
 * It never edits a `.jsonl`. Rewriting journal events looks attractive —
 * measured on a real corpus, 89% of 13.7 GB is superseded `messages_replaced`
 * snapshots — but `session-rewind-apply` truncates a journal to a checkpoint
 * PHYSICALLY and replays the remainder. Any snapshot line the doctor emptied or
 * removed can become the last surviving snapshot after such a truncation, and
 * replay would then rebuild the conversation from it. The in-memory
 * `stripSnapshotPayload` is safe precisely because replay has already consumed
 * the payload by then; on disk it is not. Reclaiming that space is a retention
 * decision (`prune`), not a repair.
 *
 * ## Reading a journal safely
 *
 * Lines in this corpus reach 1.6 MB (a full conversation snapshot). `JSON.parse`
 * on every line exhausts the heap on a multi-hundred-MB file — so the scan
 * matches the event type out of a bounded prefix and never materializes a line
 * as an object. The whole point of this module is to survive the files that
 * make other things fall over.
 */
import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { DefaultSecretScrubber } from '../security/secret-scrubber.js';
import type { SecretScrubber } from '../types/secret-scrubber.js';
import type { SessionSummary } from '../types/session.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { summarizeSessionFile } from './session-store/summary-builder.js';

/** Lifecycle boundaries, in the order a healthy session writes them. */
const BOUNDARY_TYPES = new Set([
  'session_start',
  'in_flight_start',
  'in_flight_end',
  'session_end',
]);

export type SessionLifecycleBoundary =
  | 'session_start'
  | 'in_flight_start'
  | 'in_flight_end'
  | 'session_end';

export type SessionFindingCode =
  /** Lines the loader cannot parse. It skips them silently, so they are invisible. */
  | 'unparsable_lines'
  /** The file does not end in a newline — a process died mid-write. */
  | 'truncated_tail'
  /** No `session_start`: the journal never recorded what it was. */
  | 'missing_session_start'
  /** Last boundary is `in_flight_start` — the process died mid-turn. */
  | 'died_mid_turn'
  /** No `session_end`: closed by a kill, not by a clean exit. */
  | 'never_closed'
  /** No events at all. */
  | 'empty'
  /** No `.summary.json` sidecar; the picker has no title for it. */
  | 'missing_summary'
  /** The sidecar predates the transcript, so its counts are behind. */
  | 'stale_summary'
  /** Large enough that opening it is a visible wait. */
  | 'oversized';

export interface SessionFinding {
  code: SessionFindingCode;
  severity: 'error' | 'warn' | 'info';
  detail: string;
  /** Present when `repairSessionSummaries` can resolve this finding. */
  fix?: string;
}

export interface SessionDiagnosis {
  /** Store-relative id, e.g. `2026-08-29/sess_01M16QFGAJ…`. */
  id: string;
  file: string;
  bytes: number;
  /** Physical lines, including any that failed to parse. */
  lines: number;
  unparsableLines: number;
  /** Bytes held by superseded conversation snapshots — reported, never rewritten. */
  snapshotBytes: number;
  lastBoundary: SessionLifecycleBoundary | null;
  hasSessionStart: boolean;
  hasSummarySidecar: boolean;
  /** True when the sidecar is older than the transcript it summarizes. */
  summaryStale: boolean;
  findings: SessionFinding[];
}

export interface SessionDoctorTotals {
  sessions: number;
  bytes: number;
  snapshotBytes: number;
  unparsableLines: number;
}

export interface SessionDoctorReport {
  sessionsDir: string;
  totals: SessionDoctorTotals;
  /** How many sessions carry each finding. */
  byCode: Partial<Record<SessionFindingCode, number>>;
  /** Every scanned session, worst-first (errors, then warnings, then size). */
  sessions: SessionDiagnosis[];
  /** Journals that could not be read at all, with the reason. */
  unreadable: Array<{ id: string; reason: string }>;
}

export interface DiagnoseSessionsOptions {
  sessionsDir: string;
  /**
   * Size at which a session is flagged as slow to open. Default 64 MB —
   * measured on this corpus, journals load at roughly 40 MB/s, so that is a
   * couple of seconds and climbing.
   */
  oversizedBytes?: number | undefined;
  /** Progress for a scan that walks tens of gigabytes. */
  onProgress?: ((progress: { scanned: number; total: number; id: string }) => void) | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Extract an event type without materializing the line.
 *
 * The character class is deliberately wide. Event types are not all
 * `snake_case`: plugin-emitted ones look like `git-autocommit:commit`, and a
 * narrower pattern reported 16 perfectly valid events in this corpus as
 * corruption. A doctor that invents defects is worse than no doctor.
 */
const TYPE_RE = /"type"\s*:\s*"([A-Za-z0-9_:.-]+)"/;
/**
 * How much of a line the fast path examines. The type is normally the first
 * key, but a line whose type sits past this window must NOT be called
 * unparsable — {@link readEventType} falls back to scanning the whole line
 * (a regex scan, still never a parse) before giving up.
 */
const TYPE_PROBE_CHARS = 200;

/**
 * The event type of a journal line, or null when the line carries none.
 *
 * Never parses. Lines in this corpus reach 1.6 MB and `JSON.parse` on every
 * one of them exhausts the heap on a multi-hundred-MB journal.
 */
function readEventType(line: string): string | null {
  if (line.length === 0 || line[0] !== '{') return null;
  const fast = TYPE_RE.exec(line.slice(0, TYPE_PROBE_CHARS));
  if (fast?.[1]) return fast[1];
  // Rare: a big leading field pushed `"type"` past the window. Scanning the
  // whole line is linear and allocates only the match.
  return line.length > TYPE_PROBE_CHARS ? (TYPE_RE.exec(line)?.[1] ?? null) : null;
}

function severityRank(diagnosis: SessionDiagnosis): number {
  if (diagnosis.findings.some((f) => f.severity === 'error')) return 0;
  if (diagnosis.findings.some((f) => f.severity === 'warn')) return 1;
  return 2;
}

/** `<sessionsDir>/<day>/<name>.jsonl` → `<day>/<name>`. */
async function collectJournals(sessionsDir: string): Promise<Array<{ id: string; file: string }>> {
  const out: Array<{ id: string; file: string }> = [];
  let days: string[];
  try {
    const entries = await fsp.readdir(sessionsDir, { withFileTypes: true });
    days = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  for (const day of days) {
    // `_cas`, `_trash` and friends are stores, not shards.
    if (day.startsWith('_')) continue;
    let names: string[];
    try {
      names = await fsp.readdir(path.join(sessionsDir, day));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      out.push({
        id: `${day}/${name.slice(0, -'.jsonl'.length)}`,
        file: path.join(sessionsDir, day, name),
      });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Does the file end on a complete line? A crash mid-write leaves a partial one. */
async function endsWithNewline(file: string, bytes: number): Promise<boolean> {
  if (bytes === 0) return true;
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, bytes - 1);
    return buffer.toString('utf8') === '\n';
  } finally {
    await handle.close();
  }
}

async function scanJournal(
  id: string,
  file: string,
  oversizedBytes: number,
  signal?: AbortSignal,
): Promise<SessionDiagnosis> {
  const stat = await fsp.stat(file);
  const diagnosis: SessionDiagnosis = {
    id,
    file,
    bytes: stat.size,
    lines: 0,
    unparsableLines: 0,
    snapshotBytes: 0,
    lastBoundary: null,
    hasSessionStart: false,
    hasSummarySidecar: false,
    summaryStale: false,
    findings: [],
  };

  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      signal?.throwIfAborted();
      diagnosis.lines++;
      if (line.length === 0) continue;
      const type = readEventType(line);
      if (type === null) {
        diagnosis.unparsableLines++;
        continue;
      }
      if (type === 'session_start') diagnosis.hasSessionStart = true;
      if (BOUNDARY_TYPES.has(type)) {
        diagnosis.lastBoundary = type as SessionLifecycleBoundary;
      }
      if (type === 'messages_replaced' || type === 'context_snapshot') {
        diagnosis.snapshotBytes += line.length;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const sidecar = `${file.slice(0, -'.jsonl'.length)}.summary.json`;
  const sidecarStat = await fsp.stat(sidecar).catch(() => null);
  diagnosis.hasSummarySidecar = sidecarStat !== null;
  diagnosis.summaryStale = sidecarStat !== null && sidecarStat.mtimeMs + 1 < stat.mtimeMs;

  const add = (finding: SessionFinding): void => {
    diagnosis.findings.push(finding);
  };
  if (diagnosis.lines === 0) {
    add({ code: 'empty', severity: 'info', detail: 'no events recorded' });
  }
  if (diagnosis.unparsableLines > 0) {
    add({
      code: 'unparsable_lines',
      severity: 'error',
      // The loader skips these without a word, so the only symptom is a
      // transcript that is quietly missing turns.
      detail: `${diagnosis.unparsableLines} of ${diagnosis.lines} lines cannot be parsed — the loader skips them silently`,
    });
  }
  if (!(await endsWithNewline(file, stat.size))) {
    add({
      code: 'truncated_tail',
      severity: 'warn',
      detail: 'last line is incomplete — the process died mid-write',
    });
  }
  if (diagnosis.lines > 0 && !diagnosis.hasSessionStart) {
    add({
      code: 'missing_session_start',
      severity: 'warn',
      detail: 'no session_start — model/provider metadata is unknown',
    });
  }
  if (diagnosis.lastBoundary === 'in_flight_start') {
    add({
      code: 'died_mid_turn',
      severity: 'warn',
      // Not a defect to fix here: `store.resume()` heals it on open, pairing
      // the dangling tool_uses with synthesized results.
      detail: 'died mid-turn — resume repairs this on open',
    });
  } else if (diagnosis.lines > 0 && diagnosis.lastBoundary !== 'session_end') {
    add({
      code: 'never_closed',
      severity: 'info',
      detail: 'no session_end — killed rather than closed',
    });
  }
  if (!diagnosis.hasSummarySidecar && diagnosis.lines > 0) {
    add({
      code: 'missing_summary',
      severity: 'warn',
      detail: 'no .summary.json — the picker has no title or counts for it',
      fix: 'rebuild the summary from the journal',
    });
  } else if (diagnosis.summaryStale) {
    add({
      code: 'stale_summary',
      severity: 'info',
      detail: '.summary.json is older than the transcript',
      fix: 'rebuild the summary from the journal',
    });
  }
  if (stat.size >= oversizedBytes) {
    const share = stat.size > 0 ? Math.round((diagnosis.snapshotBytes / stat.size) * 100) : 0;
    add({
      code: 'oversized',
      severity: 'info',
      detail:
        `${(stat.size / 1e6).toFixed(0)} MB — slow to open` +
        (share >= 50 ? `; ${share}% is superseded conversation snapshots` : ''),
    });
  }
  return diagnosis;
}

/**
 * Walk every journal under `sessionsDir` and report on it. Writes nothing.
 */
export async function diagnoseSessions(
  options: DiagnoseSessionsOptions,
): Promise<SessionDoctorReport> {
  const { sessionsDir, onProgress, signal } = options;
  const oversizedBytes = options.oversizedBytes ?? 64 * 1024 * 1024;
  const journals = await collectJournals(sessionsDir);
  const sessions: SessionDiagnosis[] = [];
  const unreadable: SessionDoctorReport['unreadable'] = [];

  let scanned = 0;
  for (const { id, file } of journals) {
    signal?.throwIfAborted();
    onProgress?.({ scanned, total: journals.length, id });
    try {
      sessions.push(await scanJournal(id, file, oversizedBytes, signal));
    } catch (error) {
      if (signal?.aborted) throw error;
      // One unreadable journal must not end the scan — the corpus is exactly
      // where damaged files live.
      unreadable.push({ id, reason: error instanceof Error ? error.message : String(error) });
    }
    scanned++;
  }
  onProgress?.({ scanned, total: journals.length, id: '' });

  const totals: SessionDoctorTotals = {
    sessions: sessions.length,
    bytes: sessions.reduce((sum, s) => sum + s.bytes, 0),
    snapshotBytes: sessions.reduce((sum, s) => sum + s.snapshotBytes, 0),
    unparsableLines: sessions.reduce((sum, s) => sum + s.unparsableLines, 0),
  };
  const byCode: SessionDoctorReport['byCode'] = {};
  for (const session of sessions) {
    for (const finding of session.findings) {
      byCode[finding.code] = (byCode[finding.code] ?? 0) + 1;
    }
  }
  sessions.sort((a, b) => severityRank(a) - severityRank(b) || b.bytes - a.bytes);
  return { sessionsDir, totals, byCode, sessions, unreadable };
}

export interface SummaryRepairResult {
  repaired: string[];
  failed: Array<{ id: string; reason: string }>;
}

/**
 * Rebuild the `.summary.json` sidecars the report flagged.
 *
 * The only thing this module writes. A summary is a projection of the journal
 * beside it — regenerating one cannot lose anything, and a session whose
 * summary is missing is a session the picker cannot describe.
 */
export async function repairSessionSummaries(options: {
  report: SessionDoctorReport;
  secretScrubber?: SecretScrubber | undefined;
  onProgress?: ((progress: { repaired: number; total: number; id: string }) => void) | undefined;
  signal?: AbortSignal | undefined;
}): Promise<SummaryRepairResult> {
  const { report, onProgress, signal } = options;
  const scrubber = options.secretScrubber ?? new DefaultSecretScrubber();
  const targets = report.sessions.filter((session) =>
    session.findings.some((f) => f.code === 'missing_summary' || f.code === 'stale_summary'),
  );
  const result: SummaryRepairResult = { repaired: [], failed: [] };
  for (const session of targets) {
    signal?.throwIfAborted();
    onProgress?.({ repaired: result.repaired.length, total: targets.length, id: session.id });
    try {
      const stat = await fsp.stat(session.file);
      const summary: SessionSummary = await summarizeSessionFile({
        id: session.id,
        file: session.file,
        mtime: stat.mtime.toISOString(),
        secretScrubber: scrubber,
      });
      const sidecar = `${session.file.slice(0, -'.jsonl'.length)}.summary.json`;
      await atomicWrite(sidecar, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
      result.repaired.push(session.id);
    } catch (error) {
      result.failed.push({
        id: session.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  onProgress?.({ repaired: result.repaired.length, total: targets.length, id: '' });
  return result;
}
