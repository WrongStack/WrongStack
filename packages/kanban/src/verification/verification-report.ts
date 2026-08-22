/**
 * VerificationReport builder and Markdown renderer.
 *
 * The builder constructs a KanbanVerificationReport from individual check
 * results and overall task context. The renderer produces a human-readable
 * Markdown summary suitable for CLI output or chat context.
 */
import type {
  KanbanVerificationAttachment,
  KanbanVerificationBaseline,
  KanbanVerificationCheckResult,
  KanbanVerificationFileScope,
  KanbanVerificationReport,
  KanbanVerificationSubtasks,
} from '../types.js';

export type Verdict = KanbanVerificationReport['verdict'];

export interface VerificationReportBuilderInput {
  taskId: string;
  taskTitle: string;
  boardId: string;
  checks: KanbanVerificationCheckResult[];
  fileScope?: KanbanVerificationFileScope | undefined;
  subtasks?: KanbanVerificationSubtasks | undefined;
  attachments?: KanbanVerificationAttachment[] | undefined;
  /** Attempt counter from the owning assignment, if available. */
  attempt?: number | undefined;
  /** Lease id from the owning assignment, if available. */
  leaseId?: string | undefined;
  /** Board revision at verification time, if available. */
  taskRevision?: number | undefined;
  /** Git baseline snapshot captured for the file-scope diff, if any. */
  baseline?: KanbanVerificationBaseline | undefined;
  /**
   * Override for `coveredCheckIds` — the list of criterion ids the verifier
   * actually exercised with a passing result. Computed automatically from
   * `checks` when omitted, so existing callers stay correct.
   */
  coveredCheckIds?: string[] | undefined;
}

/**
 * Build a KanbanVerificationReport from individual check results.
 * Computes the overall verdict automatically:
 *  - passed:    all checks passed or skipped, file scope matches, all subtasks
 *               COMPLETED (a failed subtask fails the parent — see below)
 *  - failed:    any check failed, or any subtask failed
 *  - needs_human: any check had an error or needs escalation
 *  - incomplete: subtasks exist but are not all completed/failed
 */
export function buildVerificationReport(
  input: VerificationReportBuilderInput,
): KanbanVerificationReport {
  const startedAt = new Date().toISOString();
  const completedAt = new Date().toISOString();

  const checks = input.checks;
  const hasFailed = checks.some((c) => c.status === 'failed');
  const hasError = checks.some((c) => c.status === 'error');
  // A failed subtask must fail the parent. `subtasks.failed` used to be
  // written and never READ: verifySubtasks counts every child exactly once
  // (completed + failed === total, always), so the incomplete branch below
  // was arithmetically unreachable on that path — and a parent whose
  // children ALL failed sailed to 'passed'. The incomplete branch stays for
  // direct builder callers that hand-construct partial counts.
  const hasFailedSubtasks = input.subtasks !== undefined && input.subtasks.failed > 0;
  const hasIncompleteSubtasks =
    input.subtasks && input.subtasks.completed + input.subtasks.failed < input.subtasks.total;
  // A file-scope mismatch means the worker changed files outside its declared
  // expectedFileChanges set, or failed to change an expected file. That is a
  // real defect regardless of whether the acceptance criteria happened to pass:
  // the card's stated contract was not honoured. Previously scopeMatches was
  // computed and rendered in the Markdown report but never consulted by the
  // verdict, so a task could score `passed` while touching unrelated files.
  const hasFileScopeMismatch = input.fileScope !== undefined && !input.fileScope.scopeMatches;

  let verdict: Verdict;
  if (hasFailed || hasFailedSubtasks || hasFileScopeMismatch) verdict = 'failed';
  else if (hasError) verdict = 'needs_human';
  else if (hasIncompleteSubtasks) verdict = 'incomplete';
  else verdict = 'passed';

  const markdownSummary = renderVerificationReportMarkdown({
    taskTitle: input.taskTitle,
    taskId: input.taskId,
    verdict,
    checks,
    fileScope: input.fileScope,
    subtasks: input.subtasks,
  });

  const coveredCheckIds = deriveCoveredCheckIds(checks, input.coveredCheckIds);

  return {
    taskId: input.taskId,
    taskTitle: input.taskTitle,
    boardId: input.boardId,
    startedAt,
    completedAt,
    verdict,
    checks,
    fileScope: input.fileScope,
    subtasks: input.subtasks,
    markdownSummary,
    attachments: input.attachments ?? [],
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(input.leaseId !== undefined ? { leaseId: input.leaseId } : {}),
    ...(input.taskRevision !== undefined ? { taskRevision: input.taskRevision } : {}),
    ...(input.baseline !== undefined ? { baseline: input.baseline } : {}),
    ...(coveredCheckIds !== undefined ? { coveredCheckIds } : {}),
  };
}

