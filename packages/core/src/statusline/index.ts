/**
 * Framework-free statusline chip contract.
 *
 * Single source of truth shared by the CLI persistence layer
 * (`packages/cli/src/services/statusline-config.ts`, which writes the
 * per-profile `statusline.json`) and the TUI renderer
 * (`packages/tui/src/components/statusline-picker.tsx` +
 * `status-line-registry.tsx`). Must stay free of React/Ink/Node imports so
 * both packages can depend on it.
 */

/** All possible statusline chip keys (canonical set).
 *
 *  Stale keys still present in a saved `statusline.json` (including
 *  long-removed phantoms like 'cpu', 'memory', 'time', 'sage') are silently
 *  ignored by downstream consumers; the canonical key set is exactly the
 *  union below. */
export type StatuslineItem =
  | 'state'
  | 'model'
  | 'tokens'
  | 'cache'
  | 'queue'
  | 'hint'
  | 'index'
  | 'breaker'
  | 'todos'
  | 'plan'
  | 'tasks'
  | 'fleet'
  | 'fleet_agents'
  | 'git'
  | 'elapsed'
  | 'context'
  | 'cost'
  | 'processes'
  | 'working_dir'
  | 'project'
  | 'yolo'
  | 'autonomy'
  | 'eternal_stage'
  | 'goal'
  | 'mode'
  | 'auto_proceed'
  | 'sessions'
  | 'tools'
  | 'theme'
  | 'token_saving'
  | 'brain'
  | 'mailbox'
  | 'enhance'
  | 'debug_stream'
  | 'next_steps'
  | 'memory_context'
  | 'side_effects'
  | 'version'
  | 'dropped_tools'
  | 'prompt_variant';

/** Physical status bar line a chip renders on (1-based, detailed mode). */
export type StatuslineLine = 1 | 2 | 3 | 4;

/**
 * Sparse per-chip line overrides (chip key → assigned line). Absent keys
 * fall back to `DEFAULT_LINES`. Values outside 1–4 are invalid and must be
 * clamped/dropped by the persistence layer before reaching the renderer.
 */
export type StatuslineLines = Partial<Record<StatuslineItem, StatuslineLine>>;

/**
 * Ordered list of statusline items — grouped by display line, then in
 * RENDER order within each line so consumers iterate the statusline
 * top-to-bottom, left-to-right. Within a line this order is also the
 * overflow drop order (later entries drop first).
 */
export const STATUSLINE_ITEMS: StatuslineItem[] = [
  // Line 1 — workspace & identity
  'project',
  'working_dir',
  'git',
  'model',
  'mode',
  'prompt_variant',
  'theme',
  'sessions',
  'tools',
  'version',
  // Line 2 — run state, safety & vitals
  'state',
  'yolo',
  'autonomy',
  'eternal_stage',
  'breaker',
  'context',
  'tokens',
  'cost',
  'cache',
  'queue',
  'processes',
  'elapsed',
  'token_saving',
  'side_effects',
  'hint',
  // Line 3 — active work & countdowns
  'goal',
  'todos',
  'plan',
  'tasks',
  'next_steps',
  'auto_proceed',
  'enhance',
  'dropped_tools',
  // Line 4 — fleet, connectivity & background services
  'fleet',
  'fleet_agents',
  'mailbox',
  'brain',
  'debug_stream',
  'memory_context',
  'index',
];

/**
 * Default status bar line per chip. MUST mirror the actual rail composition
 * in the TUI's rail builders — `statusline-navigation-order.test.ts` and the
 * `status-bar-rail-order` suite pin the rendered order, and the CLI's
 * `STATUSLINE_CONFIG_KEYS` must stay set-equal with `STATUSLINE_ITEMS`
 * (drift-guarded in `packages/cli/tests`).
 */
export const DEFAULT_LINES: Record<StatuslineItem, StatuslineLine> = {
  // Line 1 — workspace & identity: static session header (rarely changes).
  // theme/sessions/tools are the tail so overflow drops them first.
  project: 1,
  working_dir: 1,
  git: 1,
  model: 1,
  mode: 1,
  prompt_variant: 1,
  theme: 1,
  sessions: 1,
  tools: 1,
  version: 1,
  // Line 2 — run state, safety & vitals: breaker leads the dynamic block
  // (urgency), hint is last (ephemeral, first dropped on overflow).
  state: 2,
  yolo: 2,
  autonomy: 2,
  eternal_stage: 2,
  breaker: 2,
  context: 2,
  tokens: 2,
  cost: 2,
  cache: 2,
  queue: 2,
  processes: 2,
  elapsed: 2,
  token_saving: 2,
  side_effects: 2,
  hint: 2,
  // Line 3 — active work & countdowns (conditional)
  goal: 3,
  todos: 3,
  plan: 3,
  tasks: 3,
  next_steps: 3,
  auto_proceed: 3,
  enhance: 3,
  dropped_tools: 3,
  // Line 4 — fleet, connectivity & background services (conditional)
  fleet: 4,
  fleet_agents: 4,
  mailbox: 4,
  brain: 4,
  debug_stream: 4,
  memory_context: 4,
  index: 4,
};

/** Total number of statusline chips in the contract. */
export const STATUSLINE_FIELD_COUNT = STATUSLINE_ITEMS.length;
