/**
 * command plugin — runs a shell command and checks exit code.
 * The command is read from check.notes or the check description.
 * Produces evidence: { command, exitCode, stdout, stderr, durationMs }.
 */
import type { KanbanCheck, KanbanVerificationCheckResult } from '../../types.js';
import type { VerificationContext } from '../verification-context.js';
import type { VerifierPlugin } from '../verifier-plugin.js';

export class CommandPlugin implements VerifierPlugin {
  readonly id = 'command';
  readonly kind = 'deterministic' as const;

  canHandle(checkType: string): boolean {
    return checkType === 'command';
  }

  async verify(
    check: KanbanCheck,
    context: VerificationContext,
  ): Promise<KanbanVerificationCheckResult> {
    const command = check.notes?.trim() || check.description.trim();
    if (!command) {
      return {
        checkId: check.id,
        description: check.description,
        type: check.type,
        status: 'error',
        evidence: {},
        error: 'command check requires a shell command in description or notes.',
      };
    }

    const result = await context.runCommand(command);
    // A security-gate rejection (allowlist/blocklist/shell-operator) is
    // distinct from a real command failure — operators reviewing results must
    // be able to tell them apart. Surface as `status: 'error'` with the
    // validation reason in `evidence.rejectionReason` and the `error` string.
    const rejected = result.rejected === true;
    return {
      checkId: check.id,
      description: check.description,
      type: check.type,
      status: rejected ? 'error' : result.exitCode === 0 ? 'passed' : 'failed',
      evidence: {
        command,
        exitCode: result.exitCode,
        stdout: result.stdout.slice(0, 5000),
        stderr: result.stderr.slice(0, 2000),
        durationMs: result.durationMs,
        ...(rejected ? { rejectionReason: result.stderr } : {}),
      },
      error:
        result.exitCode === 0
          ? undefined
          : rejected
            ? `Command rejected by security gate: ${result.stderr}`
            : `Command exited with code ${result.exitCode}: ${result.stderr.slice(0, 500) || result.stdout.slice(0, 500)}`,
    };
  }
}
