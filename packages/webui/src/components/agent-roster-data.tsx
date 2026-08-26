import { Activity, Bookmark, BookOpen, BrainCircuit, Building2, Settings } from 'lucide-react';

export const ROSTER_UPDATE_DEBOUNCE_MS = 300;

// ── Types ──────────────────────────────────────────────────────────────

export interface RosterAgentEntry {
  role: string;
  name: string;
  summary: string;
  tools: number;
  budget: {
    timeoutMs?: number;
    maxIterations?: number;
    maxToolCalls?: number;
  };
  /** Customization status — loaded from server-side agent-roster handler. */
  customized?: boolean;
  hasIdentity?: boolean;
  entryCount?: number;
  totalBytes?: number;
  lastCapture?: string | null;
  sessionCaptureCount?: number;
  needsSummarization?: boolean;
  custom?: boolean;
  systemProtected?: boolean;
  baseRole?: string;
  taskTypes?: string[];
}

export interface CustomRosterStats {
  role: string;
  exists: boolean;
  entryCount: number;
  totalBytes: number;
  lastCapture: string | null;
  cooldownRemainingMs: number;
  sessionCaptureCount: number;
  needsSummarization: boolean;
  hasIdentity: boolean;
  hasConfig: boolean;
  hasKnowledge: boolean;
  conflictCount?: number;
  sharedLearnedExists?: boolean;
  sharedIdentityExists?: boolean;
  learningEnabled: boolean;
  lifetimeCaptureCount: number;
  lastCaptureSource: 'automatic' | 'manual' | 'taught' | null;
  isConsolidated?: boolean;
  consolidation?: {
    consolidatedAt: string;
    sourceEntryCount: number;
    sourceBytes: number;
    consolidatedBytes: number;
    trigger: 'manual' | 'automatic';
    model?: string;
    /** Raw buffer archived and reset after the pass. */
    pruned?: boolean;
    archivePath?: string;
    /** Skill addenda refreshed by the pass. */
    skills?: string[];
  } | null;
  /** Skills this project has written a dedicated addendum for. */
  skills?: string[];
  /** Captured directives already routed to a skill, awaiting distillation. */
  skilledEntryCount?: number;
  /**
   * How the buffer is performing rather than how big it is.
   *
   * `lifetimeCaptureCount` measures volume, which says nothing about whether the
   * agent is learning the right things. These do: how many directives have
   * actually been exercised on a task, how many never have, and what share of
   * those applications ended in a successful task. `directiveHitRate` is null
   * until at least one directive has been exercised.
   */
  appliedEntryCount?: number;
  deadEntryCount?: number;
  directiveHitRate?: number | null;
}

// ── Tab definitions ────────────────────────────────────────────────────

export type RosterTab = 'live' | 'officemap' | 'catalog' | 'learning' | 'memory' | 'customize';

interface TabDef {
  id: RosterTab;
  icon: React.ReactNode;
  /** i18n key resolved at render time — this module is hook-free by design. */
  labelKey: string;
}

export const TABS: TabDef[] = [
  { id: 'live', icon: <Activity className="h-4 w-4" />, labelKey: 'activity:agentRoster.tabLive' },
  {
    id: 'officemap',
    icon: <Building2 className="h-4 w-4" />,
    labelKey: 'activity:agentRoster.tabOfficeMap',
  },
  {
    id: 'catalog',
    icon: <Bookmark className="h-4 w-4" />,
    labelKey: 'activity:agentRoster.tabCatalog',
  },
  {
    id: 'learning',
    icon: <BookOpen className="h-4 w-4" />,
    labelKey: 'activity:agentRoster.tabLearning',
  },
  {
    id: 'memory',
    icon: <BrainCircuit className="h-4 w-4" />,
    labelKey: 'activity:agentRoster.tabMemory',
  },
  {
    id: 'customize',
    icon: <Settings className="h-4 w-4" />,
    labelKey: 'activity:agentRoster.tabCustomize',
  },
];

// ── Known roster roles (mirrors FLEET_ROSTER from core) ────────────────
//
// `name`/`summary` below are the ENGLISH SOURCE, not display copy: this module
// is deliberately hook-free, so it cannot call `t()`. Render sites localize via
// `activity:rosterRoles.<role>.{name,summary}` and pass these strings as
// `defaultValue`, which also covers custom roles the server sends that have no
// catalog entry. Keep both in sync when a role is added.

