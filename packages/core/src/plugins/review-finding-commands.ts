/**
 * Finding-store slash commands.
 *
 * FS-P0.5: Provides `/review findings` and `/review finding <id>` commands
 * for viewing persisted Chimera review findings.
 *
 * @module review-finding-commands
 */

import { FINDING_DEFAULT_PAGE_SIZE } from './review-finding-store.js';
import { syncReportCompletion, syncReportReopen } from './review-report-integration.js';
import type { ReviewReport, ReportLifecycleStatus } from './review-report-types.js';
import type { FindingSeverity, FindingStatus, ResolutionOutcome } from './review-finding-types.js';

/**
 * Run the review findings command.
 *
 * Usage:
 *   /review findings [--severity <s>] [--status <s>] [--limit <n>]
 *   /review finding <id>
 *   /review findings --help
 *
 * Reads the project's finding store from the project root.
 */
export interface FindingCommandContext {
  /** Project root directory (~/.wrongstack/projects/<slug>) */
  projectDir: string;
}

/**
 * Execute a finding-store command.
 */
export async function executeFindingCommand(
  args: string[],
  ctx: FindingCommandContext,
): Promise<string> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return helpText();
  }

  const subcommand = args[0]!;

  if (subcommand === 'findings' || subcommand === 'list') {
    return listFindings(args.slice(1), ctx);
  }

  if (subcommand === 'finding') {
    const id = args[1];
    if (!id) return 'Usage: /review finding <id> [resolve|ignore|reopen|triage|start]';
    const action = args[2];
    if (action === 'resolve' || action === 'ignore' || action === 'reopen' || action === 'triage' || action === 'start') {
      return transitionFinding(id, action, args.slice(3), ctx);
    }
    return showFinding(id, ctx);
  }

  if (subcommand === 'reports') {
    return listReports(args.slice(1), ctx);
  }

  if (subcommand === 'report') {
    const id = args[1];
    if (!id) return 'Usage: /review report <id> [complete|skip|action|note]';
    const action = args[2];
    if (action === 'complete' || action === 'skip' || action === 'action') {
      return transitionReport(id, action, args.slice(3), ctx);
    }
    if (action === 'note') {
      return addReportNote(id, args.slice(3), ctx);
    }
    return showReport(id, ctx);
  }

  if (subcommand === 'status') {
    return showStatus(ctx);
  }

  return `Unknown subcommand: ${subcommand}. Use /review findings --help for usage.`;
}

function helpText(): string {
  return [
    '## /review — Chimera Review Store',
    '',
    '| Command | Description |',
    '|---|---|',
    '| `/review findings` | List all active findings grouped by severity |',
    '| `/review findings --status <s>` | Filter by status (active, triaged, in_progress, resolved, ignored) |',
    '| `/review findings --severity <s>` | Filter by severity (critical, high, medium, low) |',
    '| `/review findings --limit <n>` | Max results (default 20) |',
    '| `/review finding <id>` | Show a single finding with full lifecycle |',
    '| `/review finding <id> resolve --outcome <fixed|wontfix|duplicate|false_positive|stale> [--reason "..."]` | Mark a finding resolved |',
    '| `/review finding <id> ignore [--reason "..."]` | Ignore a finding (wontfix) |',
    '| `/review finding <id> reopen [--reason "..."]` | Reopen a resolved/ignored finding back to active |',
    '| `/review finding <id> triage [--reason "..."]` | Acknowledge a finding (active → triaged) |',
    '| `/review finding <id> start [--reason "..."]` | Start work on a finding (triaged → in_progress) |',
    '| `/review reports` | List recent review reports |',
    '| `/review reports --status <s>` | Filter reports by lifecycle (open, actioned, completed, skipped) |',
    '| `/review report <id>` | Show a report with raw text, counts, and lifecycle events |',
    '| `/review report <id> complete [--reason "..."]` | Mark a report completed |',
    '| `/review report <id> skip [--reason "..."]` | Skip a report (wontfix) |',
    '| `/review report <id> action [--reason "..."]` | Mark a report as being actioned |',
    '| `/review report <id> note <message>` | Add an annotation without changing lifecycle |',
    '| `/review status` | Show store statistics |',
    '',
    'Findings: `~/.wrongstack/projects/<slug>/review-findings.jsonl`',
    'Reports: `~/.wrongstack/projects/<slug>/review-reports.jsonl`',
  ].join('\n');
}

