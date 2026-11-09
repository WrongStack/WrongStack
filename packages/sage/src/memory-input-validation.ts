/**
 * Remember-input contract: limits, allowed enums, audience normalization,
 * soft quality caps and the hard validation `remember` applies before any
 * write. Re-exported from `store-helpers.ts`.
 */

import { normalizeText, tokenize } from './memory-text.js';
import { normalizeValidity } from './shared/memory-validity.js';
import { isProgressLogText } from './shared/progress-log.js';
import {
  type MemoryAnchor,
  type MemoryAudienceSelector,
  type RememberSageInput,
  type SageKind,
  type SageScope,
  VALID_PERSISTENCE,
} from './types.js';

export const MAX_MEMORY_TEXT_CHARS = 20_000;
export const MAX_MEMORY_METADATA_ITEMS = 128;

const VALID_SCOPES = new Set<SageScope>(['project', 'user', 'session', 'file', 'symbol']);
export const VALID_KINDS = new Set<SageKind>([
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
]);
const VALID_ANCHOR_TYPES = new Set<MemoryAnchor['type']>([
  'file',
  'directory',
  'symbol',
  'package',
  'command',
  'test',
  'git',
  'agent',
]);

const AUDIENCE_KEYS = ['roles', 'taskTypes', 'modes'] as const;

export function normalizeAudience(
  value: MemoryAudienceSelector | undefined,
): MemoryAudienceSelector | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SAGE audience must be an object.');
  }
  const normalized: MemoryAudienceSelector = {};
  for (const key of AUDIENCE_KEYS) {
    const values = value[key];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.some((item) => typeof item !== 'string')) {
      throw new Error(`SAGE audience.${key} must be an array of strings.`);
    }
    if (values.length > MAX_MEMORY_METADATA_ITEMS) {
      throw new Error(`SAGE audience.${key} exceeds ${MAX_MEMORY_METADATA_ITEMS} items.`);
    }
    const items = [...new Set(values.map(normalizeSelectorValue).filter(Boolean))];
    if (items.some((item) => item.length > 256)) {
      throw new Error(`SAGE audience.${key} values must be no longer than 256 characters.`);
    }
    if (items.length > 0) normalized[key] = items;
  }
  return AUDIENCE_KEYS.some((key) => normalized[key]?.length) ? normalized : undefined;
}

/** Kinds that are meaningless without a concrete structural binding. */
export const STRUCTURAL_KINDS: ReadonlySet<SageKind> = new Set([
  'file_note',
  'symbol_note',
  'command_note',
]);

/**
 * Soft quality assessment for remember writes. Hard rejects go through
 * `validateRememberInput`; this caps confidence/importance so low-signal
 * memories rank below anchored, durable ones during injection.
 */
interface RememberQualityAdjustment {
  /** Cap applied to confidence after caller defaults. */
  confidenceCap: number;
  /** Cap applied to importance after caller defaults. */
  importanceCap: number;
  /** Human-readable reasons for diagnostics / audit. */
  reasons: string[];
}

/**
 * Ephemeral progress / session chatter that must not enter long-term store.
 * Intentionally narrow — "we decided to use X" is durable and must pass.
 */
const EPHEMERAL_REMEMBER_PATTERNS: readonly RegExp[] = [
  // The leading word is chatter only when it is a marker, not the subject:
  // "TODO implement retries" is progress, "Todo list items sync with the
  // Kanban board" is a durable fact about the todo feature.
  /^(wip|todo|fixme|hack)\b(?![\s-]*(?:lists?|items?|tools?|boards?|panels?|sync(?:s|ing)?|entr(?:y|ies)|comments?|markers?|tracking|widgets?|views?|state|mode)\b)/i,
  /\b(still working on|looking into|need to (?:fix|check|investigate)|will (?:fix|look|check) (?:this|that|it) later)\b/i,
  /^(debugging|investigating|checking|reading) (the )?(file|code|issue|bug)\b/i,
  /^(fixed|updated|changed) (the )?(bug|issue|test|file)\.?$/i,
];

