export type ModeFamily = 'balanced' | 'lite' | 'deep';

export type ModeCatalogEntry = {
  id: string;
  name: string;
  family: ModeFamily;
  description: string;
  toolPreferences: readonly string[];
  suggestedSkills: readonly string[];
};

/**
 * Mirrors packages/core/src/types/mode.ts. website/vite.config.ts compares the
 * ids during every build so additions in core cannot silently disappear here.
 */
export const modeCatalog = [
  {
    id: 'default',
    name: 'Default',
    family: 'balanced',
    description:
      'Balanced general-purpose mode for work that needs no special token or coverage trade-off.',
    toolPreferences: [],
    suggestedSkills: [],
  },
  {
    id: 'brief',
    name: 'Brief',
    family: 'lite',
    description: 'Ultra-compact responses for low-context, high-speed work.',
    toolPreferences: ['read', 'edit', 'bash'],
    suggestedSkills: [],
  },
  {
    id: 'review-lite',
    name: 'Review Lite',
    family: 'lite',
    description: 'Changed files only, focused on the highest correctness and security risks.',
    toolPreferences: ['git', 'diff', 'read', 'grep'],
    suggestedSkills: ['bug-hunter', 'typescript-strict'],
  },
  {
    id: 'audit-lite',
    name: 'Audit Lite',
    family: 'lite',
    description: 'Security triage for a small diff or explicitly named file.',
    toolPreferences: ['grep', 'read', 'git'],
    suggestedSkills: ['security-scanner'],
  },
  {
    id: 'plan-lite',
    name: 'Plan Lite',
    family: 'lite',
    description: 'Three to six actionable steps with minimal design debate.',
    toolPreferences: ['tree', 'glob', 'read', 'grep'],
    suggestedSkills: ['refactor-planner'],
  },
  {
    id: 'debug-lite',
    name: 'Debug Lite',
    family: 'lite',
    description: 'One leading hypothesis, the nearest evidence and the narrowest useful check.',
    toolPreferences: ['read', 'grep', 'test', 'logs'],
    suggestedSkills: ['bug-hunter'],
  },
  {
    id: 'test-lite',
    name: 'Test Lite',
    family: 'lite',
    description: 'One focused regression or narrow verification target.',
    toolPreferences: ['test', 'read', 'grep'],
    suggestedSkills: ['testing'],
  },
  {
    id: 'refactor-lite',
    name: 'Refactor Lite',
    family: 'lite',
    description: 'Small, scoped, behavior-preserving cleanup without opportunistic rewrites.',
    toolPreferences: ['read', 'edit', 'test'],
    suggestedSkills: ['typescript-strict'],
  },
  {
    id: 'research-lite',
    name: 'Research Lite',
    family: 'lite',
    description: 'One search, one authoritative fetch and a short current-data answer.',
    toolPreferences: ['search', 'fetch'],
    suggestedSkills: ['research-web'],
  },
  {
    id: 'code-reviewer',
    name: 'Review Deep',
    family: 'deep',
    description:
      'Comprehensive review across contracts, edge cases, lifecycle, errors, concurrency and security.',
    toolPreferences: ['read', 'grep', 'git', 'diff', 'test'],
    suggestedSkills: ['bug-hunter', 'security-scanner', 'typescript-strict', 'testing'],
  },
  {
    id: 'code-auditor',
    name: 'Audit Deep',
    family: 'deep',
    description: 'Comprehensive security audit with category coverage and exploitability notes.',
    toolPreferences: ['grep', 'read', 'audit', 'bash'],
    suggestedSkills: ['security-scanner', 'bug-hunter', 'audit-log'],
  },
  {
    id: 'architect',
    name: 'Architecture Deep',
    family: 'deep',
    description: 'Comprehensive architecture and cross-module contract analysis.',
    toolPreferences: ['read', 'glob', 'tree', 'diff'],
    suggestedSkills: ['api-design', 'refactor-planner', 'node-modern', 'docker-deploy'],
  },
  {
    id: 'debugger',
    name: 'Debug Deep',
    family: 'deep',
    description: 'Root-cause analysis with traces, logs, assumptions and explicit verification.',
    toolPreferences: ['read', 'grep', 'bash', 'logs', 'test'],
    suggestedSkills: ['bug-hunter', 'audit-log', 'observability'],
  },
  {
    id: 'tester',
    name: 'Test Deep',
    family: 'deep',
    description: 'Comprehensive QA across coverage, boundaries, isolation and integration gaps.',
    toolPreferences: ['read', 'grep', 'test', 'bash'],
    suggestedSkills: ['testing', 'bug-hunter', 'typescript-strict'],
  },
  {
    id: 'devops',
    name: 'DevOps Deep',
    family: 'deep',
    description: 'Infrastructure, deployment, observability and operational readiness review.',
    toolPreferences: ['read', 'bash', 'grep', 'logs', 'git'],
    suggestedSkills: ['docker-deploy', 'observability', 'security-scanner'],
  },
  {
    id: 'refactorer',
    name: 'Refactor Deep',
    family: 'deep',
    description: 'Modernization and refactoring with contract and verification discipline.',
    toolPreferences: ['read', 'edit', 'test', 'git', 'grep'],
    suggestedSkills: ['refactor-planner', 'typescript-strict', 'node-modern', 'testing'],
  },
  {
    id: 'ui-design',
    name: 'UI Design Deep',
    family: 'deep',
    description: 'Design-first frontend and mobile UI work with tokens, kits and accessibility.',
    toolPreferences: ['design', 'write', 'edit', 'read', 'scaffold'],
    suggestedSkills: ['react-modern'],
  },
  {
    id: 'teach',
    name: 'Teach Deep',
    family: 'deep',
    description: 'Mentor behavior with explanations, mental models, trade-offs and takeaways.',
    toolPreferences: ['read', 'edit', 'explain'],
    suggestedSkills: ['prompt-engineering', 'skill-creator', 'node-modern', 'typescript-strict'],
  },
  {
    id: 'research-web',
    name: 'Research Deep',
    family: 'deep',
    description: 'Current-data research with cross-checking, citations and reusable findings.',
    toolPreferences: ['search', 'fetch', 'context_manager'],
    suggestedSkills: [
      'research-web',
      'tech-stack',
      'node-modern',
      'security-scanner',
      'react-modern',
    ],
  },
] as const satisfies readonly ModeCatalogEntry[];

