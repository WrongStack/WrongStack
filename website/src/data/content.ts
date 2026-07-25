import {
  AppWindow,
  Bell,
  Blocks,
  Bot,
  BrainCircuit,
  Cable,
  CircleGauge,
  Command,
  Compass,
  Database,
  FileClock,
  FileText,
  Fingerprint,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  Globe2,
  KeyRound,
  Layers3,
  LifeBuoy,
  LockKeyhole,
  type LucideIcon,
  MemoryStick,
  MessageSquareMore,
  Monitor,
  Network,
  PackageOpen,
  Palette,
  PanelTop,
  PlugZap,
  Puzzle,
  Radar,
  Route,
  ScanSearch,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Workflow,
  Wrench,
} from 'lucide-react';

export const siteRoutes = [
  '/',
  '/features',
  '/how-it-works',
  '/compare',
  '/interfaces',
  '/commands',
  '/settings',
  '/architecture',
  '/ecosystem',
  '/security',
  '/getting-started',
  '/workflows',
  '/fleet',
  '/modes',
  '/agent-roster',
  '/mailbox',
  '/memory',
  '/providers',
  '/coding-plans',
  '/mcp',
  '/tools',
  '/plugins',
  '/troubleshooting',
  '/brand',
  '/created-by',
  '/sage',
  '/design-studio',
  '/skills',
  '/prompts',
  '/sdd',
  '/shadow-agent',
  '/acp',
  '/supervisor',
  '/goal',
  '/ensemble',
  '/hq',
  '/telegram',
  '/collab',
  '/sync',
  '/checkpoints',
  '/commit-workflow',
] as const;

export type SiteRoute = (typeof siteRoutes)[number];

export const primaryNav = [
  { href: '/features', label: 'Features' },
  { href: '/how-it-works', label: 'How it works' },
  { href: '/commands', label: 'Commands' },
  { href: '/settings', label: 'Settings' },
] as const;

export const moreNavGroups = [
  {
    id: 'learn',
    label: 'Learn the system',
    description: 'Start, understand, compare and choose.',
  },
  {
    id: 'work',
    label: 'Work & automate',
    description: 'Workflows, planning, execution and modes.',
  },
  {
    id: 'coordinate',
    label: 'Coordinate agents',
    description: 'Fleet, Brain, comms and collaboration.',
  },
  {
    id: 'extend',
    label: 'Build your stack',
    description: 'Tools, plugins, providers and customization.',
  },
  {
    id: 'operate',
    label: 'Operate & secure',
    description: 'Memory, security, diagnostics and sync.',
  },
] as const;

