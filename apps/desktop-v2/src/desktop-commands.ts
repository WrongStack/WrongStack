import type { BugHuntMode } from '@wrongstack/project-surfaces/lib/bug-hunt-message';
import { HUNT_COMMANDS } from './desktop-hunt';
import type { SettingsTarget } from './settings-section-request';
import type { ProjectPage } from './useDesktop';

/** A conversation tab a command can open. */
export type ConversationTab =
  | 'files'
  | 'changes'
  | 'skills'
  | 'story'
  | 'context'
  | 'usage'
  | 'activity'
  | 'processes'
  | 'side-effects'
  | 'mcp-tasks'
  | 'plan';

/**
 * Where a navigation command goes: one of the conversation's tabs, a project page, a WrongStack
 * settings section, or a new conversation in this project.
 */
export type DesktopNavigation =
  | { tab: ConversationTab }
  | { page: ProjectPage }
  | { settings: SettingsTarget }
  | { start: 'agent' | 'terminal' };

/** A navigation target outside the conversation, which the app opens. */
export type AppNavigation = Exclude<DesktopNavigation, { tab: ConversationTab }>;

export type DesktopCommandCategory =
  | 'Run'
  | 'Conversation'
  | 'Tools'
  | 'Agent'
  | 'Hunts'
  | 'Project'
  | 'App';

type CommandAction =
  | 'help'
  | 'library'
  | 'journal'
  | 'context'
  | 'compact'
  | 'compact-aggressive'
  | 'repair'
  | 'clear'
  | 'queue'
  | 'btw'
  | 'steer'
  | 'stop'
  | 'settings'
  | 'enhance'
  | 'open'
  /** A command the engine runs (`command.run`), listed by its `command.catalog`. */
  | 'engine'
  | 'review'
  | 'fix'
  | 'suggest'
  | 'autonomy'
  | 'mode'
  | 'yolo'
  | 'nextsteps'
  | 'hunt'
  | 'goal'
  | 'brain'
  | 'mcp'
  | 'doctor'
  | 'browser'
  | 'working-dir'
  | 'save'
  | 'todos'
  | 'next'
  | 'export';

export interface DesktopCommand {
  name: string;
  aliases?: readonly string[];
  description: string;
  category: DesktopCommandCategory;
  /** The arguments after the name, for help; a command without one takes none. */
  usage?: string;
  action: CommandAction;
  /** Where an `open` command goes. */
  opens?: DesktopNavigation;
  /** Which Proof-Driven Hunt a `hunt` command starts. */
  hunt?: BugHuntMode;
}

const tab = (name: ConversationTab): DesktopNavigation => ({ tab: name });
const page = (name: ProjectPage): DesktopNavigation => ({ page: name });
const settings = (name: SettingsTarget): DesktopNavigation => ({ settings: name });

export const DESKTOP_CATEGORY_ORDER: readonly DesktopCommandCategory[] = [
  'Run',
  'Conversation',
  'Tools',
  'Agent',
  'Hunts',
  'Project',
  'App',
];

