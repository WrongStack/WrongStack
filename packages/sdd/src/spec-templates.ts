import type { SpecTemplate } from '@wrongstack/core/types';

/**
 * Built-in spec templates for common development scenarios.
 */
export const SPEC_TEMPLATES: SpecTemplate[] = [
  {
    id: 'feature',
    name: 'New Feature',
    description: 'Template for new feature development',
    sections: [
      { type: 'overview', title: 'Overview', level: 2 },
      { type: 'requirements', title: 'Requirements', level: 2 },
      { type: 'architecture', title: 'Architecture', level: 2 },
      { type: 'api', title: 'API Design', level: 2 },
      { type: 'data', title: 'Data Model', level: 2 },
      { type: 'security', title: 'Security', level: 2 },
      { type: 'acceptance', title: 'Acceptance Criteria', level: 2 },
    ],
    defaultRequirements: [
      {
        type: 'functional',
        priority: 'high',
        acceptanceCriteria: [],
        blockedBy: [],
        implements: [],
      },
      {
        type: 'non-functional',
        priority: 'medium',
        acceptanceCriteria: [],
        blockedBy: [],
        implements: [],
      },
    ],
  },
  {
    id: 'bugfix',
    name: 'Bug Fix',
    description: 'Template for bug fix specifications',
    sections: [
      { type: 'overview', title: 'Bug Description', level: 2 },
      { type: 'requirements', title: 'Root Cause Analysis', level: 2 },
      { type: 'acceptance', title: 'Fix Verification', level: 2 },
    ],
    defaultRequirements: [
      {
        type: 'functional',
        priority: 'critical',
        acceptanceCriteria: [],
        blockedBy: [],
        implements: [],
      },
    ],
  },
  {
    id: 'refactor',
    name: 'Refactor',
    description: 'Template for code refactoring',
    sections: [
      { type: 'overview', title: 'Current State', level: 2 },
      { type: 'requirements', title: 'Refactoring Goals', level: 2 },
      { type: 'architecture', title: 'Target Architecture', level: 2 },
      { type: 'acceptance', title: 'Verification', level: 2 },
    ],
    defaultRequirements: [
      {
        type: 'non-functional',
        priority: 'high',
        acceptanceCriteria: [],
        blockedBy: [],
        implements: [],
      },
    ],
  },
  {
    id: 'infra',
    name: 'Infrastructure',
    description: 'Template for infrastructure/tooling changes',
    sections: [
      { type: 'overview', title: 'What and Why', level: 2 },
      { type: 'requirements', title: 'Requirements', level: 2 },
      { type: 'architecture', title: 'Design', level: 2 },
      { type: 'security', title: 'Security Impact', level: 2 },
      { type: 'acceptance', title: 'Rollout Plan', level: 2 },
    ],
    defaultRequirements: [
      {
        type: 'functional',
        priority: 'high',
        acceptanceCriteria: [],
        blockedBy: [],
        implements: [],
      },
      { type: 'security', priority: 'high', acceptanceCriteria: [], blockedBy: [], implements: [] },
    ],
  },
  {
    id: 'integration',
    name: 'Integration',
    description: 'Template for integrating external services or APIs',
    sections: [
      { type: 'overview', title: 'Integration Overview', level: 2 },
      { type: 'requirements', title: 'Integration Requirements', level: 2 },
      { type: 'api', title: 'API Contract', level: 2 },
      { type: 'architecture', title: 'Architecture', level: 2 },
      { type: 'security', title: 'Auth & Security', level: 2 },
      { type: 'acceptance', title: 'Testing Strategy', level: 2 },
    ],
    defaultRequirements: [
      {
        type: 'functional',
        priority: 'high',
        acceptanceCriteria: [],
        blockedBy: [],
        implements: [],
      },
      {
        type: 'security',
        priority: 'critical',
        acceptanceCriteria: [],
        blockedBy: [],
        implements: [],
      },
      {
        type: 'performance',
        priority: 'medium',
        acceptanceCriteria: [],
        blockedBy: [],
        implements: [],
      },
    ],
  },
  {
    id: 'cli-command',
    name: 'CLI Command',
    description: 'Template for new CLI commands/slash commands',
    sections: [
      { type: 'overview', title: 'Command Overview', level: 2 },
      { type: 'requirements', title: 'Command Requirements', level: 2 },
      { type: 'api', title: 'Command Interface', level: 2 },
      { type: 'acceptance', title: 'Usage Examples', level: 2 },
    ],
    defaultRequirements: [
      { type: 'ux', priority: 'high', acceptanceCriteria: [], blockedBy: [], implements: [] },
      {
        type: 'functional',
        priority: 'high',
        acceptanceCriteria: [],
        blockedBy: [],
        implements: [],
      },
    ],
  },
];

/**
 * Get a template by ID.
 */
export function getTemplate(id: string): SpecTemplate | undefined {
  return SPEC_TEMPLATES.find((t) => t.id === id);
}

/**
 * List all available templates.
 */
export function listTemplates(): Array<{ id: string; name: string; description: string }> {
  return SPEC_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description }));
}

/**
 * Generate a markdown skeleton from a template.
 */
export function templateToMarkdown(template: SpecTemplate, title?: string): string {
  const lines: string[] = [];
  lines.push(`# ${title ?? 'Untitled Specification'}`);
  lines.push('Version: 0.1.0');
  lines.push('');

  for (const section of template.sections) {
    lines.push(`${'#'.repeat(section.level + 1)} ${section.title}`);
    lines.push(`_<!-- ${section.type} section content -->_`);
    lines.push('');
  }

  return lines.join('\n');
}
