'use client';

import { useCallback, useEffect, useState } from 'react';

/** Below this width the workspace panel overlays the conversation instead of docking. */
export const PANEL_DOCK_MIN_WIDTH = 1100;

export interface PanelRequest {
  tab: string;
  key: number;
}

/**
 * Sidebar and workspace-panel visibility plus requests that steer the panel:
 * `panelRequest` (open on a tab; the bumped key re-applies the same tab) and
 * `agentReveal` (a counter the panel watches to switch to Agents).
 *
 * Studio docks the panel on wide screens; other views start with it closed.
 * Narrowing past the dock width closes it, unless a dialog is open — yanking
 * the panel mid-read is worse than a little overflow.
 */
export function useWorkspaceLayout(view: string) {
  const [sidebar, setSidebar] = useState(false);
  const [panel, setPanel] = useState(false);
  const [panelRequest, setPanelRequest] = useState<PanelRequest>({ tab: 'activity', key: 0 });
  const [agentReveal, setAgentReveal] = useState(0);
  useEffect(() => {
    setPanel(view === 'studio' && window.innerWidth >= PANEL_DOCK_MIN_WIDTH);
    setSidebar(false);
  }, [view]);
  useEffect(() => {
    if (window.innerWidth < PANEL_DOCK_MIN_WIDTH) setPanel(false);
    const query = window.matchMedia(`(max-width: ${PANEL_DOCK_MIN_WIDTH - 1}px)`);
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches && !document.querySelector('.modal-content')) setPanel(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  const openPanel = useCallback((tab: string) => {
    setPanel(true);
    setPanelRequest((request) => ({ tab, key: request.key + 1 }));
  }, []);
  const revealAgents = useCallback(() => {
    setPanel(true);
    setAgentReveal((count) => count + 1);
  }, []);
  /** Opens the panel on Activity and clears a pending agent reveal. */
  const showActivity = useCallback(() => {
    setPanel(true);
    setAgentReveal(0);
    setPanelRequest((request) => ({ tab: 'activity', key: request.key + 1 }));
  }, []);
  const closePanels = useCallback(() => {
    setSidebar(false);
    setPanel(false);
  }, []);
  return {
    sidebar,
    setSidebar,
    panel,
    setPanel,
    panelRequest,
    agentReveal,
    openPanel,
    revealAgents,
    showActivity,
    closePanels,
  };
}
