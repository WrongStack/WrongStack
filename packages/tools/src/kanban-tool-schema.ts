import type { JSONSchema } from '@wrongstack/contracts/types';

export const KANBAN_TOOL_DESCRIPTION =
  'Durable project task boards: create and move cards, record checks, notes, links and assignments. The board is a record of the work, not a permit for it — nothing here gates other tools. Managed boards additionally enforce ordered Backlog → Todo → Running → Review → Done transitions; release_managed_lifecycle turns that off.';

export const KANBAN_TOOL_USAGE_HINT =
  'Track substantial or multi-step work so it survives the session; a trivial edit or a question needs no card. Work stays on ONE board: call list_boards first and add_task to the board this project already uses. create_board is for a genuinely separate line of work, not for each new piece of it — a second board splits the same effort in two, and a board holding a single card is the usual sign. Common flow: list_boards or search_tasks to orient, add_task to record work, start_task when you begin, update_check with checkStatus "passed" to tick acceptance criteria (read their ids from get_task), then transition_task. On a managed board a refused transition names the field it wants — supply it and retry. When the acceptance criterion is something a machine can run, say so: set checkType ("command", "test", "file_exists", "file_matches", "git_diff", "metric") and put the command, pattern or path in checkNotes, then verify_completion executes it and the result is real evidence. Leave checkType off (or "manual") only for criteria that genuinely need a human eye — a manual check records your assertion, it does not test anything. Goal metrics pass when current >= target by default; when lower is better (error rate, cost ceiling, latency, open-bug count), pass metricDirection "at_most" with add_goal_metric / update_goal_metric so verification compares current <= target instead.';