async function loadStore(ctx: FindingCommandContext) {
  const { JsonlFindingStore } = await import('./review-finding-store.js');
  const store = new JsonlFindingStore(ctx.projectDir);
  return store;
}

async function listFindings(
  args: string[],
  ctx: FindingCommandContext,
): Promise<string> {
  let severityFilter: string | undefined;
  let statusFilter: string | undefined;
  let limit = 20;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--severity' && i + 1 < args.length) {
      severityFilter = args[++i]!;
    } else if (args[i] === '--status' && i + 1 < args.length) {
      statusFilter = args[++i]!;
    } else if (args[i] === '--limit' && i + 1 < args.length) {
      limit = Number.parseInt(args[++i]!, 10) || 20;
    }
  }

  const store = await loadStore(ctx);
  const all = await store.list({
    ...(severityFilter ? { severities: [severityFilter as FindingSeverity] } : {}),
    ...(statusFilter ? { statuses: [statusFilter as FindingStatus] } : {}),
    limit,
  });

  if (all.length === 0) {
    const filters = [severityFilter && `severity=${severityFilter}`, statusFilter && `status=${statusFilter}`]
      .filter(Boolean).join(', ');
    return `No findings found${filters ? ` (${filters})` : ''}.`;
  }

  const lines: string[] = ['| Severity | Status | File | Title |',
    '|---|---|---|---|'];
  for (const f of all) {
    const location = f.location?.file ?? 'unknown';
    const file = location.substring(location.lastIndexOf('/') + 1).substring(location.lastIndexOf('\\') + 1) || location;
    const severityEmoji = f.severity === 'critical' ? '🔴' : f.severity === 'high' ? '🟠' : f.severity === 'medium' ? '🟡' : '⚪';
    const title = f.title.length > 60 ? f.title.substring(0, 57) + '...' : f.title;
    lines.push(`| ${severityEmoji} ${f.severity} | ${f.status} | \`${file}\` | ${title} |`);
  }

  lines.push('', `_${all.length} finding(s) shown. Use \`/review finding <id>\` for details._`);
  return lines.join('\n');
}

async function showFinding(id: string, ctx: FindingCommandContext): Promise<string> {
  const store = await loadStore(ctx);
  const finding = await store.get(id);
  if (!finding) return `Finding not found: ${id}`;

  const lines: string[] = [
    `## ${finding.severity.toUpperCase()}: ${finding.title}`,
    '',
    `**ID:** \`${finding.id}\``,
    `**File:** \`${finding.location?.file ?? 'unknown'}\`${finding.location?.line ? `:${finding.location.line}` : ''}`,
    `**Severity:** ${finding.severity}`,
    `**Status:** ${finding.status}`,
    `**Source:** ${finding.source}`,
    `**Created:** ${finding.createdAt}`,
    '',
    finding.description,
  ];

  if (finding.suggestedFix) {
    lines.push('', '**Suggested fix:**', finding.suggestedFix);
  }

  const events = await store.getEvents(id);
  if (events.length > 0) {
    lines.push('', '**Lifecycle:**', '');
    for (const ev of events) {
      const eventLine = `- \`${ev.timestamp}\` ${ev.fromStatus ?? 'none'} → ${ev.toStatus} (${ev.eventType}) by ${ev.actorId}`;
      lines.push(eventLine);
      if (ev.reason) lines.push(`  _${ev.reason}_`);
    }
  }

  lines.push('', `_Fingerprint: \`${finding.fingerprint.substring(0, 16)}…\`_`);
  return lines.join('\n');
}

// ── Finding lifecycle commands ─────────────────────────────────────

