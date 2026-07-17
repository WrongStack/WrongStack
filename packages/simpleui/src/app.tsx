import {
  ArrowDown,
  Bot,
  Check,
  ChevronDown,
  FolderCode,
  History,
  Moon,
  Plus,
  Settings,
  Sparkles,
  Sun,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentChatPane } from './agent-chat-pane.js';
import { FinishedAgentsMenu } from './finished-agents-menu.js';
import { ChatMessageList } from './chat-message-list.js';
import { Composer } from './composer.js';
import { ErrorBoundary } from './error-boundary.js';
import {
  appendAgentTranscriptEntry,
  buildAgentTabs,
  canComposeForAgent,
  LEADER_AGENT_ID,
  mergeSubagentSnapshot,
  parseAgentSessionReplays,
  partitionAgentTabs,
  projectAgentTimelineEntry,
  projectCompletedAgentText,
  pruneAgents,
  resolveSelectedAgentId,
  stampAgentUpdates,
} from './lib/agent-model.js';
import { contentToText, replayToMessages, updateSubagents } from './lib/chat-model.js';
import { copyText } from './lib/clipboard.js';
import { clearComposerDraft, readComposerDraft, writeComposerDraft } from './lib/composer-draft.js';
import {
  composePromptWithFileReferences,
  type FileMention,
  removeFileMention,
} from './lib/file-mention.js';
import {
  parseSessionSummaries,
  relativeSessionTime,
  sessionDisplayName,
} from './lib/session-model.js';
import {
  DEFAULT_PREFS,
  parsePrefs,
  type AutonomyMode,
  type SimplePrefs,
} from './lib/prefs-model.js';
import {
  dequeueItem,
  enqueueFront,
  enqueueItem,
  removeQueuedAt,
  resolveSendPlan,
  type QueueMode,
  type QueuedItem,
} from './lib/queue-model.js';
import {
  parseFallbackRef,
  projectRefineResult,
  resolveRefineText,
  type RefineDecision,
  type RefineState,
} from './lib/refine-model.js';
import { projectStatusNotice, type StatusNoticeProjection } from './lib/status-notice.js';
import { agentTranscriptToToolCalls } from './lib/tool-model.js';
import {
  createWorklistStore,
  type PlanStatus,
  type TaskStatus,
  type TodoStatus,
  type WorklistView,
} from './lib/worklist-store.js';
import { SimpleSocket } from './lib/ws.js';
import { SettingsPanel } from './settings-panel.js';
import { ToolSidebar } from './tool-sidebar.js';
import type {
  AgentMode,
  AgentTranscriptEntry,
  ChatMessage,
  ConnectionState,
  ContextInfo,
  ModelDescriptor,
  PendingConfirm,
  ServerMessage,
  SessionInfo,
  SimpleSessionSummary,
  SimpleSubagent,
  ToolCallInfo,
} from './types.js';

const EMPTY_CONTEXT: ContextInfo = { load: 0, tokens: 0, maxContext: 0 };
const THEME_STORAGE_KEY = 'wrongstack.simpleui.theme';

type Theme = 'dark' | 'light';

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function compactTokens(value: number): string {
  if (!value) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return Math.round(value).toString();
}

function messageId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

