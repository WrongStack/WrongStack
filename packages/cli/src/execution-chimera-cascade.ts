import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  CascadeAgentKind,
  CascadeEvidenceCheckResult,
  CascadeEvidenceStatus,
  ChimeraCascadeNeededPayload,
  ChimeraReviewNeededPayload,
} from '@wrongstack/core/plugin';
import { emitReviewIfChanged } from '@wrongstack/core/plugin';
import type { StopReason } from '@wrongstack/core/types';
import {
  CASCADE_EVIDENCE_COMMAND_TIMEOUT_MS,
  extractCascadeEvidence,
  type CascadeEvidence,
  verifyCascadeEvidence,
} from './chimera-cascade-evidence.js';
import { buildChimeraCascadeTaskDescription } from './chimera-review-task.js';
import type { ReviewerAttempt } from './chimera-reviewer-policy.js';
import {
  attemptLabel,
  buildRetryPreamble,
  runSubagentModelLadder,
} from './chimera-subagent-ladder.js';
import type { ExecuteDeps } from './execute-deps.js';

type Director = NonNullable<ExecuteDeps['fleet']['director']>;
type Events = ExecuteDeps['core']['events'];
type Session = ExecuteDeps['session']['session'];

/** Per-attempt wall clock for a cascade agent (unchanged from before). */
const CASCADE_ATTEMPT_TIMEOUT_MS = 600_000;
/** Ladder budget per cascade agent — bounds how long shutdown can wait. */
const CASCADE_LADDER_BUDGET_MS = 900_000;

type InstallChimeraCascadeHandlerOptions = {
  events: Events;
  director: Director | null | undefined;
  session: Session;
  getPendingWork: () => Promise<void> | undefined;
  trackWork: (work: Promise<void>) => void;
  /**
   * Model ladder for cascade spawns. Supplied by the caller because only it
   * holds the live config. Omit to keep the single unpinned spawn.
   */
  buildLadder?: (() => ReviewerAttempt[]) | undefined;
  /** Test seam; production defaults to the real safe command verifier. */
  verifyEvidence?: typeof verifyCascadeEvidence | undefined;
  /** Optional session-teardown chain — the wildcard listener disposer is
   *  pushed here so the registration is released when the session ends. */
  teardownHandlers?: Array<() => void> | undefined;
  /** Persist every evidence verdict on the source report, even when re-review stops. */
  persistEvidence?:
    | ((
        reportId: string,
        status: CascadeEvidenceStatus,
        checks: CascadeEvidenceCheckResult[],
      ) => Promise<void>)
    | undefined;
};

const INHERIT_ONLY_LADDER: ReviewerAttempt[] = [
  { provider: '', model: '', fallbackModels: [], tier: 'inherit' },
];

