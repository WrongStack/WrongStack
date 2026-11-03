/** Live CodeMap telemetry: tool lifecycle, filesystem events, and agent presence. */
import { create } from 'zustand';
import type {
  ActivitySymbol,
  ActivityType,
  FileActivity,
  LiveAgentPresence,
} from './codemap-activity-types.js';

export { extractActivitiesFromMessage } from './codemap-activity-extract.js';
export type { ActivityType, FileActivity, LiveAgentPresence } from './codemap-activity-types.js';

interface CodemapActivityState {
  history: Map<string, FileActivity[]>;
  pulses: Map<string, number>;
  activeOperations: Map<string, FileActivity[]>;
  totalCount: number;
  recordActivity: (activity: FileActivity) => void;
  startActivities: (activities: FileActivity[]) => void;
  finishTool: (
    toolUseId: string,
    completion: { timestamp?: number; durationMs?: number; ok: boolean },
  ) => void;
  recordFileEvent: (activity: FileActivity) => void;
  resolveActivitySymbol: (toolUseId: string, filePath: string, symbol: ActivitySymbol) => void;
  getActivityForFile: (filePath: string) => FileActivity[];
  getActiveForFile: (filePath: string) => FileActivity[];
  getActiveOperations: () => FileActivity[];
  getAgentPresences: () => LiveAgentPresence[];
  getPulsingFiles: () => Set<string>;
  getPulseType: (filePath: string) => ActivityType | undefined;
  clear: () => void;
  _sweep: () => void;
}

const ACTIVITY_TTL_MS = 8_000;
const CORRELATION_WINDOW_MS = 2_500;
const STALE_ACTIVE_OPERATION_MS = 30 * 60_000;
const MAX_HISTORY_PER_FILE = 200;
const MAX_TOTAL_FILES = 500;

function normalizedActivity(activity: FileActivity): FileActivity {
  const status = activity.status ?? 'observed';
  return {
    ...activity,
    id:
      activity.id ?? `${activity.toolUseId ?? 'event'}:${activity.filePath}:${activity.timestamp}`,
    status,
    source: activity.source ?? 'legacy',
    agentName: activity.agentName ?? activity.agent,
    agent: activity.agent ?? activity.agentName,
  };
}

function appendHistory(history: Map<string, FileActivity[]>, activity: FileActivity): void {
  const existing = history.get(activity.filePath) ?? [];
  history.set(activity.filePath, [activity, ...existing].slice(0, MAX_HISTORY_PER_FILE));
  if (history.size <= MAX_TOTAL_FILES) return;
  const oldest = [...history.entries()].sort(
    (a, b) => (a[1][0]?.timestamp ?? 0) - (b[1][0]?.timestamp ?? 0),
  )[0]?.[0];
  if (oldest) history.delete(oldest);
}

export function activityAgentKey(activity: FileActivity): string {
  return `${activity.sessionId ?? 'unscoped'}:${activity.agentId ?? activity.agentName ?? activity.agent ?? 'external'}`;
}