export const moreNav = [
  // learn: onboarding → the system itself → meta pages
  {
    href: '/getting-started',
    label: 'Getting started',
    description: 'Install, authenticate and run',
    icon: Compass,
    group: 'learn',
  },
  {
    href: '/interfaces',
    label: 'Interfaces',
    description: 'CLI, TUI, WebUI, SimpleUI, Desktop and HQ',
    icon: PanelTop,
    group: 'learn',
  },
  {
    href: '/architecture',
    label: 'Architecture',
    description: 'Kernel, pipeline and package map',
    icon: Layers3,
    group: 'learn',
  },
  {
    href: '/compare',
    label: 'Compare products',
    description: 'Claude Code, Codex, OpenCode, Cursor and Pi',
    icon: GitCompareArrows,
    group: 'learn',
  },
  {
    href: '/brand',
    label: 'Brand guidelines',
    description: 'Logo, colors, typography and voice',
    icon: Palette,
    group: 'learn',
  },
  {
    href: '/created-by',
    label: 'Created by',
    description: 'Ersin KOÇ and the open-source workshop',
    icon: Fingerprint,
    group: 'learn',
  },
  // work: workflows → execution → planning → modes → tracking
  {
    href: '/workflows',
    label: 'Workflows',
    description: 'Goals, SDD, Goal and reviews',
    icon: Workflow,
    group: 'learn',
  },
  {
    href: '/sdd',
    label: 'SDD workflow',
    description: 'Spec-driven plan, implement, verify',
    icon: FileText,
    group: 'work',
  },
  {
    href: '/goal',
    label: 'Goal',
    description: 'Autonomous worktrees with checkpoint rollback',
    icon: GitBranch,
    group: 'work',
  },
  {
    href: '/modes',
    label: 'Session modes',
    description: '19 balanced, lite and deep personas',
    icon: CircleGauge,
    group: 'work',
  },
  {
    href: '/features/kanban-work-queue',
    label: 'Kanban work queue',
    description: 'Durable tasks, dependencies and dispatch',
    icon: AppWindow,
    group: 'work',
  },
  {
    href: '/commit-workflow',
    label: 'Commit workflow',
    description: 'Generated conventional commits',
    icon: GitCommitHorizontal,
    group: 'work',
  },
  {
    href: '/checkpoints',
    label: 'Checkpoints',
    description: 'File state snapshots, rollback safety',
    icon: FileClock,
    group: 'work',
  },
  // coordinate: fleet → agents
  {
    href: '/fleet',
    label: 'Fleet & Brain',
    description: 'Director, agents, budgets and policy',
    icon: Network,
    group: 'coordinate',
  },
  {
    href: '/features/brain-council',
    label: 'Brain Council',
    description: 'Quorum, veto, weighted votes and judge',
    icon: BrainCircuit,
    group: 'coordinate',
  },
  {
    href: '/agent-roster',
    label: 'Agent roster',
    description: '50 phase roles, plus Shadow operational role',
    icon: Bot,
    group: 'coordinate',
  },
  {
    href: '/shadow-agent',
    label: 'Shadow Agent',
    description: 'Background fleet monitor and anomaly detection',
    icon: Radar,
    group: 'coordinate',
  },
  {
    href: '/supervisor',
    label: 'Supervisor',
    description: 'Brain-gated fleet safety and risk policy',
    icon: ShieldCheck,
    group: 'coordinate',
  },
  {
    href: '/acp',
    label: 'ACP',
    description: 'Drive Claude Code, Codex, Gemini CLI and more',
    icon: Cable,
    group: 'coordinate',
  },
  {
    href: '/ensemble',
    label: 'Ensemble',
    description: 'Parallel multi-agent reviews and voting',
    icon: GitCompareArrows,
    group: 'coordinate',
  },
  {
    href: '/collab',
    label: 'Collab debugging',
    description: 'BugHunter, RefactorPlanner, and Critic',
    icon: ScanSearch,
    group: 'work',
  },
  {
    href: '/hq',
    label: 'HQ Command Center',
    description: 'Web-based fleet control panel',
    icon: Monitor,
    group: 'coordinate',
  },
  {
    href: '/mailbox',
    label: 'Global Mailbox',
    description: 'Agent messages, presence and routing',
    icon: MessageSquareMore,
    group: 'coordinate',
  },
  // extend: tools → plugins → customization
  {
    href: '/tools',
    label: 'Built-in tools',
    description: 'All 58 tools, permissions and tiers',
    icon: Wrench,
    group: 'extend',
  },
  {
    href: '/plugins',
    label: 'Plugin catalog',
    description: 'All 73 plugins, risk and lifecycle',
    icon: PackageOpen,
    group: 'extend',
  },
  {
    href: '/mcp',
    label: 'MCP guide',
    description: 'Connect and operate external tools',
    icon: PlugZap,
    group: 'extend',
  },
  {
    href: '/ecosystem',
    label: 'Ecosystem',
    description: 'MCP, skills, plugins and hooks',
    icon: Blocks,
    group: 'extend',
  },
  {
    href: '/providers',
    label: 'Providers & models',
    description: 'Auth, routing, fallback and reasoning',
    icon: Sparkles,
    group: 'extend',
  },
  {
    href: '/coding-plans',
    label: 'Connect with',
    description: 'ChatGPT login and coding-plan keys',
    icon: Globe2,
    group: 'extend',
  },
  {
    href: '/features/customization',
    label: 'Customization',
    description: 'Models, prompts, tools, themes and policy',
    icon: Settings2,
    group: 'extend',
  },
  {
    href: '/design-studio',
    label: 'Design Studio',
    description: 'Curated UI kits, tokens and verification',
    icon: Palette,
    group: 'extend',
  },
  {
    href: '/skills',
    label: 'Skills',
    description: 'Installable agent knowledge packages',
    icon: Puzzle,
    group: 'operate',
  },
  {
    href: '/prompts',
    label: 'Prompts library',
    description: 'Reusable steering templates',
    icon: Sparkles,
    group: 'operate',
  },
  // operate: knowledge → memory → security → sync
  {
    href: '/memory',
    label: 'Memory & sessions',
    description: 'Continuity, recovery and verification',
    icon: MemoryStick,
    group: 'operate',
  },
  {
    href: '/sage',
    label: 'SAGE',
    description: 'Structured knowledge, scoring and graph',
    icon: Database,
    group: 'operate',
  },
  {
    href: '/security',
    label: 'Security',
    description: 'Permissions, vault and safe defaults',
    icon: ShieldCheck,
    group: 'operate',
  },
  {
    href: '/troubleshooting',
    label: 'Troubleshooting',
    description: 'Diagnose common failures quickly',
    icon: LifeBuoy,
    group: 'operate',
  },
  {
    href: '/telegram',
    label: 'Telegram',
    description: 'Notifications and approval prompts',
    icon: Bell,
    group: 'operate',
  },
  {
    href: '/sync',
    label: 'GitHub Sync',
    description: 'Sync config across machines',
    icon: Route,
    group: 'operate',
  },
] as const;

export const homeJourneys = [
  {
    index: '01',
    title: 'Get from install to first run',
    body: 'Choose authentication, initialize the project contract and start on the interface that fits your work.',
    href: '/getting-started',
    link: 'Open getting started',
  },
  {
    index: '02',
    title: 'Understand the agent loop',
    body: 'See exactly how a prompt becomes a provider request, permission decision, tool batch and persisted result.',
    href: '/how-it-works',
    link: 'Trace one request',
  },
  {
    index: '03',
    title: 'Find the right command',
    body: 'Search all documented commands by workflow, session, agent, configuration or developer task.',
    href: '/commands',
    link: 'Open command atlas',
  },
  {
    index: '04',
    title: 'Scale into a governed fleet',
    body: 'Learn Director tasks, specialist workers, model routing, independent budgets and Brain supervision.',
    href: '/fleet',
    link: 'Explore Fleet & Brain',
  },
  {
    index: '05',
    title: 'Configure it safely',
    body: 'Understand precedence, private project overrides, model routing, context policy and the untrusted repo boundary.',
    href: '/settings',
    link: 'Read settings guide',
  },
  {
    index: '06',
    title: 'Build your own stack',
    body: 'Add MCP tools, project skills, lifecycle hooks and plugins without forking the agent kernel.',
    href: '/ecosystem',
    link: 'Explore extension points',
  },
  {
    index: '07',
    title: 'Compare the operating models',
    body: 'Use official sources to compare WrongStack with Claude Code, Codex, OpenCode, Cursor and Pi—without invented benchmark scores.',
    href: '/compare',
    link: 'Open the comparison',
  },
] as const;

export type Feature = {
  slug: string;
  eyebrow: string;
  title: string;
  summary: string;
  details: string[];
  icon: LucideIcon;
  accent: 'red' | 'amber' | 'blue' | 'green' | 'purple';
};

