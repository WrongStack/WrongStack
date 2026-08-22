import type { ContentBlock, StopReason } from '../types/acp-v1.js';
import type { ACPSessionRunResult } from './acp-session-types.js';

/**
 * Create a text ContentBlock. Convenience helper for callers of
 * `session.prompt()`.
 */
export function textContent(text: string): ContentBlock {
  return { type: 'text', text };
}

/**
 * Create an image ContentBlock. Only send this if the agent's
 * `promptCapabilities.image` is `true` (check via
 * `session.getCapabilities().promptCapabilities?.image`).
 */
export function imageContent(mimeType: string, data: string): ContentBlock {
  return { type: 'image', mimeType, data };
}

/**
 * Create an audio ContentBlock. Only send this if the agent's
 * `promptCapabilities.audio` is `true` (check via
 * `session.getCapabilities().promptCapabilities?.audio`).
 */
export function audioContent(mimeType: string, data: string): ContentBlock {
  return { type: 'audio', mimeType, data };
}

export function extractText(block: unknown): string {
  if (typeof block !== 'object' || block === null) return '';
  const b = block as {
    type?: string;
    text?: unknown;
    resource?: { text?: unknown };
  };
  if (b.type === 'text' && typeof b.text === 'string') return b.text;
  // Embedded text resources carry their content under `resource.text`.
  if (
    b.type === 'resource' &&
    b.resource &&
    typeof b.resource === 'object' &&
    typeof b.resource.text === 'string'
  ) {
    return b.resource.text;
  }
  return '';
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A fully-populated empty run result (used for pre-aborted short-circuits). */
export function emptyRunResult(stopReason: StopReason): ACPSessionRunResult {
  return {
    text: '',
    stopReason,
    hasText: false,
    toolCalls: [],
    diffs: [],
    thoughts: '',
  };
}
