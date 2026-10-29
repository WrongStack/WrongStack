/**
 * Dead-code cleanup under user control: plan → preview → apply → verify →
 * roll back on failure, with a backup that `undo` restores later.
 *
 * The fixer never trusts a stale report. Every plan re-runs the analysis and
 * acts only on findings that still exist under the same id, computing edits
 * from the CURRENT syntax tree — a file edited since the scan is re-read, not
 * patched at old offsets.
 *
 * Removing code orphans what only it used: an import, a private helper. The
 * cascade pass removes exactly those (bindings referenced before the edit and
 * not after it), so `noUnusedLocals` and linters stay green, and nothing that
 * was already unused before the fix is touched.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  type BackupManifest,
  backupRoot,
  changedSinceFix,
  restoreFromManifest,
  writeBackup,
} from './fix-backup.js';
import { deadCodePlanRevision, planDeadCodeFixesInternal } from './fix-plan.js';
import type {
  DeadCodeApplyOptions,
  DeadCodeApplyResult,
  DeadCodePlan,
  DeadCodeVerifyStep,
  InternalPlan,
} from './fix-types.js';
import { attributeFailure, verifyChanges } from './fix-verify.js';

export {
  type DeadCodeBackupInfo,
  type DeadCodeUndoResult,
  listDeadCodeBackups,
  undoDeadCodeFix,
} from './fix-backup.js';
export { planDeadCodeFixes, planDeadCodeFixesInternal } from './fix-plan.js';
export type {
  DeadCodeApplyOptions,
  DeadCodeApplyResult,
  DeadCodeFileChange,
  DeadCodePlan,
  DeadCodeVerifyMode,
  DeadCodeVerifyStep,
} from './fix-types.js';

const MAX_ATTEMPTS = 6;

function writeChanges(projectRoot: string, plan: InternalPlan): BackupManifest {
  const manifest = writeBackup(projectRoot, plan);
  try {
    for (const c of plan.internal) {
      const abs = path.join(projectRoot, c.file);
      if (c.action === 'delete') fs.unlinkSync(abs);
      else if (c.after !== null) fs.writeFileSync(abs, c.after);
    }
  } catch (err) {
    restoreFromManifest(projectRoot, manifest);
    throw new Error(
      `dead-code fix: writing failed and every file was restored: ${toErrorMessage(err)}`,
    );
  }
  return manifest;
}

export async function applyDeadCodeFixes(
  projectRoot: string,
  findingIds: readonly string[],
  opts: DeadCodeApplyOptions = {},
): Promise<DeadCodeApplyResult> {
  const progress = opts.onProgress ?? (() => {});
  const excluded: Array<{ id: string; reason: string }> = [];
  let ids = [...new Set(findingIds)];
  let lastSteps: DeadCodeVerifyStep[] = [];
  let lastPlan: DeadCodePlan = { changes: [], planned: [], skipped: [], notes: [] };
  let attempts = 0;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    progress(
      attempts === 1
        ? 'Re-scanning and planning…'
        : `Retrying without ${excluded.length} finding(s)…`,
    );
    const plan = await planDeadCodeFixesInternal(projectRoot, ids, opts);
    const revision = deadCodePlanRevision(plan.internal);
    lastPlan = {
      changes: plan.changes,
      planned: plan.planned,
      skipped: [...plan.skipped, ...excluded],
      notes: plan.notes,
      revision,
    };
    // Only the first write is bound to the reviewed preview: later attempts are that plan with
    // findings excluded for failing verification, and report them in `excluded`.
    if (attempts === 1 && opts.expectedRevision !== undefined && revision !== opts.expectedRevision)
      return {
        ok: false,
        stale: true,
        changed: [],
        deleted: [],
        rolledBack: false,
        verify: [],
        plan: lastPlan,
        excluded,
        attempts,
      };
    if (plan.internal.length === 0) break;

    const manifest = writeChanges(projectRoot, plan);
    const { ok, steps } = await verifyChanges(projectRoot, plan, opts, progress);
    lastSteps = steps.map(({ cwd: _cwd, ...step }) => step);
    if (ok) {
      return {
        ok: true,
        backupId: manifest.id,
        changed: plan.internal.filter((c) => c.action === 'edit').map((c) => c.file),
        deleted: plan.internal.filter((c) => c.action === 'delete').map((c) => c.file),
        rolledBack: false,
        verify: lastSteps,
        plan: lastPlan,
        excluded,
        attempts,
      };
    }
    progress('Verification failed — restoring every file…');
    // Verification can run for minutes: a file edited meanwhile is someone
    // else's work now. Keep it and the backup instead of overwriting it.
    const conflicts = changedSinceFix(projectRoot, manifest);
    restoreFromManifest(projectRoot, manifest, new Set(conflicts));
    if (conflicts.length > 0) {
      // The kept backup covers only what was not restored.
      const kept = { ...manifest, files: manifest.files.filter((f) => conflicts.includes(f.file)) };
      fs.writeFileSync(
        path.join(backupRoot(projectRoot), manifest.id, 'manifest.json'),
        JSON.stringify(kept, null, 2),
      );
      return {
        ok: false,
        backupId: manifest.id,
        changed: [],
        deleted: [],
        rolledBack: true,
        verify: lastSteps,
        plan: {
          ...lastPlan,
          notes: [
            ...lastPlan.notes,
            `Not restored — changed while verification ran: ${conflicts.join(', ')}. Undo backup ${manifest.id} with force to restore them.`,
          ],
        },
        excluded,
        attempts,
      };
    }
    fs.rmSync(path.join(backupRoot(projectRoot), manifest.id), { recursive: true, force: true });
    if (opts.quarantine === false) {
      return {
        ok: false,
        changed: [],
        deleted: [],
        rolledBack: true,
        verify: lastSteps,
        plan: lastPlan,
        excluded,
        attempts,
      };
    }
    const blame = attributeFailure(projectRoot, plan, steps, new Set(ids));
    if (blame.size === 0 || blame.size >= ids.length) {
      return {
        ok: false,
        changed: [],
        deleted: [],
        rolledBack: true,
        verify: lastSteps,
        plan: lastPlan,
        excluded,
        attempts,
      };
    }
    for (const [id, reason] of blame) excluded.push({ id, reason: `Excluded: ${reason}.` });
    ids = ids.filter((id) => !blame.has(id));
  }
  // Nothing left to write (every finding skipped or excluded) or attempts exhausted.
  const nothingWritten = lastPlan.changes.length === 0;
  return {
    ok: nothingWritten && excluded.length === 0,
    changed: [],
    deleted: [],
    rolledBack: !nothingWritten || excluded.length > 0,
    verify: lastSteps,
    plan: lastPlan,
    excluded,
    attempts,
  };
}
