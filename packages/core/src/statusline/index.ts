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
 * How much of a chip's payload renders.
 *
 * `auto` (the default) lets the rail fitter pick the widest form that still
 * fits the terminal — it degrades `full → short → micro` chip-by-chip,
 * widest-first, and only drops a chip once every chip on the rail is already
 * at `micro`. An explicit level pins that form regardless of available width.
 */
export type StatuslineDensity = 'auto' | 'full' | 'short' | 'micro';

/** The pinnable density levels, widest → narrowest (`auto` excluded). */
export const STATUSLINE_DENSITY_LEVELS = ['full', 'short', 'micro'] as const;

/** Cycle order used by the picker's density control. */
export const STATUSLINE_DENSITY_CYCLE: StatuslineDensity[] = ['auto', 'full', 'short', 'micro'];

/**
 * Sparse per-chip line overrides (chip key → assigned line). Absent keys
 * fall back to `DEFAULT_LINES`. Values outside 1–4 are invalid and must be
 * clamped/dropped by the persistence layer before reaching the renderer.
 */
export type StatuslineLines = Partial<Record<StatuslineItem, StatuslineLine>>;

/**
 * Sparse per-chip density overrides. Absent keys (and explicit `auto`) leave
 * the chip to the rail fitter.
 */
export type StatuslineDensities = Partial<Record<StatuslineItem, StatuslineDensity>>;

/**
 * Ordered list of statusline items — grouped by display line, then in
 * RENDER order within each line so consumers iterate the statusline
 * top-to-bottom, left-to-right. Within a line this order is also the
 * overflow drop order (later entries drop first).
 */
export const STATUSLINE_ITEMS: StatuslineItem[] = [
  // Line 1 — IDENTITY: who/where (static for the whole session)
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
  // Line 2 — VITALS: what this turn is costing (changes every token)
  'state',
  'context',
  'tokens',
  'cost',
  'cache',
  'elapsed',
  'queue',
  'hint',
  'index',
  // Line 3 — SAFETY & WORK: standing posture + the work in flight
  'yolo',
  'autonomy',
  'eternal_stage',
  'breaker',
  'token_saving',
  'processes',
  'side_effects',
  'dropped_tools',
  'goal',
  'todos',
  'plan',
  'tasks',
  // Line 4 — ASYNC: things running beside the turn, and countdowns
  'fleet',
  'fleet_agents',
  'mailbox',
  'brain',
  'debug_stream',
  'memory_context',
  'next_steps',
  'auto_proceed',
  'enhance',
];

/**
 * Default status bar line per chip, assigned by VOLATILITY rather than by
 * topic: a reader's eye learns where to look because each line changes at a
 * predictable rate.
 *
 *  L1 IDENTITY — fixed for the session. Never redraws mid-turn.
 *  L2 VITALS   — redraws every token: run state and the cost of this turn.
 *  L3 SAFETY & WORK — changes a few times per turn: standing posture
 *      (yolo/autonomy/breaker/token_saving) plus the work in flight.
 *  L4 ASYNC    — background fleets, peers, services, and second-by-second
 *      countdowns; opens and closes with the activity it reports.
 *
 * MUST mirror the actual rail composition in the TUI's rail builders —
 * `statusline-navigation-order.test.ts` and the `status-bar-rail-order`
 * suite pin the rendered order, and the CLI's `STATUSLINE_CONFIG_KEYS` must
 * stay set-equal with `STATUSLINE_ITEMS` (drift-guarded in
 * `packages/cli/tests`).
 */
export const DEFAULT_LINES: Record<StatuslineItem, StatuslineLine> = {
  // L1 — IDENTITY. theme/sessions/tools are the tail so overflow sheds
  // them before project/git/model.
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
  // L2 — VITALS. `hint` is ephemeral and deliberately lives here, last, so
  // it is the first casualty of overflow: parking it on a conditional rail
  // would make that whole rail strobe in and out during a single turn.
  // `index` is right-anchored beside the telemetry it belongs to.
  state: 2,
  context: 2,
  tokens: 2,
  cost: 2,
  cache: 2,
  elapsed: 2,
  queue: 2,
  hint: 2,
  index: 2,
  // L3 — SAFETY & WORK. Posture leads (a reader scans left for "is this
  // session dangerous?"), the work boards follow.
  yolo: 3,
  autonomy: 3,
  eternal_stage: 3,
  breaker: 3,
  token_saving: 3,
  processes: 3,
  side_effects: 3,
  dropped_tools: 3,
  goal: 3,
  todos: 3,
  plan: 3,
  tasks: 3,
  // L4 — ASYNC: fleet/peers/services plus the countdowns, all of which
  // arrive and leave on their own schedule.
  fleet: 4,
  fleet_agents: 4,
  mailbox: 4,
  brain: 4,
  debug_stream: 4,
  memory_context: 4,
  next_steps: 4,
  auto_proceed: 4,
  enhance: 4,
};

