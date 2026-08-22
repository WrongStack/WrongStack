/**
 * git_diff plugin — verifies that the git working tree diff matches expectations.
 * Config is in check.notes as JSON: { expectedFiles: string[], minChanges?: number, maxChanges?: number }
 * Produces evidence: { filesChanged, added, removed, modified, deleted, diffStats[] }.
 */
import type { KanbanCheck, KanbanVerificationCheckResult } from '../../types.js';
import type { VerificationContext } from '../verification-context.js';
import type { VerifierPlugin } from '../verifier-plugin.js';

export class GitDiffPlugin implements VerifierPlugin {
  readonly id = 'git_diff';
  readonly kind = 'deterministic' as const;

  canHandle(checkType: string): boolean {
    return checkType === 'git_diff';
  }

  async verify(
    check: KanbanCheck,
    context: VerificationContext,
  ): Promise<KanbanVerificationCheckResult> {
    // Parse config from notes JSON
    let config: { expectedFiles?: string[]; minChanges?: number; maxChanges?: number } = {};
    try {
      if (check.notes?.trim()) {
        config = JSON.parse(check.notes) as {
          expectedFiles?: string[];
          minChanges?: number;
          maxChanges?: number;
        };
      }
    } catch {
      // not JSON
    }

    const diff = await context.diffSince();
    const status = await context.gitStatus();

    let status_: 'passed' | 'failed' = 'passed';
    const errors: string[] = [];

    if (status.error) {
      status_ = 'failed';
      errors.push(status.error);
    }

    // Check if changes exist at all
    if (diff.length === 0 && status.clean) {
      status_ = 'failed';
      errors.push('No file changes detected since the task started.');
    }

    // Check expected files
    if (config.expectedFiles?.length) {
      const changedPaths = new Set(diff.map((d) => d.path));
      const missing = config.expectedFiles.filter((f) => !changedPaths.has(f));
      if (missing.length > 0) {
        status_ = 'failed';
        errors.push(`Expected changes in files not found: ${missing.join(', ')}.`);
      }
    }

    // Check min/max changes
    if (config.minChanges !== undefined) {
      const totalChanges = diff.reduce((s, d) => s + d.linesAdded + d.linesRemoved, 0);
      if (totalChanges < config.minChanges) {
        status_ = 'failed';
        errors.push(`Expected at least ${config.minChanges} lines changed, got ${totalChanges}.`);
      }
    }
    if (config.maxChanges !== undefined) {
      const totalChanges = diff.reduce((s, d) => s + d.linesAdded + d.linesRemoved, 0);
      if (totalChanges > config.maxChanges) {
        status_ = 'failed';
        errors.push(`Expected at most ${config.maxChanges} lines changed, got ${totalChanges}.`);
      }
    }

    return {
      checkId: check.id,
      description: check.description,
      type: check.type,
      status: status_,
      evidence: {
        filesChanged: diff.length,
        added: diff.filter((d) => d.operation === 'create').length,
        modified: diff.filter((d) => d.operation === 'modify').length,
        deleted: diff.filter((d) => d.operation === 'delete').length,
        diffStats: diff.map((d) => ({
          path: d.path,
          operation: d.operation,
          linesAdded: d.linesAdded,
          linesRemoved: d.linesRemoved,
        })),
        workingTree: {
          clean: status.clean,
          untracked: status.untracked,
          unstaged: status.unstaged,
          staged: status.staged,
        },
      },
      error: errors.length > 0 ? errors.join(' ') : undefined,
    };
  }
}
