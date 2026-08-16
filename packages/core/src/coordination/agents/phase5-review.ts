import { agentPrompt } from './agent-prompts.js';
import { type AgentDefinition, MEDIUM_BUDGET, TOOLS } from './types.js';

/** Phase 5 · Review — read-only quality, security, a11y, and compliance gates. */
export const REVIEW_AGENTS: AgentDefinition[] = [
  {
    config: {
      id: 'reviewer',
      name: 'Reviewer',
      role: 'reviewer',
      tools: [...TOOLS.inspect, 'git'],
      prompt: agentPrompt('reviewer'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'review',
      summary:
        "Independent AI reviewer: audits another agent's output, flags uncertainty, correlated-failure risk, and must-fix defects.",
      keywords: [
        'reviewer',
        'independent review',
        'ai review',
        'review agent',
        'quality review',
        'second opinion',
        'check another agent',
        'cross check',
        'uncertainty',
        'correlated error',
        'verify output',
        'quality control',
      ],
    },
  },
  {
    config: {
      id: 'code-reviewer',
      name: 'Code Reviewer',
      role: 'code-reviewer',
      tools: [...TOOLS.inspect, 'git', 'codebase-impact-analysis', 'codebase-invariant-check'],
      prompt: agentPrompt('code-reviewer'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'review',
      summary:
        'Correctness-first code review of diffs/PRs: finds bugs, edge cases, and convention violations with fixes.',
      keywords: [
        'review',
        'code review',
        'review pr',
        'review diff',
        'look over',
        'feedback on code',
        'quality',
        'is this correct',
        'check my code',
      ],
    },
  },
  {
    config: {
      id: 'security-reviewer',
      name: 'Security Reviewer',
      role: 'security-reviewer',
      tools: [...TOOLS.inspect, 'git'],
      prompt: agentPrompt('security-reviewer'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'review',
      summary:
        'Security review: finds injection/authz/secret/crypto issues mapped to OWASP severity with remediation.',
      keywords: [
        'security review',
        'security',
        'vulnerability',
        'vulnerabilities',
        'owasp',
        'injection',
        'sql injection',
        'xss',
        'ssrf',
        'authz',
        'secrets',
        'security audit',
        'threat',
        'unsafe',
      ],
    },
  },
  {
    config: {
      id: 'accessibility',
      name: 'Accessibility',
      role: 'accessibility',
      tools: [...TOOLS.read],
      prompt: agentPrompt('accessibility'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'review',
      summary:
        'WCAG/a11y review of UI: checks semantics, ARIA, keyboard, contrast; maps findings to success criteria.',
      keywords: [
        'accessibility',
        'a11y',
        'wcag',
        'aria',
        'screen reader',
        'keyboard navigation',
        'contrast',
        'disabled users',
        'accessible',
      ],
    },
  },
  {
    config: {
      id: 'compliance',
      name: 'Compliance',
      role: 'compliance',
      tools: [...TOOLS.inspect],
      prompt: agentPrompt('compliance'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'review',
      summary:
        'License/privacy/regulatory review: audits licenses, PII handling, and controls vs GDPR/SOC2.',
      keywords: [
        'compliance',
        'license',
        'gdpr',
        'soc2',
        'privacy',
        'pii',
        'data retention',
        'regulatory',
        'audit log',
        'legal review',
      ],
    },
  },
];
