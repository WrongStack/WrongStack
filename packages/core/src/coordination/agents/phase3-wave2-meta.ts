import { agentPrompt } from './agent-prompts.js';
import type { BundledAgentSkill } from './role-skills.js';
import {
  type AgentDefinition,
  LIGHT_BUDGET,
  MEDIUM_BUDGET,
  type RoleDispatcherSignal,
  TOOLS,
} from './types.js';

const skillSet = (...names: BundledAgentSkill[]): BundledAgentSkill[] => names;

/**
 * Wave 2: Security, resilience, governance and agent platform.
 *
 * These roles extend the existing 51-role phase catalog with focused
 * specialists. Each role carries an `agentMeta` block so the dispatcher
 * can distinguish it from siblings via an explicit rationale and signal
 * list. The legacy `keywords` array is kept for backward compatibility
 * with the heuristic dispatcher.
 */

const THREAT_MODELER_META = {
  rationale:
    'Models trust boundaries, abuse cases and data flow before code is written; threat-modeler is the pre-implementation counterpart to security-reviewer.',
  signals: [
    'threat model',
    'trust boundary',
    'abuse case',
    'attack tree',
    'data flow diagram',
    'stride',
    'asset',
    'adversary',
  ] as const,
  differentiatesFrom:
    'security-reviewer finds defects in code; threat-modeler designs the threat surface before code exists.',
};

const SECURE_CODING_COACH_META = {
  rationale:
    'Teaches secure patterns, produces safe defaults and walks engineers through fixes; secure-coding-coach is the counterpart to security-scanner that drives adoption.',
  signals: [
    'secure coding',
    'secure default',
    'hardening',
    'security example',
    'security review',
    'security fix',
    'defensive',
    'owasp',
  ] as const,
  differentiatesFrom:
    'security-scanner detects issues; secure-coding-coach produces prescriptive safe-by-default code and guidance.',
};

const RESILIENCE_ENGINEER_META = {
  rationale:
    'Designs retry, timeout, circuit breaker and graceful-degradation patterns; resilience-engineer is the protective counterpart to chaos.',
  signals: [
    'retry',
    'timeout',
    'circuit breaker',
    'bulkhead',
    'graceful degradation',
    'backoff',
    'resilience',
    'fault tolerance',
  ] as const,
  differentiatesFrom:
    'chaos injects faults to test existing code; resilience-engineer designs the protective mechanisms ahead of time.',
};

const CHAOS_ENGINEER_META = {
  rationale:
    'Builds the controlled fault-injection harness and blast-radius discipline; chaos-engineer is the operator counterpart to the chaos reviewer.',
  signals: [
    'chaos experiment',
    'fault injection',
    'blast radius',
    'gameday',
    'steady state',
    'hypothesis',
    'explosion radius',
  ] as const,
  differentiatesFrom:
    'chaos verifies fault behavior; chaos-engineer designs the experiments and runs them safely.',
};

const COMPLIANCE_AUDITOR_META = {
  rationale:
    'Produces auditable control evidence, traceability and evidence maps; compliance-auditor is the documenter counterpart to compliance.',
  signals: [
    'audit',
    'control evidence',
    'evidence map',
    'soc2',
    'iso 27001',
    'attestation',
    'auditable',
    'remediation tracking',
  ] as const,
  differentiatesFrom:
    'compliance reviews the design; compliance-auditor produces traceable evidence for an external audit.',
};

const PRIVACY_ENGINEER_META = {
  rationale:
    'Implements data minimization, consent, retention and deletion; privacy-engineer is the implementation counterpart to compliance.',
  signals: [
    'privacy',
    'pii',
    'consent',
    'retention',
    'deletion',
    'data minimization',
    'lawful basis',
    'gdpr',
  ] as const,
  differentiatesFrom:
    'compliance audits controls; privacy-engineer implements privacy-by-design in code and pipelines.',
};

const PLUGIN_AUTHOR_META = {
  rationale:
    'Builds, packages and ships runnable WrongStack plugins; plugin-author is the production counterpart to skill-manage.',
  signals: [
    'plugin',
    'plugin api',
    'lifecycle',
    'health',
    'teardown',
    'packaging',
    'distribution',
  ] as const,
  differentiatesFrom:
    'skill-manage authors skills; plugin-author authors full lifecycle plugins with health and teardown.',
};

const TOOL_AUTHOR_META = {
  rationale:
    'Designs tool schemas, capability declarations and error contracts; tool-author is the narrow, security-focused counterpart to plugin-author.',
  signals: [
    'tool',
    'tool schema',
    'capability',
    'permission',
    'tool contract',
    'tool error',
    'tool lifecycle',
  ] as const,
  differentiatesFrom:
    'plugin-author writes full plugin lifecycle; tool-author focuses on a single tool contract and capability set.',
};

const PROMPT_EVALUATOR_META = {
  rationale:
    'Builds rubrics and runs adversarial / regression tests on prompts; prompt-evaluator is the independent measurement counterpart to prompt.',
  signals: [
    'prompt eval',
    'prompt regression',
    'rubric',
    'adversarial prompt',
    'prompt benchmark',
    'judge prompt',
    'eval suite',
  ] as const,
  differentiatesFrom:
    'prompt authors prompts; prompt-evaluator independently measures them with rubrics and adversarial inputs.',
};

const BENCHMARK_ENGINEER_META = {
  rationale:
    'Designs reproducible benchmarks and methodology for comparing models and agent setups; benchmark-engineer is the measurement-infrastructure counterpart to performance.',
  signals: [
    'benchmark',
    'reproducible',
    'evaluation harness',
    'regression suite',
    'metric methodology',
    'baseline',
    'deterministic run',
  ] as const,
  differentiatesFrom:
    'performance optimizes product code; benchmark-engineer builds the measurement infrastructure that supports comparison.',
};

