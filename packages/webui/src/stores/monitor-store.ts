import { normalizeLiveSessions } from '@wrongstack/project-surfaces/office/feed-model';
import {
  deriveMonitorStats,
  type FleetAggregate,
} from '@wrongstack/project-surfaces/office/monitor-stats';
import type { ClientCounts, LiveSession } from '@wrongstack/project-surfaces/office/types';
import { create } from 'zustand';

// ============================================
// Monitor Store
// ============================================
// Tracks connected clients, mail queue activity, and agent counts
// for the real-time monitoring dashboard.

export type {
  ClientCounts,
  LiveAgent,
  LiveAgentActivity,
  LiveMailActivity,
  LiveSession,
  LiveTodoItem,
  LiveToolActivity,
} from '@wrongstack/project-surfaces/office/types';

export interface MailActivity {
  timestamp: number;
  type: 'sent' | 'delivered' | 'read' | 'completed';
  from?: string;
  to?: string;
  subject?: string;
  /** Stable monotonic id assigned by `addMailActivity` — use as the React key
   *  so a prepend doesn't shift index-based keys and force a full remount. */
  seq?: number;
}

export {
  clientBucket,
  deriveMonitorStats,
  type FleetAggregate,
} from '@wrongstack/project-surfaces/office/monitor-stats';

/** Real-time session stats from client.status_update events */
export interface CurrentSessionStats {
  clientType?: string;
  clientId?: string;
  agentCount?: number;
  model?: string;
  mode?: string;
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  costUsd?: number;
  timestamp?: number;
}

interface MonitorState {
  /** Connected client counts by type */
  clientCounts: ClientCounts;
  /** Recent mail queue activity (last 50 events) */
  mailActivity: MailActivity[];
  /** Total messages in mailbox */
  totalMessages: number;
  /** Open (uncompleted) messages */
  openMessages: number;
  /** Messages waiting for reply (unread) */
  unreadMessages: number;
  /** Total registered agents */
  totalAgents: number;
  /** Currently active agents */
  activeAgents: number;
  /** Current session stats from client.status_update */
  currentSession: CurrentSessionStats;
  /** Live cross-process sessions (the Fleet HQ map's structural source). */
  liveSessions: LiveSession[];
  /** Project-wide tool/cost/token totals across all live agents. */
  aggregate: FleetAggregate;
  /** Last update timestamp */
  lastUpdated: number;

  setClientCounts: (counts: ClientCounts) => void;
  /** Replace the live-session snapshot and re-derive client/agent counts. */
  setLiveSessions: (sessions: LiveSession[]) => void;
  addMailActivity: (activity: MailActivity) => void;
  setMailStats: (total: number, open: number, unread: number) => void;
  setAgentStats: (total: number, active: number) => void;
  setCurrentSession: (stats: CurrentSessionStats) => void;
  clear: () => void;
}

// Monotonic id source for mail-activity React keys (stable across prepends).
let mailActivitySeq = 0;