export function installChimeraCascadeHandler({
  events,
  director,
  session,
  getPendingWork,
  trackWork,
  buildLadder,
  verifyEvidence = verifyCascadeEvidence,
  persistEvidence,
  teardownHandlers,
}: InstallChimeraCascadeHandlerOptions): void {
  // Capture the disposer instead of discarding it — the wildcard listener
  // otherwise accumulates in EventBus.wildcards until the process cap is
  // hit (see the EventBus leak board card). Owner tag included so a cap
  // rejection log names this registration site.
  const off = events.onPattern('chimera.cascade_needed', (_event, payload) => {
    const p = payload as ChimeraCascadeNeededPayload;
    const dir = director;
    if (!dir) return; // Director not available — cascade skipped.
    if (p.agents.length === 0) return;

    const previousWork = getPendingWork();

    // Track in pending work so the execution finally block awaits cascade
    // completion before session.close(). Chain onto any prior in-flight
    // work so cascades run after their parent review, not concurrently.
    const pendingWork = (async () => {
      // Await any prior pending work (the parent review) before spawning.
      try {
        await previousWork;
      } catch {
        // Parent failed — proceed with cascade anyway; the review text
        // is carried in the payload, independent of subagent success.
      }

      // P0-3: collect each successful agent's claimed verification evidence
      // so the re-review step can re-run the real commands before accepting
      // the fixes as verified.
      const agentEvidence: Array<{
        agentKind: CascadeAgentKind;
        evidence: CascadeEvidence;
      }> = [];

      for (const agentKind of p.agents) {
        try {
          const taskDesc = buildChimeraCascadeTaskDescription(agentKind, p);
          const role = agentKind === 'security-scanner' ? 'security-scanner' : 'bug-hunter';
          const ladder = buildLadder?.() ?? INHERIT_ONLY_LADDER;
          const outcome = await runSubagentModelLadder({
            director: dir,
            ladder,
            attemptTimeoutMs: CASCADE_ATTEMPT_TIMEOUT_MS,
            budgetMs: CASCADE_LADDER_BUDGET_MS,
            buildConfig: (attempt, timeoutMs) => ({
              name: `chimera-cascade-${agentKind}`,
              role,
              maxIterations: 40,
              maxToolCalls: 200,
              timeoutMs,
              // Cascade agents are ephemeral infrastructure: like reviewers,
              // they must not consume the leader's lifetime maxSpawns budget.
              spawnBudgetExempt: true,
              // Model-driven completion (see core coordination/subagent-finish.ts):
              // a rung crossing its wall-clock budget is notified in-band
              // between tool batches and finishes its own turn within the
              // grace window instead of being killed. Ladder-retry semantics
              // are intact: a rung that still exhausts the grace window lands
              // as a `timeout` task result, which advances the ladder, and
              // `buildRetryPreamble` below already warns the successor that
              // the tree may hold the dead rung's partial edits.
              gracefulFinish: true,
              // Rung 0 stays unpinned so the role model matrix still decides;
              // later rungs pin a model precisely because it just failed.
              ...(attempt.tier === 'inherit'
                ? {}
                : {
                    provider: attempt.provider,
                    model: attempt.model,
                    fallbackModels: attempt.fallbackModels,
                  }),
            }),
            // Cascade agents write files, so a successor must be told the tree
            // may already hold the dead attempt's partial edits.
            buildTask: (_attempt, failures) => `${buildRetryPreamble(failures)}${taskDesc}`,
            onAttemptFailed: async (failure, next) => {
              if (!next) return;
              await session.append({
                type: 'error',
                ts: new Date().toISOString(),
                message: `🦂 Chimera cascade (${agentKind}) on ${failure.model} failed (${failure.reason}) — retrying on ${attemptLabel(next)} (${next.tier}).`,
                phase: 'agent',
              });
            },
          });
          const result = outcome.result;

          if (result?.status === 'success') {
            const resultText =
              typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
            // P0-3: collect the agent's claimed verification evidence so the
            // re-review step can re-run the real commands before accepting
            // the fixes as verified.
            const claimed = extractCascadeEvidence(resultText);
            if (claimed) {
              agentEvidence.push({ agentKind, evidence: claimed });
            }
            await session.append({
              type: 'llm_response',
              ts: new Date().toISOString(),
              content: [
                {
                  type: 'text',
                  text: `🦂 Chimera cascade (${agentKind}) — ${resultText}`,
                },
              ],
              stopReason: 'end_turn' as StopReason,
              usage: { input: 0, output: 0 },
            });
          } else {
            const detail = outcome.lastError
              ? outcome.lastError instanceof Error
                ? outcome.lastError.message
                : String(outcome.lastError)
              : `${result?.status ?? 'unknown'}: ${result?.error?.message ?? 'no result'}`;
            await session.append({
              type: 'error',
              ts: new Date().toISOString(),
              message: `🦂 Chimera cascade (${agentKind}) ${result?.status ?? 'unknown'}: ${detail} — exhausted ${outcome.attemptsUsed} of ${ladder.length} model(s)`,
              phase: 'agent',
            });
          }
        } catch (err) {
          await session.append({
            type: 'error',
            ts: new Date().toISOString(),
            message: `🦂 Chimera cascade (${agentKind}) failed: ${err instanceof Error ? err.message : String(err)}`,
            phase: 'agent',
          });
        }
      }

      // Merge every successful agent's evidence into the one contract verified
      // before re-review. Later agents replace a same-named check because they
      // ran after earlier agents and therefore describe the final tree state.
      const accumulatedEvidence: CascadeEvidence = {};
      for (const { evidence } of agentEvidence) {
        for (const name of ['typecheck', 'lint', 'tests'] as const) {
          if (evidence[name]) accumulatedEvidence[name] = evidence[name];
        }
      }

      await maybeReReviewCascade({
        events,
        session,
        bundle: p.bundle,
        reportId: p.reportId,
        claimedEvidence: accumulatedEvidence,
        verifyEvidence,
        persistEvidence,
      });
    })();

    trackWork(pendingWork);
  }, 'chimera-cascade');
  // Session-scoped release: the caller's teardown chain (execution.ts
  // finally block) invokes this to drop the wildcard listener at session
  // end instead of letting it accumulate toward MAX_WILDCARDS.
  if (off) teardownHandlers?.push(off);
}

