import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { effectiveFallbackChain, fallbackProfileChain } from '@wrongstack/core/agent';
import {
  areSubagentsAllowedForSession,
  type ProviderModelStatusTracker,
} from '@wrongstack/core/coordination';
import {
  CHIMERA_REVIEW_PROMPT,
  type ChimeraReviewCompletePayload,
  type ChimeraReviewNeededPayload,
  classifyChimeraReviewSource,
  integrateFindings,
  maybeCompactReviewStores,
  type ParsedReviewReport,
  parseChimeraReviewReport,
  persistReviewReport,
  recordCompletedReview,
  verifyFindingsAgainstDisk,
} from '@wrongstack/core/plugin';
import {
  buildChimeraReviewTaskDescription,
  isChimeraAllClearReview,
  truncateAtCodePointBoundary,
} from './chimera-review-task.js';
import {
  applyChimeraReviewerReadOnlyPolicy,
  assignReviewerModels,
  buildReviewerAttemptLadder,
  REVIEWER_LADDER_BUDGET_MS,
  resolveReviewerFallbackModels,
} from './chimera-reviewer-policy.js';
import { attemptLabel, runSubagentModelLadder } from './chimera-subagent-ladder.js';
import type { ExecuteDeps } from './execute-deps.js';

type Director = NonNullable<ExecuteDeps['fleet']['director']>;
type Events = ExecuteDeps['core']['events'];
type Session = ExecuteDeps['session']['session'];
type Mailbox = ExecuteDeps['session']['mailbox'];
type Agent = ExecuteDeps['core']['agent'];
type Config = ExecuteDeps['core']['config'];

/**
 * Canonicalize a file path for citation gating. The reviewer can cite
 * absolute Windows paths (`D:\Codebox\...`) or mix casing on a
 * case-insensitive filesystem; without this normalization, every citation
 * counts as "out of scope" and the auto-fix eligibility guard silently
 * suppresses the fix while the mailbox directive still claims findings.
 *
 * Exported for unit testing — the citation-gating pipeline is otherwise
 * locked inside an event-handler closure and is not reachable from a
 * direct test.
 */
