/** Fix planning: re-scan, select still-present findings, and compute every file change. */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { unifiedDiff } from '@wrongstack/core/utils';
import { isBinaryBuffer, isValidUtf8 } from '../_util.js';
import { analyzeDeadCode } from './analyze.js';
import {
  cascadeCleanup,
  computeFileEdit,
  editPackageJson,
  type FileOps,
  truncateDiff,
} from './fix-edits.js';
import type { DeadCodePlan, InternalChange, InternalPlan } from './fix-types.js';
import { loadTypescript } from './parse.js';
import type { DeadCodeFinding, DeadCodeScanOptions } from './types.js';

const NOT_UTF8 =
  'Not UTF-8 text (a legacy single-byte encoding?) — rewriting or backing it up would corrupt every non-ASCII byte. Convert the file to UTF-8 first.';

/**
 * The fixer rewrites, deletes and backs up files from a UTF-8 decode; a file
 * that does not decode losslessly would come back (and undo) with U+FFFD in
 * place of every non-ASCII byte. Null = absent/unreadable, false = not UTF-8.
 */
function utf8Source(abs: string): string | false | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(abs);
  } catch {
    return null;
  }
  return isBinaryBuffer(raw) || !isValidUtf8(raw) ? false : raw.toString('utf8');
}

