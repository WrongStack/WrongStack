/**
 * VerifierPlugin interface — the abstraction for every verification check.
 *
 * Two categories of plugins exist:
 *  - **Deterministic** (file_exists, command, test, git_diff, metric):
 *    Pure functions or shell runners. Never call an LLM. Always produce
 *    structured evidence (exit codes, file stats, diff hunks).
 *  - **Escalation** (agent, council):
 *    Delegate to a subagent or Council. Must produce backingRefs
 *    (concrete file paths, test results, diff excerpts) — a bare
 *    "passed" verdict without evidence is rejected by EvidenceValidator.
 *
 * Every plugin self-declares whether it can handle a given check type.
 * The registry iterates plugins and runs the first match.
 */
import type { KanbanCheck, KanbanVerificationCheckResult } from '../types.js';
import type { VerificationContext } from './verification-context.js';

export type VerifierPluginKind = 'deterministic' | 'escalation';

export interface VerifierPlugin {
  /** Unique plugin identifier (e.g. 'file_exists', 'command', 'agent'). */
  readonly id: string;
  /** Whether this plugin needs an LLM or runs purely on the file system. */
  readonly kind: VerifierPluginKind;
  /** True when this plugin can handle the given check type string. */
  canHandle(checkType: string): boolean;
  /**
   * Execute the verification and return a structured result.
   * Deterministic plugins must never call an LLM.
   * Escalation plugins must populate `backingRefs` with concrete proof.
   */
  verify(check: KanbanCheck, context: VerificationContext): Promise<KanbanVerificationCheckResult>;
}
