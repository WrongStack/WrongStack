import type { ValidationResult } from './result.js';
import { MAX_ENTRY_TEXT_CHARS, MAX_RECENT_MESSAGES, MAX_RECENT_TOOLS } from './limits.js';
import {
  ALLOWED_ENTRY_KINDS,
  ALLOWED_FLEET_STATUSES,
  TEXT_BEARING_ENTRY_KINDS,
} from './allow-lists.js';

export function validateFleetEntry(entry: {
  id: string;
  name: string;
  status: string;
  streamingText?: string;
  iterations?: number;
  toolCalls?: number;
  recentTools?: unknown[];
  recentMessages?: unknown[];
  cost?: number;
}): ValidationResult<Record<string, unknown>> {
  if (!entry.id || typeof entry.id !== 'string') {
    return { valid: false, error: 'fleetEntry.id: missing or non-string.' };
  }
  if (!entry.name || typeof entry.name !== 'string') {
    return { valid: false, error: 'fleetEntry.name: missing or non-string.' };
  }

  const status = entry.status;
  if (!ALLOWED_FLEET_STATUSES.has(status)) {
    return { valid: false, error: `fleetEntry.status: "${status}" not on allow-list.` };
  }

  if (entry.streamingText && entry.streamingText.length > MAX_ENTRY_TEXT_CHARS) {
    return {
      valid: false,
      error: `fleetEntry.streamingText: exceeds ${MAX_ENTRY_TEXT_CHARS.toLocaleString()} chars.`,
    };
  }

  if (entry.recentTools && !Array.isArray(entry.recentTools)) {
    return { valid: false, error: 'fleetEntry.recentTools: not an array.' };
  }
  if (entry.recentTools && entry.recentTools.length > MAX_RECENT_TOOLS) {
    return {
      valid: false,
      error: `fleetEntry.recentTools: ${entry.recentTools.length} exceeds max ${MAX_RECENT_TOOLS}.`,
    };
  }

  if (entry.recentMessages && !Array.isArray(entry.recentMessages)) {
    return { valid: false, error: 'fleetEntry.recentMessages: not an array.' };
  }
  if (entry.recentMessages && entry.recentMessages.length > MAX_RECENT_MESSAGES) {
    return {
      valid: false,
      error: `fleetEntry.recentMessages: ${entry.recentMessages.length} exceeds max ${MAX_RECENT_MESSAGES}.`,
    };
  }

  if (entry.cost !== undefined) {
    if (typeof entry.cost !== 'number' || !Number.isFinite(entry.cost) || entry.cost < 0) {
      return {
        valid: false,
        error: `fleetEntry.cost: ${entry.cost} is not a finite non-negative number.`,
      };
    }
  }

  return { valid: true, value: entry as unknown as Record<string, unknown> };
}

/**
 * Validate a restored session entry (from JSONL).
 *
 * Rejects:
 *  - Non-object entries
 *  - Unknown entry kinds
 *  - Oversized payloads
 */
export function validateRestoreEntry(
  entry: unknown,
  index: number,
): ValidationResult<Record<string, unknown>> {
  if (!entry || typeof entry !== 'object') {
    return { valid: false, error: `restoreEntry[${index}]: not an object (got ${typeof entry}).` };
  }

  const e = entry as Record<string, unknown>;
  const kind = String(e.kind ?? '');

  if (kind === 'tool') {
    // Tool entries are validated loosely — they come from our own JSONL
    return { valid: true, value: e };
  }

  if (!ALLOWED_ENTRY_KINDS.has(kind)) {
    return {
      valid: false,
      error: `restoreEntry[${index}].kind: "${kind}" not on allow-list.`,
    };
  }

  if (TEXT_BEARING_ENTRY_KINDS.has(kind)) {
    const text = e.text;
    if (typeof text === 'string' && text.length > MAX_ENTRY_TEXT_CHARS) {
      return {
        valid: false,
        error: `restoreEntry[${index}].text: exceeds ${MAX_ENTRY_TEXT_CHARS.toLocaleString()} chars.`,
      };
    }
  }

  return { valid: true, value: e };
}
