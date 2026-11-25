/**
 * Sandbox status formatting + WS-event reducer for the WebUI (plan 28 T9).
 * Pure module — no React, no fetch; consumers (SessionsDashboard chip,
 * Settings sections) own the data flow.
 */

/** The subset of the server's resolved SandboxConfig the UI renders. */
export interface SandboxStatusLite {
  mode: string;
  tier: string;
  backend: string;
}

/** Compact status line for a chip/badge: `sandbox: off` | `sandbox: enforced (RO|RW|FULL)`. */
export function formatSandboxStatusLine(cfg: SandboxStatusLite): string {
  if (cfg.mode !== 'enforced') return 'sandbox: off';
  const tier = cfg.tier === 'read-only' ? 'RO' : cfg.tier === 'workspace-write' ? 'RW' : 'FULL';
  return `sandbox: enforced (${tier})`;
}

/** A relayed `{ type: 'sandbox.event', payload: { event, … } }` WS message. */
export interface SandboxWsEvent {
  event: string;
  tool?: string | undefined;
  granted?: boolean | undefined;
  at?: string | undefined;
}

export interface SandboxEventState {
  lastEvent?: SandboxWsEvent | undefined;
  denialCount: number;
  expansionCount: number;
}

export function initialSandboxEventState(): SandboxEventState {
  return { denialCount: 0, expansionCount: 0 };
}

/** Fold one relayed sandbox.* event into the display state; unknown names are ignored. */
export function reduceSandboxEvent(
  state: SandboxEventState,
  msg: SandboxWsEvent,
): SandboxEventState {
  if (!msg || typeof msg !== 'object') return state;
  if (msg.event === 'sandbox.denied') {
    return { ...state, lastEvent: msg, denialCount: state.denialCount + 1 };
  }
  if (msg.event === 'sandbox.expansion_requested' || msg.event === 'sandbox.expansion_outcome') {
    return { ...state, lastEvent: msg, expansionCount: state.expansionCount + 1 };
  }
  return state;
}
