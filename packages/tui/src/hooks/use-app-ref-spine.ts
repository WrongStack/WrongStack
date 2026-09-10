import { useRef } from 'react';
import type { State } from '../app-state.js';
import type { HistoryScrollController } from '../components/scrollable-history.js';
import type { StatusBarClickMap } from '../components/status-bar-types.js';
import type { StatuslineItem } from '../components/statusline-picker.js';
import type { DOMElement } from '../ink.js';
import { useAppRuntimeRefs } from './use-app-runtime-refs.js';
import { useEnhanceRuntimeState } from './use-enhance-runtime-state.js';

import type { useTuiEnvironmentState } from './use-tui-environment-state.js';

/** The environment-produced layout values the spine mirrors into refs. */
type Environment = ReturnType<typeof useTuiEnvironmentState>;

export interface AppRefSpineDeps {
  attachments: Parameters<typeof useAppRuntimeRefs>[0];
  state: Parameters<typeof useAppRuntimeRefs>[1];
  lines: Environment['lines'];
  densities: Environment['densities'];
  midRunSendPicker: boolean;
}

/**
 * Facade: every shared ref in App, created exactly once.
 *
 * TUI decomposition Phase 4 A1 (docs/decomposition-a0-app-map.md). Owns
 * the `useAppRuntimeRefs` spine, the history scroll / status-bar click-map
 * refs, the environment lines/densities mirrors (latest layout readable
 * from callbacks without re-creating them per keystroke), and the
 * enhance runtime refs/countdown state.
 *
 * Call-order contract: after `useAppState` (needs `state`) and
 * `useTuiEnvironmentState` (mirrors `lines`/`densities`); before every
 * consumer. Fixed and unconditional (behavior contract §0.3 of
 * docs/decomposition-plan.md).
 */
export function useAppRefSpine(deps: AppRefSpineDeps) {
  const { attachments, state, lines, densities, midRunSendPicker } = deps;
  const refs = useAppRuntimeRefs(attachments, state);

  // Latest layout, readable from the picker-open callback without making it
  // depend on (and re-create for) every layout keystroke.
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const densitiesRef = useRef(densities);
  densitiesRef.current = densities;

  const historyScrollRef = useRef<HistoryScrollController | null>(null);

  const statusBarClickMapRef = useRef<StatusBarClickMap | null>(null);
  const inspectOverlayHeaderRef = useRef<DOMElement | null>(null);

  const enhance = useEnhanceRuntimeState({
    enhanceEnabled: state.enhanceEnabled,
    midRunSendPicker,
  });

  return {
    ...refs,
    historyScrollRef,
    statusBarClickMapRef,
    inspectOverlayHeaderRef,
    linesRef,
    densitiesRef,
    ...enhance,
  };
}

/** Convenience type: the spine's return (consumed by App destructure). */
export type AppRefSpine = ReturnType<typeof useAppRefSpine>;
export type { State, StatuslineItem };
