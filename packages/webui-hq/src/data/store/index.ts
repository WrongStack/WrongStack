/**
 * The HQ store.
 *
 * Plain zustand: every component reads with `useHqStore(useShallow(...))` and
 * re-renders on any change to what it selected. The previous implementation
 * carried a hand-rolled key-filtered subscription, which silently broke any
 * component that read a state key it had forgotten to list — the classic
 * symptom was nav clicks doing nothing on an idle server, because only the
 * next telemetry broadcast happened to re-render the shell. That failure mode
 * is structurally impossible here; do not reintroduce a key filter.
 *
 * All fold logic lives in `reducers.ts` as pure functions.
 */
import { create } from 'zustand';
import {
  reduceAlert,
  reduceCommandStatus,
  reduceEvent,
  reduceHydrateSnapshot,
  reduceSnapshot,
} from './reducers.js';
import type { HqStore } from './types.js';

export const useHqStore = create<HqStore>()((set) => ({
  snapshot: null,
  events: [],
  alerts: [],
  commandStatuses: [],
  resumeCursors: {},
  needsSnapshotRefresh: false,
  peerEnvelope: null,
  connected: false,
  authRequired: false,
  snapshotAcceptedAtMs: null,

  selectedSessionId: null,
  selectedAgentId: null,
  selectedClientId: null,

  activeView: 'cockpit',

  setActiveView: (view) => set({ activeView: view }),

  selectSession: (sessionId, agentId = null) =>
    set({ selectedSessionId: sessionId, selectedAgentId: agentId }),

  selectAgent: (sessionId, agentId) =>
    set({ selectedSessionId: sessionId, selectedAgentId: agentId }),

  selectClient: (clientId) => set({ selectedClientId: clientId }),

  markAuthRequired: () => set((state) => (state.authRequired ? {} : { authRequired: true })),

  dismissPeerEnvelope: () => set({ peerEnvelope: null }),

  hydrateSnapshot: (snapshot) => set((state) => reduceHydrateSnapshot(state, snapshot)),
  applySnapshot: (snapshot) => set((state) => reduceSnapshot(state, snapshot)),
  applyEvent: (event) => set((state) => reduceEvent(state, event)),
  applyAlert: (alert) => set((state) => reduceAlert(state, alert)),
  applyCommandStatus: (command) => set((state) => reduceCommandStatus(state, command)),

  setConnected: (connected) => set({ connected }),

  setNeedsSnapshotRefresh: (needed) =>
    set((state) => (state.needsSnapshotRefresh === needed ? {} : { needsSnapshotRefresh: needed })),

  resetResumeCursors: () => set({ resumeCursors: {} }),
}));

export {
  isSameAlert,
  MAX_ALERTS,
  MAX_COMMAND_STATUSES,
  MAX_EVENTS,
  reduceAlert,
  reduceCommandStatus,
  reduceEvent,
  reduceHydrateSnapshot,
  reduceSnapshot,
} from './reducers.js';
export type {
  HqActions,
  HqFleetState,
  HqPeerEnvelope,
  HqSelectionState,
  HqState,
  HqStore,
  HqUiState,
  HqViewId,
} from './types.js';
