export type CommandCategory =
  | 'All'
  | 'Workflow'
  | 'Session'
  | 'Agents'
  | 'Configure'
  | 'Developer'
  | 'Ecosystem';

export type CommandEntry = {
  name: string;
  summary: string;
  category: Exclude<CommandCategory, 'All'>;
  usage?: string[];
  note?: string;
  origin: 'Core' | 'Built-in plugin';
};

const commandRows: Array<[string, string]> = [
  ['/help', 'List all commands or open detailed help for one command.'],
  ['/desktop', 'Explain how to access the local WrongStack Desktop application.'],
  ['/webui', 'Explain how to start and access the browser-based WrongStack interface.'],
  [
    '/init',
    'In-session command: regenerate .wrongstack/AGENTS.md and back up the existing file first.',
  ],
  ['/clear', 'Wipe session state and clear the terminal view.'],
  ['/compact', 'Run the configured context-window compactor immediately.'],
  ['/context', 'Inspect, repair and tune context modes, thresholds and limits.'],
  ['/dev', 'Run a shell command locally without adding its output to model context.'],
  ['/codebase-reindex', 'Rebuild the project symbol and codebase search index.'],
  ['/techstack', 'Scan dependencies, verify versions and write a technology report.'],
  ['/diag', 'Inspect runtime diagnostics and active system state.'],
  ['/stats', 'Show token, cost and iteration statistics for the session.'],
  ['/memory', 'Search, graph, verify, clean, import and inspect structured memory.'],
  ['/todos', 'View and manage the current session todo list.'],
  ['/tasks', 'Manage structured tasks with priorities and dependencies.'],
  ['/mode', 'Switch the session persona, including lite and deep mode families.'],
  ['/setmodel', 'Set the leader model or role/phase model routing matrix.'],
  ['/models', 'Manage custom model definitions.'],
  ['/modelcaps', 'Browse model context, capability and pricing information.'],
  ['/yolo', 'Query or toggle automatic tool approval for this session.'],
  ['/autonomy', 'Set the active autonomy level.'],
  ['/save', 'Force the live session writer to flush to disk.'],
  ['/sessions', 'List and resume saved sessions; also available as /resume and /load.'],
  ['/prune', 'Preview or delete old session data.'],
  ['/exit', 'Close the REPL cleanly; aliases include /quit and /q.'],
  ['/tool', 'Choose simple or extended tool-description detail.'],
  ['/tools', 'List the complete registered tool inventory.'],
  ['/plugin', 'List, inspect, enable, disable and manage plugins.'],
  ['/mcp', 'Add, update, discover, restart and inspect MCP servers.'],
  ['/auth', 'Open the API-key status dashboard.'],
  ['/spawn', 'Create an isolated specialist subagent.'],
  [
    '/agent-improve',
    'Inspect and develop a roster agent for this project: captured directives, per-skill project addenda, skill affinity and the optimization pass.',
  ],
  ['/agents', 'Monitor agents, timeline events and per-agent transcripts.'],
  ['/director', '(Obsolete) Director Mode is permanently on — fleet tools always available.'],
  ['/delegate', 'Hand a bounded task to a specialist role.'],
  ['/fleet', 'Inspect fleet status, budgets, logs, streams, retries and workers.'],
  ['/sdd', 'Run the Spec-Driven Development workflow.'],
  ['/btw', 'Ask a quick side question without derailing the current task.'],
  ['/next', 'Toggle automatic next-task prediction.'],
  ['/suggest', 'Generate context-aware next actions, with a fast heuristic mode.'],
  ['/enhance', 'Refine a prompt before it is sent to the agent.'],
  ['/ensemble', 'Fan one task to multiple ACP-capable coding agents.'],
  ['/fix', 'Classify an error and route it into a focused repair workflow.'],
  ['/goal', 'Run an autonomous phase-based workflow.'],
  ['/worktree', 'Inspect and manage worktrees used by autonomous phases.'],
  ['/settings', 'View or change live runtime settings.'],
  ['/telegram-setup', 'Configure a Telegram bot token and default chat.'],
  ['/collab', 'Start structured live collaboration helpers.'],
  ['/statusline', 'Choose which TUI status-bar instruments are visible.'],
  ['/interrupt', 'Abort the in-flight leader iteration safely.'],
  ['/kanban', 'Manage durable boards, dependency-ready tasks, assignments and fleet dispatch.'],
  ['/brain', 'Inspect the decision arbiter, ask it a question or set its risk ceiling.'],
  ['/coordinator', 'Control multi-session autonomous goal coordination.'],
  ['/review', 'Run a model-driven code review pass.'],
  ['/mailbox', 'Read and send cross-agent project mailbox messages.'],
  ['/mailbox-demo', 'Exercise mailbox routing during development.'],
  ['/mailbox-serve', 'Expose the project mailbox through its HTTP bridge.'],
  ['/fallback', 'Inspect and configure fallback model behavior.'],
  ['/working_dir', 'Show or change the live working directory.'],
  ['/project', 'List, add, rename, remove or switch registered projects.'],
  ['/mouse', 'Capture mouse events for terminal UI testing.'],
  ['/telegram-settings', 'Tune Telegram notification preferences.'],
  ['/audit', 'Inspect the side-effect trail for shell, install and fetch actions.'],
  ['/doctor', 'Diagnose and safely repair configuration problems with backup and history.'],
  ['/tuneup', 'Audit session health, context cost, performance and reliability settings.'],
  ['/f', 'Open a numbered TUI function-key panel.'],
  ['/acp', 'Discover and run installed ACP coding agents using their existing logins.'],
  ['/design', 'Browse, pin and materialize a curated Design Studio kit.'],
  ['/hq', 'Inspect and control HQ Command Center connectivity for the current surface.'],
  ['/refiner', 'Inspect and tune automatic prompt-refinement behavior.'],
  ['/shadow', 'Start and manage a shadow fleet monitor.'],
  ['/supervisor', 'Inspect or configure the Brain-gated Fleet Supervisor.'],
  ['/security', 'Run dependency audit, scan dispatch and redaction diagnostics.'],
  ['/prompts', 'Manage the layered project, user and bundled prompt library.'],
  ['/prompt', 'Search and insert a reusable prompt.'],
  ['/prompt-gen', 'Author a reusable prompt with model assistance.'],
  ['/sync', 'Sync selected settings, skills, prompts, memory and history through GitHub.'],
  ['/commit', 'Stage changes and create a generated conventional commit.'],
  ['/git', 'Run high-level Git workflow actions through the command surface.'],
  ['/gitcheck', 'Silently inspect the working tree for uncommitted changes.'],
  ['/push', 'Push the current branch to its configured remote.'],
  ['/gitid', 'Inspect or manage Git identity used for repository operations.'],
  ['/metrics', 'Show a metrics snapshot when observability is enabled.'],
  ['/health', 'Run registered health checks when observability is enabled.'],
  ['/skill', 'List discovered skills or load one skill body.'],
  ['/skill-gen', 'Author a new skill with model guidance.'],
  ['/skill-search', 'Search the configured skill registry.'],
  ['/skill-install', 'Install a skill from GitHub or the registry.'],
  ['/skill-import', 'Import compatible skills from supported foreign locations.'],
  ['/skill-update', 'Update installed skills.'],
  ['/skill-uninstall', 'Remove an installed skill.'],
  ['/plan', 'Manage the per-session strategic plan board.'],
  ['/profile', 'Manage configuration profiles in ~/.wrongstack/profiles/<name>.'],
  [
    '/provider-status',
    'View live health of configured provider/model routes (healthy/degraded/blocked).',
  ],
  ['/chimera', 'Show the Chimera post-session code-quality guardian status and configuration.'],
  ['/auto-review', 'Show the continuous auto-review pipeline status and configuration.'],
  ['/semver', 'Show the current version or bump it (patch/minor/major/auto).'],
  ['/lsp', 'Manage LSP servers: list, install, start, stop, restart, show diagnostics.'],
];

