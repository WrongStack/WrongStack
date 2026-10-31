import * as path from 'node:path';
import type { MultiAgentHostOptions } from './host-types.js';

export function applyFleetRootDefaults(opts: MultiAgentHostOptions): void {
  if (opts.fleetRoot && !opts.manifestPath) {
    opts.manifestPath = path.join(opts.fleetRoot, 'fleet.json');
  }
  if (opts.fleetRoot && !opts.sharedScratchpadPath) {
    opts.sharedScratchpadPath = path.join(opts.fleetRoot, 'shared');
  }
  if (opts.fleetRoot && !opts.sessionsRoot) {
    opts.sessionsRoot = path.join(opts.fleetRoot, 'subagents');
  }
  if (opts.fleetRoot && !opts.stateCheckpointPath) {
    opts.stateCheckpointPath = path.join(opts.fleetRoot, 'director-state.json');
  }
}
