import type { Logger } from '@wrongstack/contracts/types';
import type { Director } from '@wrongstack/coordination';
import { FLEET_ROSTER } from '@wrongstack/coordination';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { MultiAgentHost } from '../fleet/host.js';

/**
 * Phase: director activation + announcement (card #7C slice 4).
 *
 * Verbatim extraction of the cli-main.ts director block: resolves the Director
 * from the multi-agent host, restores any fleet checkpoint state, registers
 * the roster tools, and prints the mode announcement (short line for browser
 * surfaces, full paths for REPL and the TUI log file; budget summary only when resuming
 * from a checkpoint so fresh starts stay quiet).
 *
 * Returns the resolved Director (or null when Director mode is disabled) so
 * the composition root keeps owning the mutable `director` binding.
 */
export async function ensureDirectorAndAnnounce(args: {
  multiAgentHost: MultiAgentHost;
  /** Fleet checkpoint restored from the resumed session, if any. */
  priorFleetState: Parameters<Director['setCheckpointState']>[0] | undefined;
  renderer: { writeInfo(msg: string): void };
  logger?: Pick<Logger, 'info'> | undefined;
  toolRegistry: ToolRegistry;
  flags: Record<string, unknown>;
  /** Fleet paths are optional in DirectorAutonomyResult; the announcement prints them verbatim. */
  fleetRoot: string | undefined;
  manifestPath: string | undefined;
  sharedScratchpadPath: string | undefined;
  subagentSessionsRoot: string | undefined;
  /** Print the startup card? Config `startupAnnounce: false` passes false; wiring is unaffected. */
  announce?: boolean | undefined;
}): Promise<Director | null> {
  const {
    multiAgentHost,
    priorFleetState,
    renderer,
    toolRegistry,
    flags,
    fleetRoot,
    manifestPath,
    sharedScratchpadPath,
    subagentSessionsRoot,
  } = args;

  // `announce: false` mutes the whole startup card: every report() call below
  // becomes a no-op while the Director wiring itself still runs unchanged.
  const report =
    args.announce === false
      ? () => {}
      : flags.tui === true && flags['no-tui'] !== true && flags.webui !== true
        ? (message: string) => args.logger?.info(message, { event: 'tui.startup.director' })
        : (message: string) => renderer.writeInfo(message);

  const director = await multiAgentHost.ensureDirector();
  if (director) {
    if (priorFleetState) director.setCheckpointState(priorFleetState);
    // Registration alone does not put a tool in front of the model. Below the
    // `off` token-saving tier the registry carries an explicit direct-surface
    // name set (see registerCanonicalHostTools), and it is built before the
    // Director exists — so every orchestration tool registered here landed in
    // the executable catalog and nowhere else. On a modern context window the
    // resolved tier is `minimal`, which meant `spawn_subagent`, `assign_task`,
    // `await_tasks` and the rest of the fleet surface never reached a single
    // provider request: the leader had the whole roster and no way to call it.
    // `exposeToProvider` is a no-op when the surface is unrestricted (tier
    // `off`), so this is safe at every tier.
    const directorToolNames: string[] = [];
    for (const tool of director.tools(FLEET_ROSTER)) {
      toolRegistry.register(tool);
      directorToolNames.push(tool.name);
    }
    toolRegistry.exposeToProvider(directorToolNames);
    const browserSurface = flags.webui === true;
    if (browserSurface) {
      report(`Director mode enabled (${Object.keys(FLEET_ROSTER).length} roles) → ${fleetRoot}`);
    } else {
      report(`Director mode enabled. Roster: ${Object.keys(FLEET_ROSTER).join(', ')}`);
      report(`  fleet root → ${fleetRoot}`);
      report(`  manifest   → ${manifestPath}`);
      report(`  scratchpad → ${sharedScratchpadPath}`);
      report(`  subagents  → ${subagentSessionsRoot}`);
    }
    if (priorFleetState) {
      const budget = multiAgentHost.budgetView();
      const fmt = (n: number) => (Number.isFinite(n) ? String(n) : '∞');
      report(
        `  fleet budget → ${budget.usedSpawns}/${fmt(budget.maxSpawns)} spawns used` +
          ` (${fmt(budget.remainingSpawns)} remaining; maxConcurrent ${budget.maxConcurrent})`,
      );
      if (budget.ceilingMismatch && budget.checkpointMaxSpawns !== undefined) {
        report(
          `  ⚠ checkpoint maxSpawns was ${budget.checkpointMaxSpawns}; live ceiling is ${fmt(budget.maxSpawns)}`,
        );
      }
    }
  } else {
    report(`Running without Director — fleet orchestration tools disabled.`);
  }
  return director;
}
