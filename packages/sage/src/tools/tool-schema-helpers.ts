import type { MemoryScope } from '@wrongstack/core/types';
import type { MemoryAnchor, SageKind, SageScope, SageStatus } from '../types.js';

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
