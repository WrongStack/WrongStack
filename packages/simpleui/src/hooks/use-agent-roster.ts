import { useEffect, useMemo, useState } from 'react';
import {
  type AgentTab,
  buildAgentTabs,
  canComposeForAgent,
  LEADER_AGENT_ID,
  partitionAgentTabs,
  pruneAgents,
  resolveSelectedAgentId,
} from '../lib/agent-model.js';
import type { AgentTranscriptEntry, SimpleSubagent } from '../types.js';

export interface UseAgentRosterOptions {
  /** Whether the leader run is in flight — drives the leader tab status. */
  running: boolean;
}

export interface UseAgentRosterResult {
  subagents: SimpleSubagent[];
  setSubagents: React.Dispatch<React.SetStateAction<SimpleSubagent[]>>;
  agentTranscripts: Record<string, AgentTranscriptEntry[]>;
  setAgentTranscripts: React.Dispatch<React.SetStateAction<Record<string, AgentTranscriptEntry[]>>>;
  selectedAgentId: string;
  setSelectedAgentId: React.Dispatch<React.SetStateAction<string>>;
  agentTabs: AgentTab[];
  liveAgentTabs: AgentTab[];
  finishedAgentTabs: AgentTab[];
  activeAgentId: string;
  activeAgent: AgentTab | undefined;
  leaderSelected: boolean;
}

/**
 * Owns the SimpleUI agent roster: worker state, transcripts, tab selection,
 * derived tab lists, and the 15-second idle-prune interval.
 *
 * Behavioural contract (must survive the PR-3 extraction from `app.tsx`):
 *  - `buildAgentTabs(subagents, running)` always places the leader first;
 *    the leader tab's status mirrors `running`.
 *  - `partitionAgentTabs` splits into `liveAgentTabs` (strip) and
 *    `finishedAgentTabs` (dropdown). The leader is always in the live group.
 *  - `resolveSelectedAgentId(selectedId, tabs)` falls back to the leader when
 *    the currently selected tab is no longer in the list.
 *  - `canComposeForAgent(activeAgentId)` returns true only for the leader —
 *    the composer renders exclusively on the leader pane.
 *  - The prune interval fires every 15 seconds when at least one worker
 *    exists. It calls `pruneAgents(current, Date.now())` and skips the state
 *    update when nothing changed (avoids unnecessary re-renders). The
 *    interval is gated on `subagents.length > 0` so an idle session never
 *    starts a timer.
 *  - All three setters (`setSubagents`, `setAgentTranscripts`,
 *    `setSelectedAgentId`) are exposed so the message handler can mutate
 *    them via `MessageHandlerDeps`.
 */
export function useAgentRoster(options: UseAgentRosterOptions): UseAgentRosterResult {
  const { running } = options;

  const [subagents, setSubagents] = useState<SimpleSubagent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(LEADER_AGENT_ID);
  const [agentTranscripts, setAgentTranscripts] = useState<Record<string, AgentTranscriptEntry[]>>(
    {},
  );

  const agentTabs = useMemo(() => buildAgentTabs(subagents, running), [running, subagents]);

  const { active: liveAgentTabs, finished: finishedAgentTabs } = useMemo(
    () => partitionAgentTabs(agentTabs),
    [agentTabs],
  );

  const activeAgentId = resolveSelectedAgentId(selectedAgentId, agentTabs);
  const activeAgent = agentTabs.find((tab) => tab.id === activeAgentId);
  const leaderSelected = canComposeForAgent(activeAgentId);

  // Periodically prune idle/offline workers that have aged out so the strip
  // and dropdown don't accumulate agents no longer worth viewing. We also
  // drop the matching `agentTranscripts` keys for pruned agents — without
  // this, every retired worker would leave its full transcript (up to
  // `MAX_AGENT_TRANSCRIPT_ENTRIES = 500` entries from agent-model.ts) pinned
  // in React state forever, leaking tens of KB to several MB per stale agent.
  useEffect(() => {
    if (subagents.length === 0) return;
    const timer = setInterval(() => {
      setSubagents((current) => {
        const pruned = pruneAgents(current, Date.now());
        if (pruned.length === current.length) return current;
        const retainedIds = new Set(pruned.map((agent) => agent.id));
        setAgentTranscripts((transcripts) => {
          let changed = false;
          const next: Record<string, AgentTranscriptEntry[]> = {};
          for (const [id, entries] of Object.entries(transcripts)) {
            if (retainedIds.has(id) || id === LEADER_AGENT_ID) {
              next[id] = entries;
            } else {
              changed = true;
            }
          }
          return changed ? next : transcripts;
        });
        return pruned;
      });
    }, 15_000);
    return () => clearInterval(timer);
  }, [subagents.length, setAgentTranscripts]);

  return {
    subagents,
    setSubagents,
    agentTranscripts,
    setAgentTranscripts,
    selectedAgentId,
    setSelectedAgentId,
    agentTabs,
    liveAgentTabs,
    finishedAgentTabs,
    activeAgentId,
    activeAgent,
    leaderSelected,
  };
}