export const featureStories: Feature[] = [
  {
    slug: 'tool-execution',
    eyebrow: 'Execution',
    title: 'Tools that act like production code',
    summary:
      'File, shell, Git, search, quality and codebase-index tools share one execution contract: schema validation, cancellation, progress streaming and permission checks.',
    details: [
      'Smart, sequential or parallel batch execution',
      'Malformed tool arguments repaired before validation',
      'Abort signals flow into subprocesses, walks and MCP calls',
      'Loop detection steers repeated work, then cuts persistent loops',
    ],
    icon: SquareTerminal,
    accent: 'red',
  },
  {
    slug: 'sessions-and-memory',
    eyebrow: 'Continuity',
    title: 'Sessions and memory survive the chat window',
    summary:
      'Append-only session logs preserve reconstructable history while SAGE stores verified project facts, anchors and relationships across sessions.',
    details: [
      'Crash recovery and date-sharded session storage',
      'Project, user and session memory scopes',
      'Automatic relevance-gated memory injection',
      'File-change hygiene re-verifies affected anchors',
    ],
    icon: MemoryStick,
    accent: 'purple',
  },
  {
    slug: 'multi-agent-fleet',
    eyebrow: 'Orchestration',
    title: 'A fleet, not a pile of background prompts',
    summary:
      'The Director queues structured work, routes specialist models, negotiates budgets and keeps agents aware of peers through mail, pulse digests and live events.',
    details: [
      'Per-agent iteration, token, cost and timeout budgets',
      'First-completion awaits and pending-task rebalancing',
      'Fleet Supervisor proposals gated by the Brain',
      'Worktree isolation and structured result hand-off',
    ],
    icon: Network,
    accent: 'blue',
  },
  {
    slug: 'provider-resilience',
    eyebrow: 'Resilience',
    title: 'Failures have a taxonomy and an escape route',
    summary:
      'Provider errors are classified once. Retry, cross-provider fallback and recovery then run in a fixed, bounded order instead of relying on scattered regex guesses.',
    details: [
      'Retry-After aware backoff with jitter',
      'Capacity-only cross-provider fallback',
      'Context overflow compaction and retry',
      'Cheaper-model and sibling reroute recovery',
    ],
    icon: Route,
    accent: 'amber',
  },
  {
    slug: 'brain-and-autonomy',
    eyebrow: 'Governance',
    title: 'Autonomy has a live ceiling',
    summary:
      'The Brain sits between autonomous consumers and the human. Deterministic policy runs first, optional LLM judgment second, and interactive escalation remains available.',
    details: [
      'Risk ceiling from off through all',
      'Exact option-id contract prevents fuzzy decisions',
      'Self-activation on tool failure streaks and error storms',
      'Decision events visible in TUI, WebUI and HQ',
    ],
    icon: BrainCircuit,
    accent: 'green',
  },
  {
    slug: 'model-routing',
    eyebrow: 'Model control',
    title: 'Route models by role, phase and failure profile',
    summary:
      'Use one model for the leader, another for reviewers, and a named fallback chain for capacity events. Runtime reasoning controls can vary without changing the model.',
    details: [
      'Catalog refreshed from models.dev',
      'API-key and subscription provider families',
      'Role → phase → wildcard → leader precedence',
      'Favorite models and automatic fallback derivation',
    ],
    icon: GitBranch,
    accent: 'red',
  },
  {
    slug: 'agent-workflow',
    eyebrow: 'Workflow system',
    title: 'From an open-ended request to a controlled delivery loop',
    summary:
      'Goals, todos, plans, SDD and Goal give work an explicit shape while steering commands keep the operator in control of the next move.',
    details: [
      'Goal and plan state remain visible across turns',
      'Spec-driven workflows connect requirements to evidence',
      'Goal advances through bounded delivery stages',
      'BTW and prompt enhancement add context without losing the objective',
    ],
    icon: Workflow,
    accent: 'red',
  },
  {
    slug: 'code-intelligence',
    eyebrow: 'Repository understanding',
    title: 'Navigate structure, symbols and meaning before editing',
    summary:
      'Fast file search, a persistent codebase index and an optional LSP bridge let the agent move from text matches to symbol-aware repository understanding.',
    details: [
      'Grep, glob and tree cover fast structural discovery',
      'Codebase index supports project-wide retrieval',
      'LSP diagnostics and go-to-definition add semantic context',
      'Monaco completion serves the graphical editing surface',
    ],
    icon: ScanSearch,
    accent: 'blue',
  },
  {
    slug: 'quality-system',
    eyebrow: 'Verification',
    title: 'Quality gates are part of the task, not an afterthought',
    summary:
      'Test, typecheck, lint, formatting, dependency auditing and security dispatch produce concrete evidence for the final answer.',
    details: [
      'Focused checks can run before full repository gates',
      'Streaming output keeps long validations observable',
      'Security work can route to dedicated scanners',
      'Results return through the same tool lifecycle as edits',
    ],
    icon: ShieldCheck,
    accent: 'green',
  },
  {
    slug: 'coordination-system',
    eyebrow: 'Team execution',
    title: 'One coordination layer across agents and surfaces',
    summary:
      'Director tasks, delegation, fleets, the global mailbox, collaborative debugging and ACP ensemble work share structured identities and events.',
    details: [
      'Task ownership and lineage stay authoritative',
      'Mailbox aliases connect CLI, TUI, WebUI and Desktop',
      'Collaborative debugging streams role-bound findings',
      'Pending tasks can be rebalanced without losing their identity',
    ],
    icon: Network,
    accent: 'purple',
  },
  {
    slug: 'context-management',
    eyebrow: 'Model window',
    title: 'Keep the useful context and preserve the original record',
    summary:
      'Context modes, calibrated token estimates and three compaction strategies protect the model window without rewriting the session audit trail.',
    details: [
      'Balanced, frugal, deep and archival operating modes',
      'Hybrid, intelligent and selective compaction',
      'Tool-use adjacency repaired after context surgery',
      'Hard overflow recovery compacts and retries deliberately',
    ],
    icon: Layers3,
    accent: 'amber',
  },
  {
    slug: 'observability',
    eyebrow: 'Operational visibility',
    title: 'Events, traces and health tell the same operational story',
    summary:
      'Typed events feed metrics, traces, health registries, side-effect audits and HQ alerts without coupling the agent kernel to one interface.',
    details: [
      'Typed EventBus covers the complete run lifecycle',
      'Metrics and tracing remain no-op until enabled',
      'HQ alerts emit only on state transitions',
      'Tool payloads are truncated and redacted before telemetry leaves scope',
    ],
    icon: Radar,
    accent: 'blue',
  },
  {
    slug: 'persistence',
    eyebrow: 'Durable state',
    title: 'Sessions, checkpoints and memory each preserve the right thing',
    summary:
      'Append-only session history, reversible checkpoints, replay tools, project registration and SAGE keep durable state explicit and recoverable.',
    details: [
      'Date-sharded reconstructable session logs',
      'Crash recovery through in-flight markers',
      'Checkpoint, replay and rewind serve different recovery needs',
      'Project-local memories retain verified facts and anchors',
    ],
    icon: Database,
    accent: 'purple',
  },
  {
    slug: 'extensibility',
    eyebrow: 'Open system',
    title: 'Extend tools and knowledge without forking the kernel',
    summary:
      'MCP servers, skills, plugins, lifecycle hooks, reusable prompts and provider adapters enter through explicit contracts and trust boundaries.',
    details: [
      'MCP transports support eager and lazy connection',
      'Skills load from project, user and compatible foreign layers',
      'Plugins declare capabilities before registration',
      'Hooks can steer and validate without bypassing permissions',
    ],
    icon: PlugZap,
    accent: 'green',
  },
  {
    slug: 'global-mailbox',
    eyebrow: 'Agent communication',
    title: 'Agents communicate through a durable project mailbox',
    summary:
      'Leaders, workers and every local surface exchange typed task, result, status, steer and broadcast messages without sharing mutable conversation state.',
    details: [
      'Session-unique identities plus convenient leader aliases',
      'Acknowledgement, completion and soft-delete lifecycle',
      'Heartbeats and stale-agent pruning keep presence accurate',
      'File locking and indexed reads make cross-process delivery safe',
    ],
    icon: MessageSquareMore,
    accent: 'amber',
  },
  {
    slug: 'kanban-work-queue',
    eyebrow: 'Durable work queue',
    title: 'Kanban connects human planning to fleet execution',
    summary:
      'Project boards carry dependency-aware tasks, assignment routing, acceptance criteria, measurable goals and Director-backed dispatch across sessions.',
    details: [
      'Atomic claiming prevents two agents taking the same work',
      'Dependencies, WIP limits, chains, split and merge lineage',
      'Per-task provider, model, role and tool routing',
      'TaskGraph, SDD and Goal import, sync and export',
    ],
    icon: PanelTop,
    accent: 'purple',
  },
  {
    slug: 'brain-council',
    eyebrow: 'Multi-model governance',
    title: 'A Brain Council can deliberate before high-risk autonomy',
    summary:
      'Multiple model seats with distinct personas, weights and optional veto rights can resolve risky decisions by quorum, majority or a separate judge.',
    details: [
      'Executor, auditor, skeptic and strategist perspectives',
      'Configurable minimum risk, quorum and weighted votes',
      'Veto seats can refuse unsafe proposals outright',
      'A persistent ledger feeds prior outcomes into later decisions',
    ],
    icon: BrainCircuit,
    accent: 'red',
  },
  {
    slug: 'customization',
    eyebrow: 'Make it yours',
    title: 'Every operating layer has an explicit customization point',
    summary:
      'Models, prompts, skills, tools, hooks, plugins, permissions, context, memory, interfaces and fleet roles can change without turning the kernel into a fork.',
    details: [
      'Global, project-local and session-level configuration layers',
      'Declarative model matrix, fallback profiles and runtime reasoning',
      'Project skills, prompt library and plugin capability contracts',
      'Theme, layout and surface preferences share the same product identity',
    ],
    icon: Settings2,
    accent: 'green',
  },
];