export function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessions, setSessions] = useState<SimpleSessionSummary[]>([]);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [context, setContext] = useState<ContextInfo>(EMPTY_CONTEXT);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [models, setModels] = useState<Record<string, ModelDescriptor[]>>({});
  const [modes, setModes] = useState<AgentMode[]>([]);
  const [activeModeId, setActiveModeId] = useState('default');
  const [prefs, setPrefs] = useState<SimplePrefs>(DEFAULT_PREFS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [queue, setQueue] = useState<QueuedItem[]>([]);
  const [refineState, setRefineState] = useState<RefineState | null>(null);
  const [providerLabels, setProviderLabels] = useState<Record<string, string>>({});
  const [subagents, setSubagents] = useState<SimpleSubagent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState(LEADER_AGENT_ID);
  const [agentTranscripts, setAgentTranscripts] = useState<Record<string, AgentTranscriptEntry[]>>(
    {},
  );
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [draft, setDraft] = useState('');
  const [fileRefs, setFileRefs] = useState<string[]>([]);
  const [fileMention, setFileMention] = useState<FileMention | null>(null);
  const [fileMatches, setFileMatches] = useState<string[]>([]);
  const [filePickerIndex, setFilePickerIndex] = useState(0);
  const [fileSearching, setFileSearching] = useState(false);
  const [running, setRunning] = useState(false);
  const [activity, setActivity] = useState('');
  const [notice, setNotice] = useState<(StatusNoticeProjection & { id: string }) | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCallInfo[]>([]);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [worklists] = useState(createWorklistStore);
  const socketRef = useRef<SimpleSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const activeModelRef = useRef<{ provider: string; model: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionMenuRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const draftRef = useRef('');
  const fileRefsRef = useRef<string[]>([]);
  const runningRef = useRef(false);
  // handleServerMessage is a stable []-callback, so the drain and refine
  // paths it triggers read live state through refs rather than closing over
  // a stale render.
  const refineStateRef = useRef<RefineState | null>(null);
  const prefsRef = useRef<SimplePrefs>(DEFAULT_PREFS);
  const queueRef = useRef<QueuedItem[]>([]);
  draftRef.current = draft;
  fileRefsRef.current = fileRefs;
  runningRef.current = running;
  refineStateRef.current = refineState;
  prefsRef.current = prefs;
  queueRef.current = queue;

  /** Send a message to the agent and reflect it locally. The single send
   *  path — the composer, the queue drain, and every refine decision all
   *  funnel through here. */
  const dispatchUserMessage = useCallback((content: string) => {
    const sessionId = sessionIdRef.current;
    if (!content || !sessionId) return;
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
    setMessages((current) => [...current, { id: messageId('user'), role: 'user', text: content }]);
    setRunning(true);
    setToolCalls([]);
    setActivity('Thinking');
    socketRef.current?.send('user_message', {
      sessionId,
      id: messageId('prompt'),
      content,
      timestamp: Date.now(),
    });
  }, []);

  /** Open the refine round-trip, or send straight through when refine is off. */
  const startSend = useCallback(
    (content: string) => {
      if (!prefsRef.current.enhanceEnabled) {
        dispatchUserMessage(content);
        return;
      }
      setRefineState({
        original: content,
        refined: content,
        english: content,
        status: 'refining',
      });
      socketRef.current?.send('model.refine', { text: content });
    },
    [dispatchUserMessage],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Theme persistence is best-effort in privacy-restricted browsers.
    }
  }, [theme]);

  useEffect(() => {
    if (!sessionMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!sessionMenuRef.current?.contains(event.target as Node)) setSessionMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSessionMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [sessionMenuOpen]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleGlobalKey = (event: KeyboardEvent) => {
      if (event.key === 'l' && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
        event.preventDefault();
        if (!runningRef.current && sessionIdRef.current) {
          socketRef.current?.send('session.new', { sessionId: sessionIdRef.current });
        }
        return;
      }
    };
    document.addEventListener('keydown', handleGlobalKey);
    return () => document.removeEventListener('keydown', handleGlobalKey);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => {
      setNotice((current) => (current?.id === notice.id ? null : current));
    }, 5_000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!copiedMessageId) return;
    const timer = setTimeout(() => setCopiedMessageId(null), 1_800);
    return () => clearTimeout(timer);
  }, [copiedMessageId]);

  const handleServerMessage = useCallback((message: ServerMessage) => {
    const payload = message.payload ?? {};
    worklists.applyMessage(message);
    const projectedNotice = projectStatusNotice(message);
    if (projectedNotice) {
      setNotice({ ...projectedNotice, id: messageId('notice') });
    }
    switch (message.type) {
      case 'session.start': {
        const id = typeof payload['sessionId'] === 'string' ? payload['sessionId'] : '';
        const provider = typeof payload['provider'] === 'string' ? payload['provider'] : '';
        const model = typeof payload['model'] === 'string' ? payload['model'] : '';
        const maxContext = finiteNumber(payload['maxContext']);
        const previousId = sessionIdRef.current;
        const switchedSession = Boolean(previousId && id && previousId !== id);
        const resetSessionState = switchedSession || payload['reset'] === true;
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
          projectName:
            typeof payload['projectName'] === 'string' ? payload['projectName'] : 'Project',
          cwd: typeof payload['cwd'] === 'string' ? payload['cwd'] : '',
          maxContext,
        });
        setModels((current) => ({
          ...current,
          [provider]: current[provider]?.some((item) => item.id === model)
            ? current[provider]
            : [{ id: model, name: model }, ...(current[provider] ?? [])].filter((item) => item.id),
        }));
        if (Array.isArray(payload['replayMessages'])) {
          setMessages(replayToMessages(payload['replayMessages']));
        } else if (resetSessionState) {
          setMessages([]);
        }
        if (!previousId || resetSessionState) {
          const agentSessions = parseAgentSessionReplays(payload['agentSessions']);
          setSubagents(
            agentSessions.map(({ subagentId, agentName, status, task }) => ({
              id: subagentId,
              name: agentName,
              status,
              task,
            })),
          );
          setAgentTranscripts(
            Object.fromEntries(
              agentSessions.map(({ subagentId, transcript }) => [subagentId, transcript]),
            ),
          );
        }
        if (!previousId || switchedSession) {
          const savedDraft = readComposerDraft(id);
          draftRef.current = savedDraft.text;
          fileRefsRef.current = savedDraft.fileRefs;
          setDraft(savedDraft.text);
          setFileRefs(savedDraft.fileRefs);
          setFileMention(null);
        } else if (payload['reset'] === true) {
          clearComposerDraft(id);
          draftRef.current = '';
          fileRefsRef.current = [];
          setDraft('');
          setFileRefs([]);
          setFileMention(null);
        }
        if (resetSessionState) {
          setPendingConfirm(null);
          setRunning(false);
          setActivity('');
          setToolCalls([]);
          setSelectedAgentId(LEADER_AGENT_ID);
        }
        setSessionMenuOpen(false);
        const replayUsage = payload['replayUsage'];
        const replayInput =
          replayUsage && typeof replayUsage === 'object'
            ? finiteNumber((replayUsage as Record<string, unknown>)['input'])
            : 0;
        setContext((current) => ({
          load: resetSessionState
            ? maxContext > 0
              ? replayInput / maxContext
              : 0
            : current.maxContext > 0
              ? current.load
              : maxContext > 0
                ? replayInput / maxContext
                : 0,
          tokens: resetSessionState ? replayInput : current.tokens || replayInput,
          maxContext: maxContext || current.maxContext,
        }));
        if (provider) socketRef.current?.send('provider.models', { providerId: provider });
        socketRef.current?.send('sessions.list', { sessionId: id, limit: 12 });
        break;
      }
      case 'sessions.list': {
        if (typeof payload['error'] !== 'string') {
          setSessions(parseSessionSummaries(payload['sessions']));
        }
        break;
      }
      case 'providers.saved': {
        const providers = Array.isArray(payload['providers']) ? payload['providers'] : [];
        for (const entry of providers) {
          if (!entry || typeof entry !== 'object') continue;
          const id = (entry as Record<string, unknown>)['id'];
          if (typeof id === 'string')
            socketRef.current?.send('provider.models', { providerId: id });
        }
        break;
      }
      case 'provider.catalog': {
        const providers = Array.isArray(payload['providers']) ? payload['providers'] : [];
        const labels: Record<string, string> = {};
        for (const entry of providers) {
          if (!entry || typeof entry !== 'object') continue;
          const item = entry as Record<string, unknown>;
          if (typeof item['id'] === 'string') {
            labels[item['id']] = typeof item['name'] === 'string' ? item['name'] : item['id'];
          }
        }
        setProviderLabels(labels);
        break;
      }
      case 'provider.models': {
        const provider = typeof payload['provider'] === 'string' ? payload['provider'] : '';
        const list = Array.isArray(payload['models'])
          ? payload['models'].flatMap((entry) => {
              if (!entry || typeof entry !== 'object') return [];
              const item = entry as Record<string, unknown>;
              if (typeof item['id'] !== 'string') return [];
              return [
                {
                  id: item['id'],
                  name: typeof item['name'] === 'string' ? item['name'] : item['id'],
                  contextWindow: finiteNumber(item['contextWindow']) || undefined,
                } satisfies ModelDescriptor,
              ];
            })
          : [];
        if (provider) {
          const active = activeModelRef.current;
          const nextList =
            active?.provider === provider && !list.some((item) => item.id === active.model)
              ? [{ id: active.model, name: active.model }, ...list]
              : list;
          setModels((current) => ({ ...current, [provider]: nextList }));
        }
        break;
      }
      case 'files.list': {
        const files = Array.isArray(payload['files'])
          ? payload['files'].filter((file): file is string => typeof file === 'string')
          : [];
        setFileMatches(files);
        setFilePickerIndex(0);
        setFileSearching(false);
        break;
      }
      case 'provider.thinking_delta': {
        const text = typeof payload['text'] === 'string' ? payload['text'] : '';
        if (!text) break;
        setRunning(true);
        setActivity('Thinking');
        setMessages((current) => {
          const last = current.at(-1);
          if (last?.role === 'thinking' && last.streaming) {
            return current.map((item, index) =>
              index === current.length - 1 ? { ...item, text: item.text + text } : item,
            );
          }
          return [
            ...current.map((item) =>
              item.streaming && item.role === 'thinking' ? { ...item, streaming: false } : item,
            ),
            { id: messageId('thinking'), role: 'thinking', text, streaming: true },
          ];
        });
        break;
      }
      case 'provider.text_delta': {
        const text = typeof payload['text'] === 'string' ? payload['text'] : '';
        if (!text) break;
        setRunning(true);
        setActivity('Responding');
        setMessages((current) => {
          const normalized = current.map((item) =>
            item.streaming && item.role === 'thinking' ? { ...item, streaming: false } : item,
          );
          const last = normalized.at(-1);
          if (last?.role === 'assistant' && last.streaming) {
            return normalized.map((item, index) =>
              index === normalized.length - 1 ? { ...item, text: item.text + text } : item,
            );
          }
          return [
            ...normalized,
            { id: messageId('assistant'), role: 'assistant', text, streaming: true },
          ];
        });
        break;
      }
      case 'provider.response': {
        const responseText = contentToText(payload['content']).trim();
        setMessages((current) => {
          const last = current.at(-1);
          if (last?.role === 'assistant' && last.streaming) {
            return current.map((item, index) =>
              index === current.length - 1 ? { ...item, streaming: false } : item,
            );
          }
          return responseText
            ? [...current, { id: messageId('assistant'), role: 'assistant', text: responseText }]
            : current;
        });
        setActivity('Working');
        break;
      }
      case 'provider.retry':
        setRunning(true);
        setActivity(
          `Retrying ${typeof payload['providerId'] === 'string' ? payload['providerId'] : 'provider'}`,
        );
        break;
      case 'provider.fallback': {
        const target =
          payload['to'] && typeof payload['to'] === 'object'
            ? (payload['to'] as Record<string, unknown>)
            : undefined;
        const fallbackModel = typeof target?.['model'] === 'string' ? target['model'] : '';
        setRunning(true);
        setActivity(fallbackModel ? `Fallback · ${fallbackModel}` : 'Switching fallback model');
        break;
      }
      case 'context.compacted':
        setActivity('Context compacted');
        break;
      case 'tool.loop_detected':
        setActivity('Stopping repeated tool loop');
        break;
      case 'iteration.started':
        setRunning(true);
        setActivity('Thinking');
        break;
      case 'tool.started': {
        const name = typeof payload['name'] === 'string' ? payload['name'] : 'tool';
        const id = typeof payload['id'] === 'string' ? payload['id'] : `${name}-${Date.now()}`;
        setRunning(true);
        setActivity(`Running ${name}`);
        setToolCalls((current) => [
          ...current,
          { id, name, input: payload['input'], status: 'running' },
        ]);
        break;
      }
      case 'tool.progress': {
        const event = payload['event'];
        const text =
          event && typeof event === 'object'
            ? (event as Record<string, unknown>)['text']
            : undefined;
        if (typeof text === 'string' && text.trim())
          setActivity(text.trim().split('\n')[0] ?? 'Working');
        break;
      }
      case 'tool.executed': {
        const execId = typeof payload['id'] === 'string' ? payload['id'] : '';
        const execName = typeof payload['name'] === 'string' ? payload['name'] : '';
        setActivity('Thinking');
        if (execId || execName) {
          setToolCalls((current) =>
            current.map((tc) => {
              if (
                (execId && tc.id === execId) ||
                (!execId && tc.name === execName && tc.status === 'running')
              ) {
                return {
                  ...tc,
                  status: payload['ok'] === false ? 'error' : 'done',
                  output: typeof payload['output'] === 'string' ? payload['output'] : undefined,
                  durationMs:
                    typeof payload['durationMs'] === 'number' ? payload['durationMs'] : undefined,
                  ok: payload['ok'] !== false,
                };
              }
              return tc;
            }),
          );
        }
        break;
      }
      case 'run.result': {
        setRunning(false);
        setActivity('');
        setMessages((current) =>
          current.map((item) => (item.streaming ? { ...item, streaming: false } : item)),
        );
        // Drain one held message per turn boundary, in arrival order. Queued
        // text is sent as written rather than through refine: the point of
        // queueing is to walk away, and a review panel would stall the drain.
        const { item, rest } = dequeueItem(queueRef.current);
        if (item) {
          queueRef.current = rest;
          setQueue(rest);
          dispatchUserMessage(item.text);
        }
        break;
      }
      case 'prefs.updated':
        // Snapshots may be partial (autonomy.switch broadcasts one key), so
        // merge onto the previous value rather than reparsing from defaults.
        setPrefs((current) => parsePrefs(payload, current));
        break;
      case 'modes.list': {
        const list = Array.isArray(payload['modes'])
          ? payload['modes'].flatMap((entry) => {
              if (!entry || typeof entry !== 'object') return [];
              const item = entry as Record<string, unknown>;
              if (typeof item['id'] !== 'string') return [];
              return [
                {
                  id: item['id'],
                  name: typeof item['name'] === 'string' ? item['name'] : item['id'],
                  description:
                    typeof item['description'] === 'string' ? item['description'] : undefined,
                } satisfies AgentMode,
              ];
            })
          : [];
        setModes(list);
        if (typeof payload['activeId'] === 'string') setActiveModeId(payload['activeId']);
        break;
      }
      case 'model.refine_result': {
        const current = refineStateRef.current;
        // A result with no open panel is a late arrival from a cancelled
        // round — dropping it is correct, sending it would be a surprise.
        if (!current) break;
        const action = projectRefineResult(payload, current);
        if (action.kind === 'retry') {
          setRefineState(action.state);
          socketRef.current?.send('model.refine', {
            text: action.state.original,
            timeoutMs: action.timeoutMs,
          });
          break;
        }
        if (action.kind === 'send') {
          setRefineState(null);
          dispatchUserMessage(action.text);
          break;
        }
        setRefineState(action.state);
        break;
      }
      case 'error': {
        const text = typeof payload['message'] === 'string' ? payload['message'] : 'Run failed';
        setRunning(false);
        setActivity('');
        setMessages((current) => [...current, { id: messageId('error'), role: 'system', text }]);
        // An errored turn is still a turn boundary — drain one held message so a
        // failure doesn't strand the queue forever (the `run.result` path drains
        // on success; without this, any error leaves queued messages unsent).
        const { item, rest } = dequeueItem(queueRef.current);
        if (item) {
          queueRef.current = rest;
          setQueue(rest);
          dispatchUserMessage(item.text);
        }
        break;
      }
      case 'ctx.pct': {
        const rawLoad = finiteNumber(payload['load']);
        setContext({
          load: rawLoad > 1 ? rawLoad / 100 : rawLoad,
          tokens: finiteNumber(payload['tokens']),
          maxContext: finiteNumber(payload['maxContext']),
        });
        break;
      }
      case 'ctx.max_context': {
        const maxContext = finiteNumber(payload['maxContext']);
        setContext((current) => ({ ...current, maxContext }));
        setSession((current) => (current ? { ...current, maxContext } : current));
        break;
      }
      case 'tool.confirm_needed':
        if (typeof payload['id'] === 'string') {
          setPendingConfirm({
            id: payload['id'],
            toolName: typeof payload['toolName'] === 'string' ? payload['toolName'] : 'tool',
            input: payload['input'],
            riskTier: typeof payload['riskTier'] === 'string' ? payload['riskTier'] : undefined,
          });
        }
        break;
      case 'coordinator.stats': {
        const statuses = Array.isArray(payload['subagentStatuses'])
          ? payload['subagentStatuses']
          : [];
        const snapshot = statuses.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return [];
          const item = entry as Record<string, unknown>;
          const id = typeof item['id'] === 'string' ? item['id'] : '';
          if (!id || id === LEADER_AGENT_ID) return [];
          return [
            {
              id,
              name: typeof item['name'] === 'string' ? item['name'] : id,
              status: typeof item['status'] === 'string' ? item['status'] : 'idle',
              task: typeof item['currentTask'] === 'string' ? item['currentTask'] : undefined,
            } satisfies SimpleSubagent,
          ];
        });
        setSubagents((current) => stampAgentUpdates(current, mergeSubagentSnapshot(current, snapshot)));
        break;
      }
      case 'subagent.event': {
        const id = typeof payload['subagentId'] === 'string' ? payload['subagentId'] : '';
        setSubagents((current) =>
          stampAgentUpdates(
            current,
            payload['kind'] === 'removed'
              ? current.map((agent) =>
                  agent.id === id ? { ...agent, status: 'stopped', task: undefined } : agent,
                )
              : updateSubagents(current, payload),
          ),
        );
        if (payload['kind'] === 'task_completed' && id) {
          const entry = projectCompletedAgentText(
            payload,
            messageId(`agent-${id}`),
            typeof payload['name'] === 'string' ? payload['name'] : id,
          );
          if (entry) {
            setAgentTranscripts((current) => ({
              ...current,
              [id]: appendAgentTranscriptEntry(current[id] ?? [], entry),
            }));
          }
        }
        break;
      }
      case 'agent.timeline.message': {
        const entry = projectAgentTimelineEntry(payload, messageId('agent-event'));
        if (!entry) break;
        setSubagents((current) => {
          if (current.some((agent) => agent.id === entry.subagentId)) return current;
          return [
            ...current,
            {
              id: entry.subagentId,
              name: entry.agentName,
              status: 'running',
            },
          ];
        });
        setAgentTranscripts((current) => ({
          ...current,
          [entry.subagentId]: appendAgentTranscriptEntry(current[entry.subagentId] ?? [], entry),
        }));
        break;
      }
      case 'agent.status_changed': {
        const id = typeof payload['subagentId'] === 'string' ? payload['subagentId'] : '';
        if (!id || id === LEADER_AGENT_ID) break;
        const agentName = typeof payload['agentName'] === 'string' ? payload['agentName'] : id;
        setSubagents((current) => {
          const exists = current.some((agent) => agent.id === id);
          const patch = {
            id,
            name: agentName,
            status: typeof payload['status'] === 'string' ? payload['status'] : 'idle',
            task: typeof payload['task'] === 'string' ? payload['task'] : undefined,
          } satisfies SimpleSubagent;
          return exists
            ? current.map((agent) => (agent.id === id ? { ...agent, ...patch } : agent))
            : [...current, patch];
        });
        break;
      }
    }
    // dispatchUserMessage is []-stable, so this stays identity-stable and the
    // socket effect below never reconnects on a re-render.
  }, [dispatchUserMessage, worklists]);

  useEffect(() => {
    const socket = new SimpleSocket({
      onMessage: handleServerMessage,
      onState: (state) => {
        setConnection(state);
        if (state === 'open') {
          socket.send('providers.saved');
          socket.send('providers.list');
          // The server owns preference truth; seed from it rather than
          // trusting whatever this tab last rendered.
          socket.send('prefs.get');
          socket.send('modes.list');
          if (sessionIdRef.current) {
            socket.send('sessions.list', { sessionId: sessionIdRef.current, limit: 12 });
          }
        } else {
          setSessionMenuOpen(false);
          setFileMention(null);
          setFileMatches([]);
          setFileSearching(false);
        }
      },
    });
    socketRef.current = socket;
    void socket.connect();
    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, [handleServerMessage]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !stickToBottomRef.current) return;
    const frame = requestAnimationFrame(() => {
      element.scrollTo({ top: element.scrollHeight, behavior: 'auto' });
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, activity, pendingConfirm]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(180, Math.max(48, element.scrollHeight))}px`;
  }, [draft]);

  useEffect(() => {
    if (!session?.id) return;
    const timer = setTimeout(() => {
      writeComposerDraft(session.id, { text: draft, fileRefs });
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, fileRefs, session?.id]);

  useEffect(() => {
    const flushDraft = () => {
      if (!sessionIdRef.current) return;
      writeComposerDraft(sessionIdRef.current, {
        text: draftRef.current,
        fileRefs: fileRefsRef.current,
      });
    };
    window.addEventListener('pagehide', flushDraft);
    return () => {
      window.removeEventListener('pagehide', flushDraft);
      flushDraft();
    };
  }, []);

  useEffect(() => {
    if (!fileMention) {
      setFileSearching(false);
      return;
    }
    setFileSearching(true);
    setFilePickerIndex(0);
    const timer = setTimeout(() => {
      socketRef.current?.send('files.list', { query: fileMention.query, limit: 12 });
    }, 80);
    return () => clearTimeout(timer);
  }, [fileMention]);

  const groupedModels = useMemo(
    () => Object.entries(models).filter(([, entries]) => entries.length > 0),
    [models],
  );
  const agentTabs = useMemo(() => buildAgentTabs(subagents, running), [running, subagents]);
  const { active: liveAgentTabs, finished: finishedAgentTabs } = useMemo(
    () => partitionAgentTabs(agentTabs),
    [agentTabs],
  );
  const activeAgentId = resolveSelectedAgentId(selectedAgentId, agentTabs);

  // Periodically prune idle/offline workers that have aged out so the strip and
  // dropdown don't accumulate agents no longer worth viewing.
  useEffect(() => {
    if (subagents.length === 0) return;
    const timer = setInterval(() => {
      setSubagents((current) => {
        const pruned = pruneAgents(current, Date.now());
        return pruned.length === current.length ? current : pruned;
      });
    }, 15_000);
    return () => clearInterval(timer);
  }, [subagents.length]);
  const leaderSelected = canComposeForAgent(activeAgentId);
  const currentSessionSummary = useMemo(
    () => sessions.find((item) => item.id === session?.id),
    [session?.id, sessions],
  );
  const currentSessionName = sessionDisplayName(currentSessionSummary, session?.id);
  const selectedModel = session ? `${session.provider}\t${session.model}` : '';
  const load = Math.max(0, Math.min(1, context.load));
  const latestAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role === 'assistant') return message.id;
    }
    return undefined;
  }, [messages]);

  const activeAgent = agentTabs.find((agent) => agent.id === activeAgentId) ?? agentTabs[0];
  const selectedToolCalls = useMemo(
    () =>
      leaderSelected
        ? toolCalls
        : agentTranscriptToToolCalls(agentTranscripts[activeAgentId] ?? []),
    [activeAgentId, agentTranscripts, leaderSelected, toolCalls],
  );

  const selectNextStep = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const copyAssistantMessage = async (id: string, text: string) => {
    if (await copyText(text)) {
      setCopiedMessageId(id);
      return;
    }
    setNotice({
      id: messageId('notice'),
      text: 'Could not copy response',
      tone: 'error',
    });
  };

  const jumpToLatest = () => {
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
    const element = scrollRef.current;
    if (!element) return;
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollTo({ top: element.scrollHeight, behavior: reducedMotion ? 'auto' : 'smooth' });
  };

  const selectFile = (path: string) => {
    if (!fileMention) return;
    const cursor = fileMention.start;
    setDraft((current) => removeFileMention(current, fileMention));
    setFileRefs((current) => (current.includes(path) ? current : [...current, path]));
    setFileMention(null);
    setFileMatches([]);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(cursor, cursor);
    });
  };

  const createSession = () => {
    if (running || !sessionIdRef.current) return;
    socketRef.current?.send('session.new', { sessionId: sessionIdRef.current });
    setSessionMenuOpen(false);
  };

  const resumeSession = (id: string) => {
    if (running || !sessionIdRef.current || id === sessionIdRef.current) return;
    socketRef.current?.send('session.resume', { sessionId: sessionIdRef.current, id });
    setSessionMenuOpen(false);
  };

  const submitWith = (mode: QueueMode) => {
    const content = composePromptWithFileReferences(draft, fileRefs);
    // The refine panel owns the pending text; a second submit would race it.
    if (!content || connection !== 'open' || !sessionIdRef.current || refineState) return;

    const plan = resolveSendPlan(mode, running);
    clearComposerDraft(sessionIdRef.current);
    draftRef.current = '';
    fileRefsRef.current = [];
    setDraft('');
    setFileRefs([]);
    setFileMention(null);

    if (plan === 'send') {
      startSend(content);
      return;
    }

    const item: QueuedItem = { id: messageId('queued'), text: content, mode, addedAt: Date.now() };
    if (plan === 'abort-then-enqueue-front') {
      // Stop the in-flight run, then let that run's run.result drain this
      // from the head of the queue. Sending inline here would race the very
      // run.result the abort triggers.
      socketRef.current?.send('abort', { sessionId: sessionIdRef.current });
      setQueue((current) => enqueueFront(current, item));
      setNotice({ id: messageId('notice'), text: 'Steering the run…', tone: 'info' });
      return;
    }
    setQueue((current) => enqueueItem(current, item));
    setNotice({
      id: messageId('notice'),
      text: mode === 'queue' ? 'Queued for after this run' : 'Added to the run',
      tone: 'info',
    });
  };

  const refineDecision = (decision: RefineDecision) => {
    const state = refineState;
    if (!state) return;
    const text = resolveRefineText(state, decision);
    setRefineState(null);
    if (text === null) {
      // `edit` hands the text back to the composer instead of sending.
      setDraft(state.original);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    dispatchUserMessage(text);
  };

  const refineRetry = () => {
    const state = refineState;
    if (!state) return;
    // A manual retry re-arms the one automatic post-timeout retry.
    setRefineState({
      ...state,
      status: 'refining',
      error: undefined,
      errorKind: undefined,
      retried: false,
    });
    socketRef.current?.send('model.refine', { text: state.original });
  };

  const refineRetryFallback = (ref: string) => {
    const state = refineState;
    if (!state) return;
    const target = parseFallbackRef(ref);
    if (!target) return;
    setRefineState({ ...state, status: 'refining', retried: true });
    socketRef.current?.send('model.refine', {
      text: state.original,
      timeoutMs: 180_000,
      provider: target.provider,
      model: target.model,
    });
  };

  const updatePrefs = (patch: Partial<SimplePrefs>) => {
    setPrefs((current) => ({ ...current, ...patch }));
    socketRef.current?.send('prefs.update', patch as Record<string, unknown>);
  };

  const switchAutonomy = (mode: AutonomyMode) => {
    setPrefs((current) => ({ ...current, autonomy: mode }));
    // Autonomy has its own route: prefs.update only writes meta, which the
    // running loop never reads.
    socketRef.current?.send('autonomy.switch', { mode });
  };

  const switchMode = (id: string) => {
    setActiveModeId(id);
    socketRef.current?.send('mode.switch', { id });
  };

  const decideConfirm = (decision: 'yes' | 'no' | 'always') => {
    if (!pendingConfirm) return;
    socketRef.current?.send('tool.confirm_result', {
      sessionId: sessionIdRef.current ?? undefined,
      id: pendingConfirm.id,
      decision,
    });
    setPendingConfirm(null);
  };

  const abort = () => {
    socketRef.current?.send('abort', { sessionId: sessionIdRef.current ?? undefined });
    setActivity('Stopping');
  };

  const requestWorklist = useCallback((view: WorklistView) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    socketRef.current?.send(view === 'todos' ? 'todos.get' : view === 'tasks' ? 'tasks.get' : 'plan.get', {
      sessionId,
    });
  }, []);

  const updateTodoStatus = useCallback((id: string, status: TodoStatus) => {
    const sessionId = sessionIdRef.current;
    if (sessionId) socketRef.current?.send('todo.update', { sessionId, id, status });
  }, []);

  const updateTaskStatus = useCallback((id: string, status: TaskStatus) => {
    const sessionId = sessionIdRef.current;
    if (sessionId) socketRef.current?.send('task.update', { sessionId, id, status });
  }, []);

  const updatePlanStatus = useCallback((target: string, status: PlanStatus) => {
    const sessionId = sessionIdRef.current;
    if (sessionId) socketRef.current?.send('plan.item.update', { sessionId, target, status });
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="project-block">
          <div className="brand-mark" aria-hidden="true">
            W
          </div>
          <div className="project-icon">
            <FolderCode size={17} />
          </div>
          <div className="project-copy" title={session?.cwd}>
            <strong>{session?.projectName ?? 'WrongStack'}</strong>
            <div className="session-switcher" ref={sessionMenuRef}>
              <button
                type="button"
                className="session-trigger"
                disabled={!session || running}
                aria-expanded={sessionMenuOpen}
                aria-haspopup="dialog"
                onClick={() => {
                  if (!sessionMenuOpen && sessionIdRef.current) {
                    socketRef.current?.send('sessions.list', {
                      sessionId: sessionIdRef.current,
                      limit: 12,
                    });
                  }
                  setSessionMenuOpen((open) => !open);
                }}
              >
                <History size={11} aria-hidden="true" />
                <span>{session ? currentSessionName : 'Connecting…'}</span>
                <ChevronDown size={11} aria-hidden="true" />
              </button>

              {sessionMenuOpen && (
                <section className="session-menu" role="dialog" aria-label="Recent sessions">
                  <div className="session-menu-heading">
                    <span>RECENT SESSIONS</span>
                    <button type="button" disabled={running} onClick={createSession}>
                      <Plus size={11} aria-hidden="true" />
                      NEW
                    </button>
                  </div>
                  <div className="session-menu-list">
                    {sessions.length === 0 ? (
                      <div className="session-menu-empty">No saved sessions yet</div>
                    ) : (
                      sessions.slice(0, 12).map((item) => {
                        const active = item.isCurrent || item.id === session?.id;
                        return (
                          <button
                            type="button"
                            className={active ? 'active' : undefined}
                            aria-current={active ? 'page' : undefined}
                            disabled={active || running}
                            key={item.id}
                            onClick={() => resumeSession(item.id)}
                          >
                            <span className="session-menu-main">
                              {active ? (
                                <Check size={12} aria-hidden="true" />
                              ) : (
                                <History size={12} aria-hidden="true" />
                              )}
                              <span className="session-menu-copy">
                                <b>{sessionDisplayName(item)}</b>
                                <small>
                                  {[item.provider, item.model].filter(Boolean).join(' · ')}
                                </small>
                              </span>
                            </span>
                            <time dateTime={item.startedAt}>
                              {relativeSessionTime(item.startedAt)}
                            </time>
                          </button>
                        );
                      })
                    )}
                  </div>
                </section>
              )}
            </div>
          </div>
        </div>

        <div className="model-control">
          <Bot size={15} aria-hidden="true" />
          <select
            aria-label="Model"
            value={selectedModel}
            disabled={!session || groupedModels.length === 0 || running}
            onChange={(event) => {
              const [provider = '', model = ''] = event.target.value.split('\t');
              if (!provider || !model) return;
              socketRef.current?.send('model.switch', { provider, model });
            }}
          >
            {groupedModels.length === 0 && <option value="">Loading models…</option>}
            {groupedModels.map(([provider, entries]) => (
              <optgroup key={provider} label={providerLabels[provider] ?? provider}>
                {entries.map((item) => (
                  <option key={`${provider}:${item.id}`} value={`${provider}\t${item.id}`}>
                    {item.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <ChevronDown size={14} className="select-chevron" aria-hidden="true" />
        </div>

        <div className="topbar-right">
            <button
            type="button"
            className="context-meter"
            title={`${context.tokens} / ${context.maxContext} tokens — Click to compact`}
            disabled={!session || running}
            onClick={() => {
              if (sessionIdRef.current) {
                socketRef.current?.send('context.compact', {
                  sessionId: sessionIdRef.current,
                  aggressive: false,
                });
                setActivity('Compacting context');
              }
            }}
          >
            <div className="context-copy">
              <span>CONTEXT</span>
              <strong>{Math.round(load * 100)}%</strong>
            </div>
            <div className="context-track">
              <span
                style={{
                  width: `${load * 100}%`,
                  background:
                    load > 0.9 ? 'var(--danger)' : load > 0.7 ? 'var(--warning)' : 'var(--accent)',
                }}
              />
            </div>
            <small>
              {compactTokens(context.tokens)} / {compactTokens(context.maxContext)}
            </small>
            <span className="context-compact-hint">COMPACT</span>
          </button>
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
            aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
            aria-expanded={settingsOpen}
            title="Settings"
          >
            <Settings size={15} />
          </button>
          <div className={`connection ${connection}`} title={`WebSocket: ${connection}`}>
            {connection === 'open' ? <Wifi size={15} /> : <WifiOff size={15} />}
            <span>{connection === 'open' ? 'LIVE' : connection.toUpperCase()}</span>
          </div>
        </div>
      </header>

      <section className="agent-strip" aria-label="Agent conversations">
        <div className="agent-strip-label">
          <Users size={14} aria-hidden="true" /> AGENTS
        </div>
        <div className="agent-list" role="tablist" aria-label="Agent conversations">
          {liveAgentTabs.map((agent, index) => {
            const selected = activeAgentId === agent.id;
            return (
              <button
                type="button"
                id={`agent-tab-${agent.id}`}
                className={`agent-item${selected ? ' active' : ''}`}
                role="tab"
                aria-selected={selected}
                aria-controls={`agent-panel-${agent.id}`}
                tabIndex={selected ? 0 : -1}
                key={agent.id}
                title={agent.task ?? `${agent.name} · ${agent.status}`}
                onClick={() => setSelectedAgentId(agent.id)}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                  event.preventDefault();
                  const direction = event.key === 'ArrowRight' ? 1 : -1;
                  const next =
                    liveAgentTabs[(index + direction + liveAgentTabs.length) % liveAgentTabs.length];
                  if (!next) return;
                  setSelectedAgentId(next.id);
                  requestAnimationFrame(() =>
                    document.getElementById(`agent-tab-${next.id}`)?.focus(),
                  );
                }}
              >
                <span className={`agent-dot ${agent.status}`} aria-hidden="true" />
                <strong>{agent.name}</strong>
                <span>{agent.status}</span>
                {agent.task && <small>{agent.task}</small>}
              </button>
            );
          })}
        </div>
        <FinishedAgentsMenu
          agents={finishedAgentTabs}
          activeAgentId={activeAgentId}
          onSelect={setSelectedAgentId}
        />
      </section>

      <ErrorBoundary>
        <main
          id="agent-panel-leader"
          className="chat-scroll"
          role="tabpanel"
          aria-labelledby="agent-tab-leader"
          hidden={!leaderSelected}
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            const nearBottom =
              element.scrollHeight - element.scrollTop - element.clientHeight <= 120;
            stickToBottomRef.current = nearBottom;
            setShowJumpToLatest(!nearBottom);
          }}
        >
          <ChatMessageList
            messages={messages}
            latestAssistantId={latestAssistantId}
            copiedMessageId={copiedMessageId}
            running={running}
            activity={activity}
            emptyState={
              <div className="empty-state">
                <Sparkles size={25} strokeWidth={1.5} />
                <span>READY IN</span>
                <h1>{session?.projectName ?? 'your project'}</h1>
                <p>Describe the job. WrongStack will handle the rest.</p>
              </div>
            }
            onCopyMessage={copyAssistantMessage}
            onSelectNextStep={selectNextStep}
          />
        </main>
        {agentTabs
          .filter((agent) => !agent.isLeader)
          .map((agent) => (
            <AgentChatPane
              key={agent.id}
              agentId={agent.id}
              agentName={agent.name}
              entries={agentTranscripts[agent.id] ?? []}
              running={agent.status === 'running' || agent.status === 'busy'}
              hidden={activeAgentId !== agent.id}
            />
          ))}
      </ErrorBoundary>

      <ToolSidebar
        agentId={activeAgentId}
        agentName={activeAgent?.name ?? activeAgentId}
        calls={selectedToolCalls}
        worklists={worklists}
        requestWorklist={requestWorklist}
        onTodoStatusChange={updateTodoStatus}
        onTaskStatusChange={updateTaskStatus}
        onPlanStatusChange={updatePlanStatus}
      />

      {leaderSelected && showJumpToLatest && (
        <button type="button" className="jump-to-latest" onClick={jumpToLatest}>
          <ArrowDown size={13} aria-hidden="true" />
          LATEST
        </button>
      )}

      {leaderSelected && (
        <ErrorBoundary>
          <footer className="composer-wrap">
            <Composer
              draft={draft}
              setDraft={setDraft}
              fileRefs={fileRefs}
              setFileRefs={setFileRefs}
              fileMention={fileMention}
              setFileMention={setFileMention}
              fileMatches={fileMatches}
              filePickerIndex={filePickerIndex}
              setFilePickerIndex={setFilePickerIndex}
              fileSearching={fileSearching}
              running={running}
              connection={connection}
              session={session}
              pendingConfirm={pendingConfirm}
              notice={notice}
              textareaRef={textareaRef}
              queue={queue}
              refineState={refineState}
              submitWith={submitWith}
              abort={abort}
              decideConfirm={decideConfirm}
              selectFile={selectFile}
              clearQueue={() => setQueue([])}
              removeQueued={(id) =>
                setQueue((current) =>
                  removeQueuedAt(
                    current,
                    current.findIndex((item) => item.id === id),
                  ),
                )
              }
              onRefineDecision={refineDecision}
              onRefineRetry={refineRetry}
              onRefineRetryFallback={refineRetryFallback}
            />
          </footer>
        </ErrorBoundary>
      )}

      <ErrorBoundary>
        <SettingsPanel
          open={settingsOpen}
          prefs={prefs}
          modes={modes}
          activeModeId={activeModeId}
          connection={connection}
          onClose={() => setSettingsOpen(false)}
          onAutonomyChange={switchAutonomy}
          onModeChange={switchMode}
          onPrefChange={updatePrefs}
        />
      </ErrorBoundary>
    </div>
  );
}