export const useMonitorStore = create<MonitorState>()((set) => ({
  clientCounts: { tui: 0, webui: 0, repl: 0 },
  mailActivity: [],
  totalMessages: 0,
  openMessages: 0,
  unreadMessages: 0,
  totalAgents: 0,
  activeAgents: 0,
  currentSession: {},
  liveSessions: [],
  aggregate: { toolCalls: 0, costUsd: 0, tokensIn: 0, tokensOut: 0 },
  lastUpdated: Date.now(),

  setClientCounts: (counts) => set({ clientCounts: counts, lastUpdated: Date.now() }),

  setLiveSessions: (sessions) => {
    const normalized = normalizeLiveSessions(sessions);
    // Diff check: skip update when nothing semantically changed to prevent
    // unnecessary React re-renders on ~5s fleet-status broadcasts. Without
    // this, every heartbeat tick from every running agent causes all fleet
    // surfaces (office map, HQ client list, session watcher) to re-render
    // even when no agent actually changed state.
    const prev = useMonitorStore.getState().liveSessions;
    if (prev.length === normalized.length) {
      let same = true;
      for (let i = 0; i < normalized.length; i++) {
        const a = normalized[i];
        const b = prev[i];
        if (
          a.sessionId !== b.sessionId ||
          a.status !== b.status ||
          a.agentCount !== b.agentCount ||
          a.startedAt !== b.startedAt ||
          a.lastHeartbeatAt !== b.lastHeartbeatAt
        ) {
          same = false;
          break;
        }
        // Deep-check agents (only the fields the UI renders)
        const aa = a.agents ?? [];
        const ba = b.agents ?? [];
        if (aa.length !== ba.length) {
          same = false;
          break;
        }
        for (let j = 0; j < aa.length; j++) {
          if (
            aa[j]!.id !== ba[j]!.id ||
            aa[j]!.name !== ba[j]!.name ||
            aa[j]!.status !== ba[j]!.status ||
            aa[j]!.currentTool !== ba[j]!.currentTool ||
            aa[j]!.iterations !== ba[j]!.iterations ||
            aa[j]!.toolCalls !== ba[j]!.toolCalls ||
            aa[j]!.ctxPct !== ba[j]!.ctxPct ||
            aa[j]!.tokensIn !== ba[j]!.tokensIn ||
            aa[j]!.tokensOut !== ba[j]!.tokensOut ||
            aa[j]!.costUsd !== ba[j]!.costUsd ||
            aa[j]!.recentTools?.[0]?.id !== ba[j]!.recentTools?.[0]?.id ||
            aa[j]!.recentMail?.[0]?.id !== ba[j]!.recentMail?.[0]?.id ||
            aa[j]!.activity?.reads !== ba[j]!.activity?.reads ||
            aa[j]!.activity?.writes !== ba[j]!.activity?.writes ||
            aa[j]!.activity?.edits !== ba[j]!.activity?.edits ||
            aa[j]!.activity?.terminalCalls !== ba[j]!.activity?.terminalCalls ||
            aa[j]!.activity?.mailReceived !== ba[j]!.activity?.mailReceived ||
            aa[j]!.activity?.mailSent !== ba[j]!.activity?.mailSent ||
            aa[j]!.activity?.linesAdded !== ba[j]!.activity?.linesAdded ||
            aa[j]!.activity?.linesRemoved !== ba[j]!.activity?.linesRemoved
          ) {
            same = false;
            break;
          }
        }
        if (!same) break;
      }
      if (same) return; // nothing changed — skip
    }
    set({
      liveSessions: normalized,
      ...deriveMonitorStats(normalized),
      lastUpdated: Date.now(),
    });
  },

  addMailActivity: (activity) =>
    set((state) => ({
      mailActivity: [
        { ...activity, seq: activity.seq ?? ++mailActivitySeq },
        ...state.mailActivity,
      ].slice(0, 50),
      lastUpdated: Date.now(),
    })),

  setMailStats: (total, open, unread) =>
    set({
      totalMessages: total,
      openMessages: open,
      unreadMessages: unread,
      lastUpdated: Date.now(),
    }),

  setAgentStats: (total, active) =>
    set({ totalAgents: total, activeAgents: active, lastUpdated: Date.now() }),

  setCurrentSession: (stats) =>
    set({
      currentSession: { ...useMonitorStore.getState().currentSession, ...stats },
      lastUpdated: Date.now(),
    }),

  clear: () =>
    set({
      clientCounts: { tui: 0, webui: 0, repl: 0 },
      mailActivity: [],
      totalMessages: 0,
      openMessages: 0,
      unreadMessages: 0,
      totalAgents: 0,
      activeAgents: 0,
      currentSession: {},
      liveSessions: [],
      aggregate: { toolCalls: 0, costUsd: 0, tokensIn: 0, tokensOut: 0 },
      lastUpdated: Date.now(),
    }),
}));
