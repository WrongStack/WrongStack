import type { FleetChatVerbosity } from '@wrongstack/contracts/types';
import type { Director } from '@wrongstack/core/coordination';
import type {
  StatuslineDensities,
  StatuslineLines,
  StatuslineOrder,
} from '@wrongstack/core/statusline';
import type { SessionInterruptController } from './hooks/use-session-interrupt-controller.js';
import type { AgentTranscriptReader, StatuslineItem } from './ui-contracts.js';
export interface TuiCoordinationProps {
  // --- Fleet ---
  /** Live director for fleet panel rendering. Null when director mode is off. */
  director: Director | null;
  /**
   * Read the CURRENT director. Unlike the static `director` prop (captured at
   * boot, null in non---director sessions), this sees a director the fleet
   * host built lazily on the first delegate/spawn. Fleet teardown paths
   * (Ctrl+C, Esc, /steer) resolve through this.
   */
  getDirector?: (() => Director | null) | undefined;
  /** Optional roster for human-readable subagent names. */
  fleetRoster?: Record<string, { name: string }> | undefined;
  /**
   * Shared controller for the `/fleet stream on|off` and `/agents chat`
   * slash commands. The App installs dispatch-backed setters on mount so
   * the commands can flip the reducer's `fleetChat` mode from the CLI
   * surface. Also seeds the boot value of `state.fleetChat` (cli-main
   * creates it from the persisted config).
   */
  fleetStreamController?:
    | {
        mode: FleetChatVerbosity;
        setMode: (mode: FleetChatVerbosity) => void;
      }
    | undefined;
  /**
   * Read-only per-subagent transcript access for the F3 agents monitor.
   * The CLI passes AgentMonitorService (structurally compatible); absent
   * in embedded/test surfaces, where the detail card falls back to the
   * streaming-tail snippet.
   */
  agentTranscripts?: AgentTranscriptReader | undefined;
  /**
   * Shared controller for the `/interrupt` slash command. The App installs the
   * real `abortLeader` on mount so the command can abort the in-flight leader
   * run (slash commands don't get the RunController). The fleet teardown is the
   * command's own `onFleetKill`.
   */
  interruptController?: SessionInterruptController | undefined;
  /**
   * Controller for status bar hidden items. App installs a dispatch-backed
   * setter on mount so the /statusline slash command can update the TUI's
   * visible bar without a round-trip. The initial value is loaded from
   * the config file before App mounts.
   */
  statuslineHiddenItems: StatuslineItem[];
  setStatuslineHiddenItems: (items: StatuslineItem[]) => void;
  /**
   * Atomically persists statusline hidden items to disk. Used by the
   * statusline picker so each toggle is immediately durable.
   */
  saveStatuslineHiddenItems: (items: StatuslineItem[]) => Promise<void>;
  /**
   * Per-chip statusline line assignment (statusline.json schema v2).
   * Optional: hosts that don't load it keep the core contract defaults.
   */
  statuslineLines?: StatuslineLines | undefined;
  setStatuslineLines?: ((lines: StatuslineLines) => void) | undefined;
  saveStatuslineLines?: ((lines: StatuslineLines) => Promise<void>) | undefined;
  /**
   * Per-chip density pin (statusline.json schema v3). Absent keys leave the
   * chip to the rail fitter.
   */
  statuslineDensities?: StatuslineDensities | undefined;
  setStatuslineDensities?: ((densities: StatuslineDensities) => void) | undefined;
  saveStatuslineDensities?: ((densities: StatuslineDensities) => Promise<void>) | undefined;
  /** Custom left-to-right chip order (statusline.json schema v4). */
  statuslineOrder?: StatuslineOrder | undefined;
  setStatuslineOrder?: ((order: StatuslineOrder) => void) | undefined;
  saveStatuslineOrder?: ((order: StatuslineOrder) => Promise<void>) | undefined;
  /**
   * Controller for the agents monitor overlay. App installs a dispatch-backed
   * setter on mount so the `/agents on|off` slash command can toggle the
   * overlay without a round-trip.
   */
  agentsMonitorController?:
    | {
        visible: boolean;
        setVisible: (visible: boolean) => void;
      }
    | undefined;
  /**
   * Mutable ref for opening TUI panels from slash commands. The slash commands
   * call `onPanelOpen.current(action)` to open panels. The App sets
   * `onPanelOpen.current` to its actual dispatch function on mount.
   */
  onPanelOpen?: { current: ((action: string) => boolean) | null } | undefined;
  /** Active agent mode label shown in the status bar (e.g. "teach", "brief"). */
  modeLabel?: string | undefined;
  /**
   * Called ONCE on mount by the App to install its debug-stream telemetry
   * callback. The callback receives throttled DebugStreamStats every ~200 ms
   * while the stream debug feature is active. The App dispatches to its
   * reducer; the StatusBar renders the stats on line 3. When omitted (headless
   * CLI/no TTY), debug stats go to stderr via the default callback.
   */
  registerDebugStreamCallback?:
    | ((
        cb: (stats: {
          chunkCount: number;
          lastChunkSize: number;
          lastDeltaMs: number;
          totalBytes: number;
          lastChunkAt: string;
        }) => void,
      ) => void)
    | undefined;
  /**
   * Called on App unmount (via useEffect cleanup). Restores the debug-stream
   * callback to the default stderr writer so non-TUI invocations continue to
   * print debug lines.
   */
  restoreDebugStreamCallback?: (() => void) | undefined;
}
