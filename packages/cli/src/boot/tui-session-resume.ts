/**
 * TUI session resume — extracted from the runTui() options literal.
 *
 * Phase C step 2. The onResumeSession callback swaps the agent's session
 * writer, resets token accounting, and replays the JSONL events as TUI
 * history entries.
 *
 * Reads mutable state from TuiRuntimeState (activeSessionStore, wpaths).
 */
import * as path from 'node:path';
import { TOKENS } from '@wrongstack/contracts/kernel';
import type { SessionWriter } from '@wrongstack/contracts/types';
import { projectLastRequestTokens } from '@wrongstack/contracts/types/session-timeline';
import {
  restoreSessionSubagentModelPlan,
  restoreSessionSubagentPolicy,
} from '@wrongstack/core/coordination';
import { restoreSessionPermissionOverrides } from '@wrongstack/core/security';
import { restoreRequiredSkillsFromEvents } from '@wrongstack/core/skills';
import { attachTodosCheckpoint, loadTodosCheckpoint } from '@wrongstack/core/storage';
import {
  clearLeaderEffortOverride,
  rehydrateContextEvidenceFromMessages,
  restoreLeaderEffortOverride,
  sessionScopedPath,
  toErrorMessage,
} from '@wrongstack/core/utils';
import {
  lastAssistantTextOf,
  type SessionResumeContext,
  type SessionResumeResult,
} from './tui-session-resume-contracts.js';
import { rollbackFailedResume } from './tui-session-resume-rollback.js';

export type { SessionResumeFailure } from './tui-session-resume-contracts.js';

/**
 * Reservation window requested up front.
 *
 * The daemon's default is 15s and it clamps anything above `MAX_RESERVATION_MS`
 * (60s) down to that ceiling, so this asks for the ceiling directly. It is a
 * floor on safety, not a substitute for {@link RESERVATION_RENEW_MS}: journals
 * in this corpus reach 131 MB and the hydration below also waits on the same
 * catalog daemon, so the window has to be renewed, not merely widened.
 */
const RESERVATION_WINDOW_MS = 60_000;
/** Renew well inside the window so one slow round-trip cannot lose the claim. */
const RESERVATION_RENEW_MS = 20_000;

/**
 * Resume a past session by id.
 *
 * Three outcomes, in decreasing order of success:
 *
 * 1. `{ attached: true }` — transcript replayed AND the agent now writes to
 *    this session. `warnings` may still list best-effort steps that failed
 *    (sidecars, provider restore, token accounting); none of them are worth
 *    throwing away a working resume for.
 * 2. `{ attached: false }` — ownership could not be taken (another process
 *    holds it, the reservation lapsed, the writer would not open), but the
 *    journal read fine, so the transcript is shown read-only with the reason
 *    in `warnings`. The agent stays on the session it was already writing.
 * 3. `null` — the journal itself could not be read. `onFailure` carries the
 *    stage and reason.
 */
