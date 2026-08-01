import { effectiveFallbackChain } from '@wrongstack/core/agent';
import { isMailboxLeader } from '@wrongstack/core/coordination';
import {
  CHIMERA_REVIEW_PROMPT,
  type ChimeraReviewCompletePayload,
  type ChimeraReviewNeededPayload,
} from '@wrongstack/core/plugin';
import type { StopReason } from '@wrongstack/core/types';
import {
  buildChimeraReviewTaskDescription,
  isChimeraAllClearReview,
  truncateAtCodePointBoundary,
} from './chimera-review-task.js';
import {
  applyChimeraReviewerReadOnlyPolicy,
  assignReviewerModelsRoundRobin,
  buildMutatingAgentLadder,
  buildReviewerAttemptLadder,
  REVIEWER_LADDER_BUDGET_MS,
  resolveReviewerFallbackModels,
} from './chimera-reviewer-policy.js';
import {
  attemptLabel,
  buildRetryPreamble,
  runSubagentModelLadder,
} from './chimera-subagent-ladder.js';
import type { ExecuteDeps } from './execute-deps.js';
import { waitForChimeraAskApproval } from './execution-chimera-ask.js';

type Director = NonNullable<ExecuteDeps['fleet']['director']>;
type Events = ExecuteDeps['core']['events'];
type Session = ExecuteDeps['session']['session'];
type Mailbox = ExecuteDeps['session']['mailbox'];
type Agent = ExecuteDeps['core']['agent'];
type Config = ExecuteDeps['core']['config'];

type PendingChimeraWork = Promise<void> | undefined;

/** Per-attempt wall clock for the Chimera auto-fix agent. */
const FIX_ATTEMPT_TIMEOUT_MS = 1_200_000;
/** Ladder budget for the auto-fix agent — bounds how long shutdown can wait. */
const FIX_LADDER_BUDGET_MS = 1_800_000;

export type InstallChimeraReviewHandlerOptions = {
  events: Events;
  director: Director | null | undefined;
  session: Session;
  mailbox: Mailbox;
  agent: Agent;
  config: Config;
  setPendingWork: (work: PendingChimeraWork) => void;
};

