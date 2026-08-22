/**
 * file_exists plugin — checks whether a file exists at the given path.
 * Produces evidence: { path, exists, size, mtime }.
 */
import type { KanbanCheck, KanbanVerificationCheckResult } from '../../types.js';
import type { VerificationContext } from '../verification-context.js';
import type { VerifierPlugin } from '../verifier-plugin.js';

export class FileExistsPlugin implements VerifierPlugin {
  readonly id = 'file_exists';
  readonly kind = 'deterministic' as const;

  canHandle(checkType: string): boolean {
    return checkType === 'file_exists';
  }

  async verify(
    check: KanbanCheck,
    context: VerificationContext,
  ): Promise<KanbanVerificationCheckResult> {
    // Parse the description for a file path — use the check notes or description
    const filePath = check.notes?.trim() || check.description.trim();
    if (!filePath) {
      return {
        checkId: check.id,
        description: check.description,
        type: check.type,
        status: 'error',
        evidence: {},
        error: 'file_exists check requires a file path in description or notes.',
      };
    }

    const stat = await context.fileStat(filePath);
    return {
      checkId: check.id,
      description: check.description,
      type: check.type,
      status: stat?.exists ? 'passed' : 'failed',
      evidence: {
        path: filePath,
        exists: stat?.exists ?? false,
        size: stat?.size ?? 0,
        mtime: stat?.mtime ?? null,
      },
      error: stat?.exists ? undefined : `File not found: ${filePath}`,
    };
  }
}