export async function resumeSession(
  ctx: SessionResumeContext,
  sessionId: string,
): Promise<SessionResumeResult | null> {
  const { state, agent, tokenCounter, switchProviderAndModel, events, onLoadProgress } = ctx;
  const fail = (stage: string, message: string): null => {
    try {
      ctx.onFailure?.({ stage, message: message || 'unknown error' });
    } catch {
      /* a reporting sink must never turn a failed resume into a throw */
    }
    return null;
  };
  /**
   * Best-effort steps report here instead of aborting.
   *
   * Everything after the writer swap is decoration: the todo board, the
   * provider the session last used, the context chip. A resume that showed the
   * transcript and attached the writer has already done its job; losing the
   * todo sidecar is a line in the chat, not a rollback.
   */
  const warnings: string[] = [];
  const warn = (label: string, err: unknown): void => {
    warnings.push(`${label}: ${toErrorMessage(err)}`);
  };
  // Advanced as the resume walks its steps so the `catch` below can name the
  // step that actually threw. Without it every post-reservation failure —
  // journal load, writer open, hydration, sidecars, token accounting — reaches
  // the user as the same anonymous "failed".
  let stage = 'start';
  /**
   * Advance the stage AND tell the caller.
   *
   * Every `stage = …` goes through here so the progress display and the failure
   * report can never disagree about which step the resume was on.
   */
  const setStage = (next: string): void => {
    stage = next;
    try {
      ctx.onStage?.(next);
    } catch {
      /* a reporting sink must never turn a working resume into a throw */
    }
  };

  if (!state.activeSessionStore) {
    return fail('no_session_store', 'No session store is bound to this project.');
  }
  // Import before claiming/opening the target so a packaging failure leaves
  // the current writer and registry identity untouched. A bundling regression
  // that drops the named export leaves `replaySessionMessages` undefined and
  // only blows up 60 lines later, AFTER the writer swap — check it here, while
  // rolling back still costs nothing.
  setStage('load_replay_module');
  let replaySessionMessages: typeof import('@wrongstack/tui').replaySessionMessages;
  try {
    ({ replaySessionMessages } = await import('@wrongstack/tui'));
    if (typeof replaySessionMessages !== 'function') {
      throw new TypeError('@wrongstack/tui does not export replaySessionMessages');
    }
  } catch (err) {
    return fail(stage, toErrorMessage(err));
  }

  // Resolve before reserving so every contender races on one canonical key.
  setStage('resolve_id');
  let canonicalSessionId = sessionId;
  try {
    if (state.activeSessionStore.resolveId) {
      canonicalSessionId = await state.activeSessionStore.resolveId(sessionId);
    }
  } catch (err) {
    // Fail closed: without a canonical id the live-session registry cannot
    // prove that another process is not already writing the same journal.
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'execution.resume_id_resolve_failed',
        sessionId,
        message: toErrorMessage(err),
        timestamp: new Date().toISOString(),
      }),
    );
    return fail(stage, toErrorMessage(err));
  }
  const previousSessionId = agent.ctx.session?.id;
  /**
   * The journal, once read. Hoisted so the failure arm can render the
   * transcript read-only instead of re-reading a 100 MB file it already has.
   */
  let hydrated: import('@wrongstack/contracts/types').SessionData | undefined;
  let identityClaimed = false;
  let resumeClaim: import('@wrongstack/core/storage').SessionResumeClaim | undefined;
  let writerSwapped = false;
  let openedWriter: SessionWriter | undefined;
  // Hoisted so the outer catch can restore the prior session after a
  // post-swap failure instead of leaving the next prompt on the wrong writer.
  let oldWriter: typeof agent.ctx.session | undefined;
  let oldMessages: typeof agent.ctx.messages | undefined;
  let oldContextEvidence: typeof agent.ctx.contextEvidence | undefined;
  let oldSessionRefCurrent: SessionWriter | undefined;
  // Hoisted sidecar captures for the rollback arm. The pre-swap
  // `state.detachActiveTodosCheckpoint` (prior session's todo write
  // handle) and the prior `todos` / `plan.path` / `task.path` values
  // are captured at the moment of the resume-sidecar detach. On a
  // post-swap throw, restoring these values ensures the original
  // session's todos persistence remains wired up — otherwise the
  // original session's `.todos.json` would be silently detached AND
  // the resumed session's checkpoint never bound.
  let previousDetachFn: typeof state.detachActiveTodosCheckpoint;
  let oldTodos: import('@wrongstack/core/agent').TodoItem[] = [];
  let oldPlanPath: unknown;
  let oldTaskPath: unknown;

  try {
    setStage('reserve_ownership');
    if (state.wpaths.projectSlug && state.wpaths.globalRoot) {
      const { getSessionRegistry } = await import('@wrongstack/core/storage');
      const registry = getSessionRegistry(state.wpaths.globalRoot);
      resumeClaim = await registry.reserveResume({
        sessionId: canonicalSessionId,
        projectSlug: state.wpaths.projectSlug,
        projectRoot: state.projectRoot,
        reservationMs: RESERVATION_WINDOW_MS,
      });
    } else if (state.activateSessionIdentity) {
      // Host adapters predating the reservation API still provide an atomic
      // claim callback. Production WstackPaths always takes the branch above.
      await state.activateSessionIdentity(canonicalSessionId);
      identityClaimed = true;
    }
    setStage('open_journal');
    // Hydration is the slow half of a resume — journal parse, summary rebuild,
    // file-observation hashing, opening the append handle, and catalog-daemon
    // round-trips for the summary manifest. On this corpus that is 2.7s for a
    // 131 MB journal on a warm cache and far more on a cold one, against a
    // reservation window measured in seconds. Keep the claim alive for exactly
    // as long as the work is still running, then stop.
    //
    // Renewal is best-effort on purpose: a daemon predating `renew_reservation`
    // rejects the op, and this must degrade to the old behaviour (activate
    // decides) rather than turn a working resume into a failed one.
    const claimToRenew = resumeClaim;
    let renewFailures = 0;
    const renew = (): void => {
      if (!claimToRenew) return;
      void claimToRenew.renew(RESERVATION_WINDOW_MS).catch((err) => {
        if (renewFailures++ > 0) return;
        console.error(
          JSON.stringify({
            level: 'warn',
            event: 'execution.resume_reservation_renew_failed',
            sessionId: canonicalSessionId,
            message: toErrorMessage(err),
            timestamp: new Date().toISOString(),
          }),
        );
      });
    };
    const renewTimer = setInterval(renew, RESERVATION_RENEW_MS);
    // Do not hold the process open on the renewal timer: a resume that somehow
    // never settles must not become the reason the CLI cannot exit.
    renewTimer.unref?.();
    let resumed: Awaited<ReturnType<typeof state.activeSessionStore.resume>>;
    try {
      resumed = await state.activeSessionStore.resume(canonicalSessionId, onLoadProgress);
    } finally {
      clearInterval(renewTimer);
    }
    openedWriter = resumed.writer;
    // Kept for the read-only fallback: once the journal is in hand, no later
    // failure justifies re-reading (or discarding) it.
    hydrated = resumed.data;
    setStage('activate_ownership');
    // One last renewal immediately before activation: the window has to cover
    // the activate round-trip itself, not merely the load that preceded it.
    await Promise.resolve(resumeClaim?.renew(RESERVATION_WINDOW_MS)).catch(() => undefined);
    if (resumeClaim) {
      await resumeClaim.activate({
        sessionId: canonicalSessionId,
        projectSlug: state.wpaths.projectSlug,
        projectRoot: state.projectRoot,
        projectName: path.basename(state.projectRoot),
        workingDir: agent.ctx.workingDir,
        clientType: 'tui',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
      identityClaimed = true;
      await state.activateSessionIdentity?.(canonicalSessionId);
    }
    setStage('replay_history');
    const meta = resumed.data.metadata;
    const entries = replaySessionMessages(
      resumed.data.messages,
      resumed.data.events,
      /* startId */ 1,
    );
    // Re-queue background delegation results this session never received.
    // Never wakes; the leader sees them on its next iteration.
    try {
      agent.container
        ?.safeResolve?.(TOKENS.DelegationTracker)
        ?.rehydrate(canonicalSessionId, resumed.data.events ?? []);
    } catch (err) {
      warn('delegation rehydrate', err);
    }
    setStage('read_sidecars');
    const sessionsDir = state.wpaths.projectSessions;
    const resumedTodosPath = sessionScopedPath(sessionsDir, resumed.writer.id, '.todos.json');
    const restoredTodos = await loadTodosCheckpoint(
      resumedTodosPath,
      events,
      agent.ctx.traceId,
      resumed.writer.id,
    ).catch(() => null);

    // Swap writers before hydration so the recovery snapshot lands in the
    // resumed journal; the hoisted prior state keeps rollback lossless.
    setStage('swap_writer');
    oldWriter = agent.ctx.session;
    oldMessages = [...agent.ctx.messages];
    oldContextEvidence = agent.ctx.contextEvidence;
    agent.ctx.session = resumed.writer;
    try {
      // Rebuild the agent's conversation context from the resumed messages.
      // Go through the observable state wrapper so subscribers fire and
      // tool-use adjacency is re-checked on the next request.
      agent.ctx.state.replaceMessages(resumed.data.messages);
      rehydrateContextEvidenceFromMessages(agent.ctx, resumed.data.messages);
      restoreSessionSubagentPolicy(
        agent.ctx,
        resumed.data.events,
        resumed.data.subagentsAllowed,
        resumed.data.subagentCompanionsAllowed,
      );
      restoreSessionSubagentModelPlan(agent.ctx, resumed.data.events);
      restoreSessionPermissionOverrides(agent.ctx.meta, resumed.data);
      restoreRequiredSkillsFromEvents(agent.ctx, resumed.data.events);
      // The previous session's override must not ride into this one.
      clearLeaderEffortOverride(agent.ctx.meta);
      restoreLeaderEffortOverride(agent.ctx.meta, resumed.data.events);
    } catch (err) {
      agent.ctx.session = oldWriter;
      if (oldContextEvidence !== undefined) agent.ctx.contextEvidence = oldContextEvidence;
      agent.ctx.state.replaceMessages(oldMessages);
      throw err;
    }
    writerSwapped = true;
    // Repoint the cli-main `sessionRef` so provider-side
    // `getSessionId: () => sessionRef.current?.id` callbacks and the
    // record-mode `bindReplayToContainer` binding (both set up before the
    // resume) follow the resumed session. Without this, every prompt
    // after `/resume` would write to the boot session's JSONL because
    // the ref was only set once at boot (cli-main.ts:317). The ref is
    // optional on TuiRuntimeState, so older hosts that predate the fix
    // simply skip the repoint — same behavior as before.
    if (state.sessionRef) {
      oldSessionRefCurrent = state.sessionRef.current;
      state.sessionRef.current = resumed.writer;
    }
    setStage('flush_journal');
    // Best-effort from here on. The writer is swapped and the transcript is
    // built; a queue that will not drain is a durability problem for the NEXT
    // turn, not a reason to tear down a resume the user can already see. It
    // used to rethrow, which rolled the whole thing back to a blank screen.
    await agent.ctx.flushConversationJournal().catch((err) => {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'execution.resume_journal_flush_failed',
          message: toErrorMessage(err),
          timestamp: new Date().toISOString(),
        }),
      );
      warn('conversation journal did not flush', err);
    });

    // ── Re-point session-scoped sidecars (todos/plan/task) to the resumed
    // session and restore its todo board. Without this the picker resume keeps
    // writing todo edits to the PREVIOUS session's .todos.json and shows an
    // empty board — the boot `--resume` path already restores todos, so this
    // closes that asymmetry. Detach the old checkpoint BEFORE mutating todos so
    // the restore can't leak into the session we are leaving.
    //
    // Capture the prior sidecar state BEFORE the detach, so the rollback
    // arm can restore it on a post-swap failure. Without this, a throw
    // between the detach (line 195) and the re-attach (line 207) leaves
    // the original session's todos persistence detached AND the resumed
    // session's checkpoint never bound — every subsequent todo edit on
    // the original session would write to nowhere.
    setStage('repoint_sidecars');
    previousDetachFn = state.detachActiveTodosCheckpoint;
    oldTodos = agent.ctx.state.todos
      ? [...(agent.ctx.state.todos as import('@wrongstack/core/agent').TodoItem[])]
      : [];
    oldPlanPath = (agent.ctx.state as { meta?: Record<string, unknown> }).meta?.['plan.path'];
    oldTaskPath = (agent.ctx.state as { meta?: Record<string, unknown> }).meta?.['task.path'];
    // Best-effort: a todo board that will not re-point is a warning line, not
    // a reason to unwind an attached session. On failure the PREVIOUS session's
    // sidecar wiring is restored here, inline — the outer rollback arm no
    // longer runs for this block because nothing rethrows out of it.
    try {
      await Promise.resolve(previousDetachFn?.()).catch(() => undefined);
      agent.ctx.state.setMeta(
        'plan.path',
        sessionScopedPath(sessionsDir, resumed.writer.id, '.plan.json'),
      );
      agent.ctx.state.setMeta(
        'task.path',
        sessionScopedPath(sessionsDir, resumed.writer.id, '.tasks.json'),
      );
      agent.ctx.state.replaceTodos(restoredTodos ?? []);
      // Re-attach so subsequent todo edits persist to the RESUMED session file.
      try {
        state.detachActiveTodosCheckpoint = attachTodosCheckpoint(
          agent.ctx.state,
          resumedTodosPath,
          resumed.writer.id,
          events,
          agent.ctx.traceId,
        );
      } catch {
        state.detachActiveTodosCheckpoint = undefined;
      }
    } catch (err) {
      warn('todo/plan sidecars were not re-pointed', err);
      try {
        state.detachActiveTodosCheckpoint = previousDetachFn;
        agent.ctx.state.replaceTodos([...oldTodos]);
        if (oldPlanPath !== undefined) agent.ctx.state.setMeta('plan.path', oldPlanPath);
        if (oldTaskPath !== undefined) agent.ctx.state.setMeta('task.path', oldTaskPath);
      } catch {
        /* restoring the prior board is itself best-effort */
      }
    }

    // Sync the agent's provider/model to what was used in the resumed session.
    // Route all changes through the live switch callback when available so the
    // provider instance, ConfigStore, auto-compactor denominator, and context
    // chip are refreshed together. If the target provider/model is unavailable,
    // gracefully fall back to the active working provider/model.
    setStage('restore_model');
    const currentProviderId = (agent.ctx.provider as { id?: string }).id;
    // Storage summaries use "unknown" when a journal has no route metadata.
    // Treat that sentinel as missing, never as a provider to instantiate.
    // Restore only a complete pair: mixing a saved model with the current
    // provider (or vice versa) can produce an incompatible route.
    const savedProvider = typeof meta.provider === 'string' ? meta.provider.trim() : '';
    const savedModel = typeof meta.model === 'string' ? meta.model.trim() : '';
    const hasSavedRoute =
      savedProvider.length > 0 &&
      savedProvider.toLowerCase() !== 'unknown' &&
      savedModel.length > 0 &&
      savedModel.toLowerCase() !== 'unknown';
    const targetProviderId = hasSavedRoute ? savedProvider : currentProviderId;
    const targetModel = hasSavedRoute ? savedModel : agent.ctx.model;
    if (
      switchProviderAndModel &&
      targetProviderId &&
      (targetProviderId !== currentProviderId || targetModel !== agent.ctx.model)
    ) {
      try {
        const error = await Promise.resolve(switchProviderAndModel(targetProviderId, targetModel));
        if (typeof error === 'string' && error)
          warn(`could not restore ${targetProviderId}/${targetModel}`, error);
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'execution.resume_model_restore_failed',
            provider: targetProviderId,
            model: targetModel,
            message: toErrorMessage(err),
            timestamp: new Date().toISOString(),
          }),
        );
        warn(`could not restore ${targetProviderId}/${targetModel}`, err);
      }
    } else if (targetProviderId && targetProviderId !== currentProviderId) {
      // No switch callback, so the saved provider cannot be instantiated.
      // Applying only its model would pair that model with the live provider.
      warn(
        'could not restore saved route without a provider switch',
        `${targetProviderId}/${targetModel}`,
      );
    } else if (targetModel !== agent.ctx.model) {
      agent.ctx.model = targetModel;
    }

    // Finalize the current session: append a session_end (so the
    // log ends cleanly and recovery/summaries see a completed
    // session), then close (flush + summary sidecar + index). Use
    // agent.ctx.session (the currently active writer) rather than
    // the captured `session` variable — the user may have resumed
    // before, in which case `session` is stale.
    // Fire-and-forget: don't block resume on the close.
    //
    // Captured BEFORE the token-accounting/snapshot section so the
    // close runs only after the resume has fully succeeded. Earlier
    // versions scheduled this close before token-accounting/snapshot
    // runs, which created a race: any throw in those sections
    // re-bound `agent.ctx.session = oldWriter` (rollback arm) while
    // the close was already in flight against the (resumed) writer.
    // The fix is to defer the close until after the snapshot return.
    setStage('finalize_previous_session');
    let finalizeOldWriter: (() => Promise<void>) | undefined;
    if (oldWriter && oldWriter !== resumed.writer) {
      // Capture the narrowed writer for the async closure below — TS cannot
      // keep the outer guard's narrowing across the mutable let binding.
      const staleWriter = oldWriter;
      // Capture the OLD session's usage synchronously — the counter
      // is reset for the resumed session below, and this closure
      // runs after that reset.
      const endedUsage = tokenCounter.total();
      finalizeOldWriter = async () => {
        let appendOk = false;
        try {
          await staleWriter.append({
            type: 'session_end',
            ts: new Date().toISOString(),
            usage: endedUsage,
          });
          appendOk = true;
        } catch (err) {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'execution.session_end_append_failed',
              message: toErrorMessage(err),
              timestamp: new Date().toISOString(),
            }),
          );
        }
        // Only close if session_end was successfully appended — closing
        // a partially-written session file corrupts recovery/summaries.
        if (appendOk) {
          try {
            await staleWriter.close();
          } catch (err) {
            console.error(
              JSON.stringify({
                level: 'error',
                event: 'execution.session_close_failed',
                message: toErrorMessage(err),
                timestamp: new Date().toISOString(),
              }),
            );
          }
        }
      };
    }

    // Token accounting is per-session: without a reset the resumed
    // session's summary/cost chips inherit the old session's totals.
    setStage('token_accounting');
    // Best-effort: cost chips are cosmetic. A malformed `usage` block on an
    // old journal used to throw here — AFTER the writer swap — and roll a
    // fully working resume back to nothing.
    try {
      tokenCounter.reset();
      tokenCounter.account(resumed.data.usage, targetModel, targetProviderId);
    } catch (err) {
      warn('token accounting for the resumed session failed', err);
    }
    // The context-fill estimate is one request's prompt, and `data.usage` is
    // the session's running total across every request it ever made — reading
    // it here opened `/resume` with a statusline several times the size of the
    // window. The journal's last `llm_response` is the only per-request
    // measurement on disk; a session that never reached the model leaves the
    // estimate unset rather than claiming a measured zero.
    const resumedRequestTokens = projectLastRequestTokens(resumed.data.events);
    // Assign unconditionally, including the `undefined` case: a session that
    // never reached the model has NO measurement, and leaving the previous
    // session's number in place makes every context surface report the size of
    // a conversation that is no longer loaded.
    agent.ctx.lastRequestTokens = resumedRequestTokens;
    // `account()` above set the per-request snapshot to the value it was handed
    // — which is the session's CUMULATIVE usage, because that is what the cost
    // chips need. The statusline's fill ladder reads that same snapshot as its
    // second source and only rejects it when it exceeds the window, so a
    // session whose lifetime spend happens to fit under the ceiling had its
    // total spend drawn as its context fill. Overwrite it with the one number
    // that is actually a per-request prompt size.
    tokenCounter.setCurrentRequestTokens?.(resumedRequestTokens ?? 0);

    // Build the context-window snapshot the TUI uses to refresh its
    // statusline chip and `/context` panel immediately after `/resume`,
    // instead of staying at zero until the next ctx.pct event lands.
    // `tokens` is the provider-reported per-request usage; `maxContext`
    // is the resumed session's provider ceiling. Both fields are
    // optional on the TUI side, so a missing future provider (no
    // capabilities.maxContext) degrades to a 0/anything chip — same as
    // today's behavior — instead of throwing.
    //
    // Same number the estimate above uses, and for the same reason: this chip
    // reports how full the window is, so it must be one request's prompt. It
    // used to sum `tokenCounter.currentRequestTokens()` — but the counter was
    // just handed the session's CUMULATIVE usage two lines up, so the "current
    // request" it reported was the whole session's history added together.
    const tokens = resumedRequestTokens ?? 0;
    const maxContext =
      (agent.ctx.provider as { capabilities?: { maxContext?: number } } | undefined)?.capabilities
        ?.maxContext ?? 0;

    const finalText = lastAssistantTextOf(resumed.data.messages);
    const result: SessionResumeResult = {
      entries,
      nextId: entries.length + 1,
      sessionId: resumed.writer.id,
      contextSnapshot: { tokens, maxContext },
      attached: true,
      warnings,
      ...(finalText !== undefined ? { lastAssistantText: finalText } : {}),
    };
    // Now that the resume has fully succeeded, kick off the
    // fire-and-forget oldWriter close. Doing this AFTER the snapshot
    // return means a rollback (from any throw above) re-binds
    // `agent.ctx.session = oldWriter` while the old writer is still
    // open — the close then runs against the still-open writer, not
    // against the resumed writer the rollback just restored.
    if (finalizeOldWriter) void finalizeOldWriter();
    return result;
  } catch (err) {
    await rollbackFailedResume({
      agent,
      state,
      previousSessionId,
      identityClaimed,
      resumeClaim,
      writerSwapped,
      openedWriter,
      oldWriter,
      oldMessages,
      oldContextEvidence,
      oldSessionRefCurrent,
      previousDetachFn,
      oldTodos,
      oldPlanPath,
      oldTaskPath,
    });
    const reason = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'execution.resume_session_failed',
        sessionId: canonicalSessionId,
        stage,
        message: reason,
        timestamp: new Date().toISOString(),
      }),
    );
    const message = toErrorMessage(err);
    // ── Live-session conflict: no fallback ──────────────────────────────
    // Another process holds this session's lease — a second `wstack --tui`,
    // the WebUI server, SimpleUI, a REPL. The read-only fallback below is the
    // wrong answer for that case specifically: it would blank the user's live
    // screen and replace it with a snapshot of a conversation that is STILL
    // MOVING somewhere else, which reads as a successful resume that has
    // silently stopped updating. Fail cleanly instead and leave the screen as
    // it was.
    //
    // The picker already refuses these up front (`onResumePickerEnter` reads
    // `entry.live`); this closes the race where a session goes live between
    // the listing and Enter, and covers hosts that call `resumeSession`
    // directly.
    //
    // Keyed on the error NAME, which the catalog daemon preserves across IPC
    // (`project-server` sends `errorName`, `client` restores it) — not on the
    // message text, which is display copy and can be reworded.
    if (err instanceof Error && err.name === 'SessionOwnershipConflictError') {
      return fail(stage, message);
    }
    // ── Read-only fallback ──────────────────────────────────────────────
    // Ownership is gone (rolled back above) but the transcript may not be.
    // Reading the journal and rendering it is the half of a resume that
    // cannot corrupt anything, and it is the half the user actually asked
    // for: see the conversation. Show it, say plainly that the session is
    // not attached, and leave the agent writing where it already was.
    //
    // `hydrated` is set once `store.resume()` returned, so a failure at
    // activate/swap costs no second read. A failure BEFORE that (reservation
    // conflict, missing journal) pays one `load()` — the cheap path measured
    // at 0.4s/18 MB and 2.7s/131 MB.
    let data = hydrated;
    if (!data) {
      try {
        // try/catch, not `.catch()`: a store double (or a host predating the
        // widened interface) can be missing `load` entirely, which throws
        // synchronously and would replace the real reason with a TypeError.
        data = await state.activeSessionStore.load(canonicalSessionId, onLoadProgress);
      } catch {
        data = undefined;
      }
    }
    if (data) {
      try {
        const entries = replaySessionMessages(data.messages, data.events, /* startId */ 1);
        const finalText = lastAssistantTextOf(data.messages);
        // Report through `fail` for its swallow-the-sink guard; the `null` it
        // returns is discarded because this path has a transcript to hand back.
        fail(stage, message);
        return {
          entries,
          nextId: entries.length + 1,
          sessionId: canonicalSessionId,
          // Deliberately no contextSnapshot: the chip reports the LIVE
          // window, and the live session is still the one we rolled back to.
          // Painting the viewed session's fill over it would be a lie.
          attached: false,
          warnings: [...warnings, `not attached (at ${stage}): ${message}`],
          ...(finalText !== undefined ? { lastAssistantText: finalText } : {}),
        };
      } catch (renderErr) {
        // Rendering the fallback failed too — fall through to the null
        // contract rather than masking the ORIGINAL failure with this one.
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'execution.resume_readonly_render_failed',
            sessionId: canonicalSessionId,
            message: toErrorMessage(renderErr),
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
    return fail(stage, message);
  }
}
