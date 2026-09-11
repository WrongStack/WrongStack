import { useRef } from 'react';
/**
 * Facade: every shared ref in App, created exactly once.
 *
 * TUI decomposition Phase 4 A1 (docs/decomposition-a0-app-map.md). Owns
 * the `useAppRuntimeRefs` spine, the history scroll / status-bar click-map
 * refs, and the enhance runtime refs/countdown state. (The environment
 * lines/densities mirrors moved to `useAppEnvironment` in A2 — they mirror
 * environment state the spine does not depend on.)
 *
 * Call-order contract: after `useAppState`; before every consumer. Fixed
 * and unconditional (behavior contract §0.3 of docs/decomposition-plan.md).
 */
import type { AppProps } from '../app-props.js';
import type { State } from '../app-state.js';
import type { HistoryScrollController } from '../components/scrollable-history.js';
import type { StatusBarClickMap } from '../components/status-bar-types.js';
import { useAppRuntimeRefs } from './use-app-runtime-refs.js';
import { useEnhanceRuntimeState } from './use-enhance-runtime-state.js';

interface AppRefSpineDeps {
  attachments: AppProps['attachments'];
  state: State;
  midRunSendPicker: AppProps['midRunSendPicker'];
}

export function useAppRefSpine(deps: AppRefSpineDeps) {
  const { attachments, state, midRunSendPicker } = deps;
  const refs = useAppRuntimeRefs(attachments, state);

  const historyScrollRef = useRef<HistoryScrollController | null>(null);

  const statusBarClickMapRef = useRef<StatusBarClickMap | null>(null);
  const inspectOverlayHeaderRef = useRef<import('ink').DOMElement | null>(null);

  const enhance = useEnhanceRuntimeState({
    enhanceEnabled: state.enhanceEnabled,
    midRunSendPicker: midRunSendPicker ?? false,
  });

  return {
    ...refs,
    historyScrollRef,
    statusBarClickMapRef,
    inspectOverlayHeaderRef,
    ...enhance,
  };
}

/** Convenience type: the spine's return (consumed by App destructure). */
export type AppRefSpine = ReturnType<typeof useAppRefSpine>;
