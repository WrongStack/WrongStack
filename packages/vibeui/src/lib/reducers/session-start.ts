import {
  type Message,
  projectSessionTimeline,
  type SessionMarker,
  type SessionProjection,
  type SessionToolMeta,
} from '@wrongstack/webui-protocol';
import { bounded, number, record, rows, text } from '../session-coercion';
import {
  type ChatEntry,
  MAX_MESSAGES,
  MAX_TOOLS,
  type SessionState,
  type ToolEntry,
} from '../session-state';
import { replayAgentSessions } from './agents';

/** Session-scoped fields cleared when the browser lands on a different (or reset) session. */
const sessionReset = (): Partial<SessionState> => ({
  todos: [],
  plan: [],
  tasks: [],
  agents: [],
  confirm: null,
  confirmQueue: [],
  inputs: [],
  diff: null,
  artifacts: [],
  preview: null,
  notice: '',
  runFailure: '',
  fileTree: [],
  treeLoaded: false,
  treeLoading: false,
  treeError: '',
  prefs: {},
  cache: null,
  usage: { input: 0, output: 0, total: 0 },
  modes: [],
});

/** Projects replayed history through the shared timeline so tool ordering matches every surface. */
function replayTimeline(session: SessionProjection): {
  messages: ChatEntry[];
  tools: ToolEntry[];
} | null {
  if (!session.replayMessages) return null;
  const timeline = projectSessionTimeline({
    messages: session.replayMessages.filter((m): m is Message =>
      ['user', 'assistant', 'system'].includes(text(record(m).role)),
    ),
    markers: (session.replayMarkers ?? []) as SessionMarker[],
    toolMeta: (session.replayToolMeta ?? []) as SessionToolMeta[],
    thinkingPlacement: 'inline',
    textSeparator: '\n\n',
    runtimeContextEntries: true,
  });
  const messages: ChatEntry[] = [];
  const tools: ToolEntry[] = [];
  for (const [index, entry] of timeline.entries()) {
    if (entry.kind === 'tool') {
      tools.push({
        id: entry.toolUseId || `replay-tool-${index}`,
        name: entry.name,
        input: entry.input,
        output: entry.output ?? '',
        status: entry.ok === undefined ? 'running' : entry.ok ? 'done' : 'error',
      });
      continue;
    }
    messages.push({
      id: `replay-${index}`,
      role: entry.kind === 'marker' ? 'system' : entry.kind,
      text: bounded(entry.text),
      ...(entry.runtimeContext?.length
        ? { runtimeContext: entry.runtimeContext.map(bounded) }
        : {}),
      ...(entry.kind === 'assistant' ? { final: entry.final } : {}),
      ...(entry.kind === 'user' && entry.images
        ? {
            images: entry.images.flatMap((image) =>
              image.data && image.mediaType
                ? [{ data: image.data, mediaType: image.mediaType }]
                : [],
            ),
          }
        : {}),
    });
  }
  return { messages, tools };
}

/**
 * session.start: adopts the session identity and runtime, replaces history
 * when a replay is supplied, clears session-scoped state on a switch or reset,
 * and rebuilds the agent list from the canonical snapshot when one is sent.
 */
export function reduceSessionStart(
  state: SessionState,
  session: SessionProjection,
  p: Record<string, unknown>,
): SessionState {
  const changed = state.id !== session.id || session.reset;
  const replay = replayTimeline(session);
  const started: SessionState = {
    ...state,
    id: session.id,
    project: session.projectName,
    appVersion: text(p.appVersion) || state.appVersion,
    latestVersion: text(p.latestVersion) || state.latestVersion,
    updateAvailable: p.updateAvailable === true,
    cwd: session.cwd,
    provider: session.provider,
    model: session.model,
    mode: text(p.mode),
    effortLevels: Array.isArray(p.reasoningEffortLevels)
      ? p.reasoningEffortLevels.filter((v): v is string => typeof v === 'string')
      : undefined,
    effortSupported: typeof p.effortSupported === 'boolean' ? p.effortSupported : undefined,
    projectEffort: text(p.projectReasoningEffort),
    maxContext: session.maxContext,
    running: session.isRunning,
    runOutcome: session.isRunning || changed ? null : state.runOutcome,
    tokens: number(p.lastInputTokens),
    load: session.maxContext > 0 ? number(p.lastInputTokens) / session.maxContext : 0,
    messages: replay ? replay.messages.slice(-MAX_MESSAGES) : changed ? [] : state.messages,
    tools: replay ? replay.tools.slice(-MAX_TOOLS) : changed ? [] : state.tools,
    ...(changed ? sessionReset() : {}),
  };
  if (!Array.isArray(p.agentSessions)) return started;
  return replayAgentSessions(started, rows(p.agentSessions));
}
