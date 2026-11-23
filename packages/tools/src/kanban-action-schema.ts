import type { JSONSchema } from '@wrongstack/contracts/types';
import { KANBAN_INPUT_SCHEMA } from './kanban-tool-schema.js';
import {
  KANBAN_READ_ONLY_ACTIONS,
  type KanbanAction,
  type KanbanToolInput,
} from './kanban-tool-types.js';

type Field = Exclude<keyof KanbanToolInput, 'action'>;

function fields(required: readonly Field[], optional: readonly Field[] = []) {
  return { required, optional };
}

const BOARD = ['boardId'] as const;
const CARD = ['boardId', 'taskId'] as const;
const ACTOR = ['author', 'transitionComment'] as const;
const LEASE = [
  'leaseId',
  'claimedAt',
  'heartbeatAt',
  'leaseExpiresAt',
  'attempt',
  'maxAttempts',
] as const;
const ASSIGNMENT = [
  'agentId',
  'name',
  'role',
  'provider',
  'model',
  'fallbackProfile',
  'fallbackModels',
  'tools',
  'allowedCapabilities',
  'assignee',
  ...LEASE,
  'costCeilingUsd',
  'retryPolicy',
  'lastFailureKind',
] as const;
const TASK_PATCH = [
  'title',
  'description',
  'dueDate',
  'columnId',
  'order',
  'priority',
  'taskType',
  'status',
  'labels',
  'agentId',
  'dependsOn',
  'dependencyTaskId',
  'atomic',
  'childTaskIds',
  'estimatedHours',
  'actualHours',
] as const;
const SPLIT = [
  'targetColumnId',
  'inheritAssignment',
  'inheritLabels',
  'inheritSuccessCriteria',
  'inheritGoalMetrics',
  'inheritDependencies',
  'chainChildren',
  'rewireDependents',
] as const;
const COPY = ['targetColumnId', 'order', 'preserveAssignment', 'preserveDependencies'] as const;
const BOARD_EDIT = [
  'description',
  'tags',
  'atomicityMode',
  'atomicityDecomposition',
  'gateEnforcement',
] as const;
const GRAPH_IMPORT = [
  'title',
  'description',
  'tags',
  'generatedBy',
  'sourceSystem',
  'phaseId',
  'includeCompletedTasks',
] as const;
const SEARCH = ['query', 'boardId', 'agentId', 'priority', 'label', 'labels', 'chainId'] as const;
const METRIC = [
  'metricTarget',
  'metricCurrent',
  'metricDirection',
  'metricUnit',
  'metricStatus',
  'metricNotes',
] as const;

