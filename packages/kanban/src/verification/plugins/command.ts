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
        stdout: sliceAtCodePoint(result.stdout, 5000),
        stderr: sliceAtCodePoint(result.stderr, 2000),
        durationMs: result.durationMs,
        ...(rejected ? { rejectionReason: result.stderr } : {}),
      },
      error:
        result.exitCode === 0
          ? undefined
          : rejected
            ? `Command rejected by security gate: ${result.stderr}`
            : `Command exited with code ${result.exitCode}: ${sliceAtCodePoint(result.stderr, 500) || sliceAtCodePoint(result.stdout, 500)}`,
    };
  }
}

/**
 * First `max` UTF-16 code units of `value`, never ending between the halves of
 * a surrogate pair. This evidence is persisted in the task's verificationReport,
 * and a lone surrogate there is ill-formed text (same walk-back rule as
 * verification-report's `truncateEvidence`).
 */
function sliceAtCodePoint(value: string, max: number): string {
  if (value.length <= max) return value;
  const last = value.charCodeAt(max - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}