const MEMORY_CURATOR_META = {
  rationale:
    'Validates, merges and de-duplicates long-term memory entries with audience scope; memory-curator is the quality counterpart to context.',
  signals: [
    'memory',
    'curate',
    'memory audit',
    'memory merge',
    'memory expiry',
    'audience scope',
    'memory recall quality',
  ] as const,
  differentiatesFrom:
    'context manages the active context window; memory-curator curates the long-term memory store for accuracy.',
};

const FLEET_COORDINATOR_META = {
  rationale:
    'Owns job partitioning, capacity and result synthesis across many workers; fleet-coordinator is the multi-agent execution counterpart to planner.',
  signals: [
    'fleet',
    'fan out',
    'parallel agents',
    'synthesis',
    'subagent capacity',
    'coordinator',
    'result aggregation',
  ] as const,
  differentiatesFrom:
    'planner designs ordered steps for one worker; fleet-coordinator runs many workers in parallel and merges their results.',
};

export const WAVE2_AGENTS: AgentDefinition[] = [
  {
    config: {
      id: 'threat-modeler',
      name: 'Threat Modeler',
      role: 'threat-modeler',
      tools: [...TOOLS.read, 'write', 'document'],
      prompt: agentPrompt('threat-modeler'),
    },
    budget: LIGHT_BUDGET,
    capability: {
      phase: 'review',
      summary:
        'Models trust boundaries, abuse cases and data flow before code is written; produces a threat model with attack trees.',
      keywords: [
        ...THREAT_MODELER_META.signals,
        'threat-modeler',
        'trust',
        'boundary',
        'abuse',
        'attack',
        'stride',
        'asset',
        'adversary',
      ],
    },
  },
  {
    config: {
      id: 'secure-coding-coach',
      name: 'Secure Coding Coach',
      role: 'secure-coding-coach',
      tools: [...TOOLS.read],
      prompt: agentPrompt('secure-coding-coach'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'review',
      summary:
        'Teaches secure patterns, produces safe defaults and walks engineers through prescriptive fixes.',
      keywords: [
        ...SECURE_CODING_COACH_META.signals,
        'secure-coding',
        'security-coach',
        'hardening',
        'safe-default',
        'owasp',
      ],
    },
  },
  {
    config: {
      id: 'resilience-engineer',
      name: 'Resilience Engineer',
      role: 'resilience-engineer',
      tools: [...TOOLS.build, 'logs'],
      prompt: agentPrompt('resilience-engineer'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'verify',
      summary:
        'Designs retry, timeout, circuit breaker, bulkhead and graceful-degradation patterns ahead of time.',
      keywords: [
        ...RESILIENCE_ENGINEER_META.signals,
        'resilience',
        'timeout',
        'circuit-breaker',
        'bulkhead',
        'backoff',
        'graceful',
      ],
    },
  },
  {
    config: {
      id: 'chaos-engineer',
      name: 'Chaos Engineer',
      role: 'chaos-engineer',
      tools: [...TOOLS.build, 'logs'],
      prompt: agentPrompt('chaos-engineer'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'verify',
      summary:
        'Builds and runs controlled fault-injection experiments with a defined blast radius, steady state and hypothesis.',
      keywords: [
        ...CHAOS_ENGINEER_META.signals,
        'chaos-engineer',
        'chaos-experiment',
        'gameday',
        'steady-state',
      ],
    },
  },
  {
    config: {
      id: 'compliance-auditor',
      name: 'Compliance Auditor',
      role: 'compliance-auditor',
      tools: [...TOOLS.inspect],
      prompt: agentPrompt('compliance-auditor'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'review',
      summary:
        'Produces auditable control evidence, traceability and evidence maps for SOC2, ISO and similar frameworks.',
      keywords: [
        ...COMPLIANCE_AUDITOR_META.signals,
        'compliance-auditor',
        'soc2',
        'iso',
        'evidence-map',
        'attestation',
        'auditable',
      ],
    },
  },
  {
    config: {
      id: 'privacy-engineer',
      name: 'Privacy Engineer',
      role: 'privacy-engineer',
      tools: [...TOOLS.build, 'audit'],
      prompt: agentPrompt('privacy-engineer'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'review',
      summary:
        'Implements data minimization, consent, retention and deletion; privacy-by-design across the stack.',
      keywords: [
        ...PRIVACY_ENGINEER_META.signals,
        'privacy-engineer',
        'pii',
        'gdpr',
        'consent',
        'retention',
        'deletion',
        'data-minimization',
      ],
    },
  },
];

export const WAVE2_ROLE_METAS: Record<string, RoleDispatcherSignal> = {
  'threat-modeler': THREAT_MODELER_META,
  'secure-coding-coach': SECURE_CODING_COACH_META,
  'resilience-engineer': RESILIENCE_ENGINEER_META,
  'chaos-engineer': CHAOS_ENGINEER_META,
  'compliance-auditor': COMPLIANCE_AUDITOR_META,
  'privacy-engineer': PRIVACY_ENGINEER_META,
  'plugin-author': PLUGIN_AUTHOR_META,
  'tool-author': TOOL_AUTHOR_META,
  'prompt-evaluator': PROMPT_EVALUATOR_META,
  'benchmark-engineer': BENCHMARK_ENGINEER_META,
  'memory-curator': MEMORY_CURATOR_META,
  'fleet-coordinator': FLEET_COORDINATOR_META,
};

export const WAVE2_ROLES = new Set<string>(Object.keys(WAVE2_ROLE_METAS));

void skillSet;
