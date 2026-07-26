import { randomUUID } from 'node:crypto';
import type { SubagentConfig } from '../types/multi-agent.js';

/**
 * Coerce an unknown value into a trimmed array of non-empty strings,
 * returning `undefined` when the input is absent or contains no usable
 * entries. Shared by the quality-gate and kanban-queue tool factories so
 * identical normalisation logic does not drift across extracted modules.
 */
export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return strings.length > 0 ? strings : undefined;
}

/**
 * Normalise the loose `worktree` override accepted from tool input into the
 * typed `SubagentConfig['worktree']` union, or `undefined` when invalid.
 * Shared by the quality-gate and kanban-queue tool factories.
 */
export function normalizeWorktreeOverride(value: unknown): SubagentConfig['worktree'] | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'auto' || value === 'required' || value === 'off') return value;
  return undefined;
}

/**
 * Instantiate a roster config from a base template, assigning a unique id.
 * Roster entries are templates — a director may spawn several workers with
 * the same role, so never reuse the template id. Shared by the director
 * tools and quality-gate modules to keep the ID generation pattern in one
 * place.
 */
export function instantiateRosterConfig(role: string, base: SubagentConfig): SubagentConfig {
  return {
    ...base,
    id: `${role}-${randomUUID().slice(0, 8)}`,
  };
}