export async function planDeadCodeFixesInternal(
  projectRoot: string,
  findingIds: readonly string[],
  scanOptions: DeadCodeScanOptions = {},
): Promise<InternalPlan> {
  const ts = await loadTypescript();
  const analysis = await analyzeDeadCode(projectRoot, { ...scanOptions, paths: undefined });
  const byId = new Map(analysis.findings.map((f) => [f.id, f]));
  const skipped: Array<{ id: string; reason: string }> = [];
  const notes: string[] = [];
  const selected: DeadCodeFinding[] = [];
  for (const id of new Set(findingIds)) {
    const f = byId.get(id);
    if (!f) {
      skipped.push({ id, reason: 'Not in a fresh scan — already fixed, or the code changed.' });
      continue;
    }
    if (!f.fix) {
      skipped.push({ id, reason: f.manualReason ?? 'No mechanical fix for this finding.' });
      continue;
    }
    if (utf8Source(path.join(projectRoot, f.file)) === false) {
      skipped.push({ id, reason: NOT_UTF8 });
      continue;
    }
    selected.push(f);
  }

  const deletes = new Set(selected.filter((f) => f.fix === 'delete-file').map((f) => f.file));
  // A deleted file must not stay imported by a surviving file. A file kept for
  // that reason survives too, so what IT imports must stay: repeat to a fixpoint.
  for (let changed = true; changed; ) {
    changed = false;
    for (const file of [...deletes]) {
      const importers: string[] = [];
      for (const node of analysis.nodes.values()) {
        if (deletes.has(node.rel)) continue;
        const hits =
          node.imports.some((i) => i.targets.includes(file) && i.kind !== 'mock') ||
          node.reexports.some((r) => r.targets.includes(file)) ||
          // Glob loaders, dynamic-import prefixes and path literals reference
          // files through extraEdges — there is no import statement to inspect.
          node.extraEdges.includes(file);
        if (hits) importers.push(node.rel);
      }
      if (importers.length > 0) {
        deletes.delete(file);
        changed = true;
        const f = selected.find((s) => s.file === file && s.fix === 'delete-file')!;
        skipped.push({
          id: f.id,
          reason: `Still imported by ${importers.slice(0, 3).join(', ')}${importers.length > 3 ? '…' : ''} — select those too.`,
        });
      }
    }
  }

  const ops = new Map<string, FileOps>();
  const opsFor = (file: string): FileOps => {
    let o = ops.get(file);
    if (!o) {
      o = {
        removeDeclarations: new Set(),
        removeLocals: new Set(),
        unexport: new Set(),
        removeReexports: new Set(),
      };
      ops.set(file, o);
    }
    return o;
  };
  const owners = new Map<string, Set<string>>();
  const own = (file: string, id: string): void => {
    const set = owners.get(file) ?? new Set();
    set.add(id);
    owners.set(file, set);
  };
  const planned = new Set<string>();
  const linkedBy = new Map<string, string>();
  const depRemovals = new Map<string, Array<{ field: string; dep: string }>>();

  for (const f of selected) {
    if (f.fix === 'delete-file') {
      if (!deletes.has(f.file)) continue;
      planned.add(f.id);
      own(f.file, f.id);
      continue;
    }
    if (deletes.has(f.file)) {
      planned.add(f.id);
      continue;
    }
    planned.add(f.id);
    own(f.file, f.id);
    const name = f.name ?? '';
    switch (f.fix) {
      case 'remove-declaration':
        if (f.category === 'unused-local') opsFor(f.file).removeLocals.add(name);
        else opsFor(f.file).removeDeclarations.add(name);
        break;
      case 'remove-export-keyword':
        opsFor(f.file).unexport.add(name);
        break;
      case 'remove-reexport':
        opsFor(f.file).removeReexports.add(name);
        break;
      case 'remove-dependency': {
        const list = depRemovals.get(f.file) ?? [];
        list.push({ field: f.kind ?? 'dependencies', dep: name });
        depRemovals.set(f.file, list);
        break;
      }
    }
  }

  // Deleting a declaration breaks every barrel still re-exporting it. Those
  // re-exports are unused by construction (else the export would be live):
  // remove them in the same change.
  for (const f of selected) {
    if (f.fix !== 'remove-declaration' || f.category === 'unused-local' || !planned.has(f.id))
      continue;
    for (const node of analysis.nodes.values()) {
      if (deletes.has(node.rel)) continue;
      for (const re of node.reexports) {
        if (!re.targets.includes(f.file)) continue;
        for (const n of re.fact.names) {
          if (n.imported !== f.name) continue;
          opsFor(node.rel).removeReexports.add(n.exported);
          const linked = analysis.findings.find(
            (x) => x.category === 'unused-reexport' && x.file === node.rel && x.name === n.exported,
          );
          if (linked) {
            planned.add(linked.id);
            own(node.rel, linked.id);
            if (!linkedBy.has(linked.id)) linkedBy.set(linked.id, f.id);
          }
          notes.push(
            `${node.rel}: also removing re-export '${n.exported}' of deleted ${f.file}#${f.name}.`,
          );
        }
      }
    }
  }

  const internal: InternalChange[] = [];
  for (const file of deletes) {
    const abs = path.join(projectRoot, file);
    const before = fs.readFileSync(abs, 'utf8');
    const lines = before.split('\n').length;
    internal.push({
      file,
      action: 'delete',
      before,
      after: null,
      diff: `--- a/${file}\n+++ /dev/null\n(deleted: ${lines} lines)`,
      findingIds: [...(owners.get(file) ?? [])],
    });
  }
  for (const [file, removals] of depRemovals) {
    const abs = path.join(projectRoot, file);
    const before = fs.readFileSync(abs, 'utf8');
    const after = editPackageJson(before, removals);
    internal.push({
      file,
      action: 'edit',
      before,
      after,
      diff: unifiedDiff(before, after, { fromFile: `a/${file}`, toFile: `b/${file}` }),
      findingIds: [...(owners.get(file) ?? [])],
    });
    notes.push(`${file}: run your package manager's install afterwards to update the lockfile.`);
  }
  for (const [file, fileOps] of ops) {
    const abs = path.join(projectRoot, file);
    const before = utf8Source(abs);
    if (before === null) continue;
    if (before === false) {
      for (const id of owners.get(file) ?? []) {
        planned.delete(id);
        skipped.push({ id, reason: NOT_UTF8 });
      }
      continue;
    }
    const edited = computeFileEdit(ts, file, before, fileOps);
    const after = edited === before ? before : cascadeCleanup(ts, file, before, edited);
    if (after === before) {
      for (const id of owners.get(file) ?? []) {
        planned.delete(id);
        skipped.push({ id, reason: 'The edit could not be located in the current source.' });
      }
      continue;
    }
    internal.push({
      file,
      action: 'edit',
      before,
      after,
      diff: truncateDiff(
        unifiedDiff(before, after, { fromFile: `a/${file}`, toFile: `b/${file}` }),
      ),
      findingIds: [...(owners.get(file) ?? [])],
    });
  }
  internal.sort((a, b) => a.file.localeCompare(b.file));

  return {
    changes: internal.map(({ before: _b, after: _a, ...rest }) => rest),
    internal,
    planned: [...planned],
    skipped,
    notes,
    analysis,
    linkedBy,
  };
}

/** The plan's identity: each file's action and exact contents before and after, in file order. */
export function deadCodePlanRevision(internal: readonly InternalChange[]): string {
  const hash = createHash('sha256');
  for (const change of internal)
    hash.update(JSON.stringify([change.file, change.action, change.before, change.after]));
  return hash.digest('hex');
}

export async function planDeadCodeFixes(
  projectRoot: string,
  findingIds: readonly string[],
  scanOptions: DeadCodeScanOptions = {},
): Promise<DeadCodePlan> {
  const {
    internal: _i,
    analysis: _a,
    linkedBy: _l,
    ...plan
  } = await planDeadCodeFixesInternal(projectRoot, findingIds, scanOptions);
  return { ...plan, revision: deadCodePlanRevision(_i) };
}
