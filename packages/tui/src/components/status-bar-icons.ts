import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import type { StatuslineItem } from './statusline-picker.js';

export const STATUSLINE_ICONS = {
  auto_proceed: glyphs.auto,
  autonomy: glyphs.brand,
  brain: glyphs.brain,
  breaker: glyphs.warning,
  cache: glyphs.success,
  context: glyphs.context,
  cost: glyphs.cost,
  debug_stream: glyphs.bug,
  dropped_tools: glyphs.warning,
  elapsed: glyphs.clock,
  enhance: glyphs.auto,
  eternal_stage: glyphs.running,
  fleet: glyphs.fleet,
  fleet_agents: glyphs.fleet,
  git: glyphs.gitBranch,
  goal: glyphs.goal,
  hint: glyphs.info,
  index: glyphs.index,
  mailbox: glyphs.mail,
  memory_context: glyphs.brain,
  mode: glyphs.terminal,
  model: glyphs.brand,
  next_steps: glyphs.auto,
  plan: glyphs.plan,
  processes: glyphs.process,
  project: glyphs.folder,
  prompt_variant: glyphs.terminal,
  queue: glyphs.queue,
  sessions: glyphs.sessions,
  side_effects: glyphs.audit,
  state: glyphs.running,
  tasks: glyphs.task,
  theme: glyphs.palette,
  token_saving: glyphs.save,
  tokens: glyphs.context,
  // Distinct from `tasks` (glyphs.task): both chips can render icon-only at
  // micro density, where a shared glyph would be unreadable.
  todos: glyphs.bookmark,
  tools: glyphs.tools,
  version: glyphs.brand,
  working_dir: glyphs.workingDirectory,
  yolo: glyphs.warning,
} as const satisfies Record<StatuslineItem, string>;

export const COMPACT_THRESHOLD = 50;

export function chipColor(color: string, isNoColor: boolean): string | undefined {
  return isNoColor ? undefined : color;
}

export const STACK_ORANGE = '#FD9F02';

/**
 * Per-rail background tone. Read through a function (not a frozen array) so
 * it follows a live `/theme` switch, and genuinely alternated so the four
 * rails read as four bands instead of one block: identity/safety sit on the
 * base surface, vitals/async on the raised one.
 */
export function lineBackground(logical: 0 | 1 | 2 | 3): string {
  return logical % 2 === 0 ? theme.surface : theme.surfaceRaised;
}

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const SPINNER_INTERVAL_MS = 1_000;
