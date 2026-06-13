// useStatuslineState — reactive mirrors of agent.ctx state and
// session-runtime counters that the <StatusBar /> chip reads.
//
// Why a single hook: all 8 useState calls below feed one consumer
// (<StatusBar /> in the render path) and were inlined at the
// top of the App component, cluttering the App render body. By
// consolidating them here, App.tsx shrinks by ~15 lines and the
// state-set rules live next to each other in one place.
//
// The hook is a thin pass-through today — it doesn't subscribe to
// any event bus or read any system state on its own. Each setter
// is called from a useEffect or slash-command path in app.tsx
// (18 call sites in total). Future work can wire those call sites
// to the EventBus instead of being driven by the component that
// happens to mount first.

import { useState } from 'react';

export type AutonomyStage = 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';

export interface UseStatuslineStateOptions {
  model: string;
  provider: string | undefined;
  effectiveMaxContext: number | undefined;
  yolo: boolean;
  getAutonomy?: (() => AutonomyStage) | undefined;
  modeLabel: string | undefined;
  /**
   * The items the user has chosen to hide from the statusline.
   * Accepted as either a `Set<string>` (the canonical shape) or
   * a `readonly string[]` (the shape `App` actually receives from
   * the `statuslineHiddenItems` prop, which is an array per the
   * `.wrongstack/statusline.json` schema). The hook stores it
   * internally as a `Set<string>` and exposes the same.
   */
  statuslineHiddenItems: Set<string> | readonly string[];
}

export interface UseStatuslineState {
  liveModel: string;
  setLiveModel: (v: string) => void;
  liveProvider: string;
  setLiveProvider: (v: string) => void;
  activeMaxContext: number | undefined;
  setActiveMaxContext: (v: number | undefined) => void;
  yoloLive: boolean;
  setYoloLive: (v: boolean) => void;
  autonomyLive: AutonomyStage;
  setAutonomyLive: (v: AutonomyStage) => void;
  liveModeLabel: string;
  setLiveModeLabel: (v: string) => void;
  hiddenItems: string[];
  setHiddenItems: (v: string[]) => void;
  sessionCount: number;
  setSessionCount: (v: number) => void;
}

export function useStatuslineState(opts: UseStatuslineStateOptions): UseStatuslineState {
  // Reactive mirrors of agent.ctx.{model,provider.id} so the status bar
  // re-renders when /model or /use mutate them. The banner is `Static`
  // and never re-renders — the user gets the textual confirmation from
  // the slash command's message in history instead.
  const [liveModel, setLiveModel] = useState<string>(opts.model);
  const [liveProvider, setLiveProvider] = useState<string>(opts.provider ?? 'agent');
  // CLI resolves the startup model's catalog limit, but /model can switch to a
  // different model without remounting App. Keep the denominator mutable so the
  // status bar follows the active model instead of a stale launch-time prop.
  const [activeMaxContext, setActiveMaxContext] = useState<number | undefined>(opts.effectiveMaxContext);
  const [yoloLive, setYoloLive] = useState<boolean>(opts.yolo);
  const [autonomyLive, setAutonomyLive] = useState<AutonomyStage>(opts.getAutonomy?.() ?? 'off');
  // Reactive mirror of the active agent mode so the status bar chip
  // updates after /mode <id> without remounting the App.
  const [liveModeLabel, setLiveModeLabel] = useState<string>(opts.modeLabel ?? '');
  const [hiddenItems, setHiddenItems] = useState<string[]>(
    Array.isArray(opts.statuslineHiddenItems)
      ? [...opts.statuslineHiddenItems]
      : [...(opts.statuslineHiddenItems as readonly string[])],
  );
  const [sessionCount, setSessionCount] = useState<number>(0);

  return {
    liveModel, setLiveModel,
    liveProvider, setLiveProvider,
    activeMaxContext, setActiveMaxContext,
    yoloLive, setYoloLive,
    autonomyLive, setAutonomyLive,
    liveModeLabel, setLiveModeLabel,
    hiddenItems, setHiddenItems,
    sessionCount, setSessionCount,
  };
}