export function groupAgentPresences(operations: FileActivity[]): LiveAgentPresence[] {
  const grouped = new Map<string, LiveAgentPresence>();
  for (const operation of operations) {
    const agentId = operation.agentId ?? 'external';
    const agentName = operation.agentName ?? operation.agent ?? 'External process';
    const sessionId = operation.sessionId ?? 'unscoped';
    const key = activityAgentKey(operation);
    const existing = grouped.get(key);
    if (existing) {
      existing.operations.push(operation);
      existing.startedAt = Math.min(existing.startedAt, operation.timestamp);
    } else {
      grouped.set(key, {
        key,
        agentId,
        agentName,
        sessionId,
        operations: [operation],
        startedAt: operation.timestamp,
      });
    }
  }
  return [...grouped.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export const useCodemapActivityStore = create<CodemapActivityState>((set, get) => ({
  history: new Map(),
  pulses: new Map(),
  activeOperations: new Map(),
  totalCount: 0,

  recordActivity(raw) {
    const activity = normalizedActivity(raw);
    set((state) => {
      const history = new Map(state.history);
      const pulses = new Map(state.pulses);
      appendHistory(history, activity);
      pulses.set(activity.filePath, Date.now() + ACTIVITY_TTL_MS);
      return { history, pulses, totalCount: state.totalCount + 1 };
    });
  },

  startActivities(rawActivities) {
    if (rawActivities.length === 0) return;
    const activities = rawActivities.map((activity) =>
      normalizedActivity({ ...activity, status: 'active' }),
    );
    set((state) => {
      const history = new Map(state.history);
      const pulses = new Map(state.pulses);
      const activeOperations = new Map(state.activeOperations);
      for (const activity of activities) {
        appendHistory(history, activity);
        pulses.set(activity.filePath, Date.now() + ACTIVITY_TTL_MS);
        if (activity.toolUseId) {
          const existing = activeOperations.get(activity.toolUseId) ?? [];
          activeOperations.set(activity.toolUseId, [...existing, activity]);
        }
      }
      return {
        history,
        pulses,
        activeOperations,
        totalCount: state.totalCount + activities.length,
      };
    });
  },

  finishTool(toolUseId, completion) {
    const finishedAt = completion.timestamp ?? Date.now();
    set((state) => {
      const active = state.activeOperations.get(toolUseId) ?? [];
      if (active.length === 0) return state;
      const history = new Map(state.history);
      const pulses = new Map(state.pulses);
      for (const activity of active) {
        const entries = history.get(activity.filePath) ?? [];
        history.set(
          activity.filePath,
          entries.map((entry) =>
            entry.toolUseId === toolUseId
              ? {
                  ...entry,
                  status: completion.ok ? 'completed' : 'failed',
                  ok: completion.ok,
                  completedAt: finishedAt,
                  durationMs: completion.durationMs ?? finishedAt - entry.timestamp,
                }
              : entry,
          ),
        );
        pulses.set(activity.filePath, Date.now() + ACTIVITY_TTL_MS);
      }
      const activeOperations = new Map(state.activeOperations);
      activeOperations.delete(toolUseId);
      return { history, pulses, activeOperations };
    });
  },

  recordFileEvent(raw) {
    const activity = normalizedActivity({
      ...raw,
      attribution: raw.attribution ?? (raw.agentId ? 'exact' : 'external'),
    });
    set((state) => {
      const recent = (state.history.get(activity.filePath) ?? []).find(
        (entry) =>
          entry.source !== 'watcher' &&
          entry.source !== 'external' &&
          Math.abs(activity.timestamp - entry.timestamp) <= CORRELATION_WINDOW_MS,
      );
      if (recent) {
        const history = new Map(state.history);
        history.set(
          activity.filePath,
          (history.get(activity.filePath) ?? []).map((entry) =>
            entry.id === recent.id
              ? {
                  ...entry,
                  watcherConfirmed:
                    entry.watcherConfirmed ||
                    activity.source === 'watcher' ||
                    activity.source === 'editor',
                }
              : entry,
          ),
        );
        const pulses = new Map(state.pulses);
        pulses.set(activity.filePath, Date.now() + ACTIVITY_TTL_MS);
        return { history, pulses };
      }
      const directOwner = activity.toolUseId
        ? state.activeOperations.get(activity.toolUseId)
        : undefined;
      if (directOwner && directOwner.length > 0) {
        const owner = directOwner[0]!;
        const attributed = normalizedActivity({
          ...activity,
          status: 'active',
          source: activity.source ?? 'deterministic',
          sessionId: activity.sessionId ?? owner.sessionId,
          traceId: activity.traceId ?? owner.traceId,
          agentId: activity.agentId ?? owner.agentId,
          agentName: activity.agentName ?? owner.agentName,
          agent: activity.agent ?? owner.agent,
          attribution: 'exact',
        });
        const history = new Map(state.history);
        const pulses = new Map(state.pulses);
        const activeOperations = new Map(state.activeOperations);
        appendHistory(history, attributed);
        pulses.set(attributed.filePath, Date.now() + ACTIVITY_TTL_MS);
        activeOperations.set(activity.toolUseId!, [...directOwner, attributed]);
        return {
          history,
          pulses,
          activeOperations,
          totalCount: state.totalCount + 1,
        };
      }
      const globalCandidates = [...state.activeOperations.values()]
        .flat()
        .filter(
          (entry) =>
            entry.filePath.startsWith('(tool:') &&
            Math.abs(activity.timestamp - entry.timestamp) <= 300_000,
        );
      if (globalCandidates.length === 1) {
        const owner = globalCandidates[0]!;
        const correlated = normalizedActivity({
          ...activity,
          id: `${owner.toolUseId}:${activity.filePath}:${activity.timestamp}`,
          toolUseId: owner.toolUseId,
          toolName: owner.toolName,
          summary: `${owner.toolName} → filesystem ${activity.type}`,
          status: 'active',
          source: 'deterministic',
          sessionId: owner.sessionId,
          traceId: owner.traceId,
          agentId: owner.agentId,
          agentName: owner.agentName,
          agent: owner.agent,
          watcherConfirmed: true,
          attribution: 'correlated',
        });
        const history = new Map(state.history);
        const pulses = new Map(state.pulses);
        const activeOperations = new Map(state.activeOperations);
        appendHistory(history, correlated);
        pulses.set(correlated.filePath, Date.now() + ACTIVITY_TTL_MS);
        if (correlated.toolUseId) {
          const existing = activeOperations.get(correlated.toolUseId) ?? [];
          activeOperations.set(correlated.toolUseId, [...existing, correlated]);
        }
        return {
          history,
          pulses,
          activeOperations,
          totalCount: state.totalCount + 1,
        };
      }
      const history = new Map(state.history);
      const pulses = new Map(state.pulses);
      appendHistory(history, activity);
      pulses.set(activity.filePath, Date.now() + ACTIVITY_TTL_MS);
      return { history, pulses, totalCount: state.totalCount + 1 };
    });
  },

  resolveActivitySymbol(toolUseId, filePath, symbol) {
    set((state) => {
      const history = new Map(state.history);
      history.set(
        filePath,
        (history.get(filePath) ?? []).map((entry) =>
          entry.toolUseId === toolUseId ? { ...entry, symbol } : entry,
        ),
      );
      const activeOperations = new Map(state.activeOperations);
      const active = activeOperations.get(toolUseId);
      if (active) {
        activeOperations.set(
          toolUseId,
          active.map((entry) => (entry.filePath === filePath ? { ...entry, symbol } : entry)),
        );
      }
      return { history, activeOperations };
    });
  },

  getActivityForFile(filePath) {
    return get().history.get(filePath) ?? [];
  },
  getActiveForFile(filePath) {
    return [...get().activeOperations.values()]
      .flat()
      .filter((activity) => activity.filePath === filePath);
  },
  getActiveOperations() {
    return [...get().activeOperations.values()].flat();
  },
  getAgentPresences() {
    return groupAgentPresences(get().getActiveOperations());
  },
  getPulsingFiles() {
    get()._sweep();
    return new Set(get().pulses.keys());
  },
  getPulseType(filePath) {
    get()._sweep();
    if (!get().pulses.has(filePath)) return undefined;
    return get().history.get(filePath)?.[0]?.type;
  },
  clear() {
    set({ history: new Map(), pulses: new Map(), activeOperations: new Map(), totalCount: 0 });
  },
  _sweep() {
    const now = Date.now();
    const expiredPulses = [...get().pulses]
      .filter(([, expiry]) => expiry < now)
      .map(([filePath]) => filePath);
    const staleToolIds = [...get().activeOperations]
      .filter(([, operations]) =>
        operations.every((operation) => now - operation.timestamp > STALE_ACTIVE_OPERATION_MS),
      )
      .map(([toolUseId]) => toolUseId);
    if (expiredPulses.length === 0 && staleToolIds.length === 0) return;
    set((state) => {
      const pulses = new Map(state.pulses);
      for (const filePath of expiredPulses) pulses.delete(filePath);
      if (staleToolIds.length === 0) return { pulses };
      const history = new Map(state.history);
      const activeOperations = new Map(state.activeOperations);
      for (const toolUseId of staleToolIds) {
        for (const operation of activeOperations.get(toolUseId) ?? []) {
          history.set(
            operation.filePath,
            (history.get(operation.filePath) ?? []).map((entry) =>
              entry.toolUseId === toolUseId
                ? {
                    ...entry,
                    status: 'failed',
                    ok: false,
                    completedAt: now,
                    durationMs: now - entry.timestamp,
                    summary: `${entry.summary || entry.toolName} · telemetry timeout`,
                  }
                : entry,
            ),
          );
        }
        activeOperations.delete(toolUseId);
      }
      return { pulses, history, activeOperations };
    });
  },
}));