export const primaryFeatureStories = featureStories.slice(0, 6);
export const systemSpotlightStories = featureStories.slice(14);

export const capabilityIndex = [
  ['Agent workflow', 'Goals, todos, plans, SDD, Goal, BTW, prompt enhancement', 'agent-workflow'],
  [
    'Code intelligence',
    'Grep, glob, tree, codebase index, LSP bridge, Monaco completion',
    'code-intelligence',
  ],
  [
    'Quality',
    'Test, typecheck, lint, format, dependency audit, security dispatch',
    'quality-system',
  ],
  [
    'Coordination',
    'Director, delegate, fleets, mailbox, collab debug, ACP ensemble',
    'coordination-system',
  ],
  [
    'Context',
    'Four modes, three compactors, calibration, hard overflow recovery',
    'context-management',
  ],
  [
    'Observability',
    'Typed events, metrics, traces, health, side-effect audit, HQ alerts',
    'observability',
  ],
  [
    'Persistence',
    'Sessions, checkpoints, replay, rewind, SAGE, project registry',
    'persistence',
  ],
  ['Extensibility', 'MCP, skills, plugins, hooks, prompts and provider adapters', 'extensibility'],
] as const;

export const lifecycleSteps = [
  {
    number: '01',
    label: 'Shape input',
    title: 'User intent enters a pipeline, not a text box',
    body: 'The userInput pipeline can normalize, validate or enrich every turn. The resulting message is appended to observable conversation state and recorded by the live session writer.',
    code: 'user input → userInput pipeline → ConversationState',
    icon: MessageSquareMore,
  },
  {
    number: '02',
    label: 'Build context',
    title: 'Stable instructions, live state and relevant memory are assembled',
    body: 'Project instructions, skills, tools, session state and relevance-gated memories become a provider request. Context policy estimates the window before anything leaves the machine.',
    code: 'instructions + skills + tools + memory + messages',
    icon: Layers3,
  },
  {
    number: '03',
    label: 'Call a model',
    title: 'Provider adapters translate one internal contract',
    body: 'Anthropic, OpenAI, Google and OpenAI-compatible transports stream into the same response shape. Errors are classified at construction so downstream behavior stays deterministic.',
    code: 'request pipeline → provider stream → response pipeline',
    icon: Bot,
  },
  {
    number: '04',
    label: 'Govern action',
    title: 'Every tool call crosses hooks, validation and permission policy',
    body: 'PreToolUse hooks may deny or mutate input, schema validation repairs safe coercions, and the permission policy decides auto, confirm or deny. YOLO never overrides an explicit deny.',
    code: 'hooks → repair → validate → permission → execute',
    icon: Fingerprint,
  },
  {
    number: '05',
    label: 'Execute & observe',
    title: 'Tools stream progress and remain cancellable',
    body: 'The executor publishes logs, partial output, metrics, changed files and warnings. Results pass through the toolCall pipeline and return to conversation state for the next iteration.',
    code: 'tool.progress × n → final result → next iteration',
    icon: CircleGauge,
  },
  {
    number: '06',
    label: 'Persist & learn',
    title: 'The run leaves a reconstructable trail',
    body: 'Session events, checkpoints, usage and memory verification are written through serialized append paths. Compaction changes live context, never the raw audit history.',
    code: 'session JSONL + checkpoints + verified memory',
    icon: FileClock,
  },
] as const;

