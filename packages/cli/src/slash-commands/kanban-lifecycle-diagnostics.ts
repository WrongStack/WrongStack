import { decodeLifecycleIssues, type KanbanBoard } from '@wrongstack/kanban';

export function formatLifecycleDiagnosis(err: unknown, action: string): string {
  const issues = decodeLifecycleIssues(err);
  const message = err instanceof Error ? err.message : String(err);
  const issue = issues[0];
  if (!issue) return `❌ /kanban task ${action} rejected: ${message}`;
  const field = issue.field ?? 'lifecycle';
  switch (issue.code) {
    case 'task-detail-missing':
      if (field === 'description') {
        return (
          `❌ /kanban task ${action} needs a task description first. ` +
          `Add one via the \`kanban.update_task\` tool action (patch.description = "...").`
        );
      }
      if (field === 'assignee') {
        return (
          `❌ /kanban task ${action} needs an assignee. ` +
          `Run \`/kanban task assign <boardId> <taskId> <agent>\` first.`
        );
      }
      if (field === 'childTaskIds') {
        return (
          `❌ /kanban task ${action} is an atomic parent with no persisted children. ` +
          `Decompose it via the kanban tool (\`split_atomic\`) before moving it forward.`
        );
      }
      if (field === 'successCriteria') {
        return (
          `❌ /kanban task ${action} needs explicit acceptance criteria. ` +
          `Add at least one via \`/kanban task check add <boardId> <taskId> <description>\`.`
        );
      }
      if (field === 'actor' || field === 'comment') {
        return (
          `❌ /kanban task ${action} was rejected by the lifecycle guard with an internal ` +
          `audit requirement (${field}). This is a wrongstack-cli bug — please report it ` +
          `along with the exact command you ran.`
        );
      }
      break;
    case 'review-evidence-missing':
      if (action === 'done' && issue.field === 'verificationReport') {
        return (
          `❌ /kanban task done requires a passing verification report for atomic tasks. ` +
          `Run the kanban tool's \`verify_completion\` action \`<boardId> <taskId>\` first; ` +
          `only an atomic task whose verdict is "passed" can advance to Done.`
        );
      }
      if (action === 'done') {
        return (
          `❌ /kanban task done needs reviewer action text + an evidence attachment. ` +
          `Re-run with \`/kanban task done <boardId> <taskId> --attachment <url> --note <text>\`; ` +
          `the slash command forwards those flags to the transition.`
        );
      }
      if (issue.field === 'verificationReport') {
        return (
          `❌ /kanban task ${action} requires a passing verification report. ` +
          `Run the kanban tool's \`verify_completion\` action \`<boardId> <taskId>\` ` +
          `before retrying; only an atomic task with verdict 'passed' can advance.`
        );
      }
      return (
        `❌ /kanban task ${action} needs a persisted implementation result + evidence attachment. ` +
        `Run the kanban tool's \`verify_completion\` action \`<boardId> <taskId>\` before moving the card forward.`
      );
    case 'transition-skipped':
      return (
        `❌ /kanban task ${action} skipped a managed lifecycle stage. ` +
        `Cards on managed boards must move exactly one column at a time ` +
        `(Backlog → Todo → Running → Review → Done). Use the transition UI or the ` +
        `kanban tool's transition_task action instead of jumping columns.`
      );
    case 'parent-child-incomplete':
      return `❌ /kanban task ${action} blocked by incomplete children: ${issue.message}`;
    case 'stage-mismatch':
      return (
        `❌ /kanban task ${action} hit a stage mismatch. The card's column and its ` +
        `lifecycle.currentStage disagree. Run the kanban tool's ` +
        `\`repair_managed_task_projection\` action \`<boardId> <taskId>\` to reconcile.`
      );
    case 'managed-policy-invalid':
      return (
        `❌ /kanban task ${action} cannot run on this board: ${issue.message}. ` +
        `Managed lifecycle requires columns named exactly Backlog, Todo, In-Progress, Review, Done.`
      );
    case 'acceptance-criteria-incomplete':
      return `❌ /kanban task ${action} has unpassed acceptance criteria: ${issue.message}`;
  }
  return `❌ /kanban task ${action} rejected by lifecycle guard (${issue.code}, ${field}): ${issue.message}`;
}

export const LIFECYCLE_STAGE_ALIASES: Record<string, string> = {
  backlog: 'backlog',
  todo: 'todo',
  running: 'running',
  'in-progress': 'running',
  inprogress: 'running',
  review: 'review',
  done: 'done',
  completed: 'done',
};

