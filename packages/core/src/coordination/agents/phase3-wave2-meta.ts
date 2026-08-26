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
} satisfies RoleDispatcherSignal;

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
} satisfies RoleDispatcherSignal;

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
} satisfies RoleDispatcherSignal;

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
} satisfies RoleDispatcherSignal;

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
} satisfies RoleDispatcherSignal;

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
} satisfies RoleDispatcherSignal;

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
      rationale: THREAT_MODELER_META,
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
      rationale: SECURE_CODING_COACH_META,
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
      rationale: RESILIENCE_ENGINEER_META,
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
      rationale: CHAOS_ENGINEER_META,
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
      rationale: COMPLIANCE_AUDITOR_META,
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
      rationale: PRIVACY_ENGINEER_META,
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

void skillSet;
