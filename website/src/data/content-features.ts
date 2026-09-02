import {
  BrainCircuit,
  Database,
  GitBranch,
  GraduationCap,
  Layers3,
  MemoryStick,
  MessageSquareMore,
  Network,
  PanelTop,
  PlugZap,
  Radar,
  Route,
  Satellite,
  ScanSearch,
  Settings2,
  ShieldCheck,
  SquareTerminal,
  type LucideIcon,
  Workflow,
} from 'lucide-react';

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
    slug: 'self-developing-agents',
    eyebrow: 'Learning',
    title: 'Roster agents develop skills for your codebase',
    summary:
      "A subagent ends a run with a tagged directive; the runtime routes it to the skill it refines and distils it into a project addendum injected beneath that skill on every future spawn. The agent doesn't recall a fact about your repo — its skill is better here.",
    details: [
      'Directives are captured from failed runs too, then quality-gated into what / why / how',
      'Distillation runs unattended, debounced and rate-limited, with a manual override',
      'Which skills load is ranked by what the project actually developed',
      'Committed under .wrongstack/agents/, so a fresh clone starts trained',
    ],
    icon: GraduationCap,
    accent: 'green',
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
      'One IPC owner serializes SQLite delivery across every process',
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
      'One SQLite owner plus live IPC events for every surface',
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
  {
    slug: 'wrongtrace-integration',
    eyebrow: 'Optional sibling',
    title: 'WrongTrace guardrails coordinate fleet edits without becoming a dependency',
    summary:
      'An optional external daemon contributes file health, edit locks, friction metrics and repository atlas signals over HTTP, IPC and MCP — and its absence never blocks an edit.',
    details: [
      'Mutating tools pass a fail-open lock gate on every host surface',
      'Fragile files get a surgical-edit nudge; foreign locks deny with owner and expiry',
      'HTTP, JSON-RPC pipe and MCP transports route per method',
      'Optional provider traffic rerouting through the same local daemon',
    ],
    icon: Satellite,
    accent: 'blue',
  },
];

export const primaryFeatureStories = featureStories.slice(0, 6);
export const systemSpotlightStories = featureStories.slice(14);

export function featureFromSlug(slug: string) {
  return featureStories.find((feature) => feature.slug === slug);
}

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
  ['Persistence', 'Sessions, checkpoints, replay, rewind, SAGE, project registry', 'persistence'],
  ['Extensibility', 'MCP, skills, plugins, hooks, prompts and provider adapters', 'extensibility'],
] as const;