export function isEphemeralMemoryText(text: string): boolean {
  return EPHEMERAL_REMEMBER_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Score a remember payload for injection quality. Returns caps rather than
 * rejecting so tests and short user preferences still persist; structural
 * kinds without anchors are hard-rejected in `validateRememberInput`.
 */
export function assessRememberQuality(input: {
  text: string;
  kind?: SageKind | undefined;
  anchors?: MemoryAnchor[] | undefined;
  tags?: string[] | undefined;
  scope?: SageScope | undefined;
}): RememberQualityAdjustment {
  const text = normalizeText(input.text);
  const tokens = tokenize(text);
  const anchors = input.anchors ?? [];
  const tags = input.tags ?? [];
  const reasons: string[] = [];
  let confidenceCap = 1;
  let importanceCap = 1;

  if (text.length < 12) {
    confidenceCap = Math.min(confidenceCap, 0.55);
    importanceCap = Math.min(importanceCap, 0.55);
    reasons.push('short_text');
  }
  if (tokens.length < 3) {
    confidenceCap = Math.min(confidenceCap, 0.6);
    importanceCap = Math.min(importanceCap, 0.6);
    reasons.push('few_tokens');
  }
  if (anchors.length === 0) {
    confidenceCap = Math.min(confidenceCap, 0.75);
    reasons.push('unanchored');
    // Durable project facts without anchors are hard to re-surface via path
    // inject — demote importance so anchored knowledge wins budget slots.
    if (input.scope !== 'session' && input.scope !== 'user') {
      importanceCap = Math.min(importanceCap, 0.7);
    }
  }
  if (tags.length === 0) {
    reasons.push('untagged');
  }
  if (input.kind === 'bug_root_cause' && anchors.length === 0) {
    confidenceCap = Math.min(confidenceCap, 0.65);
    importanceCap = Math.min(importanceCap, 0.75);
    reasons.push('root_cause_unanchored');
  }
  if (isEphemeralMemoryText(text)) {
    confidenceCap = Math.min(confidenceCap, 0.35);
    importanceCap = Math.min(importanceCap, 0.35);
    reasons.push('ephemeral_pattern');
  }
  if (isProgressLogText(text)) {
    importanceCap = Math.min(importanceCap, 0.55);
    reasons.push('progress_log');
  }

  return { confidenceCap, importanceCap, reasons };
}

export function validateRememberInput(input: RememberSageInput): void {
  normalizeValidity(input.validity);
  if (typeof input.text !== 'string') throw new Error('SAGE text must be a string.');
  if (input.text.length > MAX_MEMORY_TEXT_CHARS) {
    throw new Error(`SAGE text exceeds ${MAX_MEMORY_TEXT_CHARS} characters.`);
  }
  const normalizedText = normalizeText(input.text);
  if (!normalizedText) throw new Error('SAGE text must not be empty.');
  if (normalizedText.length < 4) {
    throw new Error('SAGE text is too short to be useful long-term memory.');
  }
  // Session-scoped memories MUST carry an owning session ID so retrieval and
  // injection can filter by session. Without this, a session-A memory would
  // leak into session-B search results and automatic injection.
  if (
    input.scope === 'session' &&
    (typeof input.ownerSessionId !== 'string' || !input.ownerSessionId.trim())
  ) {
    throw new Error(
      "SAGE scope 'session' requires ownerSessionId so the memory can be isolated to its owning session.",
    );
  }
  for (const [name, values] of [
    ['tags', input.tags],
    ['anchors', input.anchors],
    ['sources', input.sources],
    ['supersedes', input.supersedes],
    ['contradicts', input.contradicts],
  ] as const) {
    if (values !== undefined && !Array.isArray(values)) {
      throw new Error(`SAGE ${name} must be an array.`);
    }
    if (values && values.length > MAX_MEMORY_METADATA_ITEMS) {
      throw new Error(`SAGE ${name} exceeds ${MAX_MEMORY_METADATA_ITEMS} items.`);
    }
  }
  validateMemoryTags(input.tags);
  if (input.scope && !VALID_SCOPES.has(input.scope)) throw new Error('Invalid SAGE scope.');
  if (input.kind && !VALID_KINDS.has(input.kind)) throw new Error('Invalid SAGE kind.');
  // Runtime enforcement of the persistence class (the types.ts doc promises
  // this; unknown values previously slipped through and silently behaved as
  // non-permanent everywhere). UpdateSageInput goes through the same check in
  // sqlite-store-update.ts.
  if (input.persistence !== undefined && !VALID_PERSISTENCE.has(input.persistence)) {
    throw new Error(
      `Invalid SAGE persistence: expected one of ${[...VALID_PERSISTENCE].join(', ')}, got "${input.persistence}".`,
    );
  }
  if (
    input.expiresAt !== undefined &&
    (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt)))
  ) {
    throw new Error('SAGE expiresAt must be a valid ISO-8601 timestamp.');
  }
  if (
    input.kind &&
    STRUCTURAL_KINDS.has(input.kind) &&
    !(input.anchors && input.anchors.length > 0)
  ) {
    throw new Error(
      `SAGE kind "${input.kind}" requires at least one anchor (file/symbol/command binding).`,
    );
  }
  // Hard-reject pure progress chatter for non-session scopes. Session scope
  // is allowed to hold short-lived notes that expire.
  if ((input.scope ?? 'project') !== 'session' && isEphemeralMemoryText(normalizedText)) {
    throw new Error(
      'SAGE rejected ephemeral progress text. Store durable facts, decisions, conventions, or root causes — not WIP/todo chatter. Use todos for task state.',
    );
  }
  normalizeAudience(input.audience);
  validateMemoryAnchors(input.anchors);
  for (const source of input.sources ?? []) {
    if (
      !source ||
      ![
        'user',
        'session',
        'tool_result',
        'project_instruction',
        'file',
        'test',
        'command',
        'legacy_memory',
      ].includes(source.type)
    ) {
      throw new Error('Invalid SAGE source type.');
    }
  }
}