async function maybeReReviewCascade({
  events,
  session,
  bundle,
  reportId,
  claimedEvidence,
  verifyEvidence,
  persistEvidence,
}: {
  events: Events;
  session: Session;
  bundle: ChimeraCascadeNeededPayload['bundle'];
  reportId?: string | undefined;
  verifyEvidence: NonNullable<InstallChimeraCascadeHandlerOptions['verifyEvidence']>;
  persistEvidence?: InstallChimeraCascadeHandlerOptions['persistEvidence'];
  /**
   * P0-3: evidence claimed by the cascade fix agents before re-review. The
   * orchestrator re-runs the claimed commands against the working tree and
   * only proceeds to re-review when the verification passes — otherwise the
   * findings stay open and the report is marked unverified.
   */
  claimedEvidence: CascadeEvidence;
}): Promise<void> {
  // After the cascade fix agents finish, re-read the (now possibly modified)
  // files and re-emit chimera.review_needed to trigger a fresh review. The
  // loop is bounded by maxCascadeDepth.
  const maxDepth = bundle.maxCascadeDepth ?? 0;
  const currentDepth = bundle.cascadeDepth ?? 0;

  // P0-3: verify the cascade agents' claimed machine evidence BEFORE we
  // trust their fixes. Verification runs the same commands (typecheck/lint/
  // tests) the agent supposedly ran and compares exit codes. The verdict
  // rides on the re-review bundle so the persisted report records exactly
  // which checks the orchestrator confirmed.
  const hasClaimedEvidence = Object.keys(claimedEvidence).length > 0;
  const verification = hasClaimedEvidence
    ? await verifyEvidence(
        claimedEvidence,
        bundle.cwd,
        undefined,
        CASCADE_EVIDENCE_COMMAND_TIMEOUT_MS,
      )
    : { status: 'missing' as const, checks: [] };
  const evidenceBundle: ChimeraCascadeNeededPayload['bundle'] = {
    ...bundle,
    evidenceStatus: verification.status,
    evidenceChecks: verification.checks,
  };
  if (reportId && persistEvidence) {
    try {
      await persistEvidence(reportId, verification.status, verification.checks);
    } catch (error) {
      await session.append({
        type: 'error',
        ts: new Date().toISOString(),
        message: `Chimera cascade evidence persistence failed: ${errorText(error)}`,
        phase: 'agent',
      });
    }
  }
  await session.append({
    type: 'llm_response',
    ts: new Date().toISOString(),
    content: [
      {
        type: 'text',
        text: renderEvidenceSummary(verification.status, verification.checks),
      },
    ],
    stopReason: 'end_turn' as StopReason,
    usage: { input: 0, output: 0 },
  });
  if (verification.status !== 'verified') {
    await session.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [
        {
          type: 'text',
          text: `🦂 Chimera cascade evidence ${verification.status} — fix not confirmed, skipping re-review. Findings remain open.`,
        },
      ],
      stopReason: 'end_turn' as StopReason,
      usage: { input: 0, output: 0 },
    });
    return;
  }

  if (maxDepth > 0 && currentDepth < maxDepth) {
    try {
      const reReadFiles: ChimeraReviewNeededPayload['files'] = [];
      for (const f of evidenceBundle.files) {
        try {
          const absPath = path.join(evidenceBundle.cwd, f.path);
          const content = await fsp.readFile(absPath, 'utf8');
          reReadFiles.push({ path: f.path, status: 'modified', content });
        } catch {
          // File deleted or unreadable — skip it.
        }
      }

      if (reReadFiles.length > 0) {
        // Spread evidenceBundle (not bundle) so the evidenceStatus /
        // evidenceChecks fields ride into the re-review payload and onto the
        // persisted report when it completes.
        const reReviewBundle: ChimeraReviewNeededPayload = {
          ...evidenceBundle,
          files: reReadFiles,
          cascadeDepth: currentDepth + 1,
        };

        await session.append({
          type: 'llm_response',
          ts: new Date().toISOString(),
          content: [
            {
              type: 'text',
              text: `🦂 Chimera cascade re-review (depth ${currentDepth + 1}/${maxDepth}) — re-reviewing ${reReadFiles.length} file(s) after fixes`,
            },
          ],
          stopReason: 'end_turn' as StopReason,
          usage: { input: 0, output: 0 },
        });

        // Use emitReviewIfChanged so content-fingerprint dedup protects
        // against re-reviewing files the fix agent didn't actually change.
        // emitCustom() is the safe passthrough the function needs.
        const emitted = await emitReviewIfChanged(
          { events, emitCustom: events.emitCustom.bind(events) },
          reReviewBundle,
        );
        if (!emitted) {
          await session.append({
            type: 'llm_response',
            ts: new Date().toISOString(),
            content: [
              {
                type: 'text',
                text: `🦂 Chimera cascade re-review skipped — content unchanged since previous review (depth ${currentDepth + 1}/${maxDepth})`,
              },
            ],
            stopReason: 'end_turn' as StopReason,
            usage: { input: 0, output: 0 },
          });
        }
      }
    } catch (err) {
      await session.append({
        type: 'error',
        ts: new Date().toISOString(),
        message: `🦂 Chimera cascade re-review failed: ${err instanceof Error ? err.message : String(err)}`,
        phase: 'agent',
      });
    }
  } else if (maxDepth > 0 && currentDepth >= maxDepth) {
    await session.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [
        {
          type: 'text',
          text: `🦂 Chimera cascade stopped at depth limit (${currentDepth}/${maxDepth}) — manual review recommended if issues persist`,
        },
      ],
      stopReason: 'end_turn' as StopReason,
      usage: { input: 0, output: 0 },
    });
  }
}

function renderEvidenceSummary(
  status: CascadeEvidenceStatus,
  checks: CascadeEvidenceCheckResult[],
): string {
  if (status === 'missing') return 'no machine evidence supplied';
  const summary = checks
    .map((check) => `${check.name}:${check.ok ? 'pass' : 'fail'}(${check.actualExitCode})`)
    .join(', ');
  return `${status}${summary ? ` — ${summary}` : ''}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
