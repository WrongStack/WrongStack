/**
 * EvidenceValidator — enforces the "proof, not opinion" contract.
 *
 * Escalation verifiers (agent, council) return a verdict with optional
 * backing references. This validator checks that the verdict is supported
 * by concrete evidence — file paths, test results, command outputs, or
 * diff excerpts. A bare "passed" or "looks good" without attached proof
 * is rejected.
 *
 * Deterministic verifiers are NOT validated by this class because their
 * evidence is always structurally guaranteed (exit codes, file stats, etc.).
 */
import type { KanbanVerificationCheckResult } from '../types.js';

export interface BackingEvidenceRules {
  /** Minimum number of concrete references required. Default 1. */
  minRefs: number;
  /** At least one ref must be of these kinds. Empty = any kind accepted. */
  requiredRefKinds?: Array<'file' | 'test' | 'command' | 'diff'>;
  /** Reject refs whose summary is too vague (single word, "passed", "looks good"). */
  rejectVagueSummary: boolean;
  /** Reject verdicts that only say "passed" / "looks good" without evidence. */
  rejectBareVerdict: boolean;
}

export const DEFAULT_EVIDENCE_RULES: BackingEvidenceRules = {
  minRefs: 1,
  requiredRefKinds: [],
  rejectVagueSummary: true,
  rejectBareVerdict: true,
};

const VAGUE_PATTERNS = [
  /^(passed|ok|done|fine|good|works?|looks?\s*good|seems?\s*fine|approved?|yes|no|n\/a|\.\.\.)$/i,
  /^.{0,5}$/, // Very short strings
];

export class EvidenceValidator {
  private rules: BackingEvidenceRules;

  constructor(rules?: Partial<BackingEvidenceRules>) {
    this.rules = { ...DEFAULT_EVIDENCE_RULES, ...rules };
  }

  /** Update a specific rule. */
  setRule<K extends keyof BackingEvidenceRules>(key: K, value: BackingEvidenceRules[K]): void {
    this.rules[key] = value;
  }

  /**
   * Validate a check result's backing evidence.
   * Returns { valid: true } when the result has sufficient concrete proof.
   */
  validate(result: KanbanVerificationCheckResult): { valid: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const refs = result.backingRefs ?? [];

    // Reject bare verdict without evidence
    if (this.rules.rejectBareVerdict && refs.length === 0) {
      reasons.push(
        'No concrete file, test, command, or diff references provided. ' +
          'Agent/council verdict must cite specific evidence paths.',
      );
    }

    // Minimum reference count
    if (refs.length < this.rules.minRefs) {
      reasons.push(
        `Expected at least ${this.rules.minRefs} evidence reference(s), got ${refs.length}.`,
      );
    }

    // Required reference kinds
    if (this.rules.requiredRefKinds?.length) {
      const kinds = new Set(refs.map((r) => r.kind));
      const missing = this.rules.requiredRefKinds.filter((k) => !kinds.has(k));
      if (missing.length) {
        reasons.push(
          `Missing required evidence kinds: ${missing.join(', ')}. ` +
            `Found: ${[...kinds].join(', ') || 'none'}.`,
        );
      }
    }

    // Reject vague summaries
    if (this.rules.rejectVagueSummary) {
      for (const ref of refs) {
        if (VAGUE_PATTERNS.some((pattern) => pattern.test(ref.summary.trim()))) {
          reasons.push(
            `Vague evidence summary for "${ref.kind}:${ref.path}": "${ref.summary}". ` +
              `Use a specific description (e.g., "Added login handler at src/routes/login.ts (47 lines)").`,
          );
        }
      }
    }

    return { valid: reasons.length === 0, reasons };
  }
}