export type RosterBudget = 'light' | 'medium' | 'heavy' | 'single-shot';

export type RosterAgent = {
  role: string;
  name: string;
  summary: string;
  tools: number;
  budget: RosterBudget;
};

export type RosterPhase = {
  id: string;
  label: string;
  purpose: string;
  agents: readonly RosterAgent[];
};

/**
 * Mirrors packages/core/src/coordination/agents/phase*.ts. The build guard
 * verifies every role against FLEET_ROSTER's source inputs.
 */
export const rosterPhases = [
  {
    id: 'discovery',
    label: 'Discovery',
    purpose: 'Orient, search and research before a plan commits the fleet to a direction.',
    agents: [
      {
        role: 'explore',
        name: 'Explore',
        summary:
          'Maps unfamiliar codebases: entry points, structure, architecture and feature flow.',
        tools: 6,
        budget: 'medium',
      },
      {
        role: 'search',
        name: 'Search',
        summary: 'Finds definitions, references and duplicates with semantic and lexical search.',
        tools: 6,
        budget: 'medium',
      },
      {
        role: 'research',
        name: 'Research',
        summary: 'Compares libraries and approaches with evidence, feasibility and trade-offs.',
        tools: 6,
        budget: 'light',
      },
    ],
  },
  {
    id: 'planning',
    label: 'Planning',
    purpose: 'Turn ambiguity into requirements, architecture and dependency-aware execution plans.',
    agents: [
      {
        role: 'analyst',
        name: 'Analyst',
        summary: 'Turns vague requests into testable specifications and acceptance criteria.',
        tools: 8,
        budget: 'light',
      },
      {
        role: 'planner',
        name: 'Planner',
        summary: 'Builds ordered, dependency-aware and parallelizable execution plans.',
        tools: 8,
        budget: 'light',
      },
      {
        role: 'architect',
        name: 'Architect',
        summary: 'Designs module boundaries, interfaces, data flow and key decisions.',
        tools: 8,
        budget: 'light',
      },
      {
        role: 'critic',
        name: 'Critic',
        summary: 'Challenges plans and designs for gaps, risks and unstated assumptions.',
        tools: 6,
        budget: 'light',
      },
      {
        role: 'refactor-planner',
        name: 'Refactor Planner',
        summary:
          'Produces phased, risk-scored refactor plans with dependency and rollback analysis.',
        tools: 9,
        budget: 'heavy',
      },
    ],
  },
  {
    id: 'build',
    label: 'Build',
    purpose: 'Implement, modernize and debug with a tool scope matched to the job.',
    agents: [
      {
        role: 'executor',
        name: 'Executor',
        summary: 'Implements well-specified tasks, runs checks and leaves the tree green.',
        tools: 16,
        budget: 'heavy',
      },
      {
        role: 'refactor',
        name: 'Refactor',
        summary: 'Extracts, splits, moves and decouples code without changing behavior.',
        tools: 16,
        budget: 'heavy',
      },
      {
        role: 'simplifier',
        name: 'Simplifier',
        summary: 'Removes dead code and needless abstractions to reduce complexity.',
        tools: 16,
        budget: 'medium',
      },
      {
        role: 'migration',
        name: 'Migration',
        summary: 'Applies framework, language and major-version upgrades across call sites.',
        tools: 18,
        budget: 'heavy',
      },
      {
        role: 'vision',
        name: 'Vision',
        summary: 'Turns screenshots and mockups into matching accessible UI code.',
        tools: 11,
        budget: 'medium',
      },
      {
        role: 'debugger',
        name: 'Debugger',
        summary: 'Reproduces failures, isolates root cause and adds a regression test.',
        tools: 17,
        budget: 'heavy',
      },
      {
        role: 'tracer',
        name: 'Tracer',
        summary: 'Instruments runtime behavior to observe call order, values and timing.',
        tools: 17,
        budget: 'medium',
      },
      {
        role: 'concurrency',
        name: 'Concurrency',
        summary: 'Hunts race conditions, lock misuse, async lifecycle and shared-state hazards.',
        tools: 17,
        budget: 'medium',
      },
    ],
  },
  {
    id: 'verify',
    label: 'Verify',
    purpose: 'Prove behavior across tests, browsers, performance, resilience and security.',
    agents: [
      {
        role: 'verifier',
        name: 'Verifier',
        summary: 'Runs the relevant gates until green or returns exact blocking failures.',
        tools: 16,
        budget: 'heavy',
      },
      {
        role: 'test',
        name: 'Test',
        summary: 'Writes and runs unit and integration tests for golden paths and boundaries.',
        tools: 16,
        budget: 'heavy',
      },
      {
        role: 'e2e',
        name: 'E2E',
        summary: 'Drives complete user journeys across UI, CLI and API boundaries.',
        tools: 28,
        budget: 'heavy',
      },
      {
        role: 'browser',
        name: 'Browser',
        summary: 'Navigates, clicks, types, screenshots and extracts data through Playwright.',
        tools: 18,
        budget: 'medium',
      },
      {
        role: 'performance',
        name: 'Performance',
        summary: 'Finds real bottlenecks and proves optimization gains with measurements.',
        tools: 17,
        budget: 'medium',
      },
      {
        role: 'chaos',
        name: 'Chaos',
        summary: 'Injects network, disk and timing failures to expose recovery gaps.',
        tools: 17,
        budget: 'medium',
      },
      {
        role: 'security-scanner',
        name: 'Security Scanner',
        summary: 'Detects secrets, injection, insecure patterns and supply-chain risks.',
        tools: 10,
        budget: 'heavy',
      },
      {
        role: 'bug-hunter',
        name: 'Bug Hunter',
        summary: 'Scans for bugs, anti-patterns and code smells with ranked fixes.',
        tools: 10,
        budget: 'heavy',
      },
      {
        role: 'audit-log',
        name: 'Audit Log',
        summary: 'Analyzes session JSONL for failure patterns, tool anomalies and cost trends.',
        tools: 10,
        budget: 'medium',
      },
      {
        role: 'realtime',
        name: 'Realtime',
        summary: 'Owns WebSocket/SSE transports: presence, heartbeat, reconnect and backpressure.',
        tools: 17,
        budget: 'medium',
      },
      {
        role: 'resilience-engineer',
        name: 'Resilience Engineer',
        summary: 'Designs retry, timeout, circuit-breaker, bulkhead and graceful degradation.',
        tools: 18,
        budget: 'medium',
      },
      {
        role: 'chaos-engineer',
        name: 'Chaos Engineer',
        summary: 'Runs controlled fault-injection experiments with hypothesis and blast radius.',
        tools: 18,
        budget: 'medium',
      },
    ],
  },
  {
    id: 'review',
    label: 'Review',
    purpose: 'Apply independent correctness, security, accessibility and compliance judgment.',
    agents: [
      {
        role: 'reviewer',
        name: 'Reviewer',
        summary: 'Audits another agent’s output for uncertainty and must-fix defects.',
        tools: 11,
        budget: 'medium',
      },
      {
        role: 'code-reviewer',
        name: 'Code Reviewer',
        summary: 'Reviews diffs and PRs for bugs, edge cases and convention violations.',
        tools: 11,
        budget: 'medium',
      },
      {
        role: 'security-reviewer',
        name: 'Security Reviewer',
        summary: 'Maps injection, authz, secret and crypto findings to severity and fixes.',
        tools: 11,
        budget: 'medium',
      },
      {
        role: 'accessibility',
        name: 'Accessibility',
        summary: 'Checks semantics, ARIA, keyboard use and contrast against WCAG.',
        tools: 6,
        budget: 'medium',
      },
      {
        role: 'compliance',
        name: 'Compliance',
        summary: 'Audits licenses, PII handling and controls against GDPR and SOC 2.',
        tools: 10,
        budget: 'medium',
      },
      {
        role: 'threat-modeler',
        name: 'Threat Modeler',
        summary: 'Models trust boundaries, abuse cases and attack trees before code is written.',
        tools: 8,
        budget: 'light',
      },
      {
        role: 'secure-coding-coach',
        name: 'Secure Coding Coach',
        summary: 'Teaches secure patterns and walks engineers through prescriptive safe fixes.',
        tools: 6,
        budget: 'medium',
      },
      {
        role: 'compliance-auditor',
        name: 'Compliance Auditor',
        summary: 'Produces auditable control evidence and traceability for SOC 2 and ISO.',
        tools: 10,
        budget: 'medium',
      },
      {
        role: 'privacy-engineer',
        name: 'Privacy Engineer',
        summary: 'Implements data minimization, consent, retention and deletion by design.',
        tools: 17,
        budget: 'medium',
      },
    ],
  },
  {
    id: 'domain',
    label: 'Domain',
    purpose: 'Bring focused implementation expertise to common product and data boundaries.',
    agents: [
      {
        role: 'database',
        name: 'Database',
        summary: 'Designs schemas, optimizes queries and produces reversible migrations.',
        tools: 16,
        budget: 'heavy',
      },
      {
        role: 'api',
        name: 'API',
        summary: 'Designs and implements REST and GraphQL contracts with correct semantics.',
        tools: 17,
        budget: 'heavy',
      },
      {
        role: 'auth',
        name: 'Auth',
        summary: 'Handles identity, sessions, OAuth/OIDC, RBAC and authorization safely.',
        tools: 16,
        budget: 'heavy',
      },
      {
        role: 'data',
        name: 'Data',
        summary: 'Builds idempotent ETL/ELT pipelines with data-quality checks.',
        tools: 16,
        budget: 'heavy',
      },
      {
        role: 'frontend',
        name: 'Frontend',
        summary: 'Implements responsive, accessible UI, client state and data fetching.',
        tools: 17,
        budget: 'heavy',
      },
      {
        role: 'backend',
        name: 'Backend',
        summary: 'Builds services, business rules, persistence, queues and transactions.',
        tools: 16,
        budget: 'heavy',
      },
      {
        role: 'designer',
        name: 'Designer',
        summary: 'Creates user flows, wireframes, interaction states and design-system decisions.',
        tools: 9,
        budget: 'medium',
      },
      {
        role: 'ios',
        name: 'iOS',
        summary:
          'Apple-platform app development in Swift: SwiftUI, UIKit, SwiftData, concurrency, accessibility, and App Store submission.',
        tools: 17,
        budget: 'heavy',
      },
      {
        role: 'android',
        name: 'Android',
        summary: 'Kotlin, Jetpack Compose, Android SDK lifecycle and Play Store delivery.',
        tools: 17,
        budget: 'heavy',
      },
      {
        role: 'desktop',
        name: 'Desktop',
        summary: 'Electron and Tauri apps: native packaging, IPC and OS integration.',
        tools: 17,
        budget: 'heavy',
      },
      {
        role: 'distributed-systems',
        name: 'Distributed Systems',
        summary: 'Consistency, partitioning, idempotency and saga coordination in code.',
        tools: 12,
        budget: 'heavy',
      },
      {
        role: 'payments',
        name: 'Payments',
        summary: 'Ledgers, refunds, webhooks and reconciliation with financial invariants.',
        tools: 37,
        budget: 'heavy',
      },
      {
        role: 'messaging',
        name: 'Messaging',
        summary: 'Queues, pub/sub, delivery semantics and DLQs with broker failure modes.',
        tools: 18,
        budget: 'heavy',
      },
      {
        role: 'search-relevance',
        name: 'Search Relevance',
        summary: 'Indexing, ranking and retrieval with offline/online quality evaluation.',
        tools: 17,
        budget: 'medium',
      },
      {
        role: 'storage',
        name: 'Storage',
        summary: 'Object storage: uploads, checksums, lifecycle, CDN and replication.',
        tools: 18,
        budget: 'heavy',
      },
      {
        role: 'ml-engineer',
        name: 'ML Engineer',
        summary: 'Model integration, inference, evaluation and guardrail wiring.',
        tools: 17,
        budget: 'medium',
      },
      {
        role: 'data-governance',
        name: 'Data Governance',
        summary: 'Lineage, classification, ownership and data contracts with quality-of-record.',
        tools: 8,
        budget: 'medium',
      },
    ],
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    purpose: 'Turn verified source material into documentation, diagrams and reusable language.',
    agents: [
      {
        role: 'document',
        name: 'Document',
        summary: 'Writes READMEs, guides and API references grounded in the code.',
        tools: 9,
        budget: 'medium',
      },
      {
        role: 'uml',
        name: 'UML',
        summary: 'Generates class, sequence, component and ER diagrams from code.',
        tools: 8,
        budget: 'light',
      },
      {
        role: 'i18n',
        name: 'I18n',
        summary: 'Manages extraction, catalogs, plurals, RTL and locale formatting.',
        tools: 10,
        budget: 'medium',
      },
      {
        role: 'prompt',
        name: 'Prompt',
        summary: 'Designs, refines and evaluates system prompts and agent instructions.',
        tools: 10,
        budget: 'light',
      },
    ],
  },
  {
    id: 'delivery',
    label: 'Delivery',
    purpose: 'Move verified work through version control, release, deployment and observability.',
    agents: [
      {
        role: 'git',
        name: 'Git',
        summary: 'Handles focused commits, branches, rebases, conflicts and PR preparation.',
        tools: 6,
        budget: 'medium',
      },
      {
        role: 'release',
        name: 'Release',
        summary: 'Produces semver bumps, changelogs and release notes from real history.',
        tools: 7,
        budget: 'medium',
      },
      {
        role: 'devops',
        name: 'DevOps',
        summary: 'Builds CI/CD, containers and safe deployments with rollback support.',
        tools: 34,
        budget: 'medium',
      },
      {
        role: 'observability',
        name: 'Observability',
        summary: 'Adds structured logs, metrics, traces, alerts and dashboards.',
        tools: 17,
        budget: 'medium',
      },
      {
        role: 'dependency',
        name: 'Dependency',
        summary: 'Audits CVEs, upgrades packages and reviews supply-chain risk.',
        tools: 9,
        budget: 'medium',
      },
      {
        role: 'platform-engineer',
        name: 'Platform Engineer',
        summary: 'Monorepo layout, build graph, internal tooling and developer experience.',
        tools: 19,
        budget: 'medium',
      },
    ],
  },
  {
    id: 'meta',
    label: 'Meta',
    purpose: 'Improve the agent system itself: skills, context, cost and technology choices.',
    agents: [
      {
        role: 'skill-manage',
        name: 'Skill Manager',
        summary: 'Audits, scaffolds, refines and retires skills and their triggers.',
        tools: 10,
        budget: 'light',
      },
      {
        role: 'self-improving',
        name: 'Self-Improving',
        summary: 'Mines execution logs for recurring failures and evidence-based improvements.',
        tools: 10,
        budget: 'medium',
      },
      {
        role: 'context',
        name: 'Context',
        summary: 'Manages compaction, recall and memory within a token budget.',
        tools: 12,
        budget: 'light',
      },
      {
        role: 'cost',
        name: 'Cost',
        summary: 'Finds token and cloud spend waste with model-routing recommendations.',
        tools: 10,
        budget: 'light',
      },
      {
        role: 'tech-stack',
        name: 'Tech Stack Validator',
        summary: 'Checks current package versions and rejects obsolete technology choices.',
        tools: 9,
        budget: 'single-shot',
      },
      {
        role: 'plugin-author',
        name: 'Plugin Author',
        summary: 'Builds and ships runnable WrongStack plugins with lifecycle and teardown.',
        tools: 11,
        budget: 'medium',
      },
      {
        role: 'tool-author',
        name: 'Tool Author',
        summary: 'Designs tool schemas, capability declarations, permissions and error contracts.',
        tools: 11,
        budget: 'light',
      },
      {
        role: 'prompt-evaluator',
        name: 'Prompt Evaluator',
        summary: 'Builds rubrics, adversarial prompt tests and regression suites.',
        tools: 7,
        budget: 'medium',
      },
      {
        role: 'benchmark-engineer',
        name: 'Benchmark Engineer',
        summary: 'Designs reproducible benchmarks and methodology with deterministic baselines.',
        tools: 8,
        budget: 'medium',
      },
      {
        role: 'memory-curator',
        name: 'Memory Curator',
        summary: 'Validates, merges and de-duplicates long-term memory with audience scoping.',
        tools: 7,
        budget: 'light',
      },
      {
        role: 'fleet-coordinator',
        name: 'Fleet Coordinator',
        summary: 'Partitions multi-agent jobs, plans capacity and synthesizes worker results.',
        tools: 8,
        budget: 'medium',
      },
    ],
  },
] as const satisfies readonly RosterPhase[];

