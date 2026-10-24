import type { MemoryScope } from '@wrongstack/contracts/types';
import type { MemoryAnchor, SageKind, SageScope, SageStatus } from '../types.js';

export function validitySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['statement'],
    description:
      'When this claim applies. Assumptions are unverified until checked in the current task. Literal source checks are evidence signals, not proof that all assumptions hold. Never include secrets or executable commands.',
    properties: {
      statement: { type: 'string', minLength: 1, maxLength: 1000 },
      checks: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'path', 'text'],
          properties: {
            type: { type: 'string', enum: ['source_contains'] },
            path: {
              type: 'string',
              minLength: 1,
              maxLength: 500,
              description: 'Relative project file path.',
            },
            text: {
              type: 'string',
              minLength: 1,
              maxLength: 400,
              description: 'Exact source literal expected while the claim applies; not a regex.',
            },
          },
        },
      },
    },
  };
}

export const KIND_VALUES: SageKind[] = [
  'fact',
  'decision',
  'convention',
  'preference',
  'warning',
  'anti_pattern',
  'workflow',
  'bug_root_cause',
  'file_note',
  'symbol_note',
  'command_note',
  'summary',
  'memory_review',
  'tool_outcome',
  'error_pattern',
  'session_digest',
  'role_operational',
  'task_outcome',
  'security_signal',
  'fleet_convention',
];
export const SCOPE_VALUES: SageScope[] = ['project', 'user', 'session', 'file', 'symbol'];
export const STATUS_VALUES: SageStatus[] = [
  'active',
  'stale',
  'superseded',
  'contradicted',
  'archived',
  'deleted',
];
export const LEGACY_SCOPE_VALUES: MemoryScope[] = [
  'project-agents',
  'project-memory',
  'user-memory',
];

const ANCHOR_TYPE_VALUES: MemoryAnchor['type'][] = [
  'file',
  'directory',
  'symbol',
  'package',
  'command',
  'test',
  'git',
  'agent',
];

export function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required?: string[],
) {
  return {
    type: 'object',
    properties,
    ...(required ? { required } : {}),
    additionalProperties: false,
  };
}

export function stringSchema(description: string) {
  return { type: 'string', minLength: 1, description };
}

export function numberSchema(minimum: number, maximum: number) {
  return { type: 'number', minimum, maximum };
}

export function enumSchema(values: readonly string[], description: string) {
  return { type: 'string', enum: [...values], description };
}

export function stringArraySchema(description: string) {
  return { type: 'array', items: { type: 'string' }, description };
}

export function audienceSchema() {
  return {
    type: 'object',
    description:
      'Optional automatic-injection audience. Values are stable project role/task/mode ids.',
    properties: {
      roles: stringArraySchema('Agent role ids, for example reviewer, refactor-planner, or git.'),
      taskTypes: stringArraySchema('Task classifications such as review, refactor, or bugfix.'),
      modes: stringArraySchema('Runtime mode ids.'),
    },
    additionalProperties: false,
  };
}

export function anchorsSchema() {
  return {
    type: 'array',
    description:
      'Bind this memory to concrete code locations so it can be verified and auto-surfaced.',
    items: {
      type: 'object',
      properties: {
        type: enumSchema(ANCHOR_TYPE_VALUES, 'Anchor kind.'),
        path: stringSchema('Project-relative path (required for file/directory/package/test/git).'),
        symbol: stringSchema('Symbol name (required for symbol anchors).'),
        command: stringSchema('Shell command (required for command anchors).'),
        role: stringSchema('Roster/catalog role id (required for agent anchors).'),
      },
      required: ['type'],
      additionalProperties: false,
    },
  };
}

export function sourcesSchema() {
  return {
    type: 'array',
    maxItems: 16,
    description:
      'Evidence actually inspected. Use session for agent observations; user only for explicit user statements.',
    items: objectSchema(
      {
        type: enumSchema(
          [
            'user',
            'session',
            'tool_result',
            'project_instruction',
            'file',
            'test',
            'command',
            'legacy_memory',
          ],
          'Evidence origin.',
        ),
        path: stringSchema('Source file or test path.'),
        command: stringSchema('Command actually run.'),
        toolUseId: stringSchema('Observed tool call id.'),
        excerptHash: stringSchema('Hash of inspected evidence, if available.'),
      },
      ['type'],
    ),
  };
}