export const surfaces = [
  {
    id: 'cli',
    name: 'CLI / REPL',
    tagline: 'The direct line',
    description:
      'Fast, scriptable and close to the shell. Use it for single-shot work, interactive sessions, subcommands and automation-friendly output.',
    launch: 'wstack',
    best: 'Terminal-first work and scripts',
    traits: ['Streaming text', 'Slash commands', 'Non-interactive mode', 'All kernel capabilities'],
    icon: SquareTerminal,
  },
  {
    id: 'tui',
    name: 'TUI',
    tagline: 'The instrument panel',
    description:
      'A React/Ink terminal interface with status lines, pickers, fleet monitors, goal panels, worktrees and permission overlays—without leaving the terminal.',
    launch: 'wstack --tui',
    best: 'Long interactive coding sessions',
    traits: [
      'Keyboard-driven panels',
      'Live context and cost',
      'Fleet/agent monitors',
      'Mouse support',
    ],
    icon: Command,
  },
  {
    id: 'webui',
    name: 'WebUI',
    tagline: 'The rich workspace',
    description:
      'A per-session browser workspace with chat search, code editing, live tool progress, checkpoints, tasks and model routing. Run standalone or share the CLI agent.',
    launch: 'wstack --webui',
    best: 'Visual inspection and browser-based work',
    traits: [
      'Standalone or shared agent',
      'Monaco editor',
      'Auto-advancing ports',
      'Token-gated remote access',
    ],
    icon: Globe2,
  },
  {
    id: 'simpleui',
    name: 'SimpleUI',
    tagline: 'The lightweight chat',
    description:
      'A stripped-down browser chat for the agent—conversation, live tool progress and agent tabs without the full workspace. Fast to open when you just want to talk to the agent.',
    launch: 'wstack --simpleui',
    best: 'Quick browser chat without the full workspace',
    traits: [
      'Minimal chat surface',
      'Live tool progress',
      'Agent tabs and transcript',
      'Shares the CLI agent',
    ],
    icon: MessageSquareMore,
  },
  {
    id: 'desktop',
    name: 'Desktop',
    tagline: 'The local cockpit',
    description:
      'An Electron shell for multiple local projects and concurrent sessions, with native navigation, runtime isolation and persistent workspace state.',
    launch: 'wstack --desktop',
    best: 'Many projects and concurrent sessions',
    traits: [
      'Multi-project launcher',
      'Isolated runtime ports',
      'Native menus',
      'Workspace restoration',
    ],
    icon: AppWindow,
  },
  {
    id: 'hq',
    name: 'HQ Command Center',
    tagline: 'The control plane',
    description:
      'A project-independent dashboard that aggregates every connected surface. Inspect live sessions, costs, agents, worktrees, alerts and mailbox traffic from one place.',
    launch: 'wstack --hq',
    best: 'Cross-session and cross-machine operations',
    traits: [
      'Live console',
      'PromptDock steering',
      'Capability-scoped tokens',
      'Persisted telemetry',
    ],
    icon: Radar,
  },
] as const;

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

