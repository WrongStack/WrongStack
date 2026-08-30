import type { StopReason } from '@wrongstack/core/types';

export function normalizeAnthropic(stop: string | null | undefined): StopReason {
  switch (stop) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'refusal':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

export function normalizeOpenAI(stop: string | null | undefined): StopReason {
  switch (stop) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

/**
 * Normalize Gemini-specific finish reasons. SAFETY, RECITATION, and
 * "hallucination" are safety blocks that should not silently become end_turn.
 */
export function normalizeGemini(stop: string | null | undefined): StopReason {
  switch (stop) {
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'MALICIOUS':
    case 'hallucination':
      return 'refusal';
    case 'stop':
    case 'STOP':
      return 'end_turn';
    case 'max_tokens':
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'tool_use':
    case 'TOOL_USE':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}
