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
  Layers3,
  LifeBuoy,
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
import { COMMAND_COUNT } from './content-commands';
import { TOOL_COUNT, PLUGIN_COUNT } from './runtime-catalog';

export { commandCategories, commandFromSlug, commandSlug, commands } from './content-commands';
export type { CommandCategory, CommandEntry } from './content-commands';
export {
  capabilityIndex,
  featureFromSlug,
  featureStories,
  primaryFeatureStories,
  systemSpotlightStories,
} from './content-features';
export type { Feature } from './content-features';
export {
  architectureLayers,
  creatorFeaturedProjects,
  creatorProfiles,
  creatorWorkshopProjects,
  docsUrl,
  ecosystemPillars,
  installCommand,
  license,
  nodeVersion,
  repoUrl,
  securityFacts,
  securityLayers,
  settingGroups,
  version,
} from './content-reference';
export type { SettingGroup } from './content-reference';
export { TOOL_COUNT, PLUGIN_COUNT } from './runtime-catalog';
export { SKILL_COUNT } from '../lib/utils';

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
    description: `All ${TOOL_COUNT} tools, permissions and tiers`,
    icon: Wrench,
    group: 'extend',
  },
  {
    href: '/plugins',
    label: 'Plugin catalog',
    description: `All ${PLUGIN_COUNT} plugins, risk and lifecycle`,
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
      'A React/Ink terminal interface with service health, copyable virtual history, status lines, pickers, fleet monitors, goal panels, worktrees and permission overlays—without leaving the terminal.',
    launch: 'wstack --tui',
    best: 'Long interactive coding sessions',
    traits: [
      'Keyboard-driven panels',
      'Live service health',
      'Fleet/agent monitors',
      'Copyable history and streams',
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
    title: `${TOOL_COUNT} built-in tools — WrongStack`,
    description:
      'Explore every built-in WrongStack tool, its permission level, mutability, execution contract and token-saving tier.',
  },
  '/plugins': {
    title: `${PLUGIN_COUNT} managed plugins — WrongStack`,
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
