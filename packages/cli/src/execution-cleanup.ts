import type { Director } from '@wrongstack/core/coordination';
import type { ChimeraWorkRegistry } from './chimera-work-registry.js';
import type { ExecuteDeps } from './execute-deps.js';
import type { FleetStatusLine } from './fleet-statusline.js';

interface ExecutionCleanupInput {
  offStorageObservability: () => void;
  fleetStatusLine: FleetStatusLine | null;
  onCoordinatorStop?: (() => void) | undefined;
  stats: ExecuteDeps['ui']['stats'];
  renderer: ExecuteDeps['ui']['renderer'];
  detachTodosCheckpoint?: (() => void | Promise<void>) | undefined;
  mcpRegistry: ExecuteDeps['session']['mcpRegistry'];
  agent: ExecuteDeps['core']['agent'];
  session: ExecuteDeps['session']['session'];
  tokenCounter: ExecuteDeps['core']['tokenCounter'];
  events: ExecuteDeps['core']['events'];
  /** Session-scoped Chimera work tracker; drained before agent/session teardown. */
  chimeraWork?: ChimeraWorkRegistry | undefined;
  /** Optional director reference for fleet cleanup at session end. */
  director?: Director | null | undefined;
  reader: ExecuteDeps['ui']['reader'];
}

