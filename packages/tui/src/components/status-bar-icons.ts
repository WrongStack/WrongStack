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
  queue: glyphs.queue,
  sessions: glyphs.sessions,
  side_effects: glyphs.audit,
  state: glyphs.running,
  tasks: glyphs.task,
  theme: glyphs.palette,
  token_saving: glyphs.save,
  tokens: glyphs.context,
  todos: glyphs.task,
  tools: glyphs.tools,
  working_dir: glyphs.workingDirectory,
  yolo: glyphs.warning,
} as const satisfies Record<StatuslineItem, string>;

export const COMPACT_THRESHOLD = 50;

export function chipColor(color: string, isNoColor: boolean): string | undefined {
  return isNoColor ? undefined : color;
}

export const STACK_ORANGE = '#FD9F02';

export const LINE_BG_COLORS = [theme.surface, theme.surface, theme.surface, theme.surface] as const;

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const SPINNER_INTERVAL_MS = 1_000;