// Only field membership lives here. Definitions are reused from the public schema
// and the existing handlers still validate and authorize the actual operation.
const ACTION_FIELDS = {
  list_boards: fields([], ['includeArchived', 'limit']),
  get_board: fields(BOARD),
  create_board: fields(['title'], [...BOARD_EDIT, 'generatedBy']),
  duplicate_board: fields(BOARD, [
    'title',
    'generatedBy',
    'includeTasks',
    'includeCompletedTasks',
    'preserveAssignment',
  ]),
  update_board: fields(BOARD, ['title', ...BOARD_EDIT]),
  adopt_managed_lifecycle: fields([...BOARD, ...ACTOR, 'columns']),
  release_managed_lifecycle: fields(BOARD),
  delete_board: fields(BOARD),
  generate_board: fields(['description'], ['title', 'context']),
  export_markdown: fields(BOARD),
  export_task_graph: fields(BOARD, [
    'graphId',
    'specId',
    'title',
    'preserveOriginTaskIds',
    'includeArchived',
  ]),
  sync_task_graph: fields(
    [...BOARD, 'taskGraph'],
    [...GRAPH_IMPORT, 'archiveMissingTasks', 'preserveManualDependencies'],
  ),
  create_from_graph: fields(['taskGraph'], GRAPH_IMPORT),
  import_session_tasks: fields([]),
  search_tasks: fields([], [...SEARCH, 'status', 'limit']),
  ready_tasks: fields([], [...SEARCH, 'limit']),
  snapshot: fields([], [...SEARCH, 'status']),
  workbench: fields([], ['limit']),
  stats: fields([], BOARD),
  add_task: fields(
    [...BOARD, 'title'],
    [
      ...TASK_PATCH,
      ...ASSIGNMENT,
      'assignmentStatus',
      'childTitles',
      'checkDescription',
      'checkType',
      'checkStatus',
      'checkNotes',
      'metricName',
      ...METRIC,
      'url',
      'linkType',
      'linkTitle',
      'note',
      'author',
      'graphId',
      'specId',
      'specRequirementId',
      'sourceSystem',
      'phaseId',
    ],
  ),
  split_task: fields([...CARD, 'childTitles'], SPLIT),
  merge_tasks: fields(
    [...BOARD, 'taskIds', 'title'],
    ['description', 'targetColumnId', 'preserveAssignment', 'closeSourceTasks'],
  ),
  copy_task: fields([...CARD, 'targetBoardId'], COPY),
  transfer_task: fields([...CARD, 'targetBoardId'], COPY),
  get_task: fields(CARD),
  start_task: fields([...CARD, ...ACTOR], ['agentId', ...LEASE]),
  update_task: fields(CARD, TASK_PATCH),
  transition_task: fields(
    [...CARD, ...ACTOR, 'lifecycleStage'],
    [
      ...TASK_PATCH,
      'tickChecks',
      'transitionAction',
      'attachmentUrl',
      'attachmentType',
      'attachmentTitle',
    ],
  ),
  repair_managed_projection: fields([...CARD, ...ACTOR]),
  move_task: fields([...CARD, 'targetColumnId'], ['order']),
  delete_task: fields(CARD),
  set_chain: fields([...BOARD, 'taskIds'], ['chainId', 'enforceDependencies']),
  get_chain: fields(BOARD, ['taskId', 'chainId']),
  claim_task: fields([], [...CARD, ...ASSIGNMENT, 'assignmentStatus']),
  release_task: fields(CARD, ['releaseStatus', 'releaseReason', 'clearAssignee']),
  assign_task: fields(CARD, ASSIGNMENT),
  mark_assignment: fields(CARD, [
    'assignmentStatus',
    'status',
    'error',
    'subagentId',
    'runTaskId',
    'lastResult',
    'agentId',
    ...LEASE,
    'expectedLeaseId',
  ]),
  heartbeat_assignment: fields(CARD, ['heartbeatAt', 'leaseExpiresAt', 'expectedLeaseId']),
  recover_stale: fields(BOARD, [
    'recoveryMode',
    'recoveryNow',
    'releaseReason',
    'clearAssignee',
    'recoveryPolicyFailOnCostCeiling',
    'recoveryPolicyReleaseOnFailureKinds',
    'recoveryPolicyReleaseOnHeartbeatDue',
    'recoveryPolicyRetryPolicyOverride',
  ]),
  events: fields(BOARD, ['taskId', 'limit']),
  board_history: fields([], ['boardId', 'limit']),
  record_activity: fields(
    [...CARD, 'activityKind', 'note'],
    ['activityOutcome', 'activityDetails'],
  ),
  queue_health: fields([], BOARD),
  add_dependency: fields([...CARD, 'dependencyTaskId']),
  add_goal_metric: fields([...CARD, 'metricName'], METRIC),
  update_goal_metric: fields([...CARD, 'metricId'], ['metricName', ...METRIC]),
  add_check: fields([...CARD, 'checkDescription'], ['checkType', 'checkStatus', 'checkNotes']),
  update_check: fields(
    [...CARD, 'checkId'],
    ['checkDescription', 'checkType', 'checkStatus', 'checkNotes'],
  ),
  remove_check: fields([...CARD, 'checkId']),
  add_note: fields([...CARD, 'note'], ['author']),
  review_task: fields([...CARD, 'reviewDisposition', 'note']),
  add_link: fields([...CARD, 'url'], ['linkType', 'linkTitle']),
  verify_completion: fields(CARD),
  split_atomic: fields([...CARD, 'childTitles'], SPLIT),
  assess_atomicity: fields(CARD),
  propose_decomposition: fields([...CARD, 'subtasks'], ['note']),
  approve_decomposition: fields([...CARD, 'proposalId'], ['subtasks', 'note']),
  reject_decomposition: fields([...CARD, 'proposalId'], ['note']),
  get_contract_graph: fields(BOARD, ['taskId']),
  configure_contract_graph: fields(BOARD, ['contractEnforcement', 'author', 'agentId']),
  upsert_contract_node: fields(
    [...CARD, 'contractNodeKind', 'contractNodeTitle'],
    [
      'contractNodeState',
      'contractWaiverReason',
      'contractNodeId',
      'contractNodeDescription',
      'contractNodeEnforcement',
      'contractCheckId',
      'contractMetricId',
      'author',
      'agentId',
    ],
  ),
  remove_contract_node: fields([...BOARD, 'contractNodeId'], ['author', 'agentId']),
  add_contract_edge: fields(
    [...BOARD, 'contractEdgeFrom', 'contractEdgeTo', 'contractEdgeType'],
    ['contractEdgeId', 'contractNodeEnforcement', 'contractEdgeRationale', 'author', 'agentId'],
  ),
  remove_contract_edge: fields([...BOARD, 'contractEdgeId'], ['author', 'agentId']),
} satisfies Record<KanbanAction, ReturnType<typeof fields>>;

const readOnly = new Set<KanbanAction>(KANBAN_READ_ONLY_ACTIONS);
export const KANBAN_ACTIONS = Object.keys(ACTION_FIELDS);

export function kanbanActionSchema(action: string): JSONSchema | undefined {
  if (!Object.hasOwn(ACTION_FIELDS, action)) return undefined;
  const name = action as KanbanAction;
  const { required, optional } = ACTION_FIELDS[name];
  const canonical = KANBAN_INPUT_SCHEMA.properties ?? {};
  const properties: Record<string, JSONSchema> = {
    action: { ...canonical['action'], enum: [name] },
  };
  for (const field of [...required, ...optional, ...(readOnly.has(name) ? [] : ['runTaskId'])]) {
    const definition = canonical[field];
    if (!definition)
      throw new Error(`Kanban schema for ${action} references an unknown field ${field}`);
    properties[field] = definition;
  }
  return {
    type: 'object',
    properties,
    required: ['action', ...required],
    ...(name === 'get_chain'
      ? { anyOf: [{ required: ['taskId'] }, { required: ['chainId'] }] }
      : {}),
  };
}
