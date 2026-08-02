import {
  Blocks,
  Cable,
  Database,
  FileClock,
  Fingerprint,
  Globe2,
  KeyRound,
  LockKeyhole,
  type LucideIcon,
  MessageSquareMore,
  Network,
  PackageOpen,
  PlugZap,
  Route,
  ScanSearch,
  Settings2,
  ShieldCheck,
  Sparkles,
  Workflow,
} from 'lucide-react';

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
    facts: ['29 bundled skills', 'First-seen shadowing by name', 'GitHub and registry install'],
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
export const version = '0.298.1';

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
