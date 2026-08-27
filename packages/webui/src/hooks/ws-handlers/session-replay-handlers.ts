import type { SessionMarker } from '@wrongstack/core/types';
import { isSystemInjectedMessage } from '@wrongstack/core/types/session-markers';
import { isMobileViewport } from '@/hooks/useViewport';
import { reconcileFileTabsAfterEnvChange } from '@/hooks/ws-handlers/files-mailbox-handlers';
import { isDesktopShell } from '@/lib/desktop-shell';
import { setFaviconStatus } from '@/lib/favicon';
import { navigateToView, showPanel } from '@/lib/view-navigation';
import { getWSClient } from '@/lib/ws-client';
import type { ChatMessage, SubagentView } from '@/stores';
import {
  resetUiNavigationToHome,
  useConfigStore,
  useFileStore,
  useFleetStore,
  useProviderStatusStore,
  useSessionStore,
  useSessionTabStore,
  useUIStore,
} from '@/stores';
import {
  activeLaneId,
  adoptDefaultLane,
  chatLane,
  DEFAULT_LANE_ID,
  ensureLane,
  hasLane,
  MAX_LANES,
  setActiveLane,
} from '@/stores/chat-lanes';
import { useMemoryInjectorTraceStore } from '@/stores/memory-injector-store';
import {
  adoptDefaultSessionLane,
  ensureSessionLane,
  sessionLane,
  setActiveSessionLane,
  setSessionGlobals,
} from '@/stores/session-lanes';
import { useVizStore, wsToVizEvent } from '@/stores/viz-store';
import type { WSServerMessage } from '@/types';

export interface ReplayMessage {
  role: string | undefined;
  content: unknown;
  ts?: string | undefined;
}

export function replayTimestamp(ts: string | undefined): number {
  if (typeof ts !== 'string') return Date.now();
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function replayMessageId(index: number): string {
  return `replay_${Date.now()}_${index}`;
}

export function isRoutePinnedView(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.location.pathname === '/debug' ||
    window.location.pathname === '/analytics' ||
    window.location.pathname === '/refresh-debug'
  );
}

export function contentToToolResult(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

export function providerResponseText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        !!block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n');
}

/**
 * Keep provider/model objects from crossing the WebSocket trust boundary into
 * persisted Zustand state. Legacy provider instances expose a public id/name;
 * never stringify the full object because it may also contain credentials.
 */
