import { type Dispatch, type SetStateAction, useDeferredValue, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  activityAgentKey,
  type FileActivity,
  groupAgentPresences,
  useCodemapActivityStore,
} from './codemap-activity-store';

type ActivityState = ReturnType<typeof useCodemapActivityStore.getState>;

export interface CodeMapActivity {
  agentFilter: string;
  setAgentFilter: Dispatch<SetStateAction<string>>;
  pausedOperations: FileActivity[] | null;
  setPausedOperations: Dispatch<SetStateAction<FileActivity[] | null>>;
  setPausedRecent: Dispatch<SetStateAction<FileActivity[] | null>>;
  activityTotalCount: ActivityState['totalCount'];
  resolveActivitySymbol: ActivityState['resolveActivitySymbol'];
  getActivityForFile: ActivityState['getActivityForFile'];
  sweepActivity: ActivityState['_sweep'];
  activeOperations: FileActivity[];
  recentActivities: FileActivity[];
  allKnownAgents: ReturnType<typeof groupAgentPresences>;
  displayedActiveOperations: FileActivity[];
  displayedRecentActivities: FileActivity[];
  deferredActiveOperations: FileActivity[];
  deferredRecentActivities: FileActivity[];
  deferredPulseActivities: FileActivity[];
  agentPresences: ReturnType<typeof groupAgentPresences>;
}

/**
 * Live agent telemetry for Code Atlas: the selective activity-store slice, the
 * derived active/recent/pulse lists, the pause + per-agent filter, and the
 * deferred copies the canvas renders from.
 */
export function useCodeMapActivity(): CodeMapActivity {
  const [agentFilter, setAgentFilter] = useState('all');
  const [pausedOperations, setPausedOperations] = useState<FileActivity[] | null>(null);
  const [pausedRecent, setPausedRecent] = useState<FileActivity[] | null>(null);
  // Selective store slice — bare useCodemapActivityStore() re-renders on every
  // method-stable set(); selectors keep App-style isolation for telemetry maps.
  const {
    history: activityHistory,
    pulses: activityPulses,
    activeOperationsMap,
    activityTotalCount,
    resolveActivitySymbol,
    getActivityForFile,
    sweepActivity,
  } = useCodemapActivityStore(
    useShallow((state) => ({
      history: state.history,
      pulses: state.pulses,
      activeOperationsMap: state.activeOperations,
      activityTotalCount: state.totalCount,
      resolveActivitySymbol: state.resolveActivitySymbol,
      getActivityForFile: state.getActivityForFile,
      sweepActivity: state._sweep,
    })),
  );
  const activeOperations = useMemo(
    () => [...activeOperationsMap.values()].flat(),
    [activeOperationsMap],
  );
  const pulseActivities = useMemo(
    () =>
      [...activityPulses.keys()]
        .map((filePath) => activityHistory.get(filePath)?.[0])
        .filter((activity): activity is FileActivity => Boolean(activity)),
    [activityHistory, activityPulses],
  );
  const recentActivities = useMemo(() => {
    const candidates: FileActivity[] = [];
    for (const history of activityHistory.values()) {
      // Each per-file history is newest-first. A single file cannot
      // contribute more than the global result size, so avoid sorting the
      // entire (potentially 100k-entry) telemetry archive on every event.
      candidates.push(...history.slice(0, 16));
    }
    return candidates.sort((left, right) => right.timestamp - left.timestamp).slice(0, 16);
  }, [activityHistory]);
  const allKnownAgents = useMemo(
    () => groupAgentPresences([...activeOperations, ...recentActivities]),
    [activeOperations, recentActivities],
  );
  const displayedActiveOperations = useMemo(() => {
    const source = pausedOperations ?? activeOperations;
    return agentFilter === 'all'
      ? source
      : source.filter((activity) => activityAgentKey(activity) === agentFilter);
  }, [activeOperations, agentFilter, pausedOperations]);
  const displayedRecentActivities = useMemo(() => {
    const source = pausedRecent ?? recentActivities;
    return agentFilter === 'all'
      ? source
      : source.filter((activity) => activityAgentKey(activity) === agentFilter);
  }, [agentFilter, pausedRecent, recentActivities]);
  // Defer telemetry-driven canvas work under React concurrent rendering so
  // selection / navigation stays snappy while agents spam tools.
  const deferredActiveOperations = useDeferredValue(displayedActiveOperations);
  const deferredRecentActivities = useDeferredValue(displayedRecentActivities);
  const deferredPulseActivities = useDeferredValue(pulseActivities);
  const agentPresences = useMemo(
    () => groupAgentPresences(displayedActiveOperations),
    [displayedActiveOperations],
  );
  return {
    agentFilter,
    setAgentFilter,
    pausedOperations,
    setPausedOperations,
    setPausedRecent,
    activityTotalCount,
    resolveActivitySymbol,
    getActivityForFile,
    sweepActivity,
    activeOperations,
    recentActivities,
    allKnownAgents,
    displayedActiveOperations,
    displayedRecentActivities,
    deferredActiveOperations,
    deferredRecentActivities,
    deferredPulseActivities,
    agentPresences,
  };
}
