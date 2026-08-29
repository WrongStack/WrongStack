import type { projectNextStepsToolInput } from '@wrongstack/tools/next-steps';
import { projectSessionMessage } from '@wrongstack/webui-protocol';
import type { ServerMessage } from '../types.js';
import { LEADER_AGENT_ID } from './agent-model.js';
import { replayToMessages, replayToToolCalls } from './chat-model.js';
import type { MessageHandlerDeps } from './message-handler-deps.js';

/** Structured <nextsteps> tool input produced by `projectNextStepsToolInput`. */
type ToolInput = ReturnType<typeof projectNextStepsToolInput>;

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function handleSessionStartMessage(params: {
  message: ServerMessage;
  deps: MessageHandlerDeps;
  nextStepsByToolId: Map<string, ToolInput>;
  resetCompletedToolNextSteps: () => void;
}): void {
  const { message, deps, nextStepsByToolId, resetCompletedToolNextSteps } = params;
  const {
    sessionIdRef,
    draftRef,
    fileRefsRef,
    activeModelRef,
    socketRef,
    stickToBottomRef,
    writeComposerDraft,
    setShowJumpToLatest,
    worklists,
    setSession,
    setModels,
    setMessages,
    onUpdateInfo,
    setSubagents,
    setAgentTranscripts,
    readComposerDraft,
    setDraft,
    setFileRefs,
    setFileMention,
    clearComposerDraft,
    setPendingConfirm,
    setRunning,
    setActivity,
    setToolCalls,
    setSelectedAgentId,
    resetAgentNameCache,
    setSessionStart,
    setAttachedImages,
    setSessionMenuOpen,
    setContext,
    requestProviderModels,
  } = deps;

  const payload = message.payload ?? {};
  nextStepsByToolId.clear();
  resetCompletedToolNextSteps();
  const sessionProjection = projectSessionMessage(message);
  if (!sessionProjection) return;
  const {
    id,
    provider,
    model,
    maxContext,
    projectName,
    cwd,
    startedAt,
    isRunning,
    replayMessages,
    replayMarkers,
    replayToolMeta,
    replayUsage,
  } = sessionProjection;
  const previousId = sessionIdRef.current;
  const switchedSession = Boolean(previousId && id && previousId !== id);
  const resetSessionState = switchedSession || sessionProjection.reset;
  const startedAtMs = Date.parse(startedAt);
  const sessionStartedAt = Number.isFinite(startedAtMs) ? startedAtMs : Date.now();
  if (switchedSession && previousId) {
    writeComposerDraft(previousId, {
      text: draftRef.current,
      fileRefs: fileRefsRef.current,
    });
  }
  if (!previousId || resetSessionState) {
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
  }
  sessionIdRef.current = id || null;
  if (!previousId || resetSessionState) worklists.reset(id || null);
  activeModelRef.current = provider && model ? { provider, model } : null;
  setSession({
    id,
    provider,
    model,
    projectName,
    cwd,
    maxContext,
  });
  setModels((current) => ({
    ...current,
    [provider]: current[provider]?.some((item) => item.id === model)
      ? current[provider]
      : [{ id: model, name: model }, ...(current[provider] ?? [])].filter((item) => item.id),
  }));
  const replayedToolCalls = replayMessages ? replayToToolCalls(replayMessages, replayToolMeta) : [];
  if (replayMessages) {
    setMessages(replayToMessages(replayMessages, replayMarkers, replayToolMeta));
    setToolCalls(replayedToolCalls);
  } else if (resetSessionState) {
    setMessages([]);
    setToolCalls([]);
  }
  if (payload['appVersion'] || payload['latestVersion']) {
    onUpdateInfo?.({
      appVersion: String(payload['appVersion'] ?? ''),
      latestVersion: String(payload['latestVersion'] ?? ''),
      updateAvailable: Boolean(payload['updateAvailable']),
    });
  }

  if (!previousId || resetSessionState) {
    setSubagents([]);
    setAgentTranscripts({});
  }
  if (!previousId || switchedSession) {
    const savedDraft = readComposerDraft(id);
    draftRef.current = savedDraft.text;
    fileRefsRef.current = savedDraft.fileRefs;
    setDraft(savedDraft.text);
    setFileRefs(savedDraft.fileRefs);
    setFileMention(null);
  } else if (sessionProjection.reset) {
    clearComposerDraft(id);
    draftRef.current = '';
    fileRefsRef.current = [];
    setDraft('');
    setFileRefs([]);
    setFileMention(null);
  }
  if (resetSessionState) {
    setPendingConfirm(null);
    setRunning(isRunning);
    const runningTool = replayedToolCalls.find((call) => call.status === 'running');
    setActivity(isRunning ? (runningTool ? `Running ${runningTool.name}` : 'Thinking') : '');
    setSelectedAgentId(LEADER_AGENT_ID);
    resetAgentNameCache();
    setSessionStart(sessionStartedAt);
    setAttachedImages([]);
    setSessionMenuOpen?.(false);
  }
  const payloadLastInput = finiteNumber(payload['lastInputTokens']);
  const replayInput = replayUsage ? finiteNumber(replayUsage['input']) : payloadLastInput;
  const initialTokens = replayInput || payloadLastInput;
  setContext((current) => ({
    load: resetSessionState
      ? maxContext > 0
        ? initialTokens / maxContext
        : 0
      : current.maxContext > 0
        ? current.load
        : maxContext > 0
          ? initialTokens / maxContext
          : 0,
    tokens: resetSessionState ? initialTokens : current.tokens || initialTokens,
    maxContext: maxContext || current.maxContext,
    cache: resetSessionState ? null : current.cache,
  }));
  if (provider) requestProviderModels(provider);
  socketRef.current?.send('sessions.list', { sessionId: id, limit: 12 });
}