export function sessionRouteIdentifier(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';

  const record = value as Record<string, unknown>;
  for (const key of ['id', 'name', 'type'] as const) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

export function hydrateReplayMessages(
  replay: ReplayMessage[],
  markers: readonly SessionMarker[] = [],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const toolMessagesByUseId = new Map<string, ChatMessage>();
  let thinkingLogIteration = 0;
  let markerIndex = 0;

  const pushText = (role: 'user' | 'assistant' | 'system', content: string, timestamp: number) => {
    if (!content) return;
    if (isSystemInjectedMessage(content)) return;
    messages.push({ id: replayMessageId(messages.length), role, content, timestamp });
  };
  const pushMarker = (marker: SessionMarker) => {
    messages.push({
      id: replayMessageId(messages.length),
      role: 'system',
      content: marker.text,
      timestamp: replayTimestamp(marker.ts),
      isError: marker.level === 'error' ? true : undefined,
    });
  };

  const flushMarkersBefore = (boundary: string | undefined) => {
    if (typeof boundary !== 'string') return;
    while (markerIndex < markers.length && markers[markerIndex]!.ts < boundary) {
      pushMarker(markers[markerIndex]!);
      markerIndex += 1;
    }
  };
  const pushThinkingLog = (text: string, timestamp: number) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    thinkingLogIteration += 1;
    messages.push({
      id: replayMessageId(messages.length),
      role: 'system',
      content: '',
      timestamp,
      thinkingLog: {
        iteration: thinkingLogIteration,
        text: trimmed,
        startedAt: timestamp,
        durationMs: 0,
        replayed: true,
      },
    });
  };

  for (const m of replay) {
    flushMarkersBefore(m.ts);
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') continue;
    const role = m.role;
    const timestamp = replayTimestamp(m.ts);
    if (typeof m.content === 'string') {
      pushText(role, m.content, timestamp);
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    let text = '';
    const thinking: string[] = [];
    for (const block of m.content as Array<Record<string, unknown>>) {
      if (block.type === 'thinking' && typeof block.thinking === 'string') {
        thinking.push(block.thinking);
        continue;
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        text += (text ? '\n' : '') + block.text;
        continue;
      }
      if (block.type === 'tool_use') {
        pushText(role, text, timestamp);
        text = '';
        const toolUseId = String(block.id ?? '');
        const toolMessage: ChatMessage = {
          id: replayMessageId(messages.length),
          role: 'tool',
          content: '',
          toolName: String(block.name ?? 'tool'),
          toolInput: block.input,
          toolUseId,
          timestamp,
        };
        messages.push(toolMessage);
        if (toolUseId) toolMessagesByUseId.set(toolUseId, toolMessage);
        continue;
      }
      if (block.type === 'tool_result') {
        const toolUseId = String(block.tool_use_id ?? '');
        const toolMessage = toolMessagesByUseId.get(toolUseId);
        if (toolMessage) {
          toolMessage.toolResult = contentToToolResult(block.content);
          toolMessage.isError = Boolean(block.is_error);
        }
      }
    }
    pushText(role, text, timestamp);
    if (role === 'assistant' && thinking.length > 0) {
      pushThinkingLog(thinking.join('\n\n'), timestamp);
    }
  }

  while (markerIndex < markers.length) {
    pushMarker(markers[markerIndex]!);
    markerIndex += 1;
  }

  return messages;
}

/**
 * `session.start` is how EVERY tab change arrives: `session.new` and
 * `session.resume` both answer with one, and the server also re-announces on
 * model switch and at boot.
 *
 * Under the lane model this handler has one job — fill the NAMED session's
 * lane — and one decision: does this session come to the front?
 *
 * What it deliberately no longer does is park, snapshot, restore or clear
 * anybody else's state. Every lane keeps its own transcript whether or not it
 * is on screen, so there is nothing to save on the way out and nothing to
 * rebuild on the way in. That bookkeeping is where the cross-tab damage lived:
 * a swap that cleared instead of parked lost the outgoing transcript, and one
 * that restored under a stale key handed it to the wrong tab.
 */
export function handleSessionStart(msg: WSServerMessage) {
  const vizStart = wsToVizEvent('session.start', msg.payload as Record<string, unknown>);
  if (vizStart) {
    useVizStore.getState().pushEvent(vizStart);
    useVizStore.getState().setActive(true);
  }

  const payload = msg.payload as {
    sessionId: string;
    model: unknown;
    provider: unknown;
    maxContext?: number | undefined;
    projectName?: string | undefined;
    projectRoot?: string | undefined;
    cwd?: string | undefined;
    mode?: string | undefined;
    contextMode?: string | undefined;
    inputCost?: number | undefined;
    outputCost?: number | undefined;
    cacheReadCost?: number | undefined;
    lastInputTokens?: number | undefined;
    reasoningEffortLevels?: string[] | undefined;
    isRunning?: boolean | undefined;
    reset?: boolean | undefined;
    clearedSessionId?: string | undefined;
    needsSetup?: boolean | undefined;
    replayMessages?: ReplayMessage[] | undefined;
    replayMarkers?: SessionMarker[] | undefined;
    replayUsage?:
      | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
      | undefined;
    providerStatuses?: Array<{
      providerId: string;
      model: string;
      state: 'healthy' | 'degraded' | 'blocked';
      lastErrorKind?: string | null | undefined;
      stateExpiresAt?: number | null | undefined;
      lastFailureAt?: number | null | undefined;
    }>;
    appVersion?: unknown;
    latestVersion?: unknown;
    updateAvailable?: unknown;
  };

  const sessionId = payload.sessionId;
  if (!sessionId) return;

  // -- Project-wide state (shared by all four tabs) ---------------------
  if (payload.appVersion || payload.latestVersion) {
    setSessionGlobals({
      appVersion: String(payload.appVersion ?? ''),
      latestVersion: String(payload.latestVersion ?? ''),
      updateAvailable: Boolean(payload.updateAvailable),
    });
  }
  if (Array.isArray(payload.providerStatuses)) {
    useProviderStatusStore.getState().hydrate(
      payload.providerStatuses.map((status) => ({
        providerId: status.providerId,
        model: status.model,
        state: status.state,
        reason: status.lastErrorKind ?? status.state,
        updatedAt: status.lastFailureAt ?? Date.now(),
        stateExpiresAt: status.stateExpiresAt ?? undefined,
      })),
    );
  }
  if (payload.needsSetup) navigateToView('setup');

  const globals: Parameters<typeof setSessionGlobals>[0] = {};
  if (payload.projectRoot !== undefined) globals.projectRoot = payload.projectRoot;
  if (payload.projectName !== undefined) globals.projectName = payload.projectName;
  if (payload.cwd !== undefined) globals.cwd = payload.cwd;
  if (Object.keys(globals).length > 0) setSessionGlobals(globals);

  // -- The lane this announcement is about ------------------------------
  const isFirstSightOfLane = !hasLane(sessionId);
  // Anything typed before a session existed belongs to the first real one.
  adoptDefaultLane(sessionId);
  adoptDefaultSessionLane(sessionId);
  ensureLane(sessionId);
  ensureSessionLane(sessionId);

  const chat = chatLane(sessionId);
  const meta = sessionLane(sessionId);

  const currentConfig = useConfigStore.getState();
  const laneSession = meta.data.session;
  const rawProvider = sessionRouteIdentifier(payload.provider);
  const rawModel = sessionRouteIdentifier(payload.model);
  const provider = rawProvider || laneSession?.provider || currentConfig.provider || '';
  const model = rawModel || laneSession?.model || currentConfig.model || '';

  const isRunning = Boolean(payload.isRunning);
  // Switching BACK to a tab we already hold answers with `reset: true` as well
  // — the session id changed from the server's point of view. Treating that as
  // a reset is what zeroed a tab's transcript and counters the moment you
  // returned to it, so a lane we already know is only reset when it is the one
  // already in front (a genuine in-place clear).
  const returningToKnownTab = !isFirstSightOfLane && activeLaneId() !== sessionId;
  const isReset = isFirstSightOfLane || (payload.reset === true && !returningToKnownTab);

  if (isReset) {
    meta.startSession({ id: sessionId, startedAt: Date.now(), model, provider });
    useMemoryInjectorTraceStore.getState().clear();
  } else {
    meta.setSession({
      id: sessionId,
      startedAt: laneSession?.startedAt ?? Date.now(),
      model,
      provider,
      ...(laneSession?.title ? { title: laneSession.title } : {}),
    });
  }

  meta.setEnvRates({
    maxContext: payload.maxContext,
    mode: payload.mode,
    contextMode: payload.contextMode,
    inputCost: payload.inputCost,
    outputCost: payload.outputCost,
    cacheReadCost: payload.cacheReadCost,
    reasoningEffortLevels: payload.reasoningEffortLevels,
    // Key-presence: an omitted list means "this model advertises none".
    hasReasoningEffortKey: 'reasoningEffortLevels' in payload,
  });

  // -- Transcript -------------------------------------------------------
  const replay = payload.replayMessages;
  const hydrated =
    replay && replay.length > 0 ? hydrateReplayMessages(replay, payload.replayMarkers ?? []) : [];
  const hasLiveTranscript = chat.messages.length > 0;
  if (hydrated.length > 0 && !(isRunning && hasLiveTranscript)) {
    // Server replay wins, except for a lane whose run is still streaming: its
    // in-memory transcript is ahead of anything the journal can replay.
    chat.setMessages(hydrated);
  } else if (isReset && payload.reset === true && hydrated.length === 0 && !isRunning) {
    chat.clearMessages();
  }
  if (!isRunning) chat.clearThinking();
  chat.setLoading(isRunning);

  // -- Replay accounting ------------------------------------------------
  const usage = payload.replayUsage;
  if (replay && usage) {
    const rates = meta.data;
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    meta.patch({
      totalTokens: { input, output, cacheRead, cacheWrite },
      cost:
        ((input + cacheWrite) * rates.inputCost +
          output * rates.outputCost +
          cacheRead * rates.cacheReadCost) /
        1_000_000,
    });
  }
  const serverLastInput = payload.lastInputTokens;
  if (typeof serverLastInput === 'number' && serverLastInput > 0) {
    meta.patch({ lastInputTokens: serverLastInput });
  } else if (usage) {
    const totalPrompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    if (totalPrompt > 0) meta.patch({ lastInputTokens: totalPrompt });
  }

  // -- Subagents belong to their session --------------------------------
  // Retiring one session must not wipe the fleets of the tabs still running.
  const retiredSessionId = payload.clearedSessionId;
  if (retiredSessionId) {
    const survivors = new Map<string, SubagentView>();
    for (const [id, agent] of useFleetStore.getState().agents) {
      if (agent.sessionId !== retiredSessionId) survivors.set(id, agent);
    }
    useFleetStore.setState({ agents: survivors });
  }

  // -- Does this session come to the front? -----------------------------
  // Only when THIS client asked for it, or when nothing is in front yet.
  // A server-side re-announce for a background tab (model switch, a
  // re-broadcast) updates the lane above and stops here — yanking the user out
  // of the tab they are typing in is exactly the "tabs go haywire" symptom
  // this design exists to remove.
  const activeId = activeLaneId();
  const nothingInFront = activeId === DEFAULT_LANE_ID || !hasLane(activeId);
  const requested = claimRequestedSwitch(sessionId);
  const tabStore = useSessionTabStore.getState();
  if (!requested && !nothingInFront && activeId !== sessionId) {
    if (!tabStore.openTabIds.includes(sessionId) && tabStore.openTabIds.length < MAX_LANES) {
      // Give it a slot so the tab strip shows it, but leave the pointer alone.
      //
      // Only when one is FREE. This used to `slice(-MAX_LANES)`, which meant an
      // announce for a fifth session — a re-broadcast, another surface opening
      // a session, a stale client — silently evicted the oldest tab, running or
      // not, and took its lane with it. A session with no free slot stays out
      // of the strip; it is still one click away in the history list.
      tabStore.setOpenTabIds([...tabStore.openTabIds, sessionId]);
    }
    return;
  }

  // Bring it forward. `openTab` owns slot assignment AND the lane pointer;
  // there is no second path that binds a session to the surface.
  if (!tabStore.openTabIds.includes(sessionId)) {
    tabStore.openTab(sessionId, {});
  } else {
    setActiveLane(sessionId);
    setActiveSessionLane(sessionId);
    tabStore.markSeen(sessionId);
  }

  if (provider && model) useConfigStore.getState().setConfig({ provider, model });
  else if (provider) useConfigStore.getState().setConfig({ provider });

  setFaviconStatus(isRunning ? 'running' : 'ready');

  if (isReset) {
    if (!payload.needsSetup && isDesktopShell() && !isRoutePinnedView()) {
      resetUiNavigationToHome({ sidebarOpen: false });
    }
    useUIStore.getState().setSearchActiveMessageId(null);
    useFileStore.getState().setTreeLoading(true);
    reconcileFileTabsAfterEnvChange(useSessionStore.getState().projectRoot);
    getWSClient().send({ type: 'files.tree', payload: { path: useSessionStore.getState().cwd } });
  }

  if (replay && !payload.needsSetup && !isRoutePinnedView()) {
    if (isDesktopShell()) resetUiNavigationToHome({ sidebarOpen: false });
    else if (useUIStore.getState().currentView !== 'chat') showPanel('chat');
  }
  if (replay && isMobileViewport()) useUIStore.getState().setSidebarOpen(false);
}

/**
 * Claim the "this client asked to switch HERE" grant for one session.
 *
 * Keyed by session id, and one-shot in both directions: a later unrequested
 * announce for the same session does not inherit the grant, and — the part
 * that matters with four tabs live — an announce for a DIFFERENT session
 * cannot spend it. `session.start` arrives constantly for sessions nobody
 * clicked (a background tab's answer landing late, a server re-announce), and
 * while the grant was a bare boolean the first such arrival took the
 * foreground and left the tab the user actually clicked looking unrequested.
 */
function claimRequestedSwitch(sessionId: string): boolean {
  try {
    return getWSClient().consumeRequestedSwitch(sessionId);
  } catch {
    return false;
  }
}