/**
 * Ids of the checks the verifier actually exercised with a passing verdict.
 * Manual (human/agent) criteria are NOT covered; the agent must still mark
 * them `passed` via `update_check` for those. Anything the verifier decided
 * is recorded here so the Definition-of-Done gate can skip the per-check
 * `passed` requirement for the same ids.
 *
 * Computed from `checks` so callers don't have to track it. Explicit
 * `coveredCheckIds` on the input is honored (used by tests and by callers
 * that want to scope coverage to a subset).
 */
function deriveCoveredCheckIds(
  checks: KanbanVerificationCheckResult[],
  explicit: string[] | undefined,
): string[] | undefined {
  if (explicit !== undefined) return explicit;
  const covered: string[] = [];
  for (const check of checks) {
    if (check.status === 'passed') covered.push(check.checkId);
  }
  return covered.length > 0 ? covered : undefined;
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

export interface MarkdownRenderInput {
  taskTitle: string;
  taskId: string;
  verdict: Verdict;
  checks: KanbanVerificationCheckResult[];
  fileScope?: KanbanVerificationFileScope | undefined;
  subtasks?: KanbanVerificationSubtasks | undefined;
}

/** Status icon for a check. */
function statusIcon(status: string): string {
  switch (status) {
    case 'passed':
      return '✅';
    case 'failed':
      return '❌';
    case 'skipped':
      return '⏭️';
    case 'error':
      return '⚠️';
    default:
      return '❓';
  }
}

/** Render the full verification report as Markdown. */
export function renderVerificationReportMarkdown(input: MarkdownRenderInput): string {
  const lines: string[] = [];
  const verdictEmoji =
    input.verdict === 'passed'
      ? '✅'
      : input.verdict === 'failed'
        ? '❌'
        : input.verdict === 'needs_human'
          ? '⚠️'
          : '🔄';

  lines.push(`## ${verdictEmoji} Verification Report: ${input.taskTitle}`);
  lines.push('');
  lines.push(`**Task**: \`${input.taskId}\``);
  lines.push(`**Verdict**: \`${input.verdict.toUpperCase()}\``);
  lines.push('');

  // File scope
  if (input.fileScope) {
    const scopeOk = input.fileScope.scopeMatches ? '✅' : '❌';
    lines.push(`### ${scopeOk} File Scope`);
    lines.push('');
    lines.push(
      `| Expected: ${input.fileScope.expectedChanges} | Actual: ${input.fileScope.actualChanges} | Match: ${input.fileScope.scopeMatches} |`,
    );
    lines.push('|--|--|--|');
    lines.push('');

    for (const file of input.fileScope.files) {
      const icon = file.expected ? '✅' : '⚠️';
      lines.push(
        `- ${icon} \`${file.path}\` — **${file.operation}** (${file.linesChanged} lines)${file.expected ? '' : ' *unexpected*'}`,
      );
    }
    lines.push('');
  }

  // Subtasks
  if (input.subtasks) {
    lines.push('### 📋 Subtask Status');
    lines.push('');
    lines.push(
      `**${input.subtasks.completed}**/${input.subtasks.total} completed, **${input.subtasks.failed}** failed`,
    );
    lines.push('');
    for (const child of input.subtasks.children) {
      const icon =
        child.verdict === 'passed'
          ? '✅'
          : child.verdict === 'failed'
            ? '❌'
            : child.verdict === 'needs_human'
              ? '⚠️'
              : '🔄';
      lines.push(`- ${icon} **${child.title}** (\`${child.verdict}\`)`);
    }
    lines.push('');
  }

  // Checks
  lines.push('### 📋 Acceptance Criteria');
  lines.push('');

  for (const check of input.checks) {
    const icon = statusIcon(check.status);
    lines.push(`#### ${icon} ${check.description}`);
    lines.push('');
    lines.push(`- **Type**: \`${check.type}\``);
    lines.push(`- **Status**: \`${check.status}\``);

    // Evidence
    if (Object.keys(check.evidence).length > 0) {
      lines.push('- **Evidence**:');
      for (const [key, value] of Object.entries(check.evidence)) {
        const display =
          typeof value === 'string' && value.length > 300
            ? `${value.slice(0, 300)}…`
            : Array.isArray(value) && value.length > 10
              ? `[${value.length} items]`
              : JSON.stringify(value, null, 0);
        lines.push(`  - \`${key}\`: ${display}`);
      }
    }

    // Backing refs (concrete proof)
    if (check.backingRefs?.length) {
      lines.push('- **Proof References**:');
      for (const ref of check.backingRefs) {
        lines.push(`  - \`[${ref.kind}]\` \`${ref.path}\`: ${ref.summary}`);
      }
    }

    if (check.error) {
      lines.push(`- **Error**: \`${check.error}\``);
    }
    lines.push('');
  }

  // Summary line
  const passed = input.checks.filter((c) => c.status === 'passed').length;
  const failed = input.checks.filter((c) => c.status === 'failed').length;
  const skipped = input.checks.filter((c) => c.status === 'skipped').length;
  const errored = input.checks.filter((c) => c.status === 'error').length;
  lines.push(
    `**Summary**: ${passed} passed, ${failed} failed, ${skipped} skipped, ${errored} errors`,
  );

  return lines.join('\n');
}
