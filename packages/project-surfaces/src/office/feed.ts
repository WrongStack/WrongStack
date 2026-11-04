import { useMemo } from 'react';
import { useSurfaceHost } from '../host';
import type { OfficeFeed, OfficeSelf } from './feed-types';
import { deriveMonitorStats } from './monitor-stats';
import type { AgentTranscriptEntry } from './types';

export type { OfficeCurrentSession, OfficeFeed, OfficeSelf } from './feed-types';

export const WEBUI_SELF: OfficeSelf = { label: 'This WebUI', sublabel: 'Web UI' };

export const EMPTY_TRANSCRIPT: AgentTranscriptEntry[] = [];

export function useOfficeFeed(): OfficeFeed {
  const feed = useSurfaceHost().office;
  if (!feed) throw new Error('The office surfaces rendered without an office feed.');
  return feed;
}

/** Client counts, agent totals and project-wide usage, derived from the live sessions. */
export function useMonitorStats() {
  const sessions = useOfficeFeed().useLiveSessions();
  return useMemo(() => deriveMonitorStats(sessions), [sessions]);
}
