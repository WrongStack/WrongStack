/**
 * Finding-store slash commands.
 *
 * FS-P0.5: Provides `/review findings` and `/review finding <id>` commands
 * for viewing persisted Chimera review findings.
 *
 * @module review-finding-commands
 */
import { toErrorMessage } from '@wrongstack/core/utils';
import { FINDING_DEFAULT_PAGE_SIZE } from './review-finding-store.js';
import type { FindingCommandContext } from './review-finding-transition.js';
import { loadStore, resolveFindingId, transitionFinding } from './review-finding-transition.js';
import type { FindingSeverity, FindingStatus } from './review-finding-types.js';
import { computeReportScopeDrift } from './review-report-integration.js';
import type { ReportLifecycleStatus, ReviewReport } from './review-report-types.js';

export type { FindingCommandContext } from './review-finding-transition.js';

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
    if (
      action === 'resolve' ||
      action === 'ignore' ||
      action === 'reopen' ||
      action === 'triage' ||
      action === 'start'
    ) {
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

async function listFindings(args: string[], ctx: FindingCommandContext): Promise<string> {
  let severityFilter: string | undefined;
  let statusFilter: string | undefined;
  let limit = 20;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--severity' && i + 1 < args.length) {
      severityFilter = args[++i]!;
    } else if (arg.startsWith('--severity=')) {
      severityFilter = arg.slice('--severity='.length);
    } else if (arg === '--status' && i + 1 < args.length) {
      statusFilter = args[++i]!;
    } else if (arg.startsWith('--status=')) {
      statusFilter = arg.slice('--status='.length);
    } else if (arg === '--limit' && i + 1 < args.length) {
      const parsed = Number.parseInt(args[++i]!, 10);
      limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
    } else if (arg.startsWith('--limit=')) {
      const parsed = Number.parseInt(arg.slice('--limit='.length), 10);
      limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
    }
  }

  const store = await loadStore(ctx);
  const all = await store.list({
    ...(severityFilter ? { severities: [severityFilter as FindingSeverity] } : {}),
    ...(statusFilter ? { statuses: [statusFilter as FindingStatus] } : {}),
    limit,
  });

  if (all.length === 0) {
    const filters = [
      severityFilter && `severity=${severityFilter}`,
      statusFilter && `status=${statusFilter}`,
    ]
      .filter(Boolean)
      .join(', ');
    return `No findings found${filters ? ` (${filters})` : ''}.`;
  }

  const lines: string[] = ['| Severity | Status | File | Title |', '|---|---|---|---|'];
  for (const f of all) {
    const location = f.location?.file ?? 'unknown';
    // Basename across BOTH separators: mixed-separator locations (drive
    // backslash + forward relative rest on win32) made the previously chained
    // substring apply the ORIGINAL string's backslash index to the
    // already-truncated result, rendering garbage like `e.ts` in the table.
    const file =
      location.substring(Math.max(location.lastIndexOf('/'), location.lastIndexOf('\\')) + 1) ||
      location;
    const severityEmoji =
      f.severity === 'critical'
        ? '🔴'
        : f.severity === 'high'
          ? '🟠'
          : f.severity === 'medium'
            ? '🟡'
            : '⚪';
    const title = f.title.length > 60 ? f.title.substring(0, 57) + '...' : f.title;
    lines.push(`| ${severityEmoji} ${f.severity} | ${f.status} | \`${file}\` | ${title} |`);
  }

  lines.push('', `_${all.length} finding(s) shown. Use \`/review finding <id>\` for details._`);
  return lines.join('\n');
}