export const KANBAN_INPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
        'list_boards',
        'get_board',
        'create_board',
        'duplicate_board',
        'update_board',
        'adopt_managed_lifecycle',
        'release_managed_lifecycle',
        'delete_board',
        'generate_board',
        'export_markdown',
        'export_task_graph',
        'sync_task_graph',
        'create_from_graph',
        'import_session_tasks',
        'search_tasks',
        'ready_tasks',
        'snapshot',
        'workbench',
        'stats',
        'add_task',
        'split_task',
        'merge_tasks',
        'copy_task',
        'transfer_task',
        'get_task',
        'start_task',
        'update_task',
        'transition_task',
        'repair_managed_projection',
        'move_task',
        'delete_task',
        'set_chain',
        'get_chain',
        'claim_task',
        'release_task',
        'assign_task',
        'mark_assignment',
        'heartbeat_assignment',
        'recover_stale',
        'events',
        'board_history',
        'record_activity',
        'queue_health',
        'add_dependency',
        'add_goal_metric',
        'update_goal_metric',
        'add_check',
        'update_check',
        'remove_check',
        'add_note',
        'review_task',
        'add_link',
        'verify_completion',
        'split_atomic',
        'assess_atomicity',
        'propose_decomposition',
        'approve_decomposition',
        'reject_decomposition',
        'get_contract_graph',
        'configure_contract_graph',
        'upsert_contract_node',
        'remove_contract_node',
        'add_contract_edge',
        'remove_contract_edge',
      ],
    },
    boardId: { type: 'string' },
    taskId: { type: 'string' },
    reviewDisposition: {
      type: 'string',
      enum: ['adequate', 'enriched', 'needs_leader'],
      description:
        'review_task: record the background manager assessment after inspecting this card; note supplies the reason. Does not complete product work.',
    },
    taskIds: { type: 'array', items: { type: 'string' } },
    chainId: { type: 'string' },
    columnId: { type: 'string' },
    targetBoardId: { type: 'string' },
    targetColumnId: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    dueDate: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    labels: { type: 'array', items: { type: 'string' } },
    label: {
      type: 'string',
      description:
        'search_tasks / ready_tasks / snapshot: filter by a single label (takes precedence over labels[0]).',
    },
    priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    taskType: {
      type: 'string',
      enum: ['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore'],
    },
    status: {
      type: 'string',
      enum: [
        'pending',
        'ready',
        'in_progress',
        'blocked',
        'review',
        'completed',
        'failed',
        'archived',
      ],
    },
    order: { type: 'number' },
    query: { type: 'string' },
    limit: {
      type: 'number',
      description:
        'ready_tasks: max results. workbench: per-lane and alert limit. events: return only the most recent N events. list_boards / search_tasks: return only the N most recently updated (omit for all).',
    },
    agentId: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    fallbackProfile: { type: 'string' },
    fallbackModels: { type: 'array', items: { type: 'string' } },
    tools: { type: 'array', items: { type: 'string' } },
    allowedCapabilities: { type: 'array', items: { type: 'string' } },
    leaseId: { type: 'string' },
    claimedAt: { type: 'string' },
    heartbeatAt: { type: 'string' },
    leaseExpiresAt: { type: 'string' },
    attempt: { type: 'number' },
    maxAttempts: { type: 'number' },
    subagentId: { type: 'string' },
    runTaskId: { type: 'string' },
    lastResult: { type: 'string' },
    error: { type: 'string' },
    expectedLeaseId: { type: 'string' },
    assignmentStatus: {
      type: 'string',
      enum: ['assigned', 'queued', 'running', 'completed', 'failed', 'cancelled'],
    },
    lifecycleStage: {
      type: 'string',
      enum: ['backlog', 'todo', 'running', 'review', 'done'],
    },
    transitionAction: { type: 'string' },
    transitionComment: { type: 'string' },
    tickChecks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          checkId: { type: 'string' },
          checkStatus: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
        },
        required: ['checkId', 'checkStatus'],
      },
      description:
        '`transition_task` with lifecycleStage "done" only (rejected for any other stage): flip one or more manual criteria before the gate fires. Read ids from kanban get_task. Non-manual criteria are refused.',
    },
    attachmentUrl: { type: 'string' },
    attachmentTitle: { type: 'string' },
    attachmentType: {
      type: 'string',
      enum: ['issue', 'pr', 'doc', 'commit', 'design', 'file', 'url', 'other'],
    },
    releaseStatus: { type: 'string', enum: ['pending', 'ready', 'blocked'] },
    releaseReason: { type: 'string' },
    clearAssignee: { type: 'boolean' },
    recoveryMode: { type: 'string', enum: ['auto', 'release', 'retry', 'fail'] },
    recoveryNow: { type: 'string' },
    recoveryPolicyFailOnCostCeiling: { type: 'boolean' },
    recoveryPolicyReleaseOnFailureKinds: { type: 'array', items: { type: 'string' } },
    recoveryPolicyReleaseOnHeartbeatDue: { type: 'boolean' },
    recoveryPolicyRetryPolicyOverride: {
      type: 'string',
      enum: ['off', 'incremental', 'exponential'],
    },
    assignee: { type: 'string' },
    costCeilingUsd: { type: 'number' },
    retryPolicy: { type: 'string', enum: ['off', 'incremental', 'exponential'] },
    lastFailureKind: { type: 'string' },
    dependsOn: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Task ids this card waits on. On update_task an explicit empty array clears them — use it when a dependency was recorded in error rather than completing work nobody wants.',
    },
    atomic: {
      type: 'boolean',
      description:
        'Composite parent (true) or executable leaf (false). Set false to make a stranded parent a leaf again after its children were dropped.',
    },
    childTaskIds: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Children of a composite parent. On update_task an explicit empty array detaches them all.',
    },
    estimatedHours: { type: 'number' },
    actualHours: { type: 'number' },
    taskGraph: { type: 'object' },
    graphId: { type: 'string' },
    specId: { type: 'string' },
    specRequirementId: { type: 'string' },
    sourceSystem: { type: 'string' },
    phaseId: { type: 'string' },
    preserveOriginTaskIds: { type: 'boolean' },
    includeArchived: {
      type: 'boolean',
      description:
        'export_task_graph: include archived cards. list_boards: false hides archived boards.',
    },
    archiveMissingTasks: { type: 'boolean' },
    preserveManualDependencies: { type: 'boolean' },
    dependencyTaskId: { type: 'string' },
    enforceDependencies: { type: 'boolean' },
    childTitles: { type: 'array', items: { type: 'string' } },
    inheritAssignment: { type: 'boolean' },
    inheritLabels: { type: 'boolean' },
    inheritSuccessCriteria: { type: 'boolean' },
    inheritGoalMetrics: { type: 'boolean' },
    inheritDependencies: { type: 'boolean' },
    chainChildren: { type: 'boolean' },
    rewireDependents: { type: 'boolean' },
    closeSourceTasks: { type: 'boolean' },
    metricId: { type: 'string' },
    metricName: { type: 'string' },
    metricTarget: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    metricCurrent: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    metricDirection: { type: 'string', enum: ['at_least', 'at_most'] },
    metricUnit: { type: 'string' },
    metricStatus: { type: 'string', enum: ['pending', 'met', 'missed', 'waived'] },
    metricNotes: { type: 'string' },
    checkId: { type: 'string' },
    checkDescription: { type: 'string' },
    checkStatus: { type: 'string', enum: ['pending', 'passed', 'failed', 'skipped'] },
    checkType: {
      type: 'string',
      // Only types a verifier can actually execute. `manual` is the default and
      // means a human or agent asserts the status by hand. The rest are run by
      // `verify_completion` against the default deterministic registry. Types
      // with no plugin in that registry (`auto`, `review`, `agent`, `council`)
      // are deliberately omitted: offering them would produce criteria that
      // silently report `skipped — no verifier plugin registered`.
      enum: ['manual', 'command', 'test', 'file_exists', 'file_matches', 'git_diff', 'metric'],
      description:
        'How this acceptance criterion is verified. Default "manual" (status set by hand). Any other value makes verify_completion execute it, so the criterion becomes real evidence rather than a self-assertion. Pair with checkNotes.',
    },
    checkNotes: {
      type: 'string',
      description:
        'The executable body for a non-manual checkType, read in preference to checkDescription. command/test: the shell command or test pattern. file_exists: the path. file_matches: JSON {"file","pattern","flags"}. git_diff: JSON {"expectedFiles","minChanges","maxChanges"}.',
    },
    // ── Contract map ───────────────────────────────────────────────────
    // The card contract: what this work targets, what it must not break, what
    // it risks, and what verifies it. Advisory by default — the readiness gate
    // deliberately does not require map structure, so a map is an operator
    // review aid, not work the model must complete before implementing.
    contractEnforcement: {
      type: 'string',
      enum: ['off', 'advisory', 'strict'],
      description: 'Board-level contract map enforcement. Default when first configured: advisory.',
    },
    contractNodeId: { type: 'string' },
    contractNodeKind: {
      type: 'string',
      enum: ['objective', 'guardrail', 'risk', 'component', 'artifact', 'verification'],
      description:
        'objective = what this card is for; guardrail = what must keep working; risk = what could go wrong; component/artifact = what it touches; verification = what settles it.',
    },
    contractNodeTitle: { type: 'string' },
    contractNodeDescription: { type: 'string' },
    contractNodeState: {
      type: 'string',
      enum: ['unknown', 'active', 'satisfied', 'violated', 'waived', 'resolved'],
    },
    contractNodeEnforcement: {
      type: 'string',
      enum: ['blocking', 'advisory', 'informational'],
    },
    /** Bind a node to an acceptance criterion or goal metric already on the task. */
    contractCheckId: { type: 'string' },
    contractMetricId: { type: 'string' },
    contractWaiverReason: {
      type: 'string',
      description: 'Required, with an actor, when contractNodeState is "waived".',
    },
    contractEdgeId: { type: 'string' },
    contractEdgeFrom: {
      type: 'string',
      description: 'A contract node id, or a task id (bare or "task:<id>") for the card endpoint.',
    },
    contractEdgeTo: { type: 'string' },
    contractEdgeType: {
      type: 'string',
      enum: [
        'targets',
        'affects',
        'must_preserve',
        'exposes',
        'verified_by',
        'conflicts_with',
        'derived_from',
        'relates_to',
      ],
    },
    contractEdgeRationale: { type: 'string' },
    note: { type: 'string' },
    activityKind: {
      type: 'string',
      description:
        'record_activity: what happened. The summary goes in `note`; `activityDetails` carries any longer body.',
      enum: ['decision', 'attempt', 'result', 'blocker', 'observation'],
    },
    activityOutcome: {
      type: 'string',
      enum: ['succeeded', 'failed', 'partial', 'skipped', 'unknown'],
    },
    activityDetails: { type: 'string' },
    author: { type: 'string' },
    url: { type: 'string' },
    linkTitle: { type: 'string' },
    linkType: {
      type: 'string',
      enum: ['issue', 'pr', 'doc', 'commit', 'design', 'file', 'url', 'other'],
    },
    context: { type: 'string' },
    columns: { type: 'array', items: { type: 'string' } },
    generatedBy: { type: 'string' },
    includeTasks: { type: 'boolean' },
    includeCompletedTasks: { type: 'boolean' },
    preserveAssignment: { type: 'boolean' },
    preserveDependencies: { type: 'boolean' },
    atomicityMode: { type: 'string', enum: ['off', 'assess', 'enforce'] },
    atomicityDecomposition: { type: 'string', enum: ['auto', 'propose'] },
    gateEnforcement: {
      type: 'string',
      // WS-023: `'off'` is deliberately absent. The agent whose work this gate
      // checks must not be able to switch it off; it may only tighten. Turning
      // a gate off stays a human decision, made through board config.
      enum: ['strict', 'soft'],
    },
    proposalId: {
      type: 'string',
      description:
        'approve_decomposition / reject_decomposition: the proposal id reported by propose_decomposition.',
    },
    subtasks: {
      type: 'array',
      minItems: 2,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          successCriteria: { type: 'array', items: { type: 'string' } },
          dependsOnIndex: { type: 'array', items: { type: 'number' } },
        },
        required: ['title'],
      },
    },
  },
  required: ['action'],
};

