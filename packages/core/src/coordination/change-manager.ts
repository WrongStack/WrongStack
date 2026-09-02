/**
 * ChangeManager — autonomous code change lifecycle management.
 *
 * Manages the full lifecycle of proposed code changes:
 *   PROPOSE → REVIEW (consensus) → APPLY → VERIFY → (ROLLBACK on failure)
 *
 * The manager does NOT write files directly — it publishes change nodes to the
 * KnowledgeGraph and uses the ConsensusProtocol for approvals. File mutations
 * are performed by agents acting on approved change nodes.
 *
 * Quality gates run automatically before approval:
 * - Tests must pass (or be explicitly waived)
 * - TypeScript must compile
 * - No new critical/high security findings
 * - Lint must pass (or be explicitly ignored)
 *
 * Rollback: on failure detection, the manager can propose a rollback change
 * that reverses the applied change. Rollback changes also go through consensus.
 *
 * @module change-manager
 */
import type { ChangeNode, QualityGateResult } from './knowledge-graph.js';
import type { KnowledgeGraph } from './knowledge-graph.js';
import type { ConsensusProtocol } from './consensus-protocol.js';
import type { FleetBus } from './fleet-bus.js';

export interface ChangeFile {
  path: string;
  action: 'create' | 'modify' | 'delete';
  /** For modify: unified diff string */
  diff?: string;
  /** For create/modify: full file content */
  content?: string;
}

export interface ChangeProposal {
  title: string;
  description: string;
  files: ChangeFile[];
  proposedBy: string;
  satisfiesGoals: string[];
  tags: string[];
  /** Quality gate waivers (e.g., ['no-tests', 'lint-errors']) */
  waivers?: string[];
  /** Skip consensus vote (for automated/internal refactors only) */
  skipVote?: boolean;
}

export interface ApplyResult {
  changeId: string;
  success: boolean;
  appliedAt: string;
  filesTouched: string[];
  verificationResult?: QualityGateResult;
  rollbackChangeId?: string | undefined;
  error?: string | undefined;
}

export interface RollbackResult {
  originalChangeId: string;
  rollbackChangeId: string;
  success: boolean;
  rolledBackAt: string;
  error?: string;
}

/** Quality checks performed before applying a change. */
export interface QualityGateChecks {
  runTests: boolean;
  runTypecheck: boolean;
  runLint: boolean;
  runSecurityScan: boolean;
  checkTestCoverage: boolean;
  minCoveragePercent?: number;
}

export interface ChangeManagerOptions {
  graph: KnowledgeGraph;
  consensus: ConsensusProtocol;
  fleet?: FleetBus | undefined;
  checks?: Partial<QualityGateChecks> | undefined;
}

/**
 * Default quality gate: tests + typecheck + security scan.
 * Lint and coverage are informational warnings, not blockers.
 */
export const DEFAULT_QUALITY_CHECKS: QualityGateChecks = {
  runTests: true,
  runTypecheck: true,
  runLint: false, // warning only
  runSecurityScan: true,
  checkTestCoverage: false,
  minCoveragePercent: 70,
};

/**
 * ChangeManager orchestrates the full change lifecycle.
 *
 * ## Workflow
 * ```
 * propose() → knowledge graph (proposed)
 *            → consensus.vote() (approved/rejected)
 *            → apply() → knowledge graph (applied)
 *            → verify() → on failure: proposeRollback()
 * ```
 */
export class ChangeManager {
  private readonly graph: KnowledgeGraph;
  private readonly consensus: ConsensusProtocol;
  private readonly fleet?: FleetBus | undefined;
  private readonly checks: QualityGateChecks;

  /** Track applied changes for rollback lookup. */
  private readonly appliedChanges = new Map<string, string>(); // changeId → rollbackId