async function showFinding(id: string, ctx: FindingCommandContext): Promise<string> {
  const store = await loadStore(ctx);
  const finding = await resolveFindingId(store, id);
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

  const events = await store.getEvents(finding.id);
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

function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
  if (tokens >= 1_000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(Math.round(tokens));
}

function formatCompactReportUsage(usage: ReviewReport['usage']): string {
  if (!usage || usage.totalTokens <= 0) return '—';
  const tok = formatCompactTokens(usage.totalTokens);
  if (usage.costUsd > 0) {
    const cost =
      usage.costUsd < 0.01 ? `$${usage.costUsd.toFixed(4)}` : `$${usage.costUsd.toFixed(3)}`;
    return `${tok} (${cost})`;
  }
  return tok;
}

async function listReports(args: string[], ctx: FindingCommandContext): Promise<string> {
  let statusFilter: string | undefined;
  let limit = 15;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--status' && i + 1 < args.length) {
      statusFilter = args[++i]!;
    } else if (arg.startsWith('--status=')) {
      statusFilter = arg.slice('--status='.length);
    } else if (arg === '--limit' && i + 1 < args.length) {
      const parsed = Number.parseInt(args[++i]!, 10);
      limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
    } else if (arg.startsWith('--limit=')) {
      const parsed = Number.parseInt(arg.slice('--limit='.length), 10);
      limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
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
    '| Lifecycle | Source | Findings | Tokens | Reviewed | Report |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of reports) {
    const emoji = LIFECYCLE_EMOJI[r.lifecycle] ?? '⚪';
    const total = r.counts.critical + r.counts.high + r.counts.medium + r.counts.low;
    const sevSummary =
      total === 0
        ? 'clean'
        : [
            r.counts.critical > 0 && `${r.counts.critical}🔴`,
            r.counts.high > 0 && `${r.counts.high}🟠`,
            r.counts.medium > 0 && `${r.counts.medium}🟡`,
            r.counts.low > 0 && `${r.counts.low}⚪`,
          ]
            .filter(Boolean)
            .join(' ');
    const tokenSummary = formatCompactReportUsage(r.usage);
    const date = r.reviewedAt.substring(0, 10);
    const id = r.id.substring(0, 8);
    lines.push(
      `| ${emoji} ${r.lifecycle} | ${r.source} | ${sevSummary} | ${tokenSummary} | ${date} | \`${id}\` |`,
    );
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

  const scopeDrift = ctx.cwd ? await computeReportScopeDrift(report, ctx.cwd) : undefined;
  const driftedList = scopeDrift
    ? [...scopeDrift.modifiedPaths, ...scopeDrift.missingPaths.map((p) => `${p} (missing)`)]
    : [];

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
    ...(report.scopeManifest?.headSha ? [`**HEAD:** \`${report.scopeManifest.headSha}\``] : []),
    ...(scopeDrift
      ? [
          scopeDrift.stale
            ? `**Scope status:** ⚠️ stale on disk (${driftedList.length} file(s) changed since review: ${driftedList.slice(0, 6).join(', ')})`
            : `**Scope status:** ✅ current on disk (${scopeDrift.checkedCount} file(s) match reviewed SHA-256)`,
        ]
      : []),
    ...(report.usage !== undefined
      ? [
          `**Tokens:** ${report.usage.totalTokens.toLocaleString('en-US')} (in ${report.usage.inputTokens.toLocaleString('en-US')}, out ${report.usage.outputTokens.toLocaleString('en-US')}${
            report.usage.cacheReadTokens
              ? `, cache read ${report.usage.cacheReadTokens.toLocaleString('en-US')}`
              : ''
          }${report.usage.costUsd > 0 ? `, $${report.usage.costUsd.toFixed(4)}` : ''})`,
          ...(report.usage.iterations !== undefined || report.usage.toolCalls !== undefined
            ? [
                `**Execution:** ${report.usage.iterations ?? 0} turn(s), ${report.usage.toolCalls ?? 0} tool call(s)${
                  report.usage.attemptsUsed && report.usage.attemptsUsed > 1
                    ? `, ${report.usage.attemptsUsed} model attempts`
                    : ''
                }`,
              ]
            : []),
        ]
      : []),
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
    const manifestByPath = new Map(
      (report.scopeManifest?.files ?? []).map((entry) => [entry.path, entry] as const),
    );
    lines.push('', '**Files reviewed:**');
    for (const f of report.files.slice(0, 20)) {
      const m = manifestByPath.get(f.path);
      const extras: string[] = [];
      if (m?.isIncrementalDelta) extras.push('delta');
      if (m?.addedLines !== undefined || m?.removedLines !== undefined) {
        extras.push(`+${m.addedLines ?? 0}/-${m.removedLines ?? 0}`);
      }
      if (m?.changedSymbols && m.changedSymbols.length > 0) {
        extras.push(`symbols: ${m.changedSymbols.slice(0, 4).join(', ')}`);
      }
      if (m?.pairedTestPath) {
        extras.push(`test: ${m.pairedTestUpdated ? 'updated' : 'not updated'}`);
      }
      const suffix = extras.length > 0 ? ` — ${extras.join(' · ')}` : '';
      lines.push(`  - \`${f.path}\` (${f.status})${suffix}`);
    }
    if (report.files.length > 20) {
      lines.push(`  _...and ${report.files.length - 20} more_`);
    }
  }

  if (report.scopeManifest?.sessionIntent && report.scopeManifest.sessionIntent.length > 0) {
    lines.push('', '**Session intent:**');
    for (const snippet of report.scopeManifest.sessionIntent) {
      lines.push(`  - ${snippet}`);
    }
  }

  if (
    report.scopeManifest?.deletedFileReferences &&
    report.scopeManifest.deletedFileReferences.length > 0
  ) {
    lines.push('', '**Deleted-file references:**');
    for (const ref of report.scopeManifest.deletedFileReferences) {
      lines.push(
        `  - \`${ref.deletedPath}\` → ${ref.referencedBy.map((p) => `\`${p}\``).join(', ')}`,
      );
    }
  }

  if (report.scopeManifest?.signatureCallers && report.scopeManifest.signatureCallers.length > 0) {
    lines.push('', '**Modified export callers:**');
    for (const entry of report.scopeManifest.signatureCallers) {
      lines.push(
        `  - \`${entry.symbol}\` (\`${entry.file}\`) → ${entry.callers.map((c) => `\`${c}\``).join(', ')}`,
      );
    }
  }

  if (report.scopeManifest?.skippedFiles && report.scopeManifest.skippedFiles.length > 0) {
    lines.push('', `**Skipped files (${report.scopeManifest.skippedFiles.length}):**`);
    for (const s of report.scopeManifest.skippedFiles.slice(0, 15)) {
      lines.push(`  - \`${s.path}\` (${s.reason}${s.detail ? `: ${s.detail}` : ''})`);
    }
    if (report.scopeManifest.skippedFiles.length > 15) {
      lines.push(`  _...and ${report.scopeManifest.skippedFiles.length - 15} more_`);
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
    lines.push(
      '',
      '<details><summary>Raw report text</summary>',
      '',
      report.rawText,
      '',
      '</details>',
    );
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
    const arg = extraArgs[i]!;
    if (arg === '--reason' && i + 1 < extraArgs.length) {
      reason = extraArgs[++i];
    } else if (arg.startsWith('--reason=')) {
      reason = arg.slice('--reason='.length);
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
    await store.transition(
      report.id,
      targetStatus,
      { id: 'operator', kind: 'operator' },
      {
        ...(cleanReason !== undefined ? { reason: cleanReason } : {}),
      },
    );
  } catch (err) {
    const msg = toErrorMessage(err);
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
    const msg = toErrorMessage(err);
    return `Could not add note to report ${id}: ${msg}`;
  }

  return `📝 Note added to report \`${report.id}\`.`;
}