/**
 * Total entries in commandRows. Single source of truth for marketing
 * copy and home-page stats so future command additions cannot drift.
 * Declared after `commandRows` so `commandRows.length` is safe to read
 * without triggering a temporal-dead-zone ReferenceError.
 */
export const COMMAND_COUNT = commandRows.length;

const categories: Record<Exclude<CommandCategory, 'All'>, string[]> = {
  Workflow: [
    '/sdd',
    '/btw',
    '/next',
    '/suggest',
    '/enhance',
    '/fix',
    '/goal',
    '/autonomy',
    '/plan',
    '/review',
    '/kanban',
    '/refiner',
  ],
  Session: [
    '/clear',
    '/compact',
    '/context',
    '/diag',
    '/stats',
    '/memory',
    '/todos',
    '/tasks',
    '/save',
    '/sessions',
    '/prune',
    '/exit',
    '/interrupt',
  ],
  Agents: [
    '/spawn',
    '/agent-improve',
    '/agents',
    '/director',
    '/delegate',
    '/fleet',
    '/ensemble',
    '/collab',
    '/brain',
    '/coordinator',
    '/mailbox',
    '/mailbox-demo',
    '/mailbox-serve',
    '/shadow',
    '/supervisor',
    '/acp',
    '/hq',
  ],
  Configure: [
    '/init',
    '/mode',
    '/setmodel',
    '/models',
    '/modelcaps',
    '/yolo',
    '/settings',
    '/statusline',
    '/fallback',
    '/auth',
    '/working_dir',
    '/project',
    '/f',
    '/mouse',
    '/design',
    '/profile',
    '/provider-status',
  ],
  Developer: [
    '/dev',
    '/codebase-reindex',
    '/techstack',
    '/worktree',
    '/review',
    '/audit',
    '/security',
    '/commit',
    '/gitcheck',
    '/push',
    '/git',
    '/gitid',
    '/doctor',
    '/tuneup',
    '/chimera',
    '/auto-review',
    '/semver',
    '/lsp',
  ],
  Ecosystem: [
    '/help',
    '/desktop',
    '/webui',
    '/tool',
    '/tools',
    '/plugin',
    '/mcp',
    '/telegram-setup',
    '/telegram-settings',
    '/prompts',
    '/prompt',
    '/prompt-gen',
    '/sync',
    '/metrics',
    '/health',
    '/skill',
    '/skill-gen',
    '/skill-search',
    '/skill-install',
    '/skill-import',
    '/skill-update',
    '/skill-uninstall',
  ],
};