export const specialRosterAgents = [
  {
    role: 'shadow-agent',
    name: 'Shadow',
    summary: 'One-shot fleet monitoring and intervention for quiet anomaly checks.',
  },
  {
    role: 'generic',
    name: 'Generic Project Agent',
    summary: 'Template agent used directly or cloned into project-specific roles.',
  },
  {
    role: 'explore-companion',
    name: 'Explore Companion',
    summary:
      'State-triggered background codebase explorer that runs behind the leader and reports findings by mail.',
  },
  {
    role: 'chaos-monkey',
    name: 'Chaos Monkey',
    summary:
      'One-shot mutation-testing agent that applies deterministic mutants and proves whether the targeted tests catch them.',
  },
] as const;

export const externalAcpAgents = [
  { role: 'cline', name: 'Cline', runtime: 'npx @agentify/cline' },
  { role: 'gemini-cli', name: 'Gemini CLI', runtime: 'gemini' },
  { role: 'copilot', name: 'GitHub Copilot', runtime: 'gh copilot' },
  { role: 'openhands', name: 'OpenHands', runtime: 'openhands' },
  { role: 'goose', name: 'Goose', runtime: 'goose' },
] as const;

export const builtInRosterCount =
  rosterPhases.reduce((total, phase) => total + phase.agents.length, 0) +
  specialRosterAgents.length;

