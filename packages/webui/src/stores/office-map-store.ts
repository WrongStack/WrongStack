/**
 * Office Map store — display preferences for the Fleet HQ map canvas.
 *
 * The map itself renders in the wide main area; these toggles are driven from
 * the OfficeMapSettingsPanel in the secondary panel. Persisted so a user's
 * preferred chrome (HUD / legend / minimap / controls / animation) survives
 * reloads.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type BackgroundStyle = 'dots' | 'lines' | 'cross' | 'none';
export type OfficeViewMode = 'office' | 'topology';

interface OfficeMapState {
  /** Primary Fleet surface: human-friendly office lanes or the topology graph. */
  viewMode: OfficeViewMode;
  /** Real-time Session Stats HUD overlay (top-left). */
  showHud: boolean;
  /** Status + Connections legends (bottom corners). */
  showLegend: boolean;
  /** React Flow minimap (bottom-right). */
  showMinimap: boolean;
  /** React Flow zoom/fit controls (bottom-left). */
  showControls: boolean;
  /** Animate the dashed flow along active wires. */
  animateEdges: boolean;
  /** Bottom Live Activity feed (recent cross-process viz events). */
  showFeed: boolean;
  /** Background grid style. */
  background: BackgroundStyle;
  /** Idle time (ms) before an active desk is flagged as waiting. */
  waitThresholdMs: number;

  setViewMode: (v: OfficeViewMode) => void;
  setShowHud: (v: boolean) => void;
  setShowLegend: (v: boolean) => void;
  setShowMinimap: (v: boolean) => void;
  setShowControls: (v: boolean) => void;
  setAnimateEdges: (v: boolean) => void;
  setShowFeed: (v: boolean) => void;
  setBackground: (v: BackgroundStyle) => void;
  setWaitThresholdMs: (v: number) => void;
}

/** Presets offered in the settings panel; values in ms. */
export const WAIT_THRESHOLD_PRESETS = [30_000, 60_000, 120_000, 300_000, 600_000] as const;

export const DEFAULT_WAIT_THRESHOLD_MS = 120_000;

export const useOfficeMapStore = create<OfficeMapState>()(
  persist(
    (set) => ({
      viewMode: 'office',
      showHud: true,
      showLegend: true,
      showMinimap: true,
      showControls: true,
      animateEdges: true,
      showFeed: true,
      background: 'dots',
      waitThresholdMs: DEFAULT_WAIT_THRESHOLD_MS,

      setViewMode: (v) => set({ viewMode: v }),
      setShowHud: (v) => set({ showHud: v }),
      setShowLegend: (v) => set({ showLegend: v }),
      setShowMinimap: (v) => set({ showMinimap: v }),
      setShowControls: (v) => set({ showControls: v }),
      setAnimateEdges: (v) => set({ animateEdges: v }),
      setShowFeed: (v) => set({ showFeed: v }),
      setBackground: (v) => set({ background: v }),
      setWaitThresholdMs: (v) =>
        set({ waitThresholdMs: Number.isFinite(v) && v > 0 ? Math.round(v) : DEFAULT_WAIT_THRESHOLD_MS }),
    }),
    { name: 'wrongstack-officemap' },
  ),
);
