import type { SessionMarker } from '@wrongstack/core/types';
import { isSystemInjectedMessage } from '@wrongstack/core/types/session-markers';
import { isMobileViewport } from '@/hooks/useViewport';
import { reconcileFileTabsAfterEnvChange } from '@/hooks/ws-handlers/files-mailbox-handlers';
import { isDesktopShell } from '@/lib/desktop-shell';
import { setFaviconStatus } from '@/lib/favicon';
import { streamCoalescer } from '@/lib/stream-coalescer';
import { navigateToView, showPanel } from '@/lib/view-navigation';
import { getWSClient } from '@/lib/ws-client';
import type { ChatMessage, SubagentView } from '@/stores';
import {
  resetUiNavigationToHome,
  useChatStore,
  useConfigStore,
  useFileStore,
  useFleetStore,
  useProviderStatusStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import { useMemoryInjectorTraceStore } from '@/stores/memory-injector-store';
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
    cwd?: string | undefined;
    mode?: string | undefined;
    contextMode?: string | undefined;
    inputCost?: number | undefined;
    outputCost?: number | undefined;
    cacheReadCost?: number | undefined;
    lastInputTokens?: number | undefined;
    reset?: boolean | undefined;
    clearedSessionId?: string | undefined;
    needsSetup?: boolean | undefined;
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
  const provider = sessionRouteIdentifier(payload.provider);
  const model = sessionRouteIdentifier(payload.model);
  const prev = useSessionStore.getState().session?.id;
  const isNew = !prev || prev !== payload.sessionId;
  const isReset = isNew || payload.reset;

  if (payload.appVersion || payload.latestVersion) {
    useSessionStore.getState().setUpdateInfo({
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

  if (payload.needsSetup) {
    navigateToView('setup');
  }

  if (isReset) {
    useMemoryInjectorTraceStore.getState().clear();
    useSessionStore.getState().startSession({
      id: payload.sessionId,
      startedAt: Date.now(),
      model,
      provider,
    });
  } else {
    useSessionStore.getState().setSession({
      id: payload.sessionId,
      startedAt: useSessionStore.getState().session?.startedAt ?? Date.now(),
      model,
      provider,
    });
  }

  useSessionStore.getState().setEnv({
    maxContext: payload.maxContext,
    projectRoot: (payload as { projectRoot?: string }).projectRoot ?? '',
    projectName: payload.projectName,
    cwd: payload.cwd,
    mode: payload.mode,
    contextMode: payload.contextMode,
    inputCost: payload.inputCost,
    outputCost: payload.outputCost,
    cacheReadCost: payload.cacheReadCost,
    // Always pass the key (even undefined) so the store's key-presence
    // semantics replace a previous model's list on switch.
    reasoningEffortLevels: (payload as { reasoningEffortLevels?: string[] }).reasoningEffortLevels,
  });
  useConfigStore.getState().setConfig({ provider, model });
  if (isReset) {
    if (!payload.needsSetup && isDesktopShell() && !isRoutePinnedView()) {
      resetUiNavigationToHome({ sidebarOpen: false });
    }
    streamCoalescer.dropAll();
    useChatStore.getState().clearMessages();
    useChatStore.getState().setBoundSessionId(payload.sessionId);
    useUIStore.getState().setSearchActiveMessageId(null);
    useChatStore.getState().setLoading(false);
    useSessionStore.setState({ todos: [] });
    setFaviconStatus('ready');

    const fleet = useFleetStore.getState();
    if (payload.clearedSessionId) {
      const survivors = new Map<string, SubagentView>();
      for (const [id, agent] of fleet.agents) {
        if (agent.sessionId !== payload.clearedSessionId) {
          survivors.set(id, agent);
        }
      }
      useFleetStore.setState({ agents: survivors });
    } else {
      fleet.clear();
    }

    useFileStore.getState().setTreeLoading(true);
    reconcileFileTabsAfterEnvChange(useSessionStore.getState().projectRoot);
    getWSClient().send({ type: 'files.tree', payload: { path: useSessionStore.getState().cwd } });
  }
  const replay = (payload as { replayMessages?: ReplayMessage[] }).replayMessages;
  const replayMarkers = (payload as { replayMarkers?: SessionMarker[] }).replayMarkers ?? [];
  if (replay && replay.length > 0) {
    const chat = useChatStore.getState();
    const shouldReplace =
      isReset ||
      chat.messages.length === 0 ||
      chat.boundSessionId !== payload.sessionId ||
      chat.isLoading;
    if (shouldReplace) {
      chat.setMessages(hydrateReplayMessages(replay, replayMarkers));
      chat.setBoundSessionId(payload.sessionId);
    }
  }
  if (replay) {
    const usage = (
      payload as {
        replayUsage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      }
    ).replayUsage;
    if (usage) {
      const rates = useSessionStore.getState();
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const cacheRead = usage.cacheRead ?? 0;
      const cacheWrite = usage.cacheWrite ?? 0;
      useSessionStore.setState({
        totalTokens: { input, output, cacheRead, cacheWrite },
        cost:
          ((input + cacheWrite) * rates.inputCost +
            output * rates.outputCost +
            cacheRead * rates.cacheReadCost) /
          1_000_000,
      });
    }
    const serverLastInput = (payload as { lastInputTokens?: number }).lastInputTokens;
    if (typeof serverLastInput === 'number' && serverLastInput > 0) {
      useSessionStore.setState({ lastInputTokens: serverLastInput });
    } else if (usage) {
      const totalPrompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      if (totalPrompt > 0) useSessionStore.setState({ lastInputTokens: totalPrompt });
    }
    if (isReset && !payload.needsSetup) {
      if (!isRoutePinnedView()) {
        if (isDesktopShell()) resetUiNavigationToHome({ sidebarOpen: false });
        else if (useUIStore.getState().currentView !== 'chat') showPanel('chat');
      }
    }
    if (isMobileViewport()) {
      useUIStore.getState().setSidebarOpen(false);
    }
  }
}