const featuredUsage: Record<string, { usage: string[]; note?: string }> = {
  '/context': {
    usage: ['/context', '/context mode deep', '/context thresholds 0.6 0.75 0.9'],
    note: 'The /ctx alias reaches the same command.',
  },
  '/goal': {
    usage: ['/goal set "ship the auth refactor"', '/goal pause', '/goal resume', '/goal journal'],
  },
  '/fleet': {
    usage: [
      '/fleet list',
      '/fleet dispatch "fix the login crash"',
      '/fleet spawn debugger',
      '/fleet status',
    ],
  },
  '/mode': {
    usage: ['/mode', '/mode brief', '/mode review-lite', '/mode code-reviewer'],
    note: 'WrongStack ships 19 built-in persona modes. This is independent from /context mode and /autonomy.',
  },
  '/spawn': {
    usage: [
      '/spawn --name=researcher "compare the migration options"',
      '/spawn --model=<id> "review this diff"',
    ],
  },
  '/agents': {
    usage: ['/agents', '/agents list', '/agents show <id>', '/agents chat compact'],
  },
  '/delegate': {
    usage: ['/delegate list', '/delegate --role=security-scanner "audit the auth flow"'],
  },
  '/brain': {
    usage: ['/brain', '/brain risk medium', '/brain ask "should the fleet spawn a helper?"'],
  },
  '/mcp': {
    usage: ['/mcp list', '/mcp add', '/mcp discover <server>', '/mcp restart <server>'],
  },
  '/settings': {
    usage: ['/settings', '/settings get context.mode', '/settings set context.mode deep'],
  },
  '/memory': {
    usage: ['/memory search <query>', '/memory graph', '/memory verify', '/memory hygiene'],
  },
  '/sessions': {
    usage: ['/sessions', '/resume', '/sessions rename <id> "release work"'],
  },
  '/sdd': {
    usage: ['/sdd "add OAuth account switching"', '/sdd status'],
  },
  '/skill-install': {
    usage: ['/skill-install user/repo', '/skill-install registry:skill-id'],
  },
  '/security': {
    usage: ['/security audit-deps', '/security scan', '/security redact-test'],
  },
  '/kanban': {
    usage: [
      '/kanban',
      '/kanban snapshot',
      '/kanban task ready',
      '/kanban task dispatch <board> <task> --model=<model>',
    ],
    note: 'Aliases: /kb and /board. The TUI panel is available through /kanban open.',
  },
  '/acp': {
    usage: [
      '/acp',
      '/acp probe',
      '/acp gemini-cli "review this module"',
      '/acp parallel claude-code,codex-cli "review this diff"',
    ],
  },
  '/supervisor': {
    usage: ['/supervisor', '/supervisor status', '/supervisor on', '/supervisor off'],
  },
  '/tuneup': {
    usage: ['/tuneup', '/tuneup fix', '/tuneup deep'],
    note: 'The --power path is the only tune-up mode that changes autonomy, YOLO or Director defaults.',
  },
  '/profile': {
    usage: ['/profile', '/profile list', '/profile switch <name>', '/profile copy <name>'],
  },
  '/provider-status': {
    usage: [
      '/provider-status',
      '/provider-status waiting',
      '/provider-status degraded',
      '/provider-status retry <provider> <model>',
    ],
  },
  '/chimera': {
    usage: ['/chimera', '/chimera autoFix ask'],
  },
  '/auto-review': {
    usage: ['/auto-review', '/auto-review on', '/auto-review off'],
  },
  '/semver': {
    usage: ['/semver status', '/semver patch', '/semver minor', '/semver auto --dry'],
  },
  '/lsp': {
    usage: ['/lsp list', '/lsp install <language>', '/lsp start <name>', '/lsp diagnostics [file]'],
  },
};

const pluginCommands = new Set([
  '/prompts',
  '/prompt',
  '/prompt-gen',
  '/sync',
  '/skill',
  '/skill-gen',
  '/skill-search',
  '/skill-install',
  '/skill-import',
  '/skill-update',
  '/skill-uninstall',
  '/chimera',
  '/auto-review',
  '/semver',
  '/lsp',
]);

export const commands: CommandEntry[] = commandRows.map(([name, summary]) => {
  const category = (Object.entries(categories).find(([, names]) => names.includes(name))?.[0] ??
    'Ecosystem') as Exclude<CommandCategory, 'All'>;
  return {
    name,
    summary,
    category,
    origin: pluginCommands.has(name) ? 'Built-in plugin' : 'Core',
    ...featuredUsage[name],
  };
});

export function commandSlug(name: string) {
  return name.slice(1).replace(/_/g, '-');
}

export function commandFromSlug(slug: string) {
  return commands.find((command) => commandSlug(command.name) === slug);
}

export const commandCategories: CommandCategory[] = [
  'All',
  'Workflow',
  'Session',
  'Agents',
  'Configure',
  'Developer',
  'Ecosystem',
];