async function showStatus(ctx: FindingCommandContext): Promise<string> {
  const [store, reportStore] = await Promise.all([loadStore(ctx), loadReportStore(ctx)]);
  const [all, reports] = await Promise.all([
    store.list({ limit: 9999 }),
    reportStore.list({ limit: 9999 }),
  ]);

  const counts: Record<string, number> = {};
  const severityCounts: Record<string, number> = {};
  for (const f of all) {
    counts[f.status] = (counts[f.status] || 0) + 1;
    severityCounts[f.severity] = (severityCounts[f.severity] || 0) + 1;
  }

  const lines: string[] = [
    '## Finding Store Status',
    '',
    `**Total findings:** ${all.length}`,
    '',
    '**By status:**',
    ...Object.entries(counts).map(([k, v]) => `  - ${k}: ${v}`),
    '',
    '**By severity:**',
    ...Object.entries(severityCounts).map(([k, v]) => `  - ${k}: ${v}`),
  ];

  if (reports.length > 0) {
    let totalTokens = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let totalCostUsd = 0;
    let reportsWithUsage = 0;
    let incrementalCount = 0;
    for (const r of reports) {
      if (r.scopeManifest?.isIncremental) incrementalCount++;
      if (r.usage && r.usage.totalTokens > 0) {
        reportsWithUsage++;
        totalTokens += r.usage.totalTokens;
        inputTokens += r.usage.inputTokens;
        outputTokens += r.usage.outputTokens;
        cacheReadTokens += r.usage.cacheReadTokens ?? 0;
        totalCostUsd += r.usage.costUsd;
      }
    }
    lines.push(
      '',
      '### Review Reports & Token Telemetry',
      `**Total reports:** ${reports.length}${incrementalCount > 0 ? ` (${incrementalCount} incremental delta)` : ''}`,
    );
    if (reportsWithUsage > 0) {
      const denom = inputTokens + cacheReadTokens;
      const cachePct = denom > 0 ? Math.round((cacheReadTokens / denom) * 100) : 0;
      lines.push(
        `**Tokens (${reportsWithUsage} metered):** ${totalTokens.toLocaleString('en-US')} (in ${inputTokens.toLocaleString('en-US')}, out ${outputTokens.toLocaleString('en-US')}${
          cacheReadTokens > 0
            ? `, cache read ${cacheReadTokens.toLocaleString('en-US')} [${cachePct}%]`
            : ''
        })`,
      );
      if (totalCostUsd > 0) {
        lines.push(`**Estimated cost:** $${totalCostUsd.toFixed(4)}`);
      }
    }
  }

  lines.push('', `_Page size: ${FINDING_DEFAULT_PAGE_SIZE}_`);
  return lines.join('\n');
}
