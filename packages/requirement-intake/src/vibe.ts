/**
 * Requirements Intake — VIBE Three-Stage Verification Protocol.
 *
 * Provides detection, tag parsing, and persistent state management for requests
 * marked with the `[VIBE]` protocol trigger anywhere in the prompt text.
 *
 * When `[VIBE]` is detected, it locks the task into the Three-Stage
 * Verification Protocol (Spec-Synthesizer -> Coder -> Auditor) and ensures
 * the state is preserved across iterative refining and updates.
 */

/** Case-insensitive detector. Not global — `RegExp#test` would skip matches via `lastIndex`. */
export const VIBE_TAG_REGEX = /\[VIBE\]/i;

export type VibeProtocolStage = 'synthesizer' | 'coder' | 'auditor' | 'passed';

export interface VibeProtocolState {
  /** True whenever [VIBE] was present in the prompt or preserved across refinements. */
  isVibeMode: boolean;
  detectedAt: number;
  /** Active stage in the verification protocol. */
  stage: VibeProtocolStage;
  /** Structured output from Spec-Synthesizer. */
  synthesizedSpec?: string | undefined;
  /** Generated implementation contract or code diff. */
  coderContract?: string | undefined;
  /** Independent verification decision from Auditor. */
  auditVerdict?: 'PASS' | 'REJECT' | undefined;
  /** Detailed audit check results or revision requests. */
  auditNotes?: string[] | undefined;
}

/**
 * Checks if the given text contains the `[VIBE]` tag (case-insensitive)
 * anywhere in the string.
 */
export function hasVibeTag(text: string | undefined | null): boolean {
  if (!text) return false;
  return VIBE_TAG_REGEX.test(text);
}

/**
 * Safely strips the `[VIBE]` tag from the text for normalized display,
 * preserving all other content and trimming extraneous whitespace.
 */
export function stripVibeTag(text: string): string {
  return text
    .replace(/\[VIBE\]/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Derives or preserves Vibe Protocol state for an intake record.
 * If the record was already in Vibe mode, it remains in Vibe mode across
 * refinements even if subsequent messages omit the tag.
 */
export function deriveVibeState(
  rawText: string,
  existingState?: VibeProtocolState | undefined,
  now: number = Date.now(),
): VibeProtocolState | undefined {
  const containsTag = hasVibeTag(rawText);

  if (existingState?.isVibeMode) {
    // Preserve existing mode and accumulated stages across refinements
    return {
      ...existingState,
      isVibeMode: true,
    };
  }

  if (containsTag) {
    return {
      isVibeMode: true,
      detectedAt: now,
      stage: 'synthesizer',
    };
  }

  return undefined;
}
