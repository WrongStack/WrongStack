/** Shapes shared by the dead-code fixer's plan, backup, verify and apply stages. */

import type { DeadCodeAnalysis } from './analyze.js';
import type { DeadCodeScanOptions } from './types.js';

export interface DeadCodeFileChange {
  file: string;
  action: 'edit' | 'delete';
  /** Unified diff (truncated for deletions and very large edits). */
  diff: string;
  findingIds: string[];
}

export interface DeadCodePlan {
  changes: DeadCodeFileChange[];
  /** Finding ids the plan covers (selected + automatically linked). */
  planned: string[];
  skipped: Array<{ id: string; reason: string }>;
  notes: string[];
  /**
   * SHA-256 over every planned file's action and exact before/after contents. Passed back as
   * `expectedRevision`, it binds an apply to the reviewed plan.
   */
  revision?: string | undefined;
}

export interface InternalChange extends DeadCodeFileChange {
  before: string;
  after: string | null;
}

export interface InternalPlan extends DeadCodePlan {
  internal: InternalChange[];
  analysis: DeadCodeAnalysis;
  /** Automatically added finding id → the selected finding that pulled it in. */
  linkedBy: Map<string, string>;
}

export type DeadCodeVerifyMode = 'typecheck' | 'none';

export interface DeadCodeVerifyStep {
  package: string;
  command: string;
  ok: boolean;
  /** Tail of the combined output. */
  output: string;
  durationMs: number;
}

export interface DeadCodeApplyOptions extends DeadCodeScanOptions {
  verify?: DeadCodeVerifyMode | undefined;
  /** Extra check run at the project root after the typecheck, as argv (`['pnpm', 'test']`). */
  verifyCommand?: readonly string[] | undefined;
  verifyTimeoutMs?: number | undefined;
  /**
   * On a failed verification, drop the findings the errors point at and retry
   * the rest (default true). False = all-or-nothing.
   */
  quarantine?: boolean | undefined;
  onProgress?: ((message: string) => void) | undefined;
  /**
   * The `revision` of the reviewed preview. When the re-scanned plan differs, nothing is
   * written and the result carries `stale: true` with the new plan.
   */
  expectedRevision?: string | undefined;
}

export interface DeadCodeApplyResult {
  ok: boolean;
  /** Present when files were written and kept. */
  backupId?: string | undefined;
  changed: string[];
  deleted: string[];
  rolledBack: boolean;
  verify: DeadCodeVerifyStep[];
  plan: DeadCodePlan;
  /** Findings dropped because removing them broke verification. */
  excluded: Array<{ id: string; reason: string }>;
  attempts: number;
  /** The re-scanned plan no longer matched `expectedRevision`; nothing was written. */
  stale?: boolean | undefined;
}