// `kanban` intentionally has a wide, action-discriminated input surface. A
// flat schema keeps calls backward-compatible, but unnamed fields made lazy
// discovery and generated tool details nearly unusable. Keep the individual
// action handlers authoritative while guaranteeing that every exposed field
// tells the model what it is for.
const KANBAN_FIELD_DESCRIPTIONS: Readonly<Record<string, string>> = {
  action: 'Operation to perform. Choose an action first; supply only the fields that action needs.',
  boardId: 'Target board identifier, returned by list_boards or create_board.',
  taskId: 'Target card identifier, returned by add_task, get_board, or search_tasks.',
  taskIds: 'Card identifiers for a bulk, merge, chain, or transfer action.',
  title: 'Human-readable board or card title.',
  description: 'Detailed board or card scope, expected outcome, or implementation context.',
  query: 'Text query used by search_tasks or a generation/decomposition action.',
  status: 'Card status to set or filter by for the selected action.',
  priority: 'Card priority used when creating or updating work.',
  assignee: 'Agent or person assigned to own this card.',
  dependsOn: 'Card ids that must complete before this card can start.',
  note: 'Human-readable rationale, progress note, review evidence, or activity summary.',
  checkDescription: 'Acceptance criterion to add or update on the card.',
  checkStatus: 'Current outcome of an acceptance criterion.',
  attachmentUrl: 'URL or project reference attached to the card.',
  attachmentTitle: 'Human-readable title for the attached reference.',
  author: 'Actor recording the note, activity, check, or review.',
  agentId: 'Stable agent identifier for an assignment, lease, or activity.',
  leaseId: 'Lease token returned by claim_task; required by lease-protected updates.',
  expectedLeaseId:
    'Fence token expected by a mutation; prevents a stale worker from overwriting newer work.',
  limit: 'Bound the number of returned records for this read-oriented action.',
  tags: 'Free-form tags applied to a card or used to filter a result.',
  labels: 'Labels applied to a card or used to filter results.',
  dueDate: 'Optional due date recorded on the card.',
  columns: 'Board column names for create_board or update_board.',
  subtasks: 'Proposed child work for decomposition; each item must have a title.',
  childTitles: 'Titles used by split_task to create child cards.',
  checkId: 'Acceptance-criterion identifier returned by get_task.',
  metricId: 'Goal-metric identifier returned by get_task.',
  metricName: 'Display name for a new goal metric.',
  metricTarget: 'Desired goal-metric value.',
  metricCurrent: 'Observed goal-metric value used for verification.',
  proposalId: 'Decomposition proposal identifier returned by propose_decomposition.',
  sourceSystem: 'External system that produced an imported task graph.',
  taskGraph: 'Structured task graph to import, synchronize, or materialize.',
};

function humanizeKanbanField(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .toLowerCase();
}

function describeKanbanField(name: string): string {
  const explicit = KANBAN_FIELD_DESCRIPTIONS[name];
  if (explicit) return explicit;
  if (name.endsWith('Id')) {
    return `Identifier for the ${humanizeKanbanField(name.slice(0, -2))} used by the selected action.`;
  }
  if (name.startsWith('include') || name.startsWith('preserve') || name.startsWith('inherit')) {
    return `Whether the selected action should ${humanizeKanbanField(name)}.`;
  }
  return `Optional ${humanizeKanbanField(name)} value for the selected Kanban action. Supply it only when that action requires it.`;
}

function annotateKanbanProperties(schema: JSONSchema): void {
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    property.description ??= describeKanbanField(name);
    annotateKanbanProperties(property);
    if (property.items && typeof property.items === 'object')
      annotateKanbanProperties(property.items);
  }
  for (const variant of [
    ...(schema.oneOf ?? []),
    ...(schema.anyOf ?? []),
    ...(schema.allOf ?? []),
  ]) {
    annotateKanbanProperties(variant);
  }
}

annotateKanbanProperties(KANBAN_INPUT_SCHEMA);