export const pageMeta: Record<SiteRoute, { title: string; description: string }> = {
  '/': {
    title: 'WrongStack — AI coding, under your control',
    description:
      'A terminal-native AI coding agent with tools, memory, multi-agent fleets, MCP, WebUI, Desktop and explicit permission control.',
  },
  '/features': {
    title: 'Features — WrongStack',
    description:
      'Explore WrongStack tools, autonomy, memory, model routing, sessions and developer workflows.',
  },
  '/how-it-works': {
    title: 'How WrongStack works',
    description:
      'Follow one request through context, providers, tools, permissions, retries, memory and persistence.',
  },
  '/compare': {
    title: 'WrongStack vs Claude Code, Codex, OpenCode, Cursor & Pi',
    description:
      'An evidence-based, official-source comparison of model routing, multi-agent coordination, mailbox, work tracking, extensions, security and operations.',
  },
  '/interfaces': {
    title: 'CLI, TUI, WebUI, SimpleUI, Desktop & HQ — WrongStack',
    description: 'Six interfaces, one agent kernel. Choose the surface that fits the way you work.',
  },
  '/commands': {
    title: 'Slash command reference — WrongStack',
    description: `Search and understand ${COMMAND_COUNT} documented WrongStack operator commands.`,
  },
  '/settings': {
    title: 'Settings & configuration — WrongStack',
    description:
      'Configure providers, models, tools, context, fleets, sessions and security safely.',
  },
  '/architecture': {
    title: 'Architecture — WrongStack',
    description:
      'Understand the kernel, package boundaries, execution pipeline, recovery and persistence model.',
  },
  '/ecosystem': {
    title: 'MCP, skills, plugins & hooks — WrongStack',
    description:
      'Extend WrongStack with MCP servers, reusable skills, plugins, prompts and lifecycle hooks.',
  },
  '/security': {
    title: 'Security model — WrongStack',
    description:
      'Permissions, encrypted secrets, network boundaries, project config safety and audit trails.',
  },
  '/getting-started': {
    title: 'Getting started — WrongStack',
    description:
      'Install WrongStack, choose authentication, initialize a project and run your first safe coding session.',
  },
  '/workflows': {
    title: 'Workflows — WrongStack',
    description:
      'Choose between goals, SDD, Goal, BTW, collaboration, ensemble and review workflows.',
  },
  '/fleet': {
    title: 'Fleet & Brain — WrongStack',
    description:
      'Understand Director orchestration, specialist agents, budgets, supervision and Brain-governed decisions.',
  },
  '/modes': {
    title: 'Session modes — WrongStack',
    description:
      'Compare all 19 built-in WrongStack persona modes, from token-saving lite passes to deep specialist workflows.',
  },
  '/agent-roster': {
    title: 'Agent roster — WrongStack',
    description:
      'Explore 50 selectable phase roles, the separate Shadow operational role (51 built-ins total), and five optional ACP roles.',
  },
  '/mailbox': {
    title: 'Global Mailbox — WrongStack',
    description:
      'Understand typed cross-agent communication, identities, aliases, heartbeats, message lifecycle and the project mailbox bridge.',
  },
  '/memory': {
    title: 'Memory & sessions — WrongStack',
    description:
      'Learn how session logs, SAGE, checkpoints, compaction, replay and recovery preserve continuity.',
  },
  '/providers': {
    title: 'Providers & model routing — WrongStack',
    description:
      'Configure API-key and subscription providers, model routing, fallback chains and runtime reasoning controls.',
  },
  '/coding-plans': {
    title: 'Connect ChatGPT, OpenCode, MiniMax, Z.AI & Kimi — WrongStack',
    description:
      'Connect WrongStack with ChatGPT Codex sign-in or dedicated OpenCode, MiniMax, Z.AI and Kimi coding-plan API keys.',
  },
  '/mcp': {
    title: 'MCP guide — WrongStack',
    description: 'Connect, secure and operate MCP servers over stdio, SSE and streamable HTTP.',
  },
  '/tools': {
    title: '58 built-in tools — WrongStack',
    description:
      'Explore every built-in WrongStack tool, its permission level, mutability, execution contract and token-saving tier.',
  },
  '/plugins': {
    title: '73 managed plugins — WrongStack',
    description:
      'Search all managed first-party WrongStack plugins by source, default state and operational risk.',
  },
  '/troubleshooting': {
    title: 'Troubleshooting — WrongStack',
    description:
      'Diagnose provider, context, tool, MCP, session, plugin and terminal issues methodically.',
  },
  '/brand': {
    title: 'Brand guidelines — WrongStack',
    description:
      'Download the WrongStack logo and use the canonical colors, typography, naming and voice guidelines.',
  },
  '/created-by': {
    title: 'Created by Ersin KOÇ — WrongStack',
    description:
      'Meet WrongStack creator Ersin KOÇ and explore AGEZT, OwnPilot and the wider open-source project workshop.',
  },
  '/sage': {
    title: 'SAGE — WrongStack',
    description:
      'Persistent, structured knowledge that the agent remembers across sessions. Scopes, types, relevance scoring, graph edges, and auto-injection.',
  },
  '/design-studio': {
    title: 'Design Studio — WrongStack',
    description:
      '48+ curated design kits. Pin one, materialize CSS tokens, and the agent builds themed, accessible UI.',
  },
  '/skills': {
    title: 'Skills — WrongStack',
    description:
      'Installable packages of instructions that auto-activate on trigger words. Teach the agent new capabilities.',
  },
  '/prompts': {
    title: 'Prompts library — WrongStack',
    description:
      'Reusable prompt templates across bundled, user, and project layers. Variables, favorites, and AI-assisted authoring.',
  },
  '/sdd': {
    title: 'SDD workflow — WrongStack',
    description:
      'Spec-Driven Development: plan, implement, and verify in structured phases with review between each step.',
  },
  '/shadow-agent': {
    title: 'Shadow Agent — WrongStack',
    description:
      'Background fleet monitor that detects stuck agents, spike tasks, and anomalies on a cron schedule.',
  },
  '/acp': {
    title: 'ACP — WrongStack',
    description:
      'Drive external coding agents (Claude Code, Codex CLI, Gemini CLI) from WrongStack using their existing logins.',
  },
  '/supervisor': {
    title: 'Fleet Supervisor — WrongStack',
    description:
      'Brain-gated safety layer that approves or blocks fleet actions against risk thresholds.',
  },
  '/goal': {
    title: 'Goal — WrongStack',
    description:
      'Fully autonomous phased workflows with git worktree isolation and checkpoint rollback.',
  },
  '/ensemble': {
    title: 'Ensemble — WrongStack',
    description:
      'Fan one task to multiple ACP agents simultaneously. Compare independent results side by side.',
  },
  '/hq': {
    title: 'HQ Command Center — WrongStack',
    description:
      'Web-based fleet control panel. Monitor status, send steer prompts, and queue work from a browser.',
  },
  '/telegram': {
    title: 'Telegram integration — WrongStack',
    description:
      'Push notifications, interactive approval prompts, and remote commands through Telegram.',
  },
  '/collab': {
    title: 'Collab debugging — WrongStack',
    description:
      'BugHunter, RefactorPlanner, and Critic run in parallel and produce a structured verdict.',
  },
  '/sync': {
    title: 'GitHub Sync — WrongStack',
    description:
      'Sync settings, skills, prompts, and memory across machines through a GitHub repository.',
  },
  '/checkpoints': {
    title: 'Checkpoints — WrongStack',
    description: 'File state snapshots before risky edits. Roll back to the last known-good state.',
  },
  '/commit-workflow': {
    title: 'Commit workflow — WrongStack',
    description:
      'Auto-generated conventional commits from your diff. Stage, review, and commit with one command.',
  },
};

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

