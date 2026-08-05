import type { Director } from '@wrongstack/core/coordination';
import type { ExecuteDeps } from './execute-deps.js';
import type { FleetStatusLine } from './fleet-statusline.js';

export interface ExecutionCleanupInput {
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
  /** Getter for chimera's in-flight work promise — avoids stale captures. */
  getPendingChimeraWork?: () => Promise<void> | undefined;
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
    getPendingChimeraWork,
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
  events.emit('session.ended', {
    id: activeSession.id,
    sessionId: activeSession.id,
    usage: tokenCounter.total(),
  });
  // Await chimera's in-flight work so the review result is written to the JSONL
  // before we close - without this, session.close() races against the subagent
  // and the review text is silently dropped because append returns early on closed.
  if (getPendingChimeraWork) {
    const chimeraWork = getPendingChimeraWork();
    if (chimeraWork) {
      await chimeraWork.catch((err) => {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'shutdown.chimera_work_failed',
            message: `Pending chimera work failed: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: new Date().toISOString(),
          }),
        );
      });
    }
  }
  // Safety net: terminate any remaining fleet subagents after chimera work
  // completes. Individual per-agent termination (reviewer, fix, cascade) runs
  // inside each handler, but this catches stragglers if an error path or
  // unexpected state left a subagent alive.
  if (director) {
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
