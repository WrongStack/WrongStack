/**
 * Phase start/finish gates for PhaseOrchestrator: isolated worktree
 * acquisition and the verify→repair loop. Split out of phase-orchestrator.ts.
 */
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  failPhaseAfterTasks,
  type IntegrationContext,
  worktreeEnv,
} from './phase-orchestrator-integration.js';
import type { PhaseNode } from './types.js';

/**
 * Allocate (or re-adopt after a resume) an isolated git worktree for a phase
 * when a manager is wired. A persisted isolated run must never silently switch
 * to the base tree: when that would happen the phase is failed and this
 * returns false. A fresh allocation failure may fall back to the shared tree.
 */
export async function acquirePhaseWorktree(
  int: IntegrationContext,
  phase: PhaseNode,
): Promise<boolean> {
  if (!int.worktrees || int.phaseWorktrees.has(phase.id)) return true;
  const savedWorktree = phase.metadata?.['worktreeResume'] as
    | { dir?: unknown; branch?: unknown; baseBranch?: unknown }
    | undefined;
  const canAdopt = savedWorktree && phase.metadata?.['integrationStatus'] !== 'merged';
  try {
    const handle = canAdopt
      ? await int.worktrees.adopt(phase.id, {
          dir: String(savedWorktree.dir ?? ''),
          branch: String(savedWorktree.branch ?? ''),
          baseBranch: String(savedWorktree.baseBranch ?? ''),
          ownerLabel: phase.name,
        })
      : await int.worktrees.allocate(phase.id, {
          slugHint: phase.name,
          ownerLabel: phase.name,
        });
    if (handle.status === 'active') {
      int.phaseWorktrees.set(phase.id, handle);
      phase.metadata = {
        ...phase.metadata,
        worktreeResume: {
          dir: handle.dir,
          branch: handle.branch,
          baseBranch: handle.baseBranch,
        },
      };
    } else if (canAdopt || int.graph.worktrees === true) {
      throw new Error('Saved Goal phase worktree is not active.');
    }
  } catch (error) {
    if (canAdopt || int.graph.worktrees === true) {
      await failPhaseAfterTasks(
        int,
        phase,
        `Cannot safely use phase worktree: ${toErrorMessage(error)}`,
      );
      return false;
    }
    // A fresh allocation failure may fall back to the shared tree.
  }
  return true;
}

/** Output kept per verification attempt, and attempts kept per phase. */
const VERIFY_OUTPUT_LIMIT = 4000;
const VERIFY_ATTEMPT_LIMIT = 10;

/**
 * Record one verification verdict on the phase, so the outcome and the checker's output survive
 * with the saved graph instead of living only in transient events. Newest attempts are kept.
 */
function recordVerification(
  phase: PhaseNode,
  attempt: number,
  verdict: { ok: boolean; output?: string | undefined },
): void {
  const previous = Array.isArray(phase.metadata?.['verificationAttempts'])
    ? (phase.metadata['verificationAttempts'] as unknown[])
    : [];
  // A new gate run (attempt 0) starts a fresh record.
  const kept = attempt === 0 ? [] : previous;
  phase.metadata = {
    ...phase.metadata,
    verificationAttempts: [
      ...kept,
      {
        attempt,
        ok: verdict.ok,
        at: Date.now(),
        ...(verdict.output ? { output: verdict.output.slice(-VERIFY_OUTPUT_LIMIT) } : {}),
      },
    ].slice(-VERIFY_ATTEMPT_LIMIT),
  };
}

/**
 * Run the verification gate for a phase whose tasks all succeeded. Verifies in
 * the phase's worktree; on failure, runs the repair pass and re-verifies, up to
 * `maxVerifyAttempts` repairs. Returns the final verdict. When no `verifyPhase`
 * callback is wired the gate is a no-op and always passes.
 */
export async function runPhaseVerifyGate(
  int: IntegrationContext,
  phase: PhaseNode,
  maxVerifyAttempts: number,
  isStopped: () => boolean,
): Promise<{ ok: boolean; output?: string | undefined }> {
  if (!int.ctx.verifyPhase) return { ok: true };
  const env = worktreeEnv(int, phase);

  for (let attempt = 0; attempt <= maxVerifyAttempts; attempt++) {
    if (isStopped()) return { ok: false, output: 'stopped before verification completed' };

    int.emit('phase.verifying', { phaseId: phase.id, name: phase.name, attempt });
    let verdict: { ok: boolean; output?: string | undefined };
    try {
      verdict = await int.ctx.verifyPhase(phase, env);
    } catch (err) {
      verdict = { ok: false, output: toErrorMessage(err) };
    }
    if (isStopped()) return { ok: false, output: 'stopped before verification completed' };
    recordVerification(phase, attempt, verdict);
    if (verdict.ok) return { ok: true };

    int.emit('phase.verifyFailed', {
      phaseId: phase.id,
      name: phase.name,
      attempt,
      error: verdict.output,
    });

    // Out of attempts, no repair pass available, or aborted → give up.
    if (attempt >= maxVerifyAttempts || !int.ctx.repairPhase || isStopped()) {
      return { ok: false, output: verdict.output };
    }

    int.emit('phase.repairing', { phaseId: phase.id, name: phase.name, attempt: attempt + 1 });
    try {
      await int.ctx.repairPhase(phase, verdict.output ?? 'verification failed', attempt + 1, env);
    } catch {
      // A failed repair is non-fatal: the next verifyPhase run will observe the
      // still-broken tree and the loop will exit with ok:false.
    }
  }
  return { ok: false };
}
