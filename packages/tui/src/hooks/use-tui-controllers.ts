import { useEffect } from 'react';
import type { FleetChatVerbosity } from '@wrongstack/core/types';
import type { Action } from '../app-reducer.js';

export interface FleetStreamController {
  /** Fleet-chat verbosity: off | compact | full. */
  mode: FleetChatVerbosity;
  setMode: (mode: FleetChatVerbosity) => void;
}

export interface EnhanceController {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

export interface AgentsMonitorController {
  visible: boolean;
  setVisible: (visible: boolean) => void;
}

interface UseTuiControllersOptions {
  dispatch: React.Dispatch<Action>;
  fleetChat: FleetChatVerbosity;
  enhanceEnabled: boolean;
  agentsMonitorOpen: boolean;
  fleetStreamController?: FleetStreamController | undefined;
  enhanceController?: EnhanceController | undefined;
  agentsMonitorController?: AgentsMonitorController | undefined;
}

/**
 * Bridge mutable slash-command controllers into reducer-backed TUI state.
 *
 * These controllers are owned by the CLI/slash-command layer, but while the
 * TUI is mounted they should dispatch into React state instead of mutating
 * inert mirrors. On unmount we restore mirror-only setters for late callbacks.
 */
export function useTuiControllers({
  dispatch,
  fleetChat,
  enhanceEnabled,
  agentsMonitorOpen,
  fleetStreamController,
  enhanceController,
  agentsMonitorController,
}: UseTuiControllersOptions): void {
  useEffect(() => {
    if (!fleetStreamController) return;
    fleetStreamController.mode = fleetChat;
    fleetStreamController.setMode = (mode: FleetChatVerbosity) => {
      dispatch({ type: 'setFleetChat', mode });
    };
    return () => {
      fleetStreamController.setMode = (mode: FleetChatVerbosity) => {
        fleetStreamController.mode = mode;
      };
    };
  }, [dispatch, fleetStreamController, fleetChat]);

  useEffect(() => {
    if (fleetStreamController) {
      fleetStreamController.mode = fleetChat;
    }
  }, [fleetStreamController, fleetChat]);

  useEffect(() => {
    if (!enhanceController) return;
    enhanceController.enabled = enhanceEnabled;
    enhanceController.setEnabled = (enabled: boolean) => {
      dispatch({ type: 'enhanceSet', enabled });
    };
    return () => {
      enhanceController.setEnabled = (enabled: boolean) => {
        enhanceController.enabled = enabled;
      };
    };
  }, [dispatch, enhanceController, enhanceEnabled]);

  useEffect(() => {
    if (!agentsMonitorController) return;
    agentsMonitorController.visible = agentsMonitorOpen;
    agentsMonitorController.setVisible = (visible: boolean) => {
      if (visible !== agentsMonitorOpen) {
        dispatch({ type: 'toggleAgentsMonitor' });
      }
    };
    return () => {
      agentsMonitorController.setVisible = (visible: boolean) => {
        agentsMonitorController.visible = visible;
      };
    };
  }, [agentsMonitorController, agentsMonitorOpen, dispatch]);

  useEffect(() => {
    if (agentsMonitorController) agentsMonitorController.visible = agentsMonitorOpen;
  }, [agentsMonitorController, agentsMonitorOpen]);

  // NOTE: `onPanelOpen` is deliberately NOT wired here. The panel-open bridge
  // lives in app.tsx's mount effect via `createPanelOpenDispatcher` (see
  // on-panel-open.ts), which knows the per-action requirements
  // (projectPickerOpen must fetch items first, statuslineOpen needs a
  // hiddenItems snapshot). A second naive installer here ran later in effect
  // order and overwrote the real dispatcher with a blind dispatch-anything
  // handler — breaking those payload-carrying actions.
}
