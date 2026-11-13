import { createHash } from 'node:crypto';
import {
  type ArchitectureDecisionCheck,
  validateArchitectureDecisionChecks,
} from './architecture-decision-check.js';

export type { ArchitectureDecisionCheck } from './architecture-decision-check.js';

export type ArchitectureDecisionStatus =
  | 'proposed'
  | 'accepted'
  | 'rejected'
  | 'superseded'
  | 'deprecated';

export interface ArchitectureDecisionContent {
  title: string;
  context: string;
  decision: string;
  alternatives: string[];
  consequences: string[];
  constraints: string[];
  /** Project-relative paths or directory subtrees. Empty means the whole project. */
  scope: string[];
  revisitWhen: string;
  supersedes?: string | undefined;
  checks?: ArchitectureDecisionCheck[] | undefined;
}

export interface ArchitectureDecision extends ArchitectureDecisionContent {
  projectId: string;
  id: string;
  revision: number;
  contentHash: string;
  status: ArchitectureDecisionStatus;
  createdAt: string;
  updatedAt: string;
  proposedBy: string;
  resolvedBy?: string | undefined;
  resolutionReason?: string | undefined;
  supersededBy?: string | undefined;
  /** Pins the predecessor observed when the proposal was created. */
  predecessorRevision?: number | undefined;
}

export interface ArchitectureDecisionReview {
  projectId: string;
  id: string;
  revision: number;
  contentHash: string;
  action: 'accept' | 'reject' | 'deprecate';
  reason: string;
}

export function validateDecisionContent(
  input: ArchitectureDecisionContent,
): ArchitectureDecisionContent {
  if (!input || typeof input !== 'object') throw new Error('ADR content is required.');
  const text = (value: unknown, name: string, max: number, required = true): string => {
    if (typeof value !== 'string' || (required && !value.trim()) || value.length > max)
      throw new Error(
        `ADR ${name} must be ${required ? 'non-empty ' : ''}text up to ${max} characters.`,
      );
    return value.trim();
  };
  const list = (value: unknown, name: string, maxLength = 2000): string[] => {
    if (!Array.isArray(value) || value.length > 32)
      throw new Error(`ADR ${name} must be an array of at most 32 entries.`);
    return [...new Set(value.map((entry) => text(entry, name, maxLength)))];
  };
  const scope = list(input.scope, 'scope', 500).map((value) => {
    const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (
      !normalized ||
      normalized.startsWith('/') ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split('/').some((part) => part === '..' || part === '.' || !part) ||
      /[*?\x00-\x1f]/.test(normalized)
    )
      throw new Error(
        'ADR scope must contain project-relative paths without traversal or wildcards.',
      );
    return normalized;
  });
  const supersedes =
    input.supersedes === undefined ? undefined : text(input.supersedes, 'supersedes', 80);
  const checks = validateArchitectureDecisionChecks(input.checks);
  if (
    checks.some(
      (check) =>
        scope.length > 0 &&
        !scope.some((prefix) => check.path === prefix || check.path.startsWith(`${prefix}/`)),
    )
  )
    throw new Error('ADR checks must stay within the decision scope.');
  const content: ArchitectureDecisionContent = {
    title: text(input.title, 'title', 200),
    context: text(input.context, 'context', 8000),
    decision: text(input.decision, 'decision', 8000),
    alternatives: list(input.alternatives, 'alternatives'),
    consequences: list(input.consequences, 'consequences'),
    constraints: list(input.constraints, 'constraints'),
    scope,
    revisitWhen: text(input.revisitWhen, 'revisitWhen', 2000, false),
    ...(supersedes ? { supersedes } : {}),
    ...(checks.length ? { checks } : {}),
  };
  if (JSON.stringify(content).length > 32000)
    throw new Error('ADR content exceeds 32000 characters. Split independent decisions.');
  return content;
}

export function decisionContentHash(content: ArchitectureDecisionContent): string {
  return createHash('sha256')
    .update(JSON.stringify(validateDecisionContent(content)))
    .digest('hex');
}

export function formatArchitectureDecision(record: ArchitectureDecision): string {
  const section = (label: string, values: string[]) =>
    `## ${label}\n\n${values.length ? values.map((v) => `- ${v}`).join('\n') : 'None recorded.'}`;
  return (
    [
      `# ${record.id}: ${record.title}`,
      `Project: ${record.projectId}\nStatus: ${record.status}\nRevision: ${record.revision}\nContent hash: ${record.contentHash}\nProposed by: ${record.proposedBy}\nCreated: ${record.createdAt}`,
      ...(record.resolvedBy
        ? [`Reviewed by: ${record.resolvedBy}\nReason: ${record.resolutionReason ?? ''}`]
        : []),
      ...(record.supersedes ? [`Supersedes: ${record.supersedes}`] : []),
      ...(record.supersededBy ? [`Superseded by: ${record.supersededBy}`] : []),
      `## Context\n\n${record.context}`,
      `## Decision\n\n${record.decision}`,
      section('Alternatives', record.alternatives),
      section('Consequences', record.consequences),
      section('Constraints', record.constraints),
      ...(record.checks?.length
        ? [
            `## Compliance checks\n\n\u0060\u0060\u0060json\n${JSON.stringify(record.checks, null, 2)}\n\u0060\u0060\u0060`,
          ]
        : []),
      section('Scope', record.scope.length ? record.scope : ['Entire project']),
      `## Revisit when\n\n${record.revisitWhen || 'No trigger recorded.'}`,
    ].join('\n\n') + '\n'
  );
}