export function normalizeFileKeyForCitation(raw: string, cwd: string): string {
  const forward = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  const isAbsolute = forward.startsWith('/') || /^[a-zA-Z]:\//.test(forward);
  // Use path.win32.relative when simulating win32 so Windows drive-letter
  // and backslash semantics are correct on POSIX hosts (CI runners).
  const pathMod = process.platform === 'win32' ? path.win32 : path;
  const relative = isAbsolute
    ? pathMod.relative(cwd, forward).replace(/\\/g, '/').replace(/^\.\//, '')
    : forward;
  return process.platform === 'win32' ? relative.toLowerCase() : relative;
}

type InstallChimeraReviewHandlerOptions = {
  events: Events;
  director: Director | null | undefined;
  session: Session;
  mailbox: Mailbox;
  agent: Agent;
  config: Config;
  projectDir: string;
  /**
   * Shared provider/model status tracker. When supplied, the round-robin
   * Chimera reviewer spawn skips (provider, model) pairs currently in the
   * waiting room (`state: 'blocked'`) so a 429-stricken model is never
   * re-spawned on a concurrent reviewer turn. The tracker is the same
   * singleton the leader's `/provider-status` reads from; see
   * `packages/core/src/coordination/provider-status-tracker.ts`.
   */
  statusTracker?: ProviderModelStatusTracker | undefined;
  persistReview?:
    | ((payload: ChimeraReviewCompletePayload, projectDir: string) => Promise<void>)
    | undefined;
  trackWork: (work: Promise<void>) => void;
  /** Optional session-teardown chain — the wildcard listener disposer is
   *  pushed here so the registration is released when the session ends. */
  teardownHandlers?: Array<() => void> | undefined;
};

export function installChimeraReviewHandler({
  events,
  director,
  session,
  mailbox,
  agent,
  config,
  projectDir,
  statusTracker,
  persistReview = persistChimeraReview,
  trackWork,
  teardownHandlers,
}: InstallChimeraReviewHandlerOptions): void {
  // Capture the disposer instead of discarding it — the wildcard listener
  // otherwise accumulates in EventBus.wildcards until the process cap is
  // hit (see the EventBus leak board card). Owner tag included so a cap
  // rejection log names this registration site.
  const off = events.onPattern('chimera.review_needed', (_event, payload) => {
    const p = payload as ChimeraReviewNeededPayload & {
      reviewModelSelection?: 'round-robin' | 'random' | undefined;
    };
    const reviewSessionId = agent.ctx.activeRunSessionId ?? agent.ctx.session?.id ?? session.id;
    if (!areSubagentsAllowedForSession(reviewSessionId)) {
      void recordCompletedReview(events, { bundle: p }).catch(() => undefined);
      return;
    }
    const dir = director;
    if (!dir) {
      // No Director — the review will never spawn. Release the claims made by
      // the emitter so the file content is not blocked for other sessions.
      void recordCompletedReview(events, { bundle: p }).catch(() => undefined);
      return;
    }
    if (p.files.length === 0) return;

    /**
     * Record a reviewer degradation/recovery step in the transcript. Matches the
     * `error`-typed notices this handler already uses for non-fatal fallbacks,
     * and never throws — a failed append must not abort the review itself.
     */
    const appendChimeraNotice = async (message: string): Promise<void> => {
      try {
        await session.append({
          type: 'error',
          ts: new Date().toISOString(),
          message,
          phase: 'agent',
        });
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'execution.chimera_notice_append_failed',
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }
    };

    /**
     * Persist before publishing completion so report/finding durability is
     * part of the same promise that shutdown already waits for. Completion
     * still reaches cascade and observability listeners when persistence
     * fails, but the failure is explicit in both the event stream and the
     * session transcript.
     */
    const persistAndEmitCompletion = async (
      completion: ChimeraReviewCompletePayload,
    ): Promise<void> => {
      try {
        await persistReview(completion, projectDir);
        events.emitCustom('chimera.review_persisted', {
          reportId: completion.reportId,
          sessionId: completion.sessionId,
          cwd: completion.cwd,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        events.emitCustom('chimera.review_persistence_failed', {
          reportId: completion.reportId,
          sessionId: completion.sessionId,
          cwd: completion.cwd,
          error: message,
        });
        await appendChimeraNotice(
          `🦂 Chimera report persistence failed: ${message}. The review remains in the session transcript and mailbox.`,
        );
      } finally {
        // The optional post-session plugin previously owned this release.
        // Keep it in the always-installed execution owner so auto-review-only
        // sessions cannot retain content claims forever.
        await recordCompletedReview(events, completion);
        events.emitCustom('chimera.review_complete', completion);
      }
    };

    trackWork(
      (async () => {
        let subagentId: string | undefined;
        try {
          const taskDesc = buildChimeraReviewTaskDescription(p);

          const tProvider = config.provider?.trim() || undefined;
          const tModel = config.model?.trim() || undefined;
          const rawProvider = p.reviewFallbackModels
            ? p.config.provider?.trim() || undefined
            : tProvider;
          const rawModel = p.reviewFallbackModels ? p.config.model?.trim() || undefined : tModel;
          const baseProvider = rawProvider || tProvider || config.provider;
          const baseModel = rawModel || tModel || config.model;
          // Build the Chimera-specific fallback chain: explicit fallbackModels
          // first, then the resolved fallbackProfile chain (if configured).
          // This chain enters the ladder as assignedChain (rung 0's
          // fallbackModels). The session-level chain enters separately via
          // buildReviewerAttemptLadder's profileChain param below. The ladder
          // dedupes rungs by provider/model, so overlap is harmless.
          const configFallbacks = [...(p.config.fallbackModels ?? [])];
          if (p.config.fallbackProfile) {
            configFallbacks.push(...fallbackProfileChain(config, p.config.fallbackProfile));
          }
          const baseFallbacks = p.reviewFallbackModels
            ? [...p.reviewFallbackModels]
            : resolveReviewerFallbackModels(
                configFallbacks.length > 0 ? configFallbacks : undefined,
              );
          const assigned = assignReviewerModels(
            baseProvider,
            baseModel,
            baseFallbacks,
            p.reviewModelSelection ?? 'round-robin',
            statusTracker,
          );
          // A dead model must never cost us the review. The first rung is the
          // assignment we would have spawned anyway; the rest are only reached
          // when a rung fails, ending at the session model as the last resort.
          // The Chimera-specific fallbackProfile chain (if configured) is
          // already merged into assigned.fallbackModels above. The ladder's
          // profileChain is the session-level fallback, giving the reviewer a
          // broader pool as a last resort before the session model itself.
          const ladder = buildReviewerAttemptLadder({
            assigned,
            profileChain: effectiveFallbackChain(config),
            session: { provider: config.provider, model: config.model },
          });
          const ladderRefs = ladder.map(attemptLabel);

          const outcome = await runSubagentModelLadder({
            director: dir,
            ladder,
            budgetMs: REVIEWER_LADDER_BUDGET_MS,
            keepWinnerAlive: false,
            buildConfig: (attempt, timeoutMs) =>
              applyChimeraReviewerReadOnlyPolicy({
                name: 'chimera-review',
                role: 'reviewer',
                systemPromptOverride: CHIMERA_REVIEW_PROMPT,
                maxIterations: 50,
                maxToolCalls: 250,
                timeoutMs,
                provider: attempt.provider,
                model: attempt.model,
                fallbackModels: attempt.fallbackModels,
                // Reviewers are ephemeral background infrastructure: they must
                // not consume the leader's lifetime maxSpawns budget.
                spawnBudgetExempt: true,
              }),
            // The reviewer is read-only, so a retry re-runs the task verbatim.
            buildTask: () => taskDesc,
            onAttemptFailed: async (failure, next) => {
              console.warn(
                JSON.stringify({
                  level: 'warn',
                  event: 'execution.chimera_reviewer_attempt_failed',
                  message: failure.reason,
                  model: failure.model,
                  tier: failure.tier,
                  attempt: failure.attempt,
                  of: ladder.length,
                  nextModel: next ? attemptLabel(next) : undefined,
                  timestamp: new Date().toISOString(),
                }),
              );
              if (!next) return;
              events.emitCustom('chimera.reviewer_model_fallback', {
                from: failure.model,
                to: attemptLabel(next),
                tier: next.tier,
                attempt: failure.attempt,
                of: ladder.length,
                reason: failure.reason,
              });
              await appendChimeraNotice(
                `🦂 Chimera review on ${failure.model} failed (${failure.reason}) — retrying the same review on ${attemptLabel(next)} (${next.tier}).`,
              );
            },
            onRecovered: async (attempt, failures) => {
              await appendChimeraNotice(
                `🦂 Chimera review recovered on ${attemptLabel(attempt)} (${attempt.tier}) after ${failures.length} failed attempt(s).`,
              );
            },
          });

          subagentId = outcome.subagentId;
          const result = outcome.result;

          if (result?.status !== 'success') {
            const exhaustedDetail = outcome.lastError
              ? outcome.lastError instanceof Error
                ? outcome.lastError.message
                : String(outcome.lastError)
              : `${result?.status ?? 'unknown'}: ${result?.error?.message ?? 'no result'}`;
            try {
              await session.append({
                type: 'error',
                ts: new Date().toISOString(),
                message: `🦂 Chimera review subagent ${result?.status ?? 'unknown'}: ${exhaustedDetail} — exhausted ${outcome.attemptsUsed} of ${ladder.length} model(s): ${ladderRefs.join(' → ')}`,
                phase: 'agent',
              });
            } catch (err) {
              console.error(
                JSON.stringify({
                  level: 'error',
                  event: 'execution.chimera_append_failed',
                  message: err instanceof Error ? err.message : String(err),
                  timestamp: new Date().toISOString(),
                }),
              );
            }
            await persistAndEmitCompletion({
              bundle: p,
              reviewText: '',
              status: result?.status ?? 'unknown',
              cwd: p.cwd,
              sessionId: reviewSessionId,
              reportId: randomUUID(),
            } satisfies ChimeraReviewCompletePayload);
            return;
          }

          const reviewText =
            typeof result.result === 'string'
              ? result.result.trim()
              : JSON.stringify(result.result);

          const reportId = randomUUID();

          // P0-1/P0-2: parse the report ONCE with full provenance context,
          // then verify every finding against the working tree before
          // anything is persisted. The verified report rides the completion
          // payload so the store integrations and the cascade gate never
          // re-parse with a divergent context and never act on unverified
          // claims.
          const reviewSource = classifyChimeraReviewSource(p);
          const winningAttempt = outcome.wonAt ? ladder[outcome.wonAt - 1] : undefined;
          const parsedReport: ParsedReviewReport = parseChimeraReviewReport(reviewText, {
            sessionId: reviewSessionId,
            agentId: p.fileProvenance?.find((entry) => entry.agentId)?.agentId ?? 'chimera-review',
            reviewerModel: winningAttempt ? attemptLabel(winningAttempt) : undefined,
            reviewType: reviewSource,
            reportId,
          });

          const verifiedFindings = await verifyFindingsAgainstDisk(parsedReport.findings, {
            cwd: p.cwd,
          });
          const verifiedParsedReport: ParsedReviewReport = {
            ...parsedReport,
            findings: verifiedFindings,
          };

          await persistAndEmitCompletion({
            bundle: p,
            reviewText,
            status: 'success',
            cwd: p.cwd,
            sessionId: reviewSessionId,
            reportId,
            parsedReport: verifiedParsedReport,
          } satisfies ChimeraReviewCompletePayload);

          if (reviewText) {
            const reviewHasFindings = !isChimeraAllClearReview(reviewText);
            const citedFindings = verifiedFindings.filter((finding) => finding.location);
            // Normalize the changed-file set so reviewer citations can match
            // against absolute paths and case-variant spellings. The reviewer
            // may cite absolute Windows paths or mix casing; without this,
            // every citation counts as "dropped" and the passive report
            // notice would overstate the number of in-scope findings.
            const citedPaths = new Set(
              p.files.map((file) => normalizeFileKeyForCitation(file.path, p.cwd)),
            );
            // Build a basename index so subpath citations (`src/sub/x.ts`)
            // and bare-filename citations (`x.ts`) still resolve to a
            // changed file. Without this, the exact-match gate in
            // `droppedCitations` flips false on every citation and the
            // hallucination note mislabels in-scope findings as "outside
            // the changed-file set".
            //
            // The index maps `basename -> [normalized changed paths]`. A
            // basename is only honoured as a fallback when it is unique
            // across the changed-file set; otherwise an out-of-scope file
            // sharing the basename (e.g. `evil/src/index.ts` vs the real
            // `acme/src/index.ts`) would slip through the gate.
            const changedBasenameIndex = new Map<string, string[]>();
            for (const file of p.files) {
              const normalized = normalizeFileKeyForCitation(file.path, p.cwd);
              const basename = path.basename(file.path).toLowerCase();
              const bucket = changedBasenameIndex.get(basename);
              if (bucket) bucket.push(normalized);
              else changedBasenameIndex.set(basename, [normalized]);
            }
            const inScopeCited = citedFindings.filter((finding) => {
              const citedKey = normalizeFileKeyForCitation(finding.location!.file, p.cwd);
              if (citedPaths.has(citedKey)) return true;
              // Suffix match: e.g. "src/index.ts" resolves to "packages/cli/src/index.ts"
              const suffixMatches = [...citedPaths].filter(
                (cp) => cp.endsWith(`/${citedKey}`) || cp === citedKey,
              );
              if (suffixMatches.length === 1) return true;
              const basename = path.basename(finding.location!.file).toLowerCase();
              const bucket = changedBasenameIndex.get(basename);
              return !!(bucket && bucket.length === 1);
            });
            const droppedCitations = citedFindings.filter(
              (finding) => !inScopeCited.includes(finding),
            );
            // P0-2: disk-VERIFIED findings in the changed-file set are strictly
            // actionable. In-scope findings that remain unverified (e.g. anchor
            // not matched) are flagged for user inspection, while failed
            // verifications (missing file / line out of range) are discarded.
            const actionableFindings = inScopeCited.filter(
              (finding) => finding.verification?.status === 'verified',
            );
            const unverifiedInScope = inScopeCited.filter(
              (finding) => finding.verification?.status === 'unverified',
            );
            const failedVerificationCount = inScopeCited.filter(
              (finding) => finding.verification?.status === 'failed',
            ).length;
            const effectiveHasFindings =
              reviewHasFindings && (actionableFindings.length > 0 || unverifiedInScope.length > 0);
            const verifiedCount = actionableFindings.length;
            const unverifiedCount = unverifiedInScope.length;
            const hallucinationNote =
              droppedCitations.length > 0
                ? `\n\n⚠️ Citation validation: ${droppedCitations.length} finding(s) cite files outside the changed-file set and should be verified before acting.`
                : '';
            const subject = `🦂 Chimera report ready — ${p.files.length} file(s) checked`;
            let reviewMailMessageId: string | undefined;

            try {
              const directive = effectiveHasFindings
                ? 'Chimera found potential issues. This report is informational: no leader turn, fix agent, or cascade was started. Open the report and explicitly ask the leader to act if you want changes.'
                : 'Chimera completed with no actionable findings. No follow-up was started.';
              const reviewBody =
                reviewText.length > 7500
                  ? truncateAtCodePointBoundary(reviewText, 7500) +
                    '\n\n…(truncated, full report is in the Chimera report store)'
                  : reviewText;
              const body = `${directive}${hallucinationNote}\n\n${reviewBody}`;

              const mailMsg = await mailbox.send({
                from: 'chimera-review',
                to: 'leader',
                type: 'result',
                audience: 'leaders',
                subject,
                body,
                priority: 'normal',
                // Session-affinity stamp: the recipient's leader filter
                // uses this to drop the message for any leader whose current
                // session id does NOT match the originating session of the
                // review (`reviewSessionId` is captured above from the
                // agent's active run / session id). Without this token the
                // project-wide mailbox would deliver every chimera result to
                // every leader, inviting them to act on reports that belong
                // to a different session.
                sessionAffinity: {
                  sessionId: reviewSessionId,
                  reportId,
                  kind: 'chimera.review',
                },
              });
              if (!mailMsg?.id) throw new Error('mailbox.send returned no message id');
              reviewMailMessageId = mailMsg.id;

              // This signal only means the durable mailbox copy exists. It is
              // deliberately not an instruction or leader-wake trigger.
              events.emitCustom('chimera.mailbox_delivered', {
                subject,
                autoFixMode: 'off',
                fileCount: p.files.length,
                reviewLength: reviewText.length,
                messageId: reviewMailMessageId,
              });

              // Only a genuinely all-clear review completes the mailbox message.
              // A report with findings that failed disk verification is NOT
              // all-clear: the message stays open so the user can inspect why
              // (file missing, anchor moved, hallucination) before deciding.
              if (!reviewHasFindings) {
                try {
                  await mailbox.ack({
                    messageId: reviewMailMessageId,
                    readerId: 'chimera',
                    completed: true,
                    outcome: 'Review completed with no actionable findings.',
                  });
                } catch (ackError) {
                  console.warn(
                    JSON.stringify({
                      level: 'warn',
                      event: 'execution.chimera_mailbox_completion_failed',
                      message: ackError instanceof Error ? ackError.message : String(ackError),
                      messageId: reviewMailMessageId,
                      timestamp: new Date().toISOString(),
                    }),
                  );
                }
              }
            } catch (mailErr) {
              const errMsg = mailErr instanceof Error ? mailErr.message : String(mailErr);
              console.error(
                JSON.stringify({
                  level: 'error',
                  event: 'execution.chimera_mailbox_failed',
                  message: errMsg,
                  timestamp: new Date().toISOString(),
                }),
              );
              events.emitCustom('chimera.mailbox_failed', {
                subject,
                autoFixMode: 'off',
                fileCount: p.files.length,
                reviewLength: reviewText.length,
                error: errMsg,
              });
              await session.append({
                type: 'error',
                ts: new Date().toISOString(),
                message: `🦂 Chimera report ${reportId} is ready, but mailbox delivery failed: ${errMsg}. No follow-up was started.`,
                phase: 'agent',
              });
            }

            const findingCount = actionableFindings.length;
            const message = effectiveHasFindings
              ? `🦂 Chimera report ready — ${findingCount || 'unparsed'} potential finding(s) (${verifiedCount} verified against disk, ${unverifiedCount} unverified, ${failedVerificationCount} failed) across ${p.files.length} file(s). No follow-up started; open the mailbox and explicitly ask the leader to act if wanted.`
              : `🦂 Chimera report ready — ${p.files.length} file(s) checked, no actionable findings. No follow-up started.`;
            events.emitCustom('chimera.report_available', {
              reportId,
              sessionId: reviewSessionId,
              message,
              fileCount: p.files.length,
              findingCount,
              hasActionableFindings: effectiveHasFindings,
              ...(reviewMailMessageId ? { messageId: reviewMailMessageId } : {}),
            });
          }
        } catch (err) {
          try {
            await session.append({
              type: 'error',
              ts: new Date().toISOString(),
              message: `🦂 Chimera review failed: ${err instanceof Error ? err.message : String(err)}`,
              phase: 'agent',
            });
          } catch (appendErr) {
            console.error(
              JSON.stringify({
                level: 'error',
                event: 'execution.chimera_review_append_failed',
                message: appendErr instanceof Error ? appendErr.message : String(appendErr),
                timestamp: new Date().toISOString(),
              }),
            );
          }
        } finally {
          if (subagentId) {
            try {
              await dir.terminate(subagentId);
            } catch {
              /* best-effort — subagent may already be gone */
            }
          }
        }
      })(),
    );
  }, 'chimera-review');
  // Session-scoped release: the caller's teardown chain (execution.ts
  // finally block) invokes this to drop the wildcard listener at session
  // end instead of letting it accumulate toward MAX_WILDCARDS.
  if (off) teardownHandlers?.push(off);
}

async function persistChimeraReview(
  payload: ChimeraReviewCompletePayload,
  projectDir: string,
): Promise<void> {
  const reportId = payload.reportId;
  if (!reportId) throw new Error('Chimera completion is missing reportId');

  // Parent first: a crash between the two writes leaves a recoverable report,
  // never orphan findings that point at a missing report.
  await persistReviewReport(payload, reportId, projectDir);
  await integrateFindings(payload, projectDir, reportId);

  try {
    await maybeCompactReviewStores(projectDir);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'execution.chimera_store_maintenance_failed',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}