  constructor(opts: ChangeManagerOptions) {
    this.graph = opts.graph;
    this.consensus = opts.consensus;
    this.fleet = opts.fleet ?? undefined;
    this.checks = { ...DEFAULT_QUALITY_CHECKS, ...opts.checks };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Propose a new code change. Creates a ChangeNode in the knowledge graph.
   * Does NOT automatically initiate voting — call `submitForReview()` for that.
   */
  async propose(input: ChangeProposal): Promise<ChangeNode> {
    const node = (await this.graph.add({
      type: 'change',
      title: input.title,
      description: input.description,
      files: input.files.map((f) => ({
        path: f.path,
        action: f.action,
      })),
      status: 'proposed',
      proposedBy: input.proposedBy,
      proposedAt: new Date().toISOString(),
      approvedBy: [],
      rejectedBy: [],
      votes: [],
      qualityGate: { passed: false, checks: [] }, // filled after quality gate
      satisfiesGoals: input.satisfiesGoals,
    } as Omit<ChangeNode, 'id'>)) as ChangeNode;

    // Run quality gate asynchronously. Chain the persistence into the same
    // promise and guard it with a single .catch: this is best-effort
    // background work and must never surface as an unhandled rejection (the
    // graph dir may have been torn down, or a concurrent writer may hold a
    // lock) — that would crash the process / poison an unrelated test.
    void this._runQualityGate(node.id, input.files)
      .then((gate) => this.graph.update(node.id, { qualityGate: gate }))
      .catch(() => {
        /* background quality-gate persistence is best-effort */
      });

    this._emit('change:proposed', { changeId: node.id, title: node.title });
    return node;
  }

  /**
   * Submit an approved change for application.
   * Returns the change node — actual file mutations are performed by agents
   * acting on this node's data from the knowledge graph.
   */
  async submitForReview(changeId: string): Promise<void> {
    const change = this.graph.get(changeId) as ChangeNode | undefined;
    if (change?.type !== 'change') {
      throw new Error(`ChangeManager: no change found "${changeId}"`);
    }
    if (change.status !== 'proposed') {
      throw new Error(`ChangeManager: change "${changeId}" is not in 'proposed' state`);
    }
    this.consensus.initiateVote(changeId);
    this._emit('change:submitted_for_review', { changeId, title: change.title });
  }

  /**
   * Apply an approved change. Updates the change node to 'applied'.
   * Agents should watch for 'applied' status and perform the actual file mutations.
   */
  async markApplied(changeId: string, appliedAt: string): Promise<ChangeNode | null> {
    const change = this.graph.get(changeId) as ChangeNode | undefined;
    if (!change) return null;

    const updated = (await this.graph.update(changeId, {
      status: 'applied',
      appliedAt,
    })) as ChangeNode | null;

    if (updated) {
      this.appliedChanges.set(changeId, '');
      this._emit('change:applied', { changeId, title: updated.title, files: updated.files });
    }
    return updated;
  }

  /**
   * Mark a change as applied and trigger rollback for any satisfied goal
   * that turns out to be broken.
   */
  async markAppliedWithVerification(
    changeId: string,
    verify: () => Promise<QualityGateResult>,
  ): Promise<ApplyResult> {
    const change = this.graph.get(changeId) as ChangeNode | undefined;
    if (!change) throw new Error(`ChangeManager: unknown change "${changeId}"`);

    const appliedAt = new Date().toISOString();
    await this.markApplied(changeId, appliedAt);

    const verificationResult = await verify();

    if (!verificationResult.passed) {
      const rollbackResult = await this.proposeRollback(
        changeId,
        'Quality gate failed after apply',
      );
      return {
        changeId,
        success: false,
        appliedAt,
        filesTouched: change.files.map((f) => f.path),
        verificationResult,
        rollbackChangeId: rollbackResult?.id,
        error: `Quality gate failed: ${verificationResult.checks
          .filter((c) => !c.passed)
          .map((c) => c.name)
          .join(', ')}`,
      };
    }

    return {
      changeId,
      success: true,
      appliedAt,
      filesTouched: change.files.map((f) => f.path),
      verificationResult,
    };
  }

  /**
   * Propose a rollback for an applied change. Creates a new change that
   * reverses the original. Goes through full consensus.
   */
  async proposeRollback(appliedChangeId: string, reason: string): Promise<ChangeNode | null> {
    const original = this.graph.get(appliedChangeId) as ChangeNode | undefined;
    if (original?.type !== 'change') return null;

    // For now, rollback reverses the file list (create↔delete, modify is harder)
    // A full implementation would parse the original diff and create a reverse diff.
    const rollbackFiles: ChangeFile[] = original.files.map((f) => ({
      path: f.path,
      action: f.action === 'create' ? 'delete' : f.action === 'delete' ? 'create' : 'modify',
    }));

    const rollback = await this.propose({
      title: `Rollback: ${original.title}`,
      description: `Rollback of "${original.title}" applied at ${original.appliedAt}. Reason: ${reason}`,
      files: rollbackFiles,
      proposedBy: 'change-manager',
      satisfiesGoals: [],
      tags: ['rollback', `original:${appliedChangeId}`],
    });

    // Update the original change's rollback link
    this.appliedChanges.set(appliedChangeId, rollback.id);
    await this.graph.update(appliedChangeId, {
      rollbackReason: reason,
    });

    this._emit('change:rollback_proposed', {
      originalChangeId: appliedChangeId,
      rollbackChangeId: rollback.id,
      reason,
    });

    return rollback;
  }

  /**
   * Mark a change as rolled back.
   */
  async markRolledBack(changeId: string, rolledBackAt: string): Promise<ChangeNode | null> {
    const updated = (await this.graph.update(changeId, {
      status: 'rolled_back',
      rolledBackAt,
    })) as ChangeNode | null;

    if (updated) {
      this._emit('change:rolled_back', { changeId, title: updated.title });
    }
    return updated;
  }

  // ── Queries ───────────────────────────────────────────────────────────

  getPendingReviews(): ChangeNode[] {
    return this.graph.getChanges({ status: 'proposed' });
  }

  getAppliedChanges(): ChangeNode[] {
    return this.graph.getChanges({ status: 'applied' });
  }

  getChange(id: string): ChangeNode | undefined {
    return this.graph.get(id) as ChangeNode | undefined;
  }

  getChangesForGoal(goalId: string): ChangeNode[] {
    return this.graph.getChanges({}).filter((c) => c.satisfiesGoals.includes(goalId));
  }

  // ── Quality gate ──────────────────────────────────────────────────────

  /**
   * Run quality gate checks. This is informational — actual test/lint/typecheck
   * execution is done by agents spawned for this purpose. This method stores
   * the result in the change node.
   */
  private async _runQualityGate(
    _changeId: string,
    _files: ChangeFile[],
  ): Promise<QualityGateResult> {
    const checks: QualityGateResult['checks'] = [];

    // For now, gate is informational. A full implementation would:
    // 1. Spawn a verify agent to run tests
    // 2. Spawn a typecheck agent
    // 3. Spawn a security scan agent
    // For now, we mark all as pending (actual results set by agents)
    if (this.checks.runTests) {
      checks.push({ name: 'tests', passed: false, detail: 'Tests must be run by a verify agent' });
    }
    if (this.checks.runTypecheck) {
      checks.push({ name: 'typecheck', passed: false, detail: 'TypeScript must compile' });
    }
    if (this.checks.runSecurityScan) {
      checks.push({ name: 'security', passed: false, detail: 'Security scan must pass' });
    }
    if (this.checks.runLint) {
      checks.push({ name: 'lint', passed: false, detail: 'Lint check' });
    }

    const result: QualityGateResult = {
      passed: checks.length === 0,
      checks,
    };

    await this.graph.update(_changeId, { qualityGate: result });
    return result;
  }

  /**
   * Update quality gate result for a change. Called by verify agents
   * after running their checks.
   */
  async updateQualityGate(
    changeId: string,
    checkName: string,
    result: { passed: boolean; detail?: string },
  ): Promise<void> {
    const change = this.graph.get(changeId) as ChangeNode | undefined;
    if (!change) return;

    const checks = change.qualityGate.checks.map((c) =>
      c.name === checkName ? { ...c, ...result } : c,
    );
    const allPassed = checks.every((c) => c.passed);

    await this.graph.update(changeId, {
      qualityGate: { passed: allPassed, checks },
    });

    this._emit('quality_gate:updated', { changeId, checkName, passed: result.passed });
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private _emit(type: string, payload: Record<string, unknown>): void {
    if (!this.fleet) return;
    this.fleet.emit({ subagentId: 'change-manager', ts: Date.now(), type, payload });
  }
}