export async function finalizeExecutionCleanup(input: ExecutionCleanupInput): Promise<void> {
  const {
    offStorageObservability,
    fleetStatusLine,
    onCoordinatorStop,
    stats,
    renderer,
    detachTodosCheckpoint,
    mcpRegistry,
    agent,
    session,
    tokenCounter,
    events,
    chimeraWork,
    director,
    reader,
  } = input;

  offStorageObservability();
  // Tear down the live fleet status line first so the scroll region is
  // restored before any end-of-session output prints.
  fleetStatusLine?.stop();
  // Stop the AutonomousCoordinator so its while-loop exits cleanly.
  // This sets running=false; the loop terminates at the next iteration check.
  onCoordinatorStop?.();
  // stats.render is synchronous but can throw - isolate it so cleanup
  // always runs regardless.
  try {
    stats.render(renderer);
  } catch (_err) {
    /* best-effort */
  }
  await Promise.resolve(detachTodosCheckpoint?.()).catch(() => undefined);
  // Issue #322: tear down tool-spawned process trees (bash/exec → vite, etc.)
  // before MCP stop so grandchildren cannot keep stdio open on Windows.
  // Best-effort — a missing tools package must not block session_end durability.
  try {
    const { getProcessRegistry } = await import('@wrongstack/tools');
    getProcessRegistry().killAll({ force: true, includeProtected: true });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'shutdown.process_kill_all_failed',
        message: `Process registry killAll failed: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      }),
    );
  }
  // Each cleanup step is independently guarded so a single failure
  // (e.g. MCP registry stop rejecting) cannot skip subsequent
  // durability steps (session_end, lock clear, reader close).
  await mcpRegistry.stopAll().catch((err) => {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'shutdown.mcp_stop_failed',
        message: `MCP registry stopAll failed: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      }),
    );
  });
  // Use the CURRENT writer, not the one captured at startup - an in-app
  // resume (TUI/WebUI) swaps agent.ctx.session to the resumed session's
  // writer; session_end and close must land in THAT JSONL or the resumed
  // session never gets finalized (no summary sidecar, no index entry).
  const activeSession = agent.ctx.session ?? session;
  const pending = activeSession.pendingToolUses;
  await activeSession
    .append({
      type: 'session_end',
      ts: new Date().toISOString(),
      usage: tokenCounter.total(),
      pendingToolUses: pending.length > 0 ? pending : undefined,
    })
    .catch((err) => {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'shutdown.session_end_append_failed',
          message: `session_end append failed: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: new Date().toISOString(),
        }),
      );
    });
  const sessionEndProducers = new Set<Promise<void>>();
  events.emit('session.ended', {
    id: activeSession.id,
    sessionId: activeSession.id,
    usage: tokenCounter.total(),
    waitUntil: (work: Promise<void>) => {
      const tracked = Promise.resolve(work).finally(() => sessionEndProducers.delete(tracked));
      void tracked.catch(() => undefined);
      sessionEndProducers.add(tracked);
    },
  });
  // WrongTrace session telemetry: one summary per finished session, so the
  // daemon can attribute activity to this run. NOT awaited inline — the
  // director.requestFinish reviewer notification below must not wait on a
  // daemon round-trip. The drain loop below joins sessionEndProducers, so the
  // report still completes before teardown; the hard deadline keeps a hung
  // transport from blocking that drain. Fail-open — see wrongtrace-telemetry.ts.
  try {
    const model = agent.ctx.model;
    if (!model) {
      // Mid-resume swap can leave ctx.model unset; report nothing rather than
      // attribute this session's tokens to an empty model identity.
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'shutdown.wrongtrace_telemetry_skipped',
          message: 'Skipping WrongTrace telemetry: agent model unknown at session end',
          timestamp: new Date().toISOString(),
        }),
      );
    } else {
      const { reportWrongTraceSessionTelemetry } = await import('./wiring/wrongtrace-telemetry.js');
      const usage = tokenCounter.total();
      const report = reportWrongTraceSessionTelemetry({
        sessionId: activeSession.id,
        agentName: 'wrongstack-cli',
        model,
        provider: agent.ctx.provider?.id ?? '',
        usage: {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
        },
        costUsd: tokenCounter.estimateCost().total,
      });
      // Adapter calls are already timeout-bounded (≤4s HTTP / 5s IPC); this
      // race is the belt to those braces — the drain loop must have a hard
      // ceiling on this producer. Unref so the timer alone never holds exit.
      const deadline = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5_000);
        (t as unknown as { unref?: () => void }).unref?.();
      });
      const tracked = Promise.race([report, deadline]).finally(() =>
        sessionEndProducers.delete(tracked),
      );
      void tracked.catch(() => undefined);
      sessionEndProducers.add(tracked);
    }
  } catch {
    /* best-effort telemetry */
  }
  // Persist the in-process gate-decision tally so the standalone
  // `wstack proxy-status` command (fresh process) can report the LAST
  // session's firing rates — the counter module is deliberately not an
  // EventBus listener (leak discipline), so session end is the durable
  // snapshot point. Fail-open: observability must never break teardown.
  try {
    const { snapshotGateDecisions, persistWrongTraceGateCounters } = await import(
      './wiring/wrongtrace-gate-counters.js'
    );
    const projectRoot = agent.ctx.projectRoot;
    if (projectRoot) {
      await persistWrongTraceGateCounters(projectRoot, snapshotGateDecisions());
    }
  } catch {
    /* best-effort counters persist */
  }
  // "The leader agent has finished": notify every still-running
  // graceful-finish subagent (the Chimera reviewer opts in) BEFORE waiting on
  // their work. This is the in-band notification delivered between the
  // subagent's tool calls — never an interrupt, never an abort. A notified
  // reviewer keeps its existing time budget, accelerates to complete its own
  // turn, and the drain below grants exactly that legitimate working time.
  // Delivery is idempotent per budget, so the safety-net sweep below may call
  // it again harmlessly for stragglers spawned while draining.
  if (director) {
    try {
      director.requestFinish('leader session ended — finish your review now');
    } catch (finishErr) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'shutdown.subagent_finish_notify_failed',
          message: finishErr instanceof Error ? finishErr.message : String(finishErr),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }
  // session.ended listeners are invoked synchronously but may start asynchronous
  // Git/filesystem work before emitting review_needed. Join those producers
  // first, then drain every review/cascade promise to a fixed point. This keeps
  // overlapping reviews and synchronously-created cascade descendants alive
  // until their transcript/report writes complete.
  try {
    while (sessionEndProducers.size > 0) {
      await Promise.allSettled([...sessionEndProducers]);
    }
    // Post-session reviewers are spawned ASYNCHRONOUSLY by the producers
    // above, so the early requestFinish() fired before they existed. Now
    // that every producer has settled, a reviewer that started is running —
    // notify it here, before the drain grants it working time. This is the
    // deterministic "leader has finished → accelerate" moment for the
    // post-session review path; the watchdog deadline remains the backstop.
    if (director) {
      try {
        director.requestFinish('leader session ended — finish your review now');
      } catch {
        /* best-effort — the safety net below fires again */
      }
    }
    await chimeraWork?.drainAndClose();
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'shutdown.chimera_work_failed',
        message: `Pending chimera work failed: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      }),
    );
  }
  // Safety net: terminate any remaining fleet subagents after chimera work
  // completes. Individual per-agent termination (reviewer, fix, cascade) runs
  // inside each handler, but this catches stragglers if an error path or
  // unexpected state left a subagent alive.
  if (director) {
    // Before the hard sweep: notify every still-running graceful-finish
    // subagent (the Chimera reviewer opted in) that the leader has finished.
    // This is the in-band "leader agent has finished" notification — delivered
    // between the subagent's tool calls, never as an interrupt. The notified
    // reviewer keeps its time budget, accelerates to complete its own turn,
    // and the `chimeraWork.drainAndClose()` above already waited for exactly
    // that completion. Anything STILL alive past this point ignored the
    // notification and its grace window — the bounded maximum lifetime is
    // spent, so the terminal sweep below applies.
    try {
      director.requestFinish('leader session ended — finish your review now');
    } catch (finishErr) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'shutdown.subagent_finish_notify_failed',
          message: finishErr instanceof Error ? finishErr.message : String(finishErr),
          timestamp: new Date().toISOString(),
        }),
      );
    }
    try {
      await director.terminateAll();
    } catch (termErr) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'shutdown.director_terminate_all_failed',
          message: termErr instanceof Error ? termErr.message : String(termErr),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }
  await activeSession.close().catch((err) => {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'shutdown.session_close_failed',
        message: `Session close failed: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      }),
    );
  });
  await reader.close().catch((err) => {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'shutdown.reader_close_failed',
        message: `Input reader close failed: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      }),
    );
  });
}
