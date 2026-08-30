import type {
  Message,
  SessionMarker,
  SessionTimelineImage,
  SessionToolMeta,
} from '@wrongstack/core/types';
import { projectSessionTimeline } from '@wrongstack/core/types/session-timeline';
import { isMobileViewport } from '@/hooks/useViewport';
import { reconcileFileTabsAfterEnvChange } from '@/hooks/ws-handlers/files-mailbox-handlers';
import { isDesktopShell } from '@/lib/desktop-shell';
import { setFaviconStatus } from '@/lib/favicon';
import { navigateToView, showPanel } from '@/lib/view-navigation';
import { getWSClient } from '@/lib/ws-client';
import type { ChatMessage, ChatMessageAttachment, SubagentView } from '@/stores';
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
import { restoreTabsAfterBoot } from '@/stores/session-tab-store';
import { useResumeProgressStore } from '@/stores/resume-progress-store';
import {
  activeLaneId,
  adoptDefaultLane,
  chatLane,
  DEFAULT_LANE_ID,
  ensureLane,
  hasLane,
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
import { bindForegroundStores } from '@/stores/session-store';
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

/**
 * Rebuild a lane's chat from a replayed session.
 *
 * Ordering, tool pairing and visibility come from core's
 * {@link projectSessionTimeline} — the same function the TUI, SimpleUI and HQ
 * project through — so a resumed session cannot read differently here than it
 * does there. Everything below the projection is WebUI presentation: which
 * `ChatMessage` shape a timeline entry becomes.
 *
 * `thinkingPlacement: 'merged-after'` is not a style choice. Live, the thinking
 * bubble is transient and the archived log is only committed when the
 * iteration completes — i.e. AFTER the prose and tool cards are already on
 * screen. Replaying it inline would put the log somewhere it never appeared.
 */
export function hydrateReplayMessages(
  replay: ReplayMessage[],
  markers: readonly SessionMarker[] = [],
  toolMeta: readonly SessionToolMeta[] = [],
): ChatMessage[] {
  const conversation = (Array.isArray(replay) ? replay : []).filter(
    (m): m is ReplayMessage & { role: 'user' | 'assistant' | 'system' } =>
      Boolean(
        m &&
          typeof m === 'object' &&
          typeof (m as { role?: unknown }).role === 'string' &&
          (m.role === 'user' || m.role === 'assistant' || m.role === 'system'),
      ),
  ) as unknown as Message[];

  const timeline = projectSessionTimeline({
    messages: conversation,
    markers: markers.filter((marker) => !isSubagentResumeMarker(marker.source)),
    toolMeta,
    thinkingPlacement: 'merged-after',
  });

  const messages: ChatMessage[] = [];
  for (const item of timeline) {
    const timestamp = replayTimestamp(item.ts);
    const id = replayMessageId(messages.length);
    switch (item.kind) {
      case 'user':
        messages.push({
          id,
          role: 'user',
          content: item.text,
          timestamp,
          ...(item.images ? { attachments: replayAttachments(item.images, id) } : {}),
        });
        break;
      case 'assistant':
        messages.push({ id, role: 'assistant', content: item.text, timestamp });
        break;
      case 'system':
        messages.push({ id, role: 'system', content: item.text, timestamp });
        break;
      case 'thinking':
        messages.push({
          id,
          role: 'system',
          content: '',
          timestamp,
          thinkingLog: {
            iteration: item.index,
            text: item.text,
            startedAt: timestamp,
            durationMs: 0,
            replayed: true,
          },
        });
        break;
      case 'tool':
        messages.push({
          id,
          role: 'tool',
          content: '',
          toolName: item.name,
          toolInput: item.input,
          toolUseId: item.toolUseId,
          timestamp,
          ...(item.output !== undefined ? { toolResult: item.output } : {}),
          // `!ok`, matching what `setToolResult` writes live — but only once
          // the journal actually resolved the call. An unfinished call keeps
          // `isError` absent, exactly as a live tool card does while it runs.
          ...(item.ok !== undefined ? { isError: !item.ok } : {}),
          ...(item.durationMs !== undefined ? { toolDurationMs: item.durationMs } : {}),
        });
        break;
      case 'marker': {
        messages.push({
          id,
          role: 'system',
          content: item.text,
          timestamp,
          isError: item.level === 'error' ? true : undefined,
        });
        break;
      }
      default: {
        const _exhaustive: never = item;
        void _exhaustive;
      }
    }
  }

  return messages;
}

const SUBAGENT_RESUME_MARKER_SOURCES = new Set<string>([
  'agent_spawned',
  'agent_session_linked',
  'agent_stopped',
  'agent_error',
  'delegate_started',
  'delegate_completed',
]);

function isSubagentResumeMarker(source: string): boolean {
  return SUBAGENT_RESUME_MARKER_SOURCES.has(source);
}

/**
 * Rebuild the attachment chips of a replayed prompt.
 *
 * The journal keeps the image the model saw, so the chip can show a real
 * thumbnail again instead of the empty placeholder a reload used to leave —
 * these blocks were dropped entirely by the old replay walk.
 */
function replayAttachments(
  images: readonly SessionTimelineImage[],
  messageId: string,
): ChatMessageAttachment[] {
  return images.map((image, index) => {
    const mediaType = image.mediaType ?? 'image/png';
    const dataUrl = image.data
      ? `data:${mediaType};base64,${image.data}`
      : image.url;
    return {
      id: `${messageId}_img_${index}`,
      kind: 'image' as const,
      mediaType,
      // Base64 expands 3 bytes into 4 characters; close enough for a size chip.
      bytes: image.data ? Math.floor((image.data.length * 3) / 4) : 0,
      ...(dataUrl ? { dataUrl } : {}),
    };
  });
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

  const payload = (msg?.payload && typeof msg.payload === 'object'
    ? msg.payload
    : {}) as {
    sessionId: string;
    model: unknown;
    provider: unknown;
    startedAt?: string | undefined;
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
    /** Tri-state: undefined = undocumented vocabulary, false = no effort control. */
    effortSupported?: boolean | undefined;
    /** Project-wide effort — the "general setting" the composer auto option follows. */
    projectReasoningEffort?: string | undefined;
    isRunning?: boolean | undefined;
    reset?: boolean | undefined;
    /**
     * Set to `'redisplay'` on the frames this page asked for by naming the
     * session in `session.subscribe.replayFor`. Those carry the journal's own
     * record and may replace what a pane is showing; an unsolicited
     * `session.start` for a background tab may not.
     */
    replayReason?: string | undefined;
    clearedSessionId?: string | undefined;
    needsSetup?: boolean | undefined;
    replayMessages?: ReplayMessage[] | undefined;
    replayMarkers?: SessionMarker[] | undefined;
    replayToolMeta?: SessionToolMeta[] | undefined;
    /**
     * Sessions this RUNTIME holds. Present only on the boot frame; the client
     * keeps exactly these tabs and discards the rest of its persisted strip.
     */
    openSessionIds?: string[] | undefined;
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
    agentSessions?: Array<{
      subagentId: string;
      agentName?: string | undefined;
      status?: string | undefined;
      task?: string | undefined;
      transcript?: import('@/stores').AgentTranscriptEntry[] | undefined;
    }> | undefined;
  };

  const sessionId = payload.sessionId;
  if (!sessionId) return;

  // The answer this tab was waiting for — whatever it turns out to say. Ended
  // here rather than in the transcript branch below so a frame that carries no
  // messages (a focus, a session with an empty journal) also takes the pane
  // out of its loading state instead of leaving it spinning on a wait that is
  // over.
  useResumeProgressStore.getState().end(sessionId);

  // -- Reconcile the persisted tab strip with the RUNTIME ----------------
  // Before any lane is promoted or fronted, because promoting a slot this
  // server never had is what cost a full journal resume — and its todo board —
  // on a fresh `wstack --webui`. `restoreTabsAfterBoot` is a one-shot latch, so
  // only the first `session.start` of the page does this; every later frame
  // falls straight through.
  //
  // Key-presence, not truthiness: a server too old to send the field must fall
  // back to restoring the strip unfiltered, while a server that sends an empty
  // list is stating a fact — it holds nothing yet, so nothing is an open tab.
  if ('openSessionIds' in payload) {
    restoreTabsAfterBoot(
      Array.isArray(payload.openSessionIds)
        ? payload.openSessionIds.filter((id): id is string => typeof id === 'string')
        : [],
    );
  }

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
  const payloadStartedAt =
    typeof payload.startedAt === 'string' ? Date.parse(payload.startedAt) : Number.NaN;
  const sessionStartedAt = Number.isFinite(payloadStartedAt) ? payloadStartedAt : Date.now();

  const isRunning = Boolean(payload.isRunning);
  // Did THIS client ask to land here? Claimed once, high up, because two
  // separate decisions need the answer: whether a replay may replace what the
  // lane holds, and whether the surface moves. Claiming it twice would let the
  // first read consume the grant and leave the second looking unrequested.
  const requested = claimRequestedSwitch(sessionId);
  // Switching BACK to a tab we already hold answers with `reset: true` as well
  // — the session id changed from the server's point of view. Treating that as
  // a reset is what zeroed a tab's transcript and counters the moment you
  // returned to it, so a lane we already know is only reset when it is the one
  // already in front (a genuine in-place clear).
  //
  // The server has to SAY which of the two this is. The original test —
  // "the lane exists and is not the one in front" — could never be true on the
  // path it was written for: `openTab` calls `activate()`, which moves the
  // active lane synchronously, BEFORE `focusSessionById` goes out. By the time
  // the focus answer arrives the lane IS in front, so `returningToKnownTab`
  // was always false, `isReset` was always true, and a transcript-less
  // `reset: true` fell straight through to `clearMessages()`. Every switch
  // back to an open tab emptied it. `replayReason: 'focus'` is the server
  // stating the fact instead of the client guessing from a pointer it has
  // already moved; the positional test stays for the case it does answer
  // correctly — an unrequested re-announce for a background lane.
  const isFocusFrame = payload.replayReason === 'focus';
  const returningToKnownTab =
    !isFirstSightOfLane && (isFocusFrame || activeLaneId() !== sessionId);
  const isReset = isFirstSightOfLane || (payload.reset === true && !returningToKnownTab);

  if (isReset) {
    meta.startSession({ id: sessionId, startedAt: sessionStartedAt, model, provider });
    // THIS conversation's injector trace, not the one in front. A fresh
    // session starting in a background tab used to wipe the panel the user was
    // reading in another tab.
    useMemoryInjectorTraceStore.for(sessionId).getState().clear();
  } else {
    meta.setSession({
      id: sessionId,
      startedAt: laneSession?.startedAt ?? sessionStartedAt,
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
    // Tri-state companion: undefined = undocumented vocabulary (show control),
    // false = the model documents that it has no effort control (hide it).
    effortSupported: payload.effortSupported === true || payload.effortSupported === false
      ? payload.effortSupported
      : undefined,
    hasEffortSupportedKey: 'effortSupported' in payload,
    // Display-only hint: the project-wide effort the composer auto option
    // follows (absent when the project pins no effort — provider default).
    projectReasoningEffort: typeof payload.projectReasoningEffort === 'string'
      ? payload.projectReasoningEffort
      : undefined,
    hasProjectEffortKey: 'projectReasoningEffort' in payload,
  });

  // -- Transcript -------------------------------------------------------
  const replay = payload.replayMessages;
  const hasReplayMessages = Array.isArray(replay) && replay.length > 0;
  const hydrated = hasReplayMessages
    ? hydrateReplayMessages(replay, payload.replayMarkers ?? [], payload.replayToolMeta ?? [])
    : [];
  const hasLiveTranscript = chat.messages.length > 0;
  // A tab that is ALREADY on screen must never be re-hydrated from a replay.
  //
  // Switching to an open tab makes the client ask the server to move the
  // foreground, and the server answers with a `session.start` — for a session
  // it is already holding, so its replay is rebuilt from the live working set
  // with no event stream behind it (`events: []`). Letting that win threw away
  // strictly more than it restored: every audit marker the lane had rendered
  // live (compaction, provider error, mode switch) disappeared, the streamed
  // tool cards were rebuilt from message blocks, and every message got a new
  // `replay_*` id, so anything the UI keyed on an id — search anchors, expanded
  // tool output, scroll position — reset on a click that changed nothing.
  //
  // The lane's own transcript is the fuller record whenever it has one, so a
  // lane we already know keeps what it has. An EMPTY known lane still takes
  // the replay: that is the case where the persisted copy did not survive
  // (storage cleared, quota refused the write) and the pane would otherwise
  // stay blank until clicked.
  //
  // A frame this client ASKED for is the exception to the exception. Resuming
  // a large journal can take the server tens of seconds, and in that window
  // anything at all may land in the target lane — a Chimera card, a restored
  // todo notice — and the user may well have clicked away and back. Both make
  // the lane "known and populated", which is exactly the shape this guard
  // discards, so the transcript the user waited for was thrown away on arrival
  // and no later click could ask for it again (a tab on screen is focused, not
  // resumed, and a focus carries nothing). A run that is still streaming still
  // wins: its in-memory transcript is genuinely ahead of the journal.
  const keepLiveTranscript =
    hasLiveTranscript && (isRunning || (returningToKnownTab && !requested));
  // A redisplay is the one frame that may touch a populated lane, and even it
  // may only ADD.
  //
  // What a reloaded page shows came out of localStorage, which keeps the last
  // `MAX_PERSISTED_MESSAGES` messages and nothing older — so a long
  // conversation silently came back beheaded. The journal has the rest, so a
  // redisplay splices back exactly the part that is missing from the FRONT and
  // leaves everything the lane already holds untouched. Replacing wholesale
  // would have been the easy version and the wrong one: the lane's own entries
  // carry live tool cards and the audit markers the server rebuilds without,
  // so a "restore" would have cost more than it returned.
  const isRedisplay = payload.replayReason === 'redisplay';
  if (isRedisplay && hasLiveTranscript && hydrated.length > 0) {
    const oldestShown = chat.messages[0]?.timestamp ?? 0;
    const missingPrefix = hydrated.filter((m) => m.timestamp < oldestShown);
    if (missingPrefix.length > 0) chat.setMessages([...missingPrefix, ...chat.messages]);
  } else if (hydrated.length > 0 && !keepLiveTranscript) {
    // Server replay wins, except for a lane whose run is still streaming (its
    // in-memory transcript is ahead of anything the journal can replay) or a
    // background lane that already holds this session's chat.
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
  // `lastInputTokens` drives the context-fill bar, so only a real per-request
  // measurement may set it. The fallback that used to sit here summed
  // `replayUsage` — the session's RUNNING TOTAL — and published it as the size
  // of one prompt, which drew a resumed session at several hundred percent of
  // its window. A session the server cannot measure yet keeps the bar unset;
  // the cumulative numbers still reach the usage and cost readouts above.
  const serverLastInput = payload.lastInputTokens;
  if (typeof serverLastInput === 'number' && serverLastInput > 0) {
    meta.patch({ lastInputTokens: serverLastInput });
  }

  // Retiring one session must not wipe the fleets of the tabs still running.
  const retiredSessionId = payload.clearedSessionId;
  if (retiredSessionId) {
    const survivors = new Map<string, SubagentView>();
    for (const [id, agent] of useFleetStore.getState().agents) {
      if (agent.sessionId !== retiredSessionId) survivors.set(id, agent);
    }
    useFleetStore.setState({ agents: survivors });
  }

  if (Array.isArray(payload.agentSessions) && payload.agentSessions.length > 0) {
    useFleetStore.getState().hydrateAgentSessions(payload.agentSessions, sessionId);
  }

  // -- Does this session come to the front? -----------------------------
  // Only when THIS client asked for it, or when nothing is in front yet.
  // A server-side re-announce for a background tab (model switch, a
  // re-broadcast) updates the lane above and stops here — yanking the user out
  // of the tab they are typing in is exactly the "tabs go haywire" symptom
  // this design exists to remove.
  // `requested` was claimed once at the top of this handler — the transcript
  // decision needs the same answer, and a second claim would find the grant
  // already spent and report this frame as unrequested.
  const activeId = activeLaneId();
  const nothingInFront = activeId === DEFAULT_LANE_ID || !hasLane(activeId);
  const tabStore = useSessionTabStore.getState();
  const preservePlainWebView =
    isReset &&
    !hasReplayMessages &&
    !payload.needsSetup &&
    !isDesktopShell() &&
    !isRoutePinnedView()
      ? {
          currentView: useUIStore.getState().currentView,
          activeActivity: useUIStore.getState().activeActivity,
          sidebarOpen: useUIStore.getState().sidebarOpen,
        }
      : null;
  if (!requested && !nothingInFront && activeId !== sessionId) {
    // Passive server re-announces must never allocate visible tab slots. A
    // session gets a slot only through the tab registry's explicit open/resume
    // path; otherwise a background replay can make tabs appear while the user
    // is working in another one.
    void tabStore;
    return;
  }

  // Bring it forward. `openTab` owns slot assignment AND the lane pointer;
  // there is no second path that binds a session to the surface.
  if (!tabStore.openTabIds.includes(sessionId)) {
    tabStore.openTab(sessionId, {});
  } else {
    setActiveLane(sessionId);
    setActiveSessionLane(sessionId);
    // The session-scoped side stores follow the pointer here too. `openTab`
    // gets this through `activate` → `switchSession`; this branch moves the
    // pointer itself, so it has to. Without it the `files.tree` request issued
    // a few lines below — stamped with the session now in front — comes back
    // to a file store still bound to the previous tab and is parked unseen,
    // which is the stale explorer / dead double-click on a resumed tab.
    bindForegroundStores(sessionId);
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
    useFileStore.getState().setTreeLoading(true, sessionId);
    reconcileFileTabsAfterEnvChange(useSessionStore.getState().projectRoot, sessionId);
    const ws = getWSClient();
    ws.send({
      type: 'files.tree',
      payload: { path: useSessionStore.getState().cwd, sessionId },
    });
  }

  if (preservePlainWebView) {
    useUIStore.setState(preservePlainWebView);
  }

  if (hasReplayMessages && !payload.needsSetup && !isRoutePinnedView()) {
    if (isDesktopShell()) resetUiNavigationToHome({ sidebarOpen: false });
    else if (useUIStore.getState().currentView !== 'chat') showPanel('chat');
  }
  if (hasReplayMessages && isMobileViewport()) useUIStore.getState().setSidebarOpen(false);
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
