/**
 * summaries.ts — the reactive read side of the four slots.
 *
 * Everything the tab strip and the tab map show about a tab is derived HERE,
 * from the lane registries, and nowhere else. There is deliberately no
 * per-tab mirror to keep in sync: a second copy of "what is in tab 3" is
 * exactly the kind of state that drifts and then shows tab 2's model next to
 * tab 3's transcript.
 */

import { useMemo } from 'react';
import { useChatLanes } from '@/stores/chat-lanes';
import { useFleetStore } from '@/stores/fleet-store';
import { useSessionLanes } from '@/stores/session-lanes';
import type { TabSummary } from '@/stores/session-tab-store';
import { useSessionTabStore } from '@/stores/session-tab-store';
import { useUIStore } from '@/stores/ui-store';

/**
 * A fixed accent per slot, drawn from the theme's semantic tokens so it
 * follows every palette. The point is recognition, not decoration: slot 2 is
 * the same colour in the strip, in the map and on the active-tab underline, so
 * "which tab am I looking at" is answerable at a glance instead of by reading
 * a session id.
 */
const SLOT_ACCENTS = [
  {
    name: 'primary',
    dot: 'bg-primary',
    text: 'text-primary',
    border: 'border-primary',
    soft: 'bg-primary/10',
  },
  { name: 'info', dot: 'bg-info', text: 'text-info', border: 'border-info', soft: 'bg-info/10' },
  {
    name: 'warning',
    dot: 'bg-warning',
    text: 'text-warning',
    border: 'border-warning',
    soft: 'bg-warning/10',
  },
  {
    name: 'success',
    dot: 'bg-success',
    text: 'text-success',
    border: 'border-success',
    soft: 'bg-success/10',
  },
] as const;

export function slotAccent(slot: number) {
  return SLOT_ACCENTS[slot % SLOT_ACCENTS.length]!;
}

/** Live summaries for every open slot, in slot order. */
export function useTabSummaries(titles?: Map<string, string>): TabSummary[] {
  const openTabIds = useSessionTabStore((s) => s.openTabIds);
  const lastSeenCounts = useSessionTabStore((s) => s.lastSeenCounts);
  const attention = useSessionTabStore((s) => s.attention);
  const chatLanes = useChatLanes((s) => s.lanes);
  const activeSessionId = useChatLanes((s) => s.activeSessionId);
  const sessionLanes = useSessionLanes((s) => s.lanes);
  const agents = useFleetStore((s) => s.agents);
  const nicknames = useUIStore((s) => s.sessionNicknames);

  return useMemo(() => {
    // One pass over the roster: an agent belongs to exactly the tab it names.
    const agentCounts = new Map<string, { running: number; total: number }>();
    for (const agent of agents.values()) {
      if (!agent.sessionId) continue;
      const entry = agentCounts.get(agent.sessionId) ?? { running: 0, total: 0 };
      entry.total += 1;
      if (agent.status === 'running') entry.running += 1;
      agentCounts.set(agent.sessionId, entry);
    }

    return openTabIds.map((sessionId, slot): TabSummary => {
      const chat = chatLanes[sessionId];
      const meta = sessionLanes[sessionId];
      const counts = agentCounts.get(sessionId) ?? { running: 0, total: 0 };
      const messageCount = chat?.messages.length ?? 0;
      const seen = lastSeenCounts[sessionId] ?? messageCount;
      const isActive = sessionId === activeSessionId;
      const maxContext = meta?.maxContext ?? 0;
      const lastInput = meta?.lastInputTokens ?? 0;

      return {
        slot,
        sessionId,
        isActive,
        title:
          nicknames[sessionId] ||
          titles?.get(sessionId) ||
          meta?.session?.title ||
          sessionId.slice(0, 8),
        provider: meta?.session?.provider ?? '',
        model: meta?.session?.model ?? '',
        mode: meta?.mode ?? 'default',
        isRunning: chat?.isLoading ?? false,
        messageCount,
        unread: isActive ? 0 : Math.max(0, messageCount - seen),
        queued: chat?.queue.length ?? 0,
        agentsRunning: counts.running,
        agentsTotal: counts.total,
        tokens: (meta?.totalTokens.input ?? 0) + (meta?.totalTokens.output ?? 0),
        cost: meta?.cost ?? 0,
        contextPct:
          maxContext > 0 && lastInput > 0
            ? Math.min(100, Math.round((lastInput / maxContext) * 100))
            : 0,
        needsAttention: !isActive && attention[sessionId] === true,
      };
    });
  }, [
    openTabIds,
    lastSeenCounts,
    attention,
    chatLanes,
    sessionLanes,
    activeSessionId,
    agents,
    nicknames,
    titles,
  ]);
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
