export interface FeatureQuery {
  label: string;
  type?: string;
  response?: string;
  resource?: string;
  payload?: Record<string, unknown>;
}
export interface DesktopFeature {
  id: string;
  label: string;
  group: string;
  description: string;
  views: string[];
  activities?: string[];
  settings?: string[];
  tab?: 'chat' | 'files' | 'changes' | 'skills' | 'mailbox' | 'kanban' | 'settings';
  queries?: FeatureQuery[];
}
export const desktopFeatures: DesktopFeature[] = [
  {
    id: 'conversation',
    label: 'Conversation',
    group: 'Workspace',
    description: 'Chat, streaming, approvals, questions, and prompt composition.',
    views: ['chat'],
    activities: ['chat'],
    tab: 'chat',
  },
  {
    id: 'files',
    label: 'Files & code',
    group: 'Workspace',
    description: 'Project files, code navigation, editing, and code assistance.',
    views: ['files'],
    activities: ['files'],
    tab: 'files',
  },
  {
    id: 'changes',
    label: 'Changes & worktrees',
    group: 'Workspace',
    description: 'Review changes, staging, commits, and isolated worktree lanes.',
    views: ['changes'],
    activities: ['changes'],
    tab: 'changes',
  },
  {
    id: 'mailbox',
    label: 'Mailbox',
    group: 'Workspace',
    description: 'Agent messages, threads, receipts, and collaboration.',
    views: ['mailbox'],
    activities: ['mailbox'],
    tab: 'mailbox',
  },
  {
    id: 'agents',
    label: 'Agents & fleet',
    group: 'Execution',
    description: 'Agent identities, roles, learning, live work, and fleet controls.',
    views: ['roster'],
    activities: ['agents'],
    queries: [
      { label: 'Agent roster', type: 'agent-roster.list' },
      { label: 'Agent statistics', type: 'agent-roster.stats' },
    ],
  },
  {
    id: 'goals',
    label: 'Goals & missions',
    group: 'Execution',
    description: 'Persistent mission, goal graphs, phases, tasks, and run controls.',
    views: ['goal'],
    queries: [
      { label: 'Persistent mission', type: 'goal-state.get', response: 'goal-state.updated' },
      { label: 'Goals', type: 'goal.list' },
      { label: 'Execution state', type: 'goal.status', response: 'goal.state' },
    ],
  },
  {
    id: 'kanban',
    label: 'Kanban & work',
    group: 'Execution',
    description: 'Boards, tasks, workflows, plans, and verification.',
    views: ['kanban'],
    tab: 'kanban',
  },
  {
    id: 'sdd',
    label: 'SDD',
    group: 'Execution',
    description: 'Build specifications, approve task graphs, and control parallel runs.',
    views: ['sddhub'],
    queries: [
      { label: 'Run boards', type: 'sdd.board.list' },
      { label: 'Specification builder', type: 'sdd.spec.get', response: 'sdd.spec.snapshot' },
      { label: 'Specifications', type: 'specs.list' },
    ],
  },
  {
    id: 'automations',
    label: 'Automations',
    group: 'Execution',
    description: 'Jobs, schedules, triggers, run queue, evidence, and pull requests.',
    views: ['automation'],
    queries: [{ label: 'Automation workspace', resource: '/api/automation/state' }],
  },
  {
    id: 'processes',
    label: 'Processes & browser',
    group: 'Execution',
    description: 'Running project processes, output, terminals, and browser sessions.',
    views: [],
    queries: [
      { label: 'Processes', type: 'process.list' },
      { label: 'Live browser sessions', type: 'browser.live.list' },
    ],
  },
  {
    id: 'memory',
    label: 'Memory',
    group: 'Knowledge',
    description: 'SAGE memories, candidates, recovery, graph, and vector search.',
    views: ['memory'],
    queries: [
      {
        label: 'Memories',
        type: 'memory.sage.listPage',
        payload: { limit: 100, includeStats: true },
      },
      { label: 'Memory candidates', type: 'memory.sage.listCandidates' },
    ],
  },
  {
    id: 'skills',
    label: 'Skills',
    group: 'Knowledge',
    description: 'Discover, read, create, install, and maintain agent skills.',
    views: ['skill'],
    activities: ['skills'],
    tab: 'skills',
  },
  {
    id: 'prompts',
    label: 'Prompt library',
    group: 'Knowledge',
    description: 'Saved prompts, favorites, recent use, and the prompt journal.',
    views: ['prompts'],
    queries: [
      { label: 'Prompt library', type: 'prompts.list' },
      { label: 'Prompt journal', type: 'prompts.journal' },
    ],
  },
  {
    id: 'context',
    label: 'Context & instructions',
    group: 'Knowledge',
    description: 'Context editor, modes, compaction, prompts, and user instructions.',
    views: ['context'],
    settings: ['context'],
    queries: [
      { label: 'Context', type: 'context.editor.open', response: 'context.editor.snapshot' },
      { label: 'Context modes', type: 'context.modes.list' },
      { label: 'User instructions', type: 'user_instructions.get', response: 'user_instructions' },
    ],
  },
  {
    id: 'chronicle',
    label: 'Chronicle',
    group: 'Knowledge',
    description: 'Events, facets, metrics, history, and graph exploration.',
    views: ['chronicle'],
    queries: [
      { label: 'Chronicle status', type: 'chronicle.status', response: 'chronicle.status_result' },
      {
        label: 'Chronicle facets',
        type: 'chronicle.facets',
        payload: { fields: ['eventType', 'outcome', 'providerId'], limit: 100 },
        response: 'chronicle.facets_result',
      },
    ],
  },
  {
    id: 'design',
    label: 'Design Studio',
    group: 'Project intelligence',
    description: 'Design kits, gallery, tuning, project materialization, and verification.',
    views: ['design-gallery'],
    activities: ['design'],
    queries: [
      { label: 'Design kits', type: 'design.list' },
      { label: 'Project design', type: 'design.state' },
    ],
  },
  {
    id: 'codemap',
    label: 'CodeMap',
    group: 'Project intelligence',
    description: 'Packages, files, symbols, and agent activity across the codebase.',
    views: ['codemap'],
    queries: [
      { label: 'Packages', resource: '/api/codemap/packages' },
      { label: 'Files', resource: '/api/codemap/files' },
    ],
  },
  {
    id: 'techstack',
    label: 'TechStack',
    group: 'Project intelligence',
    description: 'Dependency inventory, analysis, research, trends, and remediation.',
    views: ['techstack'],
    queries: [
      { label: 'TechStack snapshot', resource: '/api/techstack/snapshot' },
      { label: 'Trends', resource: '/api/techstack/trends' },
    ],
  },
  {
    id: 'project-kit',
    label: 'Project Kit',
    group: 'Project intelligence',
    description: 'Project readiness, instructions, skills, checks, and setup.',
    views: ['project-kit'],
    queries: [{ label: 'Project readiness', resource: '/api/project-kit' }],
  },
  {
    id: 'github',
    label: 'GitHub',
    group: 'Project intelligence',
    description:
      "Open pull requests and issues of the project's GitHub repository (WebUI view; no native page yet).",
    views: ['github'],
    queries: [{ label: 'Pull requests and issues', resource: '/api/github' }],
  },
  {
    id: 'intake',
    label: 'Requirement Intake',
    group: 'Project intelligence',
    description: 'Capture, refine, answer, submit, and archive requirements.',
    views: ['intake'],
    queries: [{ label: 'Requirements', resource: '/api/requirement-intakes' }],
  },
  {
    id: 'deadcode',
    label: 'Dead code',
    group: 'Project intelligence',
    description: 'Scan, inspect findings, and navigate to affected project files.',
    views: ['deadcode'],
    queries: [{ label: 'Available backups', resource: '/api/deadcode/backups' }],
  },
  {
    id: 'repository',
    label: 'Repository history',
    group: 'Project intelligence',
    description: 'Commit history, commit details, and file changes.',
    views: ['history'],
    queries: [
      { label: 'Repository', type: 'git.info' },
      { label: 'Commit history', type: 'git.history' },
    ],
  },
  {
    id: 'reviews',
    label: 'Chimera reviews',
    group: 'Project intelligence',
    description: 'Review reports, findings, notes, transitions, and evidence.',
    views: ['chimera'],
    settings: ['chimera'],
    queries: [
      { label: 'Review reports', type: 'chimera.reports.list', response: 'chimera.reports' },
    ],
  },
  {
    id: 'sessions',
    label: 'Session history & inspection',
    group: 'Operations',
    description: 'Core sessions, checkpoints, replay, inspection, and stories.',
    views: ['sessions', 'session-inspect', 'session-story'],
    queries: [
      { label: 'Core sessions', type: 'sessions.list' },
      { label: 'Session inspection', type: 'session.inspect' },
      { label: 'Checkpoints', type: 'session.checkpoints' },
    ],
  },
  {
    id: 'analytics',
    label: 'Analytics & usage',
    group: 'Operations',
    description: 'Token usage, cost, session metrics, and fleet activity.',
    views: ['analytics'],
    queries: [
      { label: 'Usage summary', resource: '/api/analytics/summary' },
      { label: 'Session statistics', type: 'stats.get' },
    ],
  },
  {
    id: 'providers',
    label: 'Providers & models',
    group: 'Configuration',
    description: 'Connections, vault keys, OAuth, models, fallbacks, and routing.',
    views: ['setup'],
    settings: ['provider', 'fallbacks', 'routing'],
    tab: 'settings',
  },
  {
    id: 'provider-health',
    label: 'Provider tests & quota',
    group: 'Configuration',
    description: 'Test model access, inspect provider status, plan quota, and audit history.',
    views: ['provider-test', 'provider-quota'],
    queries: [
      { label: 'Plan quota', type: 'provider.quota.get', response: 'provider.quota' },
      {
        label: 'Provider status',
        type: 'provider.status.get',
        response: 'provider.status.snapshot',
      },
      { label: 'Provider audit', type: 'provider.audit.get', response: 'provider.audit.history' },
    ],
  },
  {
    id: 'connections',
    label: 'MCP & integrations',
    group: 'Configuration',
    description: 'MCP servers, resources, prompts, tasks, auth, and service connections.',
    views: [],
    settings: ['connection', 'integrations'],
    queries: [
      { label: 'MCP servers', type: 'mcp.list' },
      {
        label: 'Connection health',
        type: 'connections.health',
        response: 'connections.health_result',
      },
    ],
  },
  {
    id: 'tools',
    label: 'Tools & permissions',
    group: 'Configuration',
    description: 'Tool registry, enabled tools, permission policy, and sandbox posture.',
    views: [],
    settings: ['security'],
    queries: [
      { label: 'Tool registry', type: 'tools.list' },
      { label: 'Sandbox', resource: '/api/sandbox/status' },
    ],
  },
  {
    id: 'brain',
    label: 'Brain & JEV',
    group: 'Configuration',
    description: 'Brain configuration, risk decisions, council, and reasoning policy.',
    views: [],
    settings: ['jev'],
    queries: [
      { label: 'Brain status', type: 'brain.status' },
      { label: 'Brain configuration', type: 'brain.config.get', response: 'brain.config' },
      { label: 'JEV', type: 'jev.get', response: 'jev.state' },
    ],
  },
  {
    id: 'settings',
    label: 'Application settings',
    group: 'Configuration',
    description: 'Appearance, agents, execution, fleet, logging, and display preferences.',
    views: ['settings'],
    settings: ['general', 'fonts', 'agent', 'execution', 'fleet', 'logs', 'display'],
    queries: [{ label: 'Preferences', type: 'prefs.get', response: 'prefs.updated' }],
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    group: 'Operations',
    description: 'Engine diagnostics, system state, connection health, and watcher metrics.',
    views: ['debug', 'refresh-debug'],
    queries: [
      { label: 'Engine diagnostics', type: 'diag.get' },
      { label: 'System', resource: '/debug/system' },
      { label: 'File watcher', resource: '/debug/watcher-metrics' },
    ],
  },
];