export const desktopCommands: readonly DesktopCommand[] = [
  // Run
  {
    name: '/stop',
    aliases: ['/abort', '/interrupt', '/int'],
    category: 'Run',
    description: 'Stop the active turn',
    action: 'stop',
  },
  {
    name: '/queue',
    category: 'Run',
    usage: '[prompt]',
    description: 'Inspect pending prompts, or queue the text after this command',
    action: 'queue',
  },
  {
    name: '/btw',
    category: 'Run',
    usage: '[message]',
    description: 'Send the following text using Message / BTW delivery',
    action: 'btw',
  },
  {
    name: '/steer',
    category: 'Run',
    usage: '[instruction]',
    description: 'Stop and steer with the following instruction',
    action: 'steer',
  },
  // Conversation
  {
    name: '/context',
    aliases: ['/debug'],
    category: 'Conversation',
    description: 'Inspect this conversation’s context and instructions',
    action: 'context',
  },
  {
    name: '/compact',
    category: 'Conversation',
    description: 'Compact this conversation’s context',
    action: 'compact',
  },
  {
    name: '/compact!',
    category: 'Conversation',
    description: 'Aggressively compact this conversation’s context',
    action: 'compact-aggressive',
  },
  {
    name: '/repair',
    category: 'Conversation',
    description: 'Repair orphan tool/result blocks in this conversation',
    action: 'repair',
  },
  {
    name: '/clear',
    category: 'Conversation',
    description: 'Clear provider context; retain the on-disk conversation',
    action: 'clear',
  },
  {
    name: '/new',
    category: 'Conversation',
    description: 'Start a new conversation in this project',
    action: 'open',
    opens: { start: 'agent' },
  },
  {
    name: '/terminal',
    aliases: ['/term'],
    category: 'Conversation',
    description: 'Open a terminal session in this project',
    action: 'open',
    opens: { start: 'terminal' },
  },
  {
    name: '/save',
    category: 'Conversation',
    description: 'Confirm this conversation is saved (it saves as it goes)',
    action: 'save',
  },
  {
    name: '/export',
    category: 'Conversation',
    description: 'Download this conversation as Markdown',
    action: 'export',
  },
  {
    name: '/sessions',
    aliases: ['/session-history', '/load', '/resume'],
    category: 'Conversation',
    description: 'Browse this project’s recorded conversations',
    action: 'open',
    opens: page('history'),
  },
  {
    name: '/history',
    category: 'Conversation',
    description: 'Read this project’s prompt journal',
    action: 'journal',
  },
  {
    name: '/prompt',
    aliases: ['/prompts'],
    category: 'Conversation',
    description: 'Browse project and user prompt templates',
    action: 'library',
  },
  // Tools of this conversation
  {
    name: '/dashboard',
    category: 'Tools',
    description: 'Context dashboard: pressure, what fills the window, cache and memory',
    action: 'open',
    opens: tab('context'),
  },
  {
    name: '/story',
    category: 'Tools',
    description: 'Replay the conversation: lanes, timeline, models, tools and files',
    action: 'open',
    opens: tab('story'),
  },
  {
    name: '/usage',
    aliases: ['/stats', '/cost'],
    category: 'Tools',
    description: 'Tokens, cache behavior, routed providers and priced estimates',
    action: 'open',
    opens: tab('usage'),
  },
  {
    name: '/activity',
    category: 'Tools',
    description: 'Tool calls, execution output and verification in this conversation',
    action: 'open',
    opens: tab('activity'),
  },
  {
    name: '/processes',
    aliases: ['/ps', '/kill'],
    category: 'Tools',
    description: 'This conversation’s commands, background output and termination',
    action: 'open',
    opens: tab('processes'),
  },
  {
    name: '/side-effects',
    category: 'Tools',
    description: 'Recorded commands, packages, network and configuration operations',
    action: 'open',
    opens: tab('side-effects'),
  },
  {
    name: '/mcp-tasks',
    category: 'Tools',
    description: 'Remote MCP work: results and cancellation',
    action: 'open',
    opens: tab('mcp-tasks'),
  },
  {
    name: '/plan',
    aliases: ['/templates'],
    category: 'Tools',
    description: 'Start this conversation’s plan from a ready-made list of steps',
    action: 'open',
    opens: tab('plan'),
  },
  {
    name: '/files',
    category: 'Tools',
    description: 'Open this project’s file manager',
    action: 'open',
    opens: tab('files'),
  },
  {
    name: '/diff',
    aliases: ['/changes'],
    category: 'Tools',
    description: 'Open this project’s changes and review',
    action: 'open',
    opens: tab('changes'),
  },
  {
    name: '/skills',
    aliases: ['/skill'],
    category: 'Tools',
    description: 'Open this project’s skill library',
    action: 'open',
    opens: tab('skills'),
  },
  {
    name: '/tools',
    category: 'Tools',
    description: 'Every tool the model can call, and which ones it may use',
    action: 'open',
    opens: settings('tool-access'),
  },
  {
    name: '/todos',
    category: 'Tools',
    usage: '[clear]',
    description: 'Show this conversation’s todo list, or clear it',
    action: 'todos',
  },
  {
    name: '/next',
    aliases: ['/enxt'],
    category: 'Tools',
    usage: '[n …]',
    description: 'List the suggested next steps, or send the numbered ones',
    action: 'next',
  },
  // Agent
  {
    name: '/review',
    aliases: ['/cr'],
    category: 'Agent',
    usage: '[focus]',
    description: 'Ask the agent to review the pending changes',
    action: 'review',
  },
  {
    name: '/fix',
    category: 'Agent',
    usage: '[error]',
    description: 'Diagnose and fix an error (paste it) or the latest failure',
    action: 'fix',
  },
  {
    name: '/suggest',
    aliases: ['/next-steps'],
    category: 'Agent',
    description: 'Ask the agent for concrete next steps',
    action: 'suggest',
  },
  {
    name: '/autonomy',
    category: 'Agent',
    usage: '[off|suggest|auto|eternal|eternal-parallel]',
    description: 'Show or switch how this conversation continues after a turn',
    action: 'autonomy',
  },
  {
    name: '/mode',
    category: 'Agent',
    usage: '[mode id]',
    description: 'List the agent modes, or switch this conversation to one',
    action: 'mode',
  },
  {
    name: '/yolo',
    category: 'Agent',
    usage: '[on|plus|off]',
    description: 'YOLO: on (damaging kinds ask) · plus (nothing ever asks) · off',
    action: 'yolo',
  },
  {
    name: '/nextsteps',
    category: 'Agent',
    usage: '[optional|required] [limit] · limit <n>',
    description: 'Make next steps optional or required; cap automatic continuation',
    action: 'nextsteps',
  },
  {
    name: '/goal',
    category: 'Agent',
    usage: '[start <title>|set <mission>|pause|resume|stop|clear|refine|save|load <name>]',
    description: 'Run a goal or steer the project mission; alone, opens the goals page',
    action: 'goal',
  },
  {
    name: '/brain',
    category: 'Agent',
    usage: '[risk <level>|ask <question>]',
    description: 'Brain settings, its auto-decision risk ceiling, or a question to it',
    action: 'brain',
  },
  // Hunts: one proven defect per round, as many rounds as asked
  ...HUNT_COMMANDS.map(
    (hunt): DesktopCommand => ({
      name: hunt.name,
      aliases: hunt.aliases,
      category: 'Hunts',
      usage: '[--rounds 1..10] [scope] · stop',
      description: `${hunt.label} — ${hunt.description}`,
      action: 'hunt',
      hunt: hunt.mode,
    }),
  ),
  // Project
  {
    name: '/memory',
    category: 'Project',
    description: 'Open project SAGE memory',
    action: 'open',
    opens: page('memory'),
  },
  {
    name: '/kanban',
    category: 'Project',
    description: 'Open the project task board',
    action: 'open',
    opens: page('kanban'),
  },
  {
    name: '/goals',
    aliases: ['/goal-state'],
    category: 'Project',
    description: 'Project goals, their runs and phase status',
    action: 'open',
    opens: page('goals'),
  },
  {
    name: '/atlas',
    category: 'Project',
    description: 'Open project Code Atlas',
    action: 'open',
    opens: page('atlas'),
  },
  {
    name: '/mailbox',
    category: 'Project',
    description: 'Open project correspondence and receipts',
    action: 'open',
    opens: page('mailbox'),
  },
  {
    name: '/fleet',
    aliases: ['/agents'],
    category: 'Project',
    description: 'Live fleet: running conversations and their agents',
    action: 'open',
    opens: page('live-fleet'),
  },
  {
    name: '/office',
    category: 'Project',
    description: 'Open the agent office map',
    action: 'open',
    opens: page('office'),
  },
  {
    name: '/roster',
    category: 'Project',
    description: 'Open the project’s agent roster',
    action: 'open',
    opens: page('roster'),
  },
  {
    name: '/worktree',
    aliases: ['/worktrees'],
    category: 'Project',
    description: 'Open the project’s worktrees',
    action: 'open',
    opens: page('worktrees'),
  },
  {
    name: '/automations',
    category: 'Project',
    description: 'Open the project’s automations',
    action: 'open',
    opens: page('automations'),
  },
  {
    name: '/chronicle',
    category: 'Project',
    description: 'Open the project’s Chronicle history',
    action: 'open',
    opens: page('chronicle'),
  },
  {
    name: '/diag',
    aliases: ['/diagnostics'],
    category: 'Project',
    description: 'Engine diagnostics: memory, processes and the code index',
    action: 'open',
    opens: page('diagnostics'),
  },
  {
    name: '/analytics',
    category: 'Project',
    description: 'Analytics: sessions, agents, tool calls, tokens and cost',
    action: 'open',
    opens: page('analytics'),
  },
  {
    name: '/working-dir',
    aliases: ['/cwd'],
    category: 'Project',
    usage: '[path]',
    description: 'Show where this conversation’s tools run, or move them inside the project',
    action: 'working-dir',
  },
  // App
  {
    name: '/settings',
    aliases: ['/model', '/auth', '/setup'],
    category: 'App',
    description: 'Open WrongStack provider and profile settings',
    action: 'settings',
  },
  {
    name: '/enhance',
    category: 'App',
    description: 'Toggle prompt refinement before sending',
    action: 'enhance',
  },
  {
    name: '/mcp',
    category: 'App',
    usage: '[tools <server>]',
    description: 'Manage MCP servers, or list one server’s tools',
    action: 'mcp',
  },
  {
    name: '/doctor',
    category: 'App',
    usage: '[fix]',
    description: 'Check the profile configuration against the defaults; fix repairs it',
    action: 'doctor',
  },
  {
    name: '/browser',
    aliases: ['/network'],
    category: 'App',
    usage: '[allow <origin>|allow loopback|…]',
    description: 'Private and localhost origins the browser and fetch tools may reach',
    action: 'browser',
  },
  { name: '/help', category: 'App', description: 'Show every desktop command', action: 'help' },
];

