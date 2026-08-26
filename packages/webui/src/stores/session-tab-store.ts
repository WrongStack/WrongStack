/**
 * session-tab-store.ts — Centralized management for up to 4 concurrent session tabs.
 *
 * Rules:
 *  1. Max 4 concurrent session tabs at any time.
 *  2. Opening/resuming a session switches to it if already open.
 *  3. If tabs < 4, opens in a new tab.
 *  4. If 4 tabs are open and at least 1 tab is empty/pristine, replaces that empty tab.
 *  5. If all 4 tabs have active work, rejects opening with an alert/toast.
 */

import { create } from 'zustand';
import { useSessionStore } from './session-store';
import { useChatStore, memorySessionCaches } from './chat-store';
import { useFleetStore } from './fleet-store';
import { toast } from '@/components/Toaster';

export const MAX_OPEN_TABS = 4;
export const TAB_STORAGE_KEY = 'wrongstack.open_session_tabs';

export function readStoredTabs(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const saved = localStorage.getItem(TAB_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, MAX_OPEN_TABS);
      }
    }
  } catch {
    // ignore
  }
  return [];
}

export function writeStoredTabs(tabs: string[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(TAB_STORAGE_KEY, JSON.stringify(tabs.slice(0, MAX_OPEN_TABS)));
  } catch {
    // ignore
  }
}

export interface OpenTabResult {
  success: boolean;
  reason: 'already_active' | 'switched' | 'opened_new_tab' | 'replaced_empty_tab' | 'tabs_full';
}

interface SessionTabState {
  openTabIds: string[];
  setOpenTabIds: (ids: string[]) => void;
  openTab: (sessionId: string, options?: { resumeSession?: (id: string) => void }) => OpenTabResult;
  closeTab: (sessionId: string) => void;
}

export const useSessionTabStore = create<SessionTabState>((set, get) => ({
  openTabIds: readStoredTabs(),

  setOpenTabIds: (ids) => {
    const valid = ids.slice(0, MAX_OPEN_TABS);
    set({ openTabIds: valid });
    writeStoredTabs(valid);
  },

  openTab: (sessionId, options) => {
    if (!sessionId) return { success: false, reason: 'tabs_full' };
    const currentSessionId = useSessionStore.getState().session?.id;
    const currentTabs = [...get().openTabIds];

    // Ensure current active session is recognized in the tab list if missing
    if (currentSessionId && !currentTabs.includes(currentSessionId) && currentTabs.length < MAX_OPEN_TABS) {
      currentTabs.push(currentSessionId);
    }

    // 1. If this session is already the active tab
    if (sessionId === currentSessionId) {
      if (!currentTabs.includes(sessionId)) {
        const nextTabs = [...currentTabs.slice(0, MAX_OPEN_TABS - 1), sessionId];
        set({ openTabIds: nextTabs });
        writeStoredTabs(nextTabs);
      }
      return { success: true, reason: 'already_active' };
    }

    // 2. If this session is already open in one of the tabs, simply switch to it
    if (currentTabs.includes(sessionId)) {
      useSessionStore.getState().switchSession(sessionId);
      useChatStore.getState().switchSession(sessionId);
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('session', sessionId);
        window.history.replaceState({}, '', url.toString());
      } catch {
        // ignore
      }
      options?.resumeSession?.(sessionId);
      return { success: true, reason: 'switched' };
    }

    // 3. If there is space for a new tab (< 4 tabs)
    if (currentTabs.length < MAX_OPEN_TABS) {
      const nextTabs = [...currentTabs, sessionId];
      set({ openTabIds: nextTabs });
      writeStoredTabs(nextTabs);
      useSessionStore.getState().switchSession(sessionId);
      useChatStore.getState().switchSession(sessionId);
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('session', sessionId);
        window.history.replaceState({}, '', url.toString());
      } catch {
        // ignore
      }
      options?.resumeSession?.(sessionId);
      return { success: true, reason: 'opened_new_tab' };
    }

    // 4. Exactly 4 tabs are open — check if at least 1 tab is empty/pristine
    const fleetAgents = useFleetStore.getState().agents;
    const chatLoading = useChatStore.getState().isLoading;

    let emptyTabId: string | null = null;
    for (const tabId of currentTabs) {
      const isRunning =
        (tabId === currentSessionId && chatLoading) ||
        Array.from(fleetAgents.values()).some(
          (a) => a.sessionId === tabId && a.status === 'running',
        );
      if (isRunning) continue;

      const cache = memorySessionCaches.get(tabId);
      const isTabEmpty = !cache || (cache.messages.length === 0 && !cache.isLoading);
      if (isTabEmpty) {
        emptyTabId = tabId;
        break;
      }
    }

    if (emptyTabId) {
      const nextTabs = currentTabs.map((id) => (id === emptyTabId ? sessionId : id));
      set({ openTabIds: nextTabs });
      writeStoredTabs(nextTabs);
      useSessionStore.getState().switchSession(sessionId);
      useChatStore.getState().switchSession(sessionId);
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('session', sessionId);
        window.history.replaceState({}, '', url.toString());
      } catch {
        // ignore
      }
      options?.resumeSession?.(sessionId);
      return { success: true, reason: 'replaced_empty_tab' };
    }

    // 5. All 4 tabs have active ongoing work — reject opening
    toast.error('Maksimum 4 aktif sekme dolu. Başka bir oturum açmak için önce bir sekmeyi kapatın.');
    return { success: false, reason: 'tabs_full' };
  },

  closeTab: (sessionId) => {
    const currentTabs = get().openTabIds;
    const nextTabs = currentTabs.filter((id) => id !== sessionId);
    set({ openTabIds: nextTabs });
    writeStoredTabs(nextTabs);
    const currentSessionId = useSessionStore.getState().session?.id;
    if (sessionId === currentSessionId && nextTabs.length > 0) {
      const fallbackId = nextTabs[nextTabs.length - 1];
      useSessionStore.getState().switchSession(fallbackId);
      useChatStore.getState().switchSession(fallbackId);
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('session', fallbackId);
        window.history.replaceState({}, '', url.toString());
      } catch {
        // ignore
      }
    }
  },
}));
