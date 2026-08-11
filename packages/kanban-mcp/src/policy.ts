export const KANBAN_READ_ACTIONS = [
  'list_boards',
  'get_board',
  'export_markdown',
  'export_task_graph',
  'search_tasks',
  'ready_tasks',
  'snapshot',
  'workbench',
  'get_task',
  'get_chain',
  'events',
  'queue_health',
  'get_contract_graph',
] as const;

export const KANBAN_MANAGE_ACTIONS = [
  'create_board',
  'duplicate_board',
  'update_board',
  'adopt_managed_lifecycle',
  'release_managed_lifecycle',
  'generate_board',
  'sync_task_graph',
  'create_from_graph',
  'import_session_tasks',
  'add_column',
  'update_column',
  'add_task',
  'split_task',
  'copy_task',
  'start_task',
  'update_task',
  'transition_task',
  'repair_managed_projection',
  'move_task',
  'set_chain',
  'claim_task',
  'release_task',
  'assign_task',
  'mark_assignment',
  'heartbeat_assignment',
  'recover_stale',
  'add_dependency',
  'add_goal_metric',
  'update_goal_metric',
  'add_check',
  'update_check',
  'remove_check',
  'add_note',
  'add_link',
  'verify_completion',
  'split_atomic',
  'assess_atomicity',
  'propose_decomposition',
  // Contract-map editing, removals included. The map is advisory metadata
  // about a card rather than the card itself, and the same tier that can add
  // a node should be able to take it back — requiring `--destructive` to undo
  // an annotation you just made would be the wrong shape. Task and board
  // deletion stay destructive.
  'configure_contract_graph',
  'upsert_contract_node',
  'remove_contract_node',
  'add_contract_edge',
  'remove_contract_edge',
] as const;

/** Operations that remove or absorb durable task/board state. */
export const KANBAN_DESTRUCTIVE_ACTIONS = [
  'delete_board',
  'delete_column',
  'delete_task',
  'merge_tasks',
  'transfer_task',
] as const;

export type KanbanReadAction = (typeof KANBAN_READ_ACTIONS)[number];
export type KanbanManageAction = (typeof KANBAN_MANAGE_ACTIONS)[number];
export type KanbanDestructiveAction = (typeof KANBAN_DESTRUCTIVE_ACTIONS)[number];
export type KanbanMcpAction = KanbanReadAction | KanbanManageAction | KanbanDestructiveAction;
export type KanbanMcpToolName =
  | 'kanban_read'
  | 'kanban_manage'
  | 'kanban_destructive'
  | 'kanban_watch';

export interface KanbanMcpPolicyOptions {
  writable?: boolean;
  destructive?: boolean;
}

export interface KanbanMcpToolPolicy {
  name: KanbanMcpToolName;
  actions?: readonly KanbanMcpAction[];
}

export function selectKanbanMcpTools(opts: KanbanMcpPolicyOptions = {}): KanbanMcpToolPolicy[] {
  const tools: KanbanMcpToolPolicy[] = [
    { name: 'kanban_read', actions: KANBAN_READ_ACTIONS },
    { name: 'kanban_watch' },
  ];
  if (opts.writable === true || opts.destructive === true) {
    tools.push({ name: 'kanban_manage', actions: KANBAN_MANAGE_ACTIONS });
  }
  if (opts.destructive === true) {
    tools.push({ name: 'kanban_destructive', actions: KANBAN_DESTRUCTIVE_ACTIONS });
  }
  return tools;
}