export const extendedRosterCount = builtInRosterCount + externalAcpAgents.length;

/* =========================================================================
   Detail-page helpers — slugs and lookups for /modes/:slug and
   /agent-roster/:slug.
   ========================================================================= */

export type RosterAgentKind = 'phase' | 'operational' | 'acp';

export type RosterDetailEntry = {
  role: string;
  name: string;
  summary: string;
  kind: RosterAgentKind;
  tools?: number;
  budget?: RosterBudget;
  phaseId?: string;
  phaseLabel?: string;
  phasePurpose?: string;
  runtime?: string;
};

export const rosterIndex: readonly RosterDetailEntry[] = [
  ...rosterPhases.flatMap((phase) =>
    phase.agents.map((agent) => ({
      ...agent,
      kind: 'phase' as const,
      phaseId: phase.id,
      phaseLabel: phase.label,
      phasePurpose: phase.purpose,
    })),
  ),
  ...specialRosterAgents.map((agent) => ({ ...agent, kind: 'operational' as const })),
  ...externalAcpAgents.map((agent) => ({
    role: agent.role,
    name: agent.name,
    summary: `External agent driven over the Agent Client Protocol through the \`${agent.runtime}\` runtime.`,
    runtime: agent.runtime,
    kind: 'acp' as const,
  })),
];

