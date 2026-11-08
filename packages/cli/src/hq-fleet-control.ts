/**
 * HQ's fleet commands (`abort fleet`, `abort <agent>`, spawn) against a Director. Lives in
 * `@wrongstack/runtime/hq-host`, shared with the standalone engine behind WebUI/desktop.
 *
 * @module hq-fleet-control
 */
export {
  createHqFleetControl,
  type HqFleetControl,
  type HqFleetScope,
  killHqSessionFleet,
  spawnHqAgent,
  terminateHqAgent,
} from '@wrongstack/runtime/hq-host';
