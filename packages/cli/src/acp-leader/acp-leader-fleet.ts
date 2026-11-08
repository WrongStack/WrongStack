/**
 * Moved to `@wrongstack/runtime/acp-leader` so the standalone engine behind
 * WebUI/desktop leads with an ACP agent the same way the CLI does. This module
 * keeps the CLI's import paths working.
 */
export {
  FLEET_SERVER_NAME,
  FLEET_TOOLS,
  type FleetEndpoint,
  fleetNote,
  fleetToolName,
  startFleetEndpoint,
} from '@wrongstack/runtime/acp-leader';
