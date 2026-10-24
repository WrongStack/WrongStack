/**
 * Agent tools over the dead-code engine.
 *
 * `dead-code-scan` is read-only (scan, and preview the exact diff a cleanup
 * would make); `dead-code-fix` is the only writer and always asks first. Fixes
 * address findings by id, and every fix re-scans — an id from an old scan that
 * no longer holds is skipped, never applied at stale offsets.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import { ToolValidationError } from '@wrongstack/contracts/types';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { analyzeDeadCode } from './analyze.js';
import {
  applyDeadCodeFixes,
  type DeadCodePlan,
  listDeadCodeBackups,
  planDeadCodeFixes,
  undoDeadCodeFix,
} from './fix.js';
import type { DeadCodeCategory, DeadCodeConfidence, DeadCodeFinding } from './types.js';

const CATEGORIES: readonly DeadCodeCategory[] = [
  'unreachable-file',
  'test-only-file',
  'dead-export',
  'unused-export',
  'unused-reexport',
  'test-only-export',
  'unused-local',
  'unused-dependency',
  'unused-public-export',
];
const CONFIDENCE_RANK: Record<DeadCodeConfidence, number> = { high: 0, medium: 1, low: 2 };
const DEFAULT_LIMIT = 100;
const MAX_PREVIEW_CHARS = 60_000;

function projectRootOf(ctx: { projectRoot?: string; cwd?: string }): string {
  return ctx.projectRoot ?? ctx.cwd ?? process.cwd();
}

function cleanPaths(paths: unknown): string[] | undefined {
  if (!Array.isArray(paths)) return undefined;
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const norm = p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (path.isAbsolute(norm) || norm.split('/').includes('..')) {
      throw new ToolValidationError({
        message: `dead-code: paths must be project-relative, got "${p}"`,
        field: 'paths',
      });
    }
    out.push(norm);
  }
  return out;
}

function compact(f: DeadCodeFinding): Record<string, unknown> {
  return {
    id: f.id,
    category: f.category,
    confidence: f.confidence,
    at: f.line ? `${f.file}:${f.line}` : f.file,
    ...(f.name ? { name: f.name } : {}),
    ...(f.kind ? { kind: f.kind } : {}),
    ...(f.fix ? { fix: f.fix } : { manual: f.manualReason ?? 'manual review' }),
    reason: f.reason,
  };
}

function compactPlan(plan: DeadCodePlan): Record<string, unknown> {
  let budget = MAX_PREVIEW_CHARS;
  const changes = plan.changes.map((c) => {
    const diff =
      c.diff.length <= budget ? c.diff : `${c.diff.slice(0, Math.max(0, budget))}\n… (truncated)`;
    budget = Math.max(0, budget - diff.length);
    return { file: c.file, action: c.action, findings: c.findingIds, diff };
  });
  return { changes, planned: plan.planned, skipped: plan.skipped, notes: plan.notes };
}

// ─── dead-code-scan ──────────────────────────────────────────────────────

export interface DeadCodeScanToolInput {
  paths?: string[] | undefined;
  categories?: DeadCodeCategory[] | undefined;
  minConfidence?: DeadCodeConfidence | undefined;
  includePublicApi?: boolean | undefined;
  entries?: string[] | undefined;
  limit?: number | undefined;
  previewIds?: string[] | undefined;
}

export const deadCodeScanTool: Tool<DeadCodeScanToolInput, Record<string, unknown>> = {
  name: 'dead-code-scan',
  category: 'Project',
  icon: 'index',
  description:
    'Find dead code in executable source files (TS/JS): unreachable files, exports nothing imports, ' +
    'unused re-exports, test-only code, unused top-level locals and unused package.json dependencies. ' +
    'Builds a precise module graph from package.json entries, HTML, CI/config references and tests; ' +
    'documentation and .d.ts files never count. Pass previewIds to see the exact diff a cleanup would make.',
  usageHint:
    'READ-ONLY. Every finding has a stable `id`, a `confidence` and, when mechanical, a `fix`.\n\n' +
    '- `paths` narrows the REPORT to project-relative prefixes; the analysis always covers the whole repo.\n' +
    '- `categories` / `minConfidence` filter; `limit` caps the list (default 100, the full report is saved to `reportPath`).\n' +
    '- `previewIds` returns the unified diff `dead-code-fix` would apply for those ids (including orphaned imports/helpers it would also remove) without writing anything.\n' +
    '- Show the user the findings and the preview, and let them choose before calling `dead-code-fix`.',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  timeoutMs: 180_000,
  inputSchema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Project-relative path prefixes to report on.',
      },
      categories: {
        type: 'array',
        items: { type: 'string', enum: [...CATEGORIES] },
        description: 'Only these categories.',
      },
      minConfidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'Lowest confidence to list (default low).',
      },
      includePublicApi: {
        type: 'boolean',
        description: 'Also report published-package API that nothing in the repo imports.',
      },
      entries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra entry files/globs loaded outside the import graph.',
      },
      limit: { type: 'number', description: 'Max findings listed (default 100).' },
      previewIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Finding ids to preview as a diff (no writes).',
      },
    },
  },
  async execute(input, ctx) {
    const projectRoot = projectRootOf(ctx);
    const paths = cleanPaths(input.paths);
    if (input.previewIds && input.previewIds.length > 0) {
      const plan = await planDeadCodeFixes(projectRoot, input.previewIds, {
        entries: input.entries,
        includePublicApi: input.includePublicApi,
      });
      return { preview: compactPlan(plan) };
    }
    const result = await analyzeDeadCode(projectRoot, {
      paths,
      entries: input.entries,
      includePublicApi: input.includePublicApi,
    });
    const min = CONFIDENCE_RANK[input.minConfidence ?? 'low'];
    const cats = input.categories?.length ? new Set(input.categories) : null;
    const listed = result.findings.filter(
      (f) => CONFIDENCE_RANK[f.confidence] <= min && (!cats || cats.has(f.category)),
    );
    const limit = Math.max(1, Math.min(1000, Math.floor(input.limit ?? DEFAULT_LIMIT)));

    let reportPath: string | undefined;
    try {
      const dir = path.join(resolveWstackPaths({ projectRoot }).projectDir, 'dead-code');
      fs.mkdirSync(dir, { recursive: true });
      reportPath = path.join(dir, 'last-scan.json');
      const { nodes: _nodes, fileHashes: _hashes, ...report } = result;
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 1));
    } catch {
      reportPath = undefined;
    }
    return {
      summary: {
        findings: result.findings.length,
        listed: Math.min(limit, listed.length),
        matchingFilter: listed.length,
        byCategory: result.byCategory,
        autoFixable: result.findings.filter((f) => f.fix).length,
      },
      stats: result.stats,
      warnings: result.warnings,
      findings: listed.slice(0, limit).map(compact),
      ...(reportPath ? { reportPath } : {}),
    };
  },
};

// ─── dead-code-fix ───────────────────────────────────────────────────────

export interface DeadCodeFixToolInput {
  action: 'apply' | 'undo' | 'backups';
  ids?: string[] | undefined;
  verify?: 'typecheck' | 'none' | undefined;
  backupId?: string | undefined;
  force?: boolean | undefined;
}

export const deadCodeFixTool: Tool<DeadCodeFixToolInput, Record<string, unknown>> = {
  name: 'dead-code-fix',
  category: 'Transform',
  icon: 'edit',
  description:
    'Remove dead code found by dead-code-scan, by finding id: delete unreachable files, remove dead ' +
    'declarations (and the imports/helpers only they used), drop needless `export`s, unused re-exports and ' +
    'unused dependencies. Re-scans first, typechecks the affected packages after, rolls back on failure, and ' +
    'keeps a backup that `undo` restores.',
  usageHint:
    'MUTATING — only apply ids the user chose after seeing the scan (and ideally the dead-code-scan preview).\n\n' +
    '- `action: "apply"` + `ids`: findings that changed since the scan are skipped, not forced. `verify` defaults to `typecheck`; a failing check restores every file, and findings the errors point at are excluded and the rest retried.\n' +
    '- `action: "undo"` + `backupId` (from apply) restores the pre-fix files; files edited after the fix need `force: true`.\n' +
    '- `action: "backups"` lists available backups.',
  permission: 'confirm',
  mutating: true,
  // Trust rules key on the action: allowing `undo` must not allow `apply`.
  subjectKey: 'action',
  capabilities: ['fs.write'],
  timeoutMs: 15 * 60_000,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['apply', 'undo', 'backups'],
        description:
          'apply = remove the given finding ids; undo = restore a backup; backups = list them.',
      },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Finding ids from dead-code-scan (apply).',
      },
      verify: {
        type: 'string',
        enum: ['typecheck', 'none'],
        description: 'Post-apply verification (default typecheck).',
      },
      backupId: { type: 'string', description: 'Backup to restore (undo).' },
      force: { type: 'boolean', description: 'Undo even over files edited after the fix.' },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const projectRoot = projectRootOf(ctx);
    if (input.action === 'backups') return { backups: listDeadCodeBackups(projectRoot) };
    if (input.action === 'undo') {
      if (!input.backupId) {
        throw new ToolValidationError({
          message: 'dead-code-fix: undo needs backupId',
          field: 'backupId',
        });
      }
      const res = undoDeadCodeFix(projectRoot, input.backupId, { force: input.force === true });
      if (res.restored.length === 0 && res.conflicts.length > 0) {
        throw new Error(
          `dead-code-fix: ${res.conflicts.length} file(s) changed after the fix (${res.conflicts.slice(0, 5).join(', ')}); nothing restored. Retry with force: true to overwrite them.`,
        );
      }
      return res as unknown as Record<string, unknown>;
    }
    if (input.action !== 'apply') {
      throw new ToolValidationError({
        message: `dead-code-fix: unknown action "${String(input.action)}"`,
        field: 'action',
      });
    }
    const ids = (input.ids ?? []).filter((x) => typeof x === 'string');
    if (ids.length === 0) {
      throw new ToolValidationError({
        message: 'dead-code-fix: apply needs at least one finding id',
        field: 'ids',
      });
    }
    const res = await applyDeadCodeFixes(projectRoot, ids, { verify: input.verify ?? 'typecheck' });
    if (!res.ok && res.rolledBack) {
      const failed = res.verify.find((v) => !v.ok);
      throw new Error(
        `dead-code-fix: verification failed${failed ? ` (${failed.package}: ${failed.command})` : ''}; every file was restored.\n${failed?.output.slice(-2500) ?? ''}`,
      );
    }
    return {
      ok: res.ok,
      backupId: res.backupId,
      changed: res.changed,
      deleted: res.deleted,
      excluded: res.excluded,
      skipped: res.plan.skipped,
      notes: res.plan.notes,
      verify: res.verify.map((v) => ({
        package: v.package,
        command: v.command,
        ok: v.ok,
        durationMs: v.durationMs,
      })),
    };
  },
};