export const KNOWN_ROLES: RosterAgentEntry[] = [
  {
    role: 'generic',
    name: 'Generic Project Agent',
    summary: 'Flexible template that can be cloned into independently learning project roles.',
    tools: 0,
    budget: { maxIterations: 2500, maxToolCalls: 7500 },
  },
  {
    role: 'audit-log',
    name: 'Audit Log',
    summary: 'Analyzes session logs, event streams, and system traces.',
    tools: 12,
    budget: { timeoutMs: 10800000, maxIterations: 2500, maxToolCalls: 7500 },
  },
  {
    role: 'bug-hunter',
    name: 'Bug Hunter',
    summary: 'Scans code for bugs, code smells, and anti-patterns.',
    tools: 15,
    budget: { timeoutMs: 18000000, maxIterations: 4000, maxToolCalls: 10000 },
  },
  {
    role: 'refactor-planner',
    name: 'Refactor Planner',
    summary: 'Analyzes code structure and produces phased refactoring plans.',
    tools: 14,
    budget: { timeoutMs: 14400000, maxIterations: 3000, maxToolCalls: 9000 },
  },
  {
    role: 'security-scanner',
    name: 'Security Scanner',
    summary: 'Scans code, configs, and dependencies for security issues.',
    tools: 18,
    budget: { timeoutMs: 18000000, maxIterations: 4000, maxToolCalls: 10000 },
  },
  {
    role: 'critic',
    name: 'Critic',
    summary: 'Evaluates decisions, plans, and implementations.',
    tools: 10,
    budget: { timeoutMs: 10800000, maxIterations: 2000, maxToolCalls: 5000 },
  },
  {
    role: 'shadow-agent',
    name: 'Shadow Agent',
    summary: 'Background monitoring agent that watches fleet health.',
    tools: 8,
    budget: { timeoutMs: 36000000, maxIterations: 500, maxToolCalls: 2000 },
  },
  {
    role: 'executor',
    name: 'Executor',
    summary: 'General-purpose task executor for delegated work.',
    tools: 20,
    budget: { timeoutMs: 7200000, maxIterations: 1500, maxToolCalls: 4000 },
  },
  {
    role: 'chimera',
    name: 'Chimera',
    summary: 'Post-session code quality review of changed files.',
    tools: 10,
    budget: { timeoutMs: 7200000, maxIterations: 1000, maxToolCalls: 3000 },
  },
  {
    role: 'researcher',
    name: 'Researcher',
    summary: 'Web research and data gathering specialist.',
    tools: 8,
    budget: { timeoutMs: 7200000, maxIterations: 1000, maxToolCalls: 3000 },
  },
  {
    role: 'tech-stack',
    name: 'Tech Stack Validator',
    summary: 'Validates package/library/framework choices.',
    tools: 9,
    budget: { timeoutMs: 7200000, maxIterations: 1000, maxToolCalls: 3000 },
  },
  {
    role: 'orchestrator',
    name: 'Orchestrator',
    summary: 'Coordinates multi-agent task execution.',
    tools: 12,
    budget: { timeoutMs: 14400000, maxIterations: 3000, maxToolCalls: 8000 },
  },
  {
    role: 'supervisor',
    name: 'Supervisor',
    summary: 'Oversees subagent execution and handles escalations.',
    tools: 10,
    budget: { timeoutMs: 14400000, maxIterations: 2000, maxToolCalls: 6000 },
  },
  {
    role: 'quality-gate',
    name: 'Quality Gate',
    summary: 'Enforces quality gates on implementations.',
    tools: 8,
    budget: { timeoutMs: 7200000, maxIterations: 1000, maxToolCalls: 3000 },
  },
  {
    role: 'architect',
    name: 'Architect',
    summary: 'Makes design and architecture decisions.',
    tools: 14,
    budget: { timeoutMs: 14400000, maxIterations: 3000, maxToolCalls: 8000 },
  },
  {
    role: 'prompt-engineer',
    name: 'Prompt Engineer',
    summary: 'Designs and optimizes system prompts.',
    tools: 8,
    budget: { timeoutMs: 7200000, maxIterations: 1000, maxToolCalls: 3000 },
  },
  {
    role: 'mnemosyne',
    name: 'Mnemosyne',
    summary: 'Memory curator — reviews and maintains SAGE integrity.',
    tools: 6,
    budget: { timeoutMs: 7200000, maxIterations: 500, maxToolCalls: 2000 },
  },
  {
    role: 'autophase',
    name: 'AutoPhase',
    summary: 'Manages multi-phase autonomous task execution.',
    tools: 10,
    budget: { timeoutMs: 14400000, maxIterations: 2000, maxToolCalls: 6000 },
  },
];

// ── Helpers for fleet agent displays ───────────────────────────────────
