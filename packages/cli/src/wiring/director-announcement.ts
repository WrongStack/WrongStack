import type { Director } from '@wrongstack/core/coordination';
import { FLEET_ROSTER } from '@wrongstack/core/coordination';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { MultiAgentHost } from '../fleet/host.js';

/**
 * Phase: director activation + announcement (card #7C slice 4).
 *
 * Verbatim extraction of the cli-main.ts director block: resolves the Director
 * from the multi-agent host, restores any fleet checkpoint state, registers
 * the roster tools, and prints the mode announcement (short line for browser
 * surfaces, full paths for the terminal; budget summary only when resuming
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
  toolRegistry: ToolRegistry;
  flags: Record<string, unknown>;
  /** Fleet paths are optional in DirectorAutonomyResult; the announcement prints them verbatim. */
  fleetRoot: string | undefined;
  manifestPath: string | undefined;
  sharedScratchpadPath: string | undefined;
  subagentSessionsRoot: string | undefined;
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

  const director = await multiAgentHost.ensureDirector();
  if (director) {
    if (priorFleetState) director.setCheckpointState(priorFleetState);
    for (const tool of director.tools(FLEET_ROSTER)) {
      toolRegistry.register(tool);
    }
    const browserSurface = flags.webui === true || flags.simpleui === true;
    if (browserSurface) {
      renderer.writeInfo(
        `Director mode enabled (${Object.keys(FLEET_ROSTER).length} roles) → ${fleetRoot}`,
      );
    } else {
      renderer.writeInfo(`Director mode enabled. Roster: ${Object.keys(FLEET_ROSTER).join(', ')}`);
      renderer.writeInfo(`  fleet root → ${fleetRoot}`);
      renderer.writeInfo(`  manifest   → ${manifestPath}`);
      renderer.writeInfo(`  scratchpad → ${sharedScratchpadPath}`);
      renderer.writeInfo(`  subagents  → ${subagentSessionsRoot}`);
    }
    if (priorFleetState) {
      const budget = multiAgentHost.budgetView();
      const fmt = (n: number) => (Number.isFinite(n) ? String(n) : '∞');
      renderer.writeInfo(
        `  fleet budget → ${budget.usedSpawns}/${fmt(budget.maxSpawns)} spawns used` +
          ` (${fmt(budget.remainingSpawns)} remaining; maxConcurrent ${budget.maxConcurrent})`,
      );
      if (budget.ceilingMismatch && budget.checkpointMaxSpawns !== undefined) {
        renderer.writeInfo(
          `  ⚠ checkpoint maxSpawns was ${budget.checkpointMaxSpawns}; live ceiling is ${fmt(budget.maxSpawns)}`,
        );
      }
    }
  } else {
    renderer.writeInfo(`Running without Director — fleet orchestration tools disabled.`);
  }
  return director;
}