export function featureFromSlug(slug: string) {
  return featureStories.find((feature) => feature.slug === slug);
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

export type SettingGroup = {
  name: string;
  description: string;
  icon: LucideIcon;
  fields: Array<{ key: string; defaultValue: string; explanation: string }>;
};

export const settingGroups: SettingGroup[] = [
  {
    name: 'Provider & model',
    description: 'Choose the wire family, credential source, active model and endpoint.',
    icon: Sparkles,
    fields: [
      { key: 'provider', defaultValue: 'required', explanation: 'Active provider id.' },
      { key: 'model', defaultValue: 'required', explanation: 'Active leader model id.' },
      {
        key: 'providers.<id>',
        defaultValue: '{}',
        explanation: 'Per-provider key, URL, model, headers and capability overrides.',
      },
      {
        key: 'favoriteModels',
        defaultValue: '[]',
        explanation: 'Models promoted in pickers and automatic fallback.',
      },
    ],
  },
  {
    name: 'Routing & fallback',
    description: 'Send roles and phases to different models and survive capacity failures.',
    icon: Route,
    fields: [
      {
        key: 'fallbackModels',
        defaultValue: '[]',
        explanation: 'Ordered same- or cross-provider fallback chain.',
      },
      {
        key: 'fallbackAuto',
        defaultValue: 'true',
        explanation: 'Derive a fallback chain from configured providers.',
      },
      {
        key: 'fallbackProfiles',
        defaultValue: '{}',
        explanation: 'Named fallback chains reusable by routes.',
      },
      {
        key: 'modelMatrix',
        defaultValue: '{}',
        explanation: 'Exact role → phase → * → leader routing.',
      },
    ],
  },
  {
    name: 'Context',
    description: 'Control how much history is kept and when compaction begins.',
    icon: Database,
    fields: [
      {
        key: 'context.mode',
        defaultValue: 'balanced',
        explanation: 'balanced, frugal, deep or archival policy.',
      },
      {
        key: 'context.strategy',
        defaultValue: 'hybrid',
        explanation: 'hybrid, intelligent or selective compaction.',
      },
      {
        key: 'context.autoCompact',
        defaultValue: 'true',
        explanation: 'Compact automatically when thresholds are crossed.',
      },
      {
        key: 'context.warn/soft/hardThreshold',
        defaultValue: '.60/.75/.90',
        explanation: 'Three-stage window pressure thresholds.',
      },
    ],
  },
  {
    name: 'Tools & runtime',
    description: 'Bound execution, choose batching and stop repeated calls.',
    icon: Settings2,
    fields: [
      {
        key: 'tools.defaultExecutionStrategy',
        defaultValue: 'smart',
        explanation: 'smart, parallel or sequential batches.',
      },
      {
        key: 'tools.maxIterations',
        defaultValue: '100',
        explanation: 'Soft iteration ceiling; can auto-extend.',
      },
      {
        key: 'tools.iterationTimeoutMs',
        defaultValue: '300000',
        explanation: 'Five-minute per-iteration deadline.',
      },
      {
        key: 'tools.loopDetection.mode',
        defaultValue: 'steer-then-cut',
        explanation: 'Correct repetition before terminating it.',
      },
    ],
  },
  {
    name: 'Fleet',
    description: 'Set worker concurrency, lifecycle, worktrees and shared budgets.',
    icon: Network,
    fields: [
      {
        key: 'fleet.maxConcurrent',
        defaultValue: '4',
        explanation: 'Maximum simultaneously active subagents.',
      },
      {
        key: 'fleet.lifecycle',
        defaultValue: 'host defaults',
        explanation: 'Retirement and between-task idle behavior.',
      },
      {
        key: 'fleet.budget',
        defaultValue: '{}',
        explanation: 'Spawn, token and cost ceilings across the fleet.',
      },
      {
        key: 'fleet.supervisor',
        defaultValue: '{}',
        explanation: 'Brain-gated fleet supervision controls.',
      },
    ],
  },
  {
    name: 'Session & observability',
    description: 'Choose recording detail and enable metrics, traces and health.',
    icon: FileClock,
    fields: [
      {
        key: 'session.auditLevel',
        defaultValue: 'standard',
        explanation: 'Controls optional audit-event detail.',
      },
      { key: 'log.level', defaultValue: 'info', explanation: 'Runtime log verbosity.' },
      {
        key: '--metrics',
        defaultValue: 'off',
        explanation: 'Enables metrics and health surfaces.',
      },
      { key: '--metrics-port', defaultValue: '9090', explanation: 'Prometheus endpoint port.' },
    ],
  },
];

export const architectureLayers = [
  {
    label: 'Surfaces',
    packages: ['apps/wrongstack', 'desktop', 'cli', 'tui', 'webui', 'webui-hq'],
    description: 'Human interaction, rendering and process boot.',
    tone: 'red',
  },
  {
    label: 'Composition',
    packages: ['runtime', 'webui-server', 'telegram', 'plugins', 'bench'],
    description: 'Host wiring, servers, integrations and optional capabilities.',
    tone: 'amber',
  },
  {
    label: 'Capabilities',
    packages: ['providers', 'tools', 'mcp', 'plug-lsp', 'acp', 'kanban', 'sdd', 'sage'],
    description: 'Contracts and implementations used by every surface.',
    tone: 'blue',
  },
  {
    label: 'Kernel',
    packages: ['core'],
    description: 'Container, pipelines, events, context, lifecycle and coordination primitives.',
    tone: 'green',
  },
] as const;

export const ecosystemPillars = [
  {
    name: 'MCP servers',
    icon: PlugZap,
    headline: 'Bring tools over a standard protocol',
    body: 'Connect stdio, SSE or streamable-HTTP servers. Tools are namespaced, permissioned, lazily connectable and cancellable through JSON-RPC notifications.',
    facts: [
      'Manifest cache for lazy servers',
      'Single-flight first connection',
      'Five-cycle reconnect cap',
    ],
    command: '/mcp',
  },
  {
    name: 'Skills',
    icon: ScanSearch,
    headline: 'Package repeatable expert behavior',
    body: 'Skills are portable SKILL.md instruction sets discovered from project, user, foreign-agent and bundled layers. Eager or progressive injection keeps the prompt bounded.',
    facts: ['25 bundled skills', 'First-seen shadowing by name', 'GitHub and registry install'],
    command: '/skill',
  },
  {
    name: 'Plugins',
    icon: PackageOpen,
    headline: 'Extend the runtime without reversing dependencies',
    body: 'Plugins declare explicit capabilities, receive a scoped API and can register tools, providers, slash commands, MCP integrations and pipeline middleware.',
    facts: [
      'Setup and teardown lifecycle',
      'Official bare command names',
      'Per-plugin extension config',
    ],
    command: '/plugin',
  },
  {
    name: 'Lifecycle hooks',
    icon: Workflow,
    headline: 'Steer execution at trusted boundaries',
    body: 'Command, HTTP and in-process hooks can observe lifecycle events. PreToolUse hooks may allow, deny or mutate before the normal permission policy still makes the final call.',
    facts: [
      'Deadlines and cancellation',
      'Open or closed failure policy',
      'Matcher-based filtering',
    ],
    command: 'config.hooks',
  },
  {
    name: 'Prompt library',
    icon: MessageSquareMore,
    headline: 'Keep useful prompts close to the project',
    body: 'Project, user and bundled prompts merge by slug. Editing a bundled prompt creates a user-layer fork, so the shipped dataset remains immutable.',
    facts: ['Variable rendering', 'Favorites and search', 'AI-assisted authoring'],
    command: '/prompt',
  },
  {
    name: 'Provider adapters',
    icon: Cable,
    headline: 'Add a model family behind one contract',
    body: 'Adapters translate streaming text, tool calls, usage and provider errors into the kernel contract. Consumers never need provider-specific status heuristics.',
    facts: ['Four wire families', 'OAuth subscription providers', 'Capability overrides'],
    command: 'provider API',
  },
] as const;

export const securityLayers = [
  {
    number: '01',
    title: 'Capability declaration',
    body: 'Tools and plugins declare what they can do before they enter the runtime. Missing capabilities stay unavailable.',
    icon: Blocks,
  },
  {
    number: '02',
    title: 'Hooks and input validation',
    body: 'Mutating hooks compose first, validating hooks inspect the final input, and JSON Schema validation rejects what cannot be repaired safely.',
    icon: ScanSearch,
  },
  {
    number: '03',
    title: 'Permission policy',
    body: 'Each tool is auto, confirm or deny. Trust rules, sensitive paths and destructive patterns refine the decision. Explicit deny survives YOLO.',
    icon: Fingerprint,
  },
  {
    number: '04',
    title: 'Runtime boundaries',
    body: 'Cancellation, timeouts, network checks, path containment and output limits constrain work while it runs.',
    icon: LockKeyhole,
  },
  {
    number: '05',
    title: 'Audit and recovery',
    body: 'Session events, side-effect records, redacted telemetry and append-only state preserve evidence without broadcasting secrets.',
    icon: FileClock,
  },
] as const;

export const installCommand = 'npm install -g wrongstack';
export const repoUrl = 'https://github.com/WrongStack/WrongStack';
export const docsUrl = `${repoUrl}/tree/main/docs`;
export const version = '0.295.3';

export const nodeVersion = '22.19+';
export const license = 'MIT';

/* =========================================================================
   Creator — shared between the homepage "Created by" card and /created-by.
   ========================================================================= */

export const creatorProfiles = [
  { label: 'GitHub', handle: '@ersinkoc', href: 'https://github.com/ersinkoc' },
  { label: 'X', handle: '@ersinkoc', href: 'https://x.com/ersinkoc' },
  { label: 'Web', handle: 'ersinkoc.com', href: 'https://www.ersinkoc.com' },
] as const;

export const creatorFeaturedProjects = [
  {
    name: 'WrongStack',
    eyebrow: 'AI coding agent',
    language: 'TypeScript',
    href: 'https://github.com/WrongStack/WrongStack',
    description:
      'A governed coding agent that reads repositories, runs tools and coordinates specialist fleets across terminal, browser and desktop surfaces.',
  },
  {
    name: 'AGEZT',
    eyebrow: 'Agentic operating system',
    language: 'Go',
    href: 'https://github.com/agezt/agezt',
    description:
      'An open-source, MIT-licensed agentic operating system designed to make autonomous software work feel like a coherent runtime.',
  },
  {
    name: 'OwnPilot',
    eyebrow: 'Personal AI platform',
    language: 'TypeScript',
    href: 'https://github.com/ownpilot/OwnPilot',
    description:
      'A privacy-first, self-hosted personal AI platform with autonomous agents, tool orchestration, multi-provider routing and persistent personal workflows.',
  },
] as const;

export const creatorWorkshopProjects = [
  {
    name: 'DFMT',
    description: 'Token and context preservation for machine-readable work.',
    href: 'https://github.com/ersinkoc/dfmt',
  },
  {
    name: 'NothingDNS',
    description: 'A complete DNS server built as open infrastructure.',
    href: 'https://github.com/NothingDNS/NothingDNS',
  },
  {
    name: 'Labyrinth',
    description: 'A pure Go recursive DNS resolver with a web dashboard.',
    href: 'https://github.com/labyrinthdns/labyrinth',
  },
  {
    name: 'CobaltDB',
    description: 'A modern embedded database for Go applications.',
    href: 'https://github.com/cobaltdb/cobaltdb',
  },
  {
    name: 'GuardianWAF',
    description: 'An open-source web application firewall.',
    href: 'https://github.com/GuardianWAF/GuardianWAF',
  },
  {
    name: 'UWAS',
    description:
      'A unified web server combining proxy, cache, HTTPS, WAF and dashboard capabilities.',
    href: 'https://github.com/uwaserver/uwas',
  },
] as const;
export const securityFacts = [
  {
    icon: KeyRound,
    title: 'Secret vault',
    body: 'API keys are encrypted per machine with AES-256-GCM and a random IV per write.',
  },
  {
    icon: LockKeyhole,
    title: 'Untrusted repo config',
    body: 'In-project config passes through an explicit allow-list; provider URLs, hooks, MCP, plugins and fleet settings are stripped.',
  },
  {
    icon: Globe2,
    title: 'Loopback first',
    body: 'WebUI, mailbox and MCP surfaces default to local-only access. Remote WebUI binds require token protection.',
  },
  {
    icon: ShieldCheck,
    title: 'Read-only mode',
    body: 'Research and explore without risk. Session-scoped toggle prevents filesystem writes, shell commands and memory mutations — only .md reports under .temp_files/ are allowed.',
  },
] as const;