export function validateMemoryTags(tags: string[] | undefined): void {
  if (
    tags !== undefined &&
    (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || tag.length > 256))
  ) {
    throw new Error('SAGE tags must be strings no longer than 256 characters.');
  }
}

export function validateMemoryAnchors(anchors: MemoryAnchor[] | undefined): void {
  if (anchors !== undefined && !Array.isArray(anchors)) {
    throw new Error('SAGE anchors must be an array.');
  }
  for (const anchor of anchors ?? []) {
    if (!anchor || !VALID_ANCHOR_TYPES.has(anchor.type))
      throw new Error('Invalid SAGE anchor type.');
    if (anchor.type === 'command') {
      if (!anchor.command?.trim()) throw new Error('Command memory anchors require a command.');
    } else if (anchor.type === 'agent') {
      if (!anchor.role?.trim()) throw new Error('Agent memory anchors require a role.');
      if (!/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(anchor.role.trim())) {
        throw new Error('Agent memory anchor role is invalid.');
      }
    } else if (!anchor.path?.trim()) {
      throw new Error(`${anchor.type} memory anchors require a path.`);
    }
    if (anchor.type === 'symbol' && !anchor.symbol?.trim()) {
      throw new Error('Symbol memory anchors require a symbol.');
    }
    // Per-type caps: paths can be deep absolute paths (Windows `C:\...`,
    // node_modules chains), commands can be long shell one-liners. A flat 256
    // rejects legitimate input — the stored form is relativized/short anyway.
    if (
      (anchor.path?.length ?? 0) > 4_096 ||
      (anchor.symbol?.length ?? 0) > 1_024 ||
      (anchor.command?.length ?? 0) > 8_192
    ) {
      throw new Error(
        'SAGE anchor strings are too long (path ≤ 4096, symbol ≤ 1024, command ≤ 8192, role ≤ 96 characters).',
      );
    }
  }
}

function normalizeSelectorValue(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}