/** The command that `name` (with its slash, any case) names, through its aliases too. */
function findCommand(
  name: string,
  extra: readonly DesktopCommand[] = [],
): DesktopCommand | undefined {
  const wanted = name.toLowerCase();
  return [...desktopCommands, ...extra].find(
    (command) => command.name === wanted || (command.aliases?.includes(wanted) ?? false),
  );
}

/** The commands a typed prefix (`/co`) can complete to, by name or alias. */
export function matchDesktopCommands(
  prefix: string,
  extra: readonly DesktopCommand[] = [],
): DesktopCommand[] {
  const wanted = prefix.toLowerCase();
  return [...desktopCommands, ...extra].filter(
    (command) =>
      command.name.startsWith(wanted) ||
      (command.aliases?.some((alias) => alias.startsWith(wanted)) ?? false),
  );
}

/**
 * A draft that starts with a command: the command (undefined when the name is not one) and the
 * text after it. Null for ordinary text — `//literal` and absolute paths stay drafts.
 */
export function parseDesktopCommand(
  text: string,
  /** Commands the engine runs, after the desktop's own. */
  extra: readonly DesktopCommand[] = [],
): { command: DesktopCommand | undefined; name: string; argument: string } | null {
  const match = /^\/([a-z][\w!-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const name = `/${match[1]!.toLowerCase()}`;
  return { command: findCommand(name, extra), name, argument: match[2]?.trim() ?? '' };
}