/**
 * Chips that start OUT of a fresh statusline. Every one is static trivia
 * recoverable elsewhere (`/theme`, `/sessions`, `/tools`, the title bar) and
 * each costs 10–30 permanent columns on the identity rail. Only a brand-new
 * `statusline.json` picks these up — an existing file's explicit chip map
 * always wins, and `/statusline reset` re-applies them.
 */
export const DEFAULT_HIDDEN_ITEMS: StatuslineItem[] = [
  'working_dir',
  'theme',
  'sessions',
  'tools',
  'side_effects',
];

/** Default on/off map for a fresh config: everything except {@link DEFAULT_HIDDEN_ITEMS}. */
export function defaultChipEnabledMap(): Record<StatuslineItem, boolean> {
  const hidden = new Set<StatuslineItem>(DEFAULT_HIDDEN_ITEMS);
  return Object.fromEntries(STATUSLINE_ITEMS.map((item) => [item, !hidden.has(item)])) as Record<
    StatuslineItem,
    boolean
  >;
}

/** Total number of statusline chips in the contract. */
export const STATUSLINE_FIELD_COUNT = STATUSLINE_ITEMS.length;

/** Human-readable name of each rail, used by the picker's section headers. */
export const LINE_TITLES: Record<StatuslineLine, string> = {
  1: 'IDENTITY',
  2: 'VITALS',
  3: 'SAFETY & WORK',
  4: 'ASYNC',
};

/** One-line explanation of what each rail is for (picker section subtitle). */
export const LINE_SUBTITLES: Record<StatuslineLine, string> = {
  1: 'fixed for the session',
  2: 'redraws every token',
  3: 'posture + work in flight',
  4: 'background activity & countdowns',
};

/** Clamp any number into the 1–4 line range. */
export function clampLine(value: number): StatuslineLine {
  if (!Number.isFinite(value)) return 1;
  return Math.min(4, Math.max(1, Math.round(value))) as StatuslineLine;
}

/**
 * Resolve a chip's effective line: user override → contract default.
 * Tolerates a missing map — a hand-edited or partially-built document must
 * degrade to the defaults, not throw inside a render or a slash command.
 */
export function effectiveLine(
  item: StatuslineItem,
  lines: StatuslineLines | undefined,
): StatuslineLine {
  const override = lines?.[item];
  return override != null ? clampLine(override) : DEFAULT_LINES[item];
}

/** Resolve a chip's effective density ('auto' when unset). */
export function effectiveDensity(
  item: StatuslineItem,
  densities: StatuslineDensities | undefined,
): StatuslineDensity {
  return densities?.[item] ?? 'auto';
}

/**
 * One-line description of each chip. Single source for the `/statusline`
 * picker, the slash command's text listing and `--help` — three copies of
 * this map used to drift apart (the CLI still described `index` as
 * "Codebase indexing status" long after it grew server health detail).
 */
export const CHIP_DESCRIPTIONS: Record<StatuslineItem, string> = {
  state: 'Agent run state / thinking spinner',
  model: 'Current provider/model id',
  tokens: 'Input/output token counters',
  cache: 'Prompt cache hit ratio, read/write tokens and savings',
  queue: 'Queued prompt count',
  hint: 'Transient status hint text',
  index: 'Codebase index server and indexing status',
  breaker: 'Process breaker countdown',
  todos: 'Todo items (pending/in-progress/done)',
  plan: 'Plan board items',
  tasks: 'Task board items',
  fleet: 'Fleet agent status (running/idle/pending/completed)',
  fleet_agents: 'Per-agent live detail row',
  git: 'Git branch, deleted and untracked counts',
  elapsed: 'Session elapsed time',
  context: 'Context window usage meter',
  cost: 'Token cost estimate',
  processes: 'Tracked bash/exec process count',
  working_dir: 'Current working directory',
  project: 'Project name',
  yolo: 'YOLO permission mode',
  autonomy: 'Autonomy mode',
  eternal_stage: 'Autonomy stage',
  goal: 'Active goal summary',
  mode: 'Active agent mode label',
  auto_proceed: 'Auto-proceed countdown',
  sessions: 'Live session count',
  tools: 'Registered tool count',
  theme: 'Active color theme preset',
  token_saving: 'Token-saving mode indicator',
  brain: 'Brain arbiter decisions',
  mailbox: 'Mailbox unread messages and peers',
  enhance: 'Prompt-enhance countdown',
  debug_stream: 'Stream debug telemetry',
  next_steps: 'Next-step auto-submit countdown',
  memory_context: 'Memory context detail (total records + active-in-context)',
  side_effects: 'Side-effect / audit event count',
  version: 'WrongStack version + update notice (right-anchored)',
  dropped_tools: 'Tools dropped from the provider request (maxTools limit)',
  prompt_variant: 'System prompt variant (Lite / Standard / Pro)',
};
