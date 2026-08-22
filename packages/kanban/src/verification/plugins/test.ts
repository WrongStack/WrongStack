/**
 * test plugin — runs a test pattern (vitest or jest) and checks pass count.
 * The test pattern is read from check.notes or the check description.
 * Produces evidence: { testPattern, passed, failed, skipped, durationMs, failureOutput }.
 */
import type { KanbanCheck, KanbanVerificationCheckResult } from '../../types.js';
import type { VerificationContext } from '../verification-context.js';
import type { VerifierPlugin } from '../verifier-plugin.js';

export class TestPlugin implements VerifierPlugin {
  readonly id = 'test';
  readonly kind = 'deterministic' as const;

  canHandle(checkType: string): boolean {
    return checkType === 'test';
  }

  async verify(
    check: KanbanCheck,
    context: VerificationContext,
  ): Promise<KanbanVerificationCheckResult> {
    const pattern = check.notes?.trim() || check.description.trim();
    if (!pattern) {
      return {
        checkId: check.id,
        description: check.description,
        type: check.type,
        status: 'error',
        evidence: {},
        error: 'test check requires a test pattern (file path or grep) in description or notes.',
      };
    }

    const result = await context.runTest(pattern);

    // Parse description for an expected minimum pass count
    const passMatch = check.description.match(/(\d+)\s*\+?\s*pass/);
    const expectedPasses = passMatch ? parseInt(passMatch[1]!, 10) : 0;

    let status: 'passed' | 'failed' = 'passed';
    const errors: string[] = [];

    if (result.failed > 0) {
      status = 'failed';
      errors.push(`${result.failed} test(s) failed.`);
    }
    if (expectedPasses > 0 && result.passed < expectedPasses) {
      status = 'failed';
      errors.push(`Expected ${expectedPasses} passes, got ${result.passed}.`);
    }

    return {
      checkId: check.id,
      description: check.description,
      type: check.type,
      status,
      evidence: {
        testPattern: pattern,
        passed: result.passed,
        failed: result.failed,
        skipped: result.skipped,
        durationMs: result.durationMs,
        failureOutput: result.failureOutput,
      },
      error: errors.length > 0 ? errors.join(' ') : undefined,
    };
  }
}