export function agentFromSlug(slug: string): RosterDetailEntry | undefined {
  return rosterIndex.find((agent) => agent.role === slug);
}

export function modeFromSlug(slug: string): ModeCatalogEntry | undefined {
  return modeCatalog.find((mode) => mode.id === slug);
}

export const modeFamilyGuidance: Record<ModeFamily, { label: string; body: string }> = {
  balanced: {
    label: 'Balanced',
    body: 'Full-capability modes for everyday work. They keep the complete toolset and default context budget, trading nothing away — pick one when the task shape matters more than token cost.',
  },
  lite: {
    label: 'Lite',
    body: 'Token-saving passes that constrain scope on purpose: fewer tools, tighter output and a narrow work surface. Pick one for quick triage, small diffs or high-frequency repetitive work.',
  },
  deep: {
    label: 'Deep',
    body: 'Specialist workflows that spend more context and more tool calls to go further: broader reading, more verification and structured multi-step output. Pick one when thoroughness beats speed.',
  },
};

export const rosterBudgetGuidance: Record<RosterBudget, string> = {
  light: 'Small context and tool budget — quick, focused passes that return fast.',
  medium: 'Standard working budget for a self-contained task inside one phase.',
  heavy: 'Extended budget for wide reading, long editing sessions or multi-file work.',
  'single-shot': 'One pass, one answer — fired for a single verdict without iteration.',
};