/** Valid resolution outcomes for the `resolve` action. */
const VALID_RESOLUTION_OUTCOMES: readonly ResolutionOutcome[] = ['fixed', 'wontfix', 'duplicate', 'false_positive', 'stale'];

/**
 * Transition a finding's lifecycle, then sync the parent report.
 *
 * - `resolve` → finding becomes resolved, report may auto-complete
 * - `ignore`  → finding becomes ignored, report may auto-complete
 * - `reopen`  → finding becomes active, terminal report auto-reopens
 * - `triage`  → finding becomes triaged (acknowledged, pending work)
 * - `start`   → finding becomes in_progress (work actively started)
 *
 * Usage: /review finding <id> resolve [--reason "..."] [--outcome <outcome>]
 *        /review finding <id> ignore [--reason "..."]
 *        /review finding <id> reopen [--reason "..."]
 *        /review finding <id> triage [--reason "..."]
 *        /review finding <id> start [--reason "..."]
 */
async function transitionFinding(
  id: string,
  action: 'resolve' | 'ignore' | 'reopen' | 'triage' | 'start',
  extraArgs: string[],
  ctx: FindingCommandContext,
): Promise<string> {
  // Parse optional --reason and --outcome from extra args.
  let reason: string | undefined;
  let outcome: string | undefined;
  for (let i = 0; i < extraArgs.length; i++) {
    if (extraArgs[i] === '--reason' && i + 1 < extraArgs.length) {
      reason = extraArgs[++i];
    } else if (extraArgs[i] === '--outcome' && i + 1 < extraArgs.length) {
      outcome = extraArgs[++i];
    }
  }

  const store = await loadStore(ctx);
  const finding = await store.get(id);
  if (!finding) return `Finding not found: ${id}`;

  // Treat empty/whitespace-only reason as undefined.
  const cleanReason = reason && reason.trim().length > 0 ? reason : undefined;

  // Normalize outcome: treat empty/whitespace-only as undefined (like reason).
  const cleanOutcome = outcome && outcome.trim().length > 0 ? outcome : undefined;

  // ── Reopen path ──────────────────────────────────────────────────
  if (action === 'reopen') {
    if (cleanOutcome) {
      return `⚠️ \`--outcome\` only applies to \`resolve\`. Usage: \`/review finding ${id} reopen --reason "..."\``;
    }
    try {
      await store.transition(finding.id, 'active', { id: 'operator', kind: 'operator' }, {
        ...(cleanReason !== undefined ? { reason: cleanReason } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Could not reopen finding ${id}: ${msg}`;
    }

    const lines: string[] = [
      `✅ Finding \`${id}\` reopened as **active**.`,
    ];

    // Auto-reopen: if the parent report was completed/skipped, reopen it.
    const reportId = finding.originReport?.reportId;
    if (reportId) {
      try {
        const reopenResult = await syncReportReopen(reportId, ctx.projectDir, {
          id: 'operator',
          kind: 'operator',
        }, cleanReason);
        if (reopenResult.reopened) {
          lines.push('', `🔵 Report \`${reportId}\` auto-reopened — was ${reopenResult.previousLifecycle}.`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(JSON.stringify({ level: 'warn', event: 'review_auto_reopen_failed', reportId, message: msg }));
      }
    }

    return lines.join('\n');
  }

  // ── Triage path ──────────────────────────────────────────────────
  if (action === 'triage') {
    if (cleanOutcome) {
      return `⚠️ \`--outcome\` only applies to \`resolve\`. Usage: \`/review finding ${id} triage --reason "..."\``;
    }
    try {
      await store.transition(finding.id, 'triaged', { id: 'operator', kind: 'operator' }, {
        ...(cleanReason !== undefined ? { reason: cleanReason } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Could not triage finding ${id}: ${msg}`;
    }

    return `✅ Finding \`${id}\` marked as **triaged**.`;
  }

  // ── Start path ───────────────────────────────────────────────────
  if (action === 'start') {
    if (cleanOutcome) {
      return `⚠️ \`--outcome\` only applies to \`resolve\`. Usage: \`/review finding ${id} start --reason "..."\``;
    }
    try {
      await store.transition(finding.id, 'in_progress', { id: 'operator', kind: 'operator' }, {
        ...(cleanReason !== undefined ? { reason: cleanReason } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Could not start finding ${id}: ${msg}`;
    }

    return `✅ Finding \`${id}\` marked as **in_progress**.`;
  }

  // ── Resolve / Ignore path ────────────────────────────────────────
  const targetStatus = action === 'resolve' ? 'resolved' : 'ignored';

  // --outcome has no meaning for ignore; reject rather than silently discard.
  if (action === 'ignore' && cleanOutcome) {
    return `⚠️ \`--outcome\` only applies to \`resolve\`. Usage: \`/review finding ${id} ignore --reason "..."\``;
  }

  // Validate outcome against the known ResolutionOutcome union.
  // When resolving without an explicit outcome, default to 'fixed'.
  if (action === 'resolve' && cleanOutcome && !VALID_RESOLUTION_OUTCOMES.includes(cleanOutcome as ResolutionOutcome)) {
    return `Invalid outcome "${cleanOutcome}". Valid values: ${VALID_RESOLUTION_OUTCOMES.join(', ')}`;
  }
  const resolvedOutcome: ResolutionOutcome | undefined =
    action === 'resolve'
      ? ((cleanOutcome as ResolutionOutcome | undefined) ?? 'fixed')
      : undefined;

  try {
    await store.transition(finding.id, targetStatus, { id: 'operator', kind: 'operator' }, {
      ...(cleanReason !== undefined ? { reason: cleanReason } : {}),
      ...(resolvedOutcome ? { outcome: resolvedOutcome } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Could not transition finding ${id} to ${targetStatus}: ${msg}`;
  }

  const lines: string[] = [
    `✅ Finding \`${id}\` marked as **${targetStatus}**.`,
  ];

  // Auto-completion: check if the parent report can be closed.
  // originReport is typed as required, but corrupt JSONL or old-format data
  // may be missing it — guard to keep auto-completion best-effort.
  const reportId = finding.originReport?.reportId;
  if (reportId) {
    try {
      const syncResult = await syncReportCompletion(reportId, ctx.projectDir, {
        id: 'operator',
        kind: 'operator',
      });
      if (syncResult.completed) {
        lines.push('', `🟢 Report \`${reportId}\` auto-completed — all ${syncResult.totalFindings} finding(s) resolved or ignored.`);
      } else if (syncResult.totalFindings > 0 && syncResult.remaining > 0) {
        lines.push(`_Report \`${reportId}\`: ${syncResult.remaining} of ${syncResult.totalFindings} finding(s) still open._`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(JSON.stringify({ level: 'warn', event: 'review_auto_completion_failed', reportId, message: msg }));
    }
  }

  return lines.join('\n');
}

// ── Report commands ────────────────────────────────────────────────

async function loadReportStore(ctx: FindingCommandContext) {
  const { JsonlReportStore } = await import('./review-report-store.js');
  return new JsonlReportStore(ctx.projectDir);
}

const LIFECYCLE_EMOJI: Record<string, string> = {
  open: '🔵',
  actioned: '🟡',
  completed: '🟢',
  skipped: '⚪',
};

async function listReports(
  args: string[],
  ctx: FindingCommandContext,
): Promise<string> {
  let statusFilter: string | undefined;
  let limit = 15;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--status' && i + 1 < args.length) {
      statusFilter = args[++i]!;
    } else if (args[i] === '--limit' && i + 1 < args.length) {
      limit = Number.parseInt(args[++i]!, 10) || 15;
    }
  }

  const store = await loadReportStore(ctx);
  const reports = await store.list({
    ...(statusFilter ? { statuses: [statusFilter as ReportLifecycleStatus] } : {}),
    limit,
  });

  if (reports.length === 0) {
    return `No reports found${statusFilter ? ` (status=${statusFilter})` : ''}.`;
  }

  const lines: string[] = [
    '| Lifecycle | Source | Findings | Reviewed | Report |',
    '|---|---|---|---|---|',
  ];
  for (const r of reports) {
    const emoji = LIFECYCLE_EMOJI[r.lifecycle] ?? '⚪';
    const total = r.counts.critical + r.counts.high + r.counts.medium + r.counts.low;
    const sevSummary = total === 0 ? 'clean' : [
      r.counts.critical > 0 && `${r.counts.critical}🔴`,
      r.counts.high > 0 && `${r.counts.high}🟠`,
      r.counts.medium > 0 && `${r.counts.medium}🟡`,
      r.counts.low > 0 && `${r.counts.low}⚪`,
    ].filter(Boolean).join(' ');
    const date = r.reviewedAt.substring(0, 10);
    const id = r.id.substring(0, 8);
    lines.push(`| ${emoji} ${r.lifecycle} | ${r.source} | ${sevSummary} | ${date} | \`${id}\` |`);
  }

  lines.push('', `_${reports.length} report(s). Use \`/review report <id>\` for details._`);
  return lines.join('\n');
}

/**
 * Resolve a report by exact ID or short-ID prefix (≥8 chars).
 * Exported for integration testing.
 */
 async function resolveReportId(
  store: Awaited<ReturnType<typeof loadReportStore>>,
  id: string,
): Promise<ReviewReport | null> {
  const report = await store.get(id);
  if (report) return report;
  if (id.length >= 8) {
    const all = await store.list({ limit: 9999 });
    const match = all.find((r) => r.id.startsWith(id));
    if (match) return match;
  }
  return null;
}

async function showReport(id: string, ctx: FindingCommandContext): Promise<string> {
  const store = await loadReportStore(ctx);
  const report = await resolveReportId(store, id);
  if (!report) return `Report not found: ${id}`;

  const emoji = LIFECYCLE_EMOJI[report.lifecycle] ?? '⚪';
  const lines: string[] = [
    `## ${emoji} Review Report — ${report.lifecycle}`,
    '',
    `**ID:** \`${report.id}\``,
    `**Reviewed:** ${report.reviewedAt}`,
    `**Source:** ${report.source}`,
    `**Reviewer model:** ${report.reviewerModel}`,
    `**Review status:** ${report.reviewStatus}`,
    ...(report.cascadeDepth !== undefined ? [`**Cascade depth:** ${report.cascadeDepth}`] : []),
    ...(report.durationSeconds !== undefined ? [`**Duration:** ${report.durationSeconds}s`] : []),
    ...(report.evidenceStatus !== undefined
      ? [
          `**Evidence:** ${
            report.evidenceStatus === 'verified'
              ? '✅ verified'
              : report.evidenceStatus === 'failed'
                ? '❌ failed'
                : '⚠️ missing'
          }`,
          ...(report.evidenceChecks && report.evidenceChecks.length > 0
            ? [
                '',
                ...report.evidenceChecks.map((check) => {
                  const mark = check.ok ? '✓' : '✗';
                  const claimed = check.claimedExitCode ?? '—';
                  const actual = check.actualExitCode ?? '—';
                  return `  ${mark} \`${check.name}\` — \`${check.command}\` (claimed ${claimed}, observed ${actual})`;
                }),
              ]
            : []),
        ]
      : []),
    '',
    '**Severity counts:**',
    `  🔴 Critical: ${report.counts.critical}`,
    `  🟠 High: ${report.counts.high}`,
    `  🟡 Medium: ${report.counts.medium}`,
    `  ⚪ Low: ${report.counts.low}`,
    `  **Total findings:** ${report.totalFindings}`,
    ...(report.unparseableCount > 0 ? [`  _${report.unparseableCount} unparseable_`] : []),
  ];

  if (report.files.length > 0) {
    lines.push('', '**Files reviewed:**');
    for (const f of report.files.slice(0, 20)) {
      lines.push(`  - \`${f.path}\` (${f.status})`);
    }
    if (report.files.length > 20) {
      lines.push(`  _...and ${report.files.length - 20} more_`);
    }
  }

  const events = await store.getEvents(report.id);
  if (events.length > 0) {
    lines.push('', '**Lifecycle events:**', '');
    for (const ev of events) {
      const transition = ev.fromLifecycle
        ? `${ev.fromLifecycle} → ${ev.toLifecycle}`
        : `→ ${ev.toLifecycle}`;
      lines.push(`- \`${ev.timestamp}\` ${transition} (${ev.eventType}) by ${ev.actorId}`);
      if (ev.reason) lines.push(`  _${ev.reason}_`);
    }
  }

  if (report.rawText?.trim()) {
    lines.push('', '<details><summary>Raw report text</summary>', '', report.rawText, '', '</details>');
  }

  return lines.join('\n');
}

// ── Report lifecycle commands ──────────────────────────────────────

/**
 * Manually transition a report's lifecycle.
 *
 * Usage: /review report <id> complete [--reason "..."]
 *        /review report <id> skip [--reason "..."]
 *        /review report <id> action [--reason "..."]
 *
 * Maps to: complete → completed, skip → skipped, action → actioned.
 */
export async function transitionReport(
  id: string,
  action: 'complete' | 'skip' | 'action',
  extraArgs: string[],
  ctx: FindingCommandContext,
): Promise<string> {
  // Parse optional --reason.
  let reason: string | undefined;
  for (let i = 0; i < extraArgs.length; i++) {
    if (extraArgs[i] === '--reason' && i + 1 < extraArgs.length) {
      reason = extraArgs[++i];
    }
  }

  const cleanReason = reason && reason.trim().length > 0 ? reason : undefined;

  const targetMap = { complete: 'completed', skip: 'skipped', action: 'actioned' } as const;
  const targetStatus = targetMap[action];

  const store = await loadReportStore(ctx);

  // Resolve short-ID prefix via shared helper.
  const report = await resolveReportId(store, id);
  if (!report) return `Report not found: ${id}`;

  try {
    await store.transition(report.id, targetStatus, { id: 'operator', kind: 'operator' }, {
      ...(cleanReason !== undefined ? { reason: cleanReason } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Could not transition report \`${report.id}\` to ${targetStatus}: ${msg}`;
  }

  const emoji = LIFECYCLE_EMOJI[targetStatus] ?? '⚪';
  return `${emoji} Report \`${report.id}\` marked as **${targetStatus}**.`;
}

/**
 * Add an annotation note to a report without changing its lifecycle status.
 *
 * Usage: /review report <id> note <message>
 */
async function addReportNote(
  id: string,
  extraArgs: string[],
  ctx: FindingCommandContext,
): Promise<string> {
  // The note is everything after "note" — join the remaining args.
  const note = extraArgs.join(' ').trim();
  if (!note) {
    return 'Usage: /review report <id> note <message>';
  }

  const store = await loadReportStore(ctx);
  const report = await resolveReportId(store, id);
  if (!report) return `Report not found: ${id}`;

  try {
    await store.addNote(report.id, { id: 'operator', kind: 'operator' }, note);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Could not add note to report ${id}: ${msg}`;
  }

  return `📝 Note added to report \`${report.id}\`.`;
}

async function showStatus(ctx: FindingCommandContext): Promise<string> {
  const store = await loadStore(ctx);
  const all = await store.list({ limit: 9999 });

  const counts: Record<string, number> = {};
  const severityCounts: Record<string, number> = {};
  for (const f of all) {
    counts[f.status] = (counts[f.status] || 0) + 1;
    severityCounts[f.severity] = (severityCounts[f.severity] || 0) + 1;
  }

  return [
    '## Finding Store Status',
    '',
    `**Total findings:** ${all.length}`,
    '',
    '**By status:**',
    ...Object.entries(counts).map(([k, v]) => `  - ${k}: ${v}`),
    '',
    '**By severity:**',
    ...Object.entries(severityCounts).map(([k, v]) => `  - ${k}: ${v}`),
    '',
    `_Page size: ${FINDING_DEFAULT_PAGE_SIZE}_`,
  ].join('\n');
}
