/**
 * What THIS process's HQ connection is doing right now.
 *
 * `/hq status` used to describe only the configuration, which answers "where
 * would a new session connect", not "is this terminal on HQ". The CLI host's
 * telemetry registers a probe here; one host per process, so a module slot is
 * the honest shape.
 *
 * @module hq-live-status
 */

export interface HqLiveConnectionStatus {
  clientId: string;
  projectId: string;
  connected: boolean;
  queuedFrames: number;
  sessionId?: string | undefined;
}

let probe: (() => HqLiveConnectionStatus | undefined) | undefined;

/** Install the probe; returns an uninstall that only removes THIS probe. */
export function setHqLiveStatusProbe(next: () => HqLiveConnectionStatus | undefined): () => void {
  probe = next;
  return () => {
    if (probe === next) probe = undefined;
  };
}

/** `undefined` when no host registered, or HQ is off for this process. */
export function readHqLiveStatus(): HqLiveConnectionStatus | undefined {
  try {
    return probe?.();
  } catch {
    return undefined;
  }
}
