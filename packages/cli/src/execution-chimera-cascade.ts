import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ChimeraCascadeNeededPayload,
  ChimeraReviewNeededPayload,
} from '@wrongstack/core/plugin';
import { emitReviewIfChanged } from '@wrongstack/core/plugin';
import type { StopReason } from '@wrongstack/core/types';
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

export type InstallChimeraCascadeHandlerOptions = {
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
}: InstallChimeraCascadeHandlerOptions): void {
  events.onPattern('chimera.cascade_needed', (_event, payload) => {
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

      await maybeReReviewCascade({ events, session, bundle: p.bundle });
    })();

    trackWork(pendingWork);
  });
}

async function maybeReReviewCascade({
  events,
  session,
  bundle,
}: {
  events: Events;
  session: Session;
  bundle: ChimeraCascadeNeededPayload['bundle'];
}): Promise<void> {
  // After the cascade fix agents finish, re-read the (now possibly modified)
  // files and re-emit chimera.review_needed to trigger a fresh review. The
  // loop is bounded by maxCascadeDepth.
  const maxDepth = bundle.maxCascadeDepth ?? 0;
  const currentDepth = bundle.cascadeDepth ?? 0;
  if (maxDepth > 0 && currentDepth < maxDepth) {
    try {
      const reReadFiles: ChimeraReviewNeededPayload['files'] = [];
      for (const f of bundle.files) {
        try {
          const absPath = path.join(bundle.cwd, f.path);
          const content = await fsp.readFile(absPath, 'utf8');
          reReadFiles.push({ path: f.path, status: 'modified', content });
        } catch {
          // File deleted or unreadable — skip it.
        }
      }

      if (reReadFiles.length > 0) {
        const reReviewBundle: ChimeraReviewNeededPayload = {
          ...bundle,
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
