/**
 * Escalation plugin: agent.
 * Delegates to a subagent for checks that cannot be deterministically verified.
 * The subagent MUST produce backingRefs with concrete evidence (file paths,
 * test results, diff excerpts). A bare "passed" verdict is rejected by
 * EvidenceValidator.
 *
 * This is a PLACEHOLDER that records the contract. Actual subagent spawning
 * is handled by the Kanban tool or Director integration layer.
 */
import type { KanbanCheck, KanbanVerificationCheckResult } from '../../types.js';
import type { VerificationContext } from '../verification-context.js';
import type { VerifierPlugin } from '../verifier-plugin.js';

export class AgentVerifierPlugin implements VerifierPlugin {
  readonly id = 'agent';
  readonly kind = 'escalation' as const;

  canHandle(checkType: string): boolean {
    return checkType === 'agent';
  }

  async verify(
    check: KanbanCheck,
    _context: VerificationContext,
  ): Promise<KanbanVerificationCheckResult> {
    // This plugin is a contract placeholder. The actual subagent dispatch
    // happens in the completion-protocol orchestrator, which has access to
    // the Director/coordinator for spawning subagents. When dispatched, the
    // subagent is instructed:
    //
    //   "Verify criterion: {check.description}
    //    You MUST attach concrete evidence (file paths, diff hunks, test
    //    results, command output) to your verdict. A bare 'passed' or
    //    'looks good' without evidence files is rejected."
    //
    // The result below tells the orchestrator that this check needs
    // escalation dispatch. The orchestrator then spawns a subagent and
    // collects the result.
    return {
      checkId: check.id,
      description: check.description,
      type: check.type,
      status: 'skipped',
      evidence: {
        escalation: 'agent',
        message:
          'This check requires agent escalation. Dispatch a subagent with the ' +
          'check description and collect a verdict with concrete backing evidence.',
      },
      error: 'Agent escalation not yet dispatched.',
    };
  }
}
