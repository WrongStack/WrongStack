import { toErrorMessage } from '@wrongstack/core/utils';
import type { ResolutionOutcome } from './review-finding-types.js';
import { syncReportCompletion, syncReportReopen } from './review-report-integration.js';

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
  /** Optional working-tree root used for live scope-drift checks against disk */
  cwd?: string | undefined;
}

export async function loadStore(ctx: FindingCommandContext) {
  const { JsonlFindingStore } = await import('./review-finding-store.js');
  const store = new JsonlFindingStore(ctx.projectDir);
  return store;
}

/**
 * Resolve a finding by exact ID or unambiguous short-ID prefix (>= 8 chars).
 */
export async function resolveFindingId(store: Awaited<ReturnType<typeof loadStore>>, id: string) {
  const finding = await store.get(id);
  if (finding) return finding;
  if (id.length >= 8) {
    const all = await store.list({ limit: 9999 });
    const matches = all.filter((f) => f.id.startsWith(id));
    if (matches.length === 1) return matches[0]!;
  }
  return null;
}

// ── Finding lifecycle commands ─────────────────────────────────────

/** Valid resolution outcomes for the `resolve` action. */
const VALID_RESOLUTION_OUTCOMES: readonly ResolutionOutcome[] = [
  'fixed',
  'wontfix',
  'duplicate',
  'false_positive',
  'stale',
];

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
export async function transitionFinding(
  id: string,
  action: 'resolve' | 'ignore' | 'reopen' | 'triage' | 'start',
  extraArgs: string[],
  ctx: FindingCommandContext,
): Promise<string> {
  // Parse optional --reason and --outcome from extra args.
  let reason: string | undefined;
  let outcome: string | undefined;
  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i]!;
    if (arg === '--reason' && i + 1 < extraArgs.length) {
      reason = extraArgs[++i];
    } else if (arg.startsWith('--reason=')) {
      reason = arg.slice('--reason='.length);
    } else if (arg === '--outcome' && i + 1 < extraArgs.length) {
      outcome = extraArgs[++i];
    } else if (arg.startsWith('--outcome=')) {
      outcome = arg.slice('--outcome='.length);
    }
  }

  const store = await loadStore(ctx);
  const finding = await resolveFindingId(store, id);
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
      await store.transition(
        finding.id,
        'active',
        { id: 'operator', kind: 'operator' },
        {
          ...(cleanReason !== undefined ? { reason: cleanReason } : {}),
        },
      );
    } catch (err) {
      const msg = toErrorMessage(err);
      return `Could not reopen finding ${id}: ${msg}`;
    }

    const lines: string[] = [`✅ Finding \`${id}\` reopened as **active**.`];

    // Auto-reopen: if the parent report was completed/skipped, reopen it.
    const reportId = finding.originReport?.reportId;
    if (reportId) {
      try {
        const reopenResult = await syncReportReopen(
          reportId,
          ctx.projectDir,
          {
            id: 'operator',
            kind: 'operator',
          },
          cleanReason,
        );
        if (reopenResult.reopened) {
          lines.push(
            '',
            `🔵 Report \`${reportId}\` auto-reopened — was ${reopenResult.previousLifecycle}.`,
          );
        }
      } catch (err) {
        const msg = toErrorMessage(err);
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'review_auto_reopen_failed',
            reportId,
            message: msg,
          }),
        );
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
      await store.transition(
        finding.id,
        'triaged',
        { id: 'operator', kind: 'operator' },
        {
          ...(cleanReason !== undefined ? { reason: cleanReason } : {}),
        },
      );
    } catch (err) {
      const msg = toErrorMessage(err);
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
      await store.transition(
        finding.id,
        'in_progress',
        { id: 'operator', kind: 'operator' },
        {
          ...(cleanReason !== undefined ? { reason: cleanReason } : {}),
        },
      );
    } catch (err) {
      const msg = toErrorMessage(err);
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
  if (
    action === 'resolve' &&
    cleanOutcome &&
    !VALID_RESOLUTION_OUTCOMES.includes(cleanOutcome as ResolutionOutcome)
  ) {
    return `Invalid outcome "${cleanOutcome}". Valid values: ${VALID_RESOLUTION_OUTCOMES.join(', ')}`;
  }
  const resolvedOutcome: ResolutionOutcome | undefined =
    action === 'resolve' ? ((cleanOutcome as ResolutionOutcome | undefined) ?? 'fixed') : undefined;

  try {
    await store.transition(
      finding.id,
      targetStatus,
      { id: 'operator', kind: 'operator' },
      {
        ...(cleanReason !== undefined ? { reason: cleanReason } : {}),
        ...(resolvedOutcome ? { outcome: resolvedOutcome } : {}),
      },
    );
  } catch (err) {
    const msg = toErrorMessage(err);
    return `Could not transition finding ${id} to ${targetStatus}: ${msg}`;
  }

  const lines: string[] = [`✅ Finding \`${id}\` marked as **${targetStatus}**.`];

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
        lines.push(
          '',
          `🟢 Report \`${reportId}\` auto-completed — all ${syncResult.totalFindings} finding(s) resolved or ignored.`,
        );
      } else if (syncResult.totalFindings > 0 && syncResult.remaining > 0) {
        lines.push(
          `_Report \`${reportId}\`: ${syncResult.remaining} of ${syncResult.totalFindings} finding(s) still open._`,
        );
      }
    } catch (err) {
      const msg = toErrorMessage(err);
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'review_auto_completion_failed',
          reportId,
          message: msg,
        }),
      );
    }
  }

  return lines.join('\n');
}