export function installChimeraReviewHandler({
  events,
  director,
  session,
  mailbox,
  agent,
  config,
  setPendingWork,
}: InstallChimeraReviewHandlerOptions): void {
  events.onPattern('chimera.review_needed', (_event, payload) => {
    const p = payload as ChimeraReviewNeededPayload;
    const dir = director;
    if (!dir) {
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

    setPendingWork(
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
          const baseFallbacks = p.reviewFallbackModels
            ? [...p.reviewFallbackModels]
            : resolveReviewerFallbackModels(undefined);
          const assigned = assignReviewerModelsRoundRobin(baseProvider, baseModel, baseFallbacks);
          // A dead model must never cost us the review. The first rung is the
          // assignment we would have spawned anyway; the rest are only reached
          // when a rung fails, ending at the session model as the last resort.
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
            // The reviewer stays alive past its task: the mailbox ask/fix phase
            // below needs it registered. The outer finally retires it.
            keepWinnerAlive: true,
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
            events.emitCustom('chimera.review_complete', {
              bundle: p,
              reviewText: '',
              status: result?.status ?? 'unknown',
              cwd: p.cwd,
              sessionId: session.id,
            } satisfies ChimeraReviewCompletePayload);
            return;
          }

          const reviewText =
            typeof result.result === 'string'
              ? result.result.trim()
              : JSON.stringify(result.result);

          events.emitCustom('chimera.review_complete', {
            bundle: p,
            reviewText,
            status: 'success',
            cwd: p.cwd,
            sessionId: session.id,
          } satisfies ChimeraReviewCompletePayload);

          if (reviewText) {
            await session.append({
              type: 'llm_response',
              ts: new Date().toISOString(),
              content: [{ type: 'text', text: reviewText }],
              stopReason: 'end_turn' as StopReason,
              usage: { input: 0, output: 0 },
            });

            const autoFix =
              (agent.ctx.meta['chimeraAutoFix'] as string | undefined) ?? p.config.autoFix ?? 'off';
            const reviewHasFindings = !isChimeraAllClearReview(reviewText);
            const isAskMode = autoFix === 'ask' && reviewHasFindings;
            const mailboxType = isAskMode ? 'ask' : 'result';
            const subject = isAskMode
              ? `🦂 Chimera review — ${p.files.length} file(s) changed. Shall I fix the findings?`
              : `🦂 Chimera review — ${p.files.length} file(s) changed`;

            let leaderApproved = false;
            let spawnedFix = false;
            let askMailMsgId: string | undefined;

            let leaderOnline = false;
            if (isAskMode) {
              try {
                const onlineAgents = await mailbox.getOnlineAgents();
                leaderOnline = onlineAgents.some(
                  (a) => a.online && isMailboxLeader(a.agentId, a.role),
                );
              } catch (leaderCheckErr) {
                console.warn(
                  JSON.stringify({
                    level: 'warn',
                    event: 'execution.chimera_leader_check_failed',
                    message:
                      leaderCheckErr instanceof Error
                        ? leaderCheckErr.message
                        : String(leaderCheckErr),
                    timestamp: new Date().toISOString(),
                  }),
                );
              }
              if (!leaderOnline) {
                console.warn(
                  JSON.stringify({
                    level: 'warn',
                    event: 'execution.chimera_mailbox_leader_offline',
                    message: `Leader not online — mailbox ${mailboxType} from chimera-review to leader will be delivered when leader reconnects`,
                    fileCount: p.files.length,
                    autoFix,
                    timestamp: new Date().toISOString(),
                  }),
                );
              }
            } else {
              leaderOnline = true;
              console.debug(
                JSON.stringify({
                  level: 'debug',
                  event: 'execution.chimera_auto_no_presence_check',
                  message:
                    'Result mode: leader presence not checked — mailbox message delivered regardless',
                  fileCount: p.files.length,
                  autoFix,
                  timestamp: new Date().toISOString(),
                }),
              );
            }

            try {
              const askTimeoutRaw =
                (agent.ctx.meta['chimeraAskTimeoutMs'] as number | undefined) ?? 30_000;
              const ASK_TIMEOUT_MS = Number.isFinite(askTimeoutRaw)
                ? Math.max(0, askTimeoutRaw)
                : 30_000;
              const directive = isAskMode
                ? `LEADER ACTION REQUIRED: The Chimera review below found issues. Reply with "yes" to auto-fix, or "no" to skip (${ASK_TIMEOUT_MS / 1000}s timeout).`
                : reviewHasFindings
                  ? 'LEADER ACTION REQUIRED: The Chimera review below found issues. Read the report and fix any Critical or High findings automatically using the edit tool. Verify with typecheck and linter.'
                  : 'Chimera review completed with no findings. Read the report summary below; no fix action is requested.';
              const reviewBody =
                reviewText.length > 7500
                  ? truncateAtCodePointBoundary(reviewText, 7500) +
                    '\n\n…(truncated, full report in session transcript)'
                  : reviewText;
              const body = `${directive}\n\n${reviewBody}`;

              const mailMsg = await mailbox.send({
                from: 'chimera-review',
                to: 'leader',
                type: mailboxType,
                audience: 'leaders',
                subject,
                body,
                priority: 'normal',
              });
              if (!mailMsg?.id) throw new Error('mailbox.send returned no message id');
              askMailMsgId = mailMsg.id;

              if (isAskMode) {
                leaderApproved = await waitForChimeraAskApproval({
                  mailbox,
                  messageId: askMailMsgId,
                  meta: agent.ctx.meta,
                  session: agent.ctx.session ?? session,
                  askTimeoutMs: ASK_TIMEOUT_MS,
                });
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
              await session.append({
                type: 'error',
                ts: new Date().toISOString(),
                message: `🦂 Chimera auto-fix skipped — mailbox unreachable: ${errMsg}. Falling back to manual review mode.`,
                phase: 'agent',
              });
            }

            events.emitCustom('chimera.mailbox_delivered', {
              subject,
              autoFixMode: autoFix,
              fileCount: p.files.length,
              reviewLength: reviewText.length,
            });

            if (!leaderOnline) {
              try {
                await mailbox.send({
                  from: 'chimera-review',
                  to: 'leader',
                  type: 'note',
                  audience: 'leaders',
                  subject: `⏰ Chimera review pending — ${p.files.length} file(s) checked`,
                  body: `The leader was offline when a chimera review completed. A full review result with "LEADER ACTION REQUIRED" directive is waiting in this mailbox from chimera-review. Open it, read the findings, and fix any Critical or High issues.`,
                  priority: 'high',
                });
              } catch (wakeErr) {
                console.warn(
                  JSON.stringify({
                    level: 'warn',
                    event: 'execution.chimera_wakeup_companion_failed',
                    message: wakeErr instanceof Error ? wakeErr.message : String(wakeErr),
                    timestamp: new Date().toISOString(),
                  }),
                );
              }
            }

            const shouldSpawnFix =
              !spawnedFix &&
              reviewHasFindings &&
              (autoFix === 'auto' || (isAskMode && leaderApproved)) &&
              reviewText.length > 0;

            if (shouldSpawnFix) {
              spawnedFix = true; // guard against double-spawn from poll race
              const fixTaskDesc = [
                `You are a fix agent. Apply the fixes requested in this review report.`,
                ``,
                `Repository: ${p.cwd}`,
                ``,
                `--- Review report ---`,
                truncateAtCodePointBoundary(reviewText, 12_000),
                ``,
                `--- Changed files ---`,
                p.files.map((f) => `- ${f.path}`).join('\n'),
                ``,
                `Read each file, understand the issue, apply fixes using the edit tool.`,
                `After fixing, run the project's typecheck and linter to verify.`,
                `Do NOT remove or reorder existing code unless the bug requires it.`,
              ].join('\n');

              try {
                const fixLadder = buildMutatingAgentLadder({
                  profileChain: effectiveFallbackChain(config),
                  session: { provider: config.provider, model: config.model },
                });
                const fixOutcome = await runSubagentModelLadder({
                  director: dir,
                  ladder: fixLadder,
                  attemptTimeoutMs: FIX_ATTEMPT_TIMEOUT_MS,
                  budgetMs: FIX_LADDER_BUDGET_MS,
                  buildConfig: (attempt, timeoutMs) => ({
                    name: 'chimera-fix',
                    role: 'fixer',
                    maxIterations: 60,
                    maxToolCalls: 350,
                    timeoutMs,
                    // Rung 0 stays unpinned so the role model matrix still
                    // decides; later rungs pin precisely because it failed.
                    ...(attempt.tier === 'inherit'
                      ? {}
                      : {
                          provider: attempt.provider,
                          model: attempt.model,
                          fallbackModels: attempt.fallbackModels,
                        }),
                  }),
                  // A fix agent writes files, so a successor must be told the
                  // tree may already hold the dead attempt's partial edits.
                  buildTask: (_attempt, failures) =>
                    `${buildRetryPreamble(failures)}${fixTaskDesc}`,
                  onAttemptFailed: async (failure, next) => {
                    if (!next) return;
                    await appendChimeraNotice(
                      `🦂 Chimera auto-fix on ${failure.model} failed (${failure.reason}) — retrying on ${attemptLabel(next)} (${next.tier}).`,
                    );
                  },
                });
                const fixResult = fixOutcome.result;
                if (fixResult?.status === 'success') {
                  await session.append({
                    type: 'llm_response',
                    ts: new Date().toISOString(),
                    content: [
                      { type: 'text', text: `Chimera fix subagent completed: ${fixResult.result}` },
                    ],
                    stopReason: 'end_turn' as StopReason,
                    usage: { input: 0, output: 0 },
                  });
                } else {
                  const fixDetail = fixOutcome.lastError
                    ? fixOutcome.lastError instanceof Error
                      ? fixOutcome.lastError.message
                      : String(fixOutcome.lastError)
                    : `${fixResult?.status ?? 'unknown'}: ${fixResult?.error?.message ?? 'no result'}`;
                  await session.append({
                    type: 'error',
                    ts: new Date().toISOString(),
                    message: `Chimera fix subagent ${fixResult?.status ?? 'unknown'}: ${fixDetail} — exhausted ${fixOutcome.attemptsUsed} of ${fixLadder.length} model(s)`,
                    phase: 'agent',
                  });
                }
              } catch (fixErr) {
                await session.append({
                  type: 'error',
                  ts: new Date().toISOString(),
                  message: `🦂 Chimera auto-fix failed: ${fixErr instanceof Error ? fixErr.message : String(fixErr)}`,
                  phase: 'agent',
                });
              }
            }
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
  });
}