export function resolveColumnReference(board: KanbanBoard, requested: string): string | null {
  const lower = requested.trim().toLowerCase();
  const exact = board.columns.find((column) => column.id === requested);
  if (exact) return exact.id;
  const caseInsensitive = board.columns.find((column) => column.id.toLowerCase() === lower);
  if (caseInsensitive) return caseInsensitive.id;
  if (board.lifecycle?.mode === 'managed') {
    const aliasStage = LIFECYCLE_STAGE_ALIASES[lower];
    if (aliasStage) {
      const mapped = board.lifecycle?.columns[aliasStage as keyof typeof board.lifecycle.columns] as
        | string
        | undefined;
      if (mapped) return mapped;
    }
  }
  return null;
}

interface TaskEvidenceFlags {
  attachment?: string | undefined;
  note?: string | undefined;
  tickChecks: { checkId: string; checkStatus: 'passed' | 'failed' | 'skipped' }[];
  positional: string[];
  warnings: string[];
}

export function parseTaskEvidenceFlags(tokens: readonly string[]): TaskEvidenceFlags {
  let attachment: string | undefined;
  let note: string | undefined;
  const tickChecks: { checkId: string; checkStatus: 'passed' | 'failed' | 'skipped' }[] = [];
  const positional: string[] = [];
  const warnings: string[] = [];
  const ATTACHMENT_KEYS = new Set(['--attachment', '--evidence', '--link']);
  const NOTE_KEYS = new Set(['--note', '--comment', '--action']);
  const TICK_CHECK_KEYS = new Set(['--tick-check', '--tick-checks']);
  const VALID_TICK_STATUSES = new Set(['passed', 'failed', 'skipped']);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const eq = token.indexOf('=');
    const inline =
      eq > 0 &&
      (ATTACHMENT_KEYS.has(token.slice(0, eq)) ||
        NOTE_KEYS.has(token.slice(0, eq)) ||
        TICK_CHECK_KEYS.has(token.slice(0, eq)));
    const key = inline ? token.slice(0, eq) : token;
    if (ATTACHMENT_KEYS.has(key)) {
      const value = inline ? token.slice(eq + 1) : tokens[i + 1];
      if (!value?.trim()) {
        warnings.push(`${key} expects a URL but none was provided`);
        i = inline ? i : i + 1;
        continue;
      }
      if (!inline && value.startsWith('-')) {
        warnings.push(`${key} expects a URL but none was provided`);
        i++;
        continue;
      }
      if (!inline) i++;
      attachment = value;
      continue;
    }
    if (TICK_CHECK_KEYS.has(key)) {
      const raw = inline ? token.slice(eq + 1) : tokens[i + 1];
      if (!raw?.trim()) {
        warnings.push(`${key} expects <checkId>=<status> but none was provided`);
        i = inline ? i : i + 1;
        continue;
      }
      if (!inline && raw.startsWith('-')) {
        warnings.push(`${key} expects <checkId>=<status> but none was provided`);
        i++;
        continue;
      }
      const sep = raw.lastIndexOf('=');
      const checkId = sep >= 0 ? raw.slice(0, sep).trim() : '';
      const status = sep >= 0 ? raw.slice(sep + 1).trim() : '';
      if (!checkId || !status || !VALID_TICK_STATUSES.has(status as 'passed' | 'failed' | 'skipped')) {
        warnings.push(
          `${key} expects <checkId>=<status> where status is passed|failed|skipped (got "${raw}")`,
        );
        i = inline ? i : i + 1;
        continue;
      }
      tickChecks.push({ checkId, checkStatus: status as 'passed' | 'failed' | 'skipped' });
      i = inline ? i : i + 1;
      continue;
    }
    if (NOTE_KEYS.has(key)) {
      const inlineValue = inline ? token.slice(eq + 1) : undefined;
      if (inlineValue !== undefined) {
        if (!inlineValue.trim()) {
          warnings.push(`${key} expects text but none was provided`);
        } else {
          note = inlineValue;
        }
        continue;
      }
      const collected: string[] = [];
      for (let j = i + 1; j < tokens.length; j++) {
        const next = tokens[j];
        if (next === undefined) break;
        if (next.startsWith('--') || next === '-') break;
        collected.push(next);
      }
      if (collected.length === 0) {
        warnings.push(`${key} expects text but none was provided`);
        continue;
      }
      i += collected.length;
      note = collected.join(' ');
      continue;
    }
    positional.push(token);
  }
  return { attachment, note, tickChecks, positional, warnings };
}
