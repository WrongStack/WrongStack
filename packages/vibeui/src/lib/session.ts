import {
  isFinalTurnStopReason,
  type Message,
  type ProtocolEnvelope,
  projectChatMessage,
  projectSessionMessage,
  projectSessionTimeline,
  projectToolMessage,
  reduceStreamActivity,
  type SessionMarker,
  type SessionToolMeta,
  type StreamActivity,
} from '@wrongstack/webui-protocol';
import { endsRun, isActiveAgent } from './agent-state';
import { type Artifact, parseArtifact } from './artifacts';
import { type AgentEntry, updateAgent } from './session-agents';
import { bounded, contentText, number, record, rows, text } from './session-coercion';
import { type FileNode, parseFileTree } from './workspace-model';

export { contentText, record, rows, text };

/**
 * Live entry ids use a monotonic counter so 500-message / 200-tool caps never repeat React keys or match stale assistant ids.
 */
let liveEntrySequence = 0;
const liveEntryId = (type: string): string => `${type}-${++liveEntrySequence}`;

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant' | 'thinking' | 'system';
  text: string;
  streaming?: boolean;
  final?: boolean;
  runtimeContext?: string[];
  delivery?: 'btw';
  autoEligible?: boolean;
  images?: { data: string; mediaType: string }[];
}
export interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  output: string;
  status: 'running' | 'done' | 'error' | 'interrupted';
}
export interface InputQuestion {
  id: string;
  prompt: string;
  kind: string;
  required: boolean;
  allowCustom: boolean;
  options: { id: string; label: string }[];
}
export interface InputRequest {
  id: string;
  title: string;
  questions: InputQuestion[];
}
export interface Confirmation {
  id: string;
  tool: string;
  input: string;
  deadlineAt: number;
}
export type { AgentEntry };
export interface SessionState {
  streamActivity?: StreamActivity | null;
  runOutcome: 'done' | 'aborted' | 'error' | null;
  id: string;
  project: string;
  appVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  cache: {
    readTokens: number;
    writeTokens: number;
    hitRatio: number;
    lastHitRatio: number | null;
    coverageTokens: number;
    capturedAt: number;
  } | null;
  usage: { input: number; output: number; total: number };
  cwd: string;
  provider: string;
  model: string;
  maxContext: number;
  tokens: number;
  load: number;
  running: boolean;
  messages: ChatEntry[];
  tools: ToolEntry[];
  sessions: { id: string; title: string; startedAt: string }[];
  models: Record<string, { id: string; name: string; contextWindow: number }[]>;
  providers: { id: string; name: string; configured: boolean; family: string; baseUrl: string }[];
  todos: { id: string; title: string; status: string }[];
  plan: { id: string; title: string; status: string }[];
  tasks: { id: string; title: string; status: string }[];
  files: { path: string; status: string; additions: number; deletions: number }[];
  matches: string[];
  diff: { path: string; oldText: string; newText: string; error: string } | null;
  agents: AgentEntry[];
  confirm: Confirmation | null;
  confirmQueue: Confirmation[];
  inputs: InputRequest[];
  notice: string;
  prefs: Record<string, unknown>;
  mode: string;
  modes: { id: string; name: string; description: string }[];
  effortLevels: string[] | undefined;
  effortSupported: boolean | undefined;
  projectEffort: string;
  runFailure: string;
  fileTree: FileNode[];
  treeLoading: boolean;
  treeLoaded: boolean;
  treeError: string;
  artifacts: Artifact[];
  preview: {
    requestId: string;
    artifact: Artifact;
    content: string;
    error: string;
    loading: boolean;
  } | null;
}

export const initialState = (): SessionState => ({
  streamActivity: null,
  id: '',
  project: '',
  appVersion: '',
  latestVersion: '',
  updateAvailable: false,
  cache: null,
  usage: { input: 0, output: 0, total: 0 },
  cwd: '',
  provider: '',
  model: '',
  maxContext: 0,
  tokens: 0,
  load: 0,
  running: false,
  runOutcome: null,
  messages: [],
  tools: [],
  sessions: [],
  models: {},
  providers: [],
  todos: [],
  plan: [],
  tasks: [],
  files: [],
  matches: [],
  diff: null,
  agents: [],
  confirm: null,
  confirmQueue: [],
  inputs: [],
  notice: '',
  prefs: {},
  mode: '',
  modes: [],
  effortLevels: undefined,
  effortSupported: undefined,
  projectEffort: '',
  runFailure: '',
  fileTree: [],
  treeLoading: false,
  treeLoaded: false,
  treeError: '',
  artifacts: [],
  preview: null,
});

function appendDelta(
  messages: ChatEntry[],
  role: ChatEntry['role'],
  delta: string,
  id: string,
): ChatEntry[] {
  const index = conversationTail(messages);
  const last = messages[index];
  if (last?.role === role && last.streaming)
    return [
      ...messages.slice(0, index),
      { ...last, text: bounded(last.text + delta) },
      ...messages.slice(index + 1),
    ];
  return [
    ...messages.map((entry) => ({ ...entry, streaming: false })),
    { id, role, text: bounded(delta), streaming: true },
  ].slice(-500);
}
function conversationTail(messages: ChatEntry[]): number {
  let index = messages.length - 1;
  while (index >= 0 && messages[index]?.delivery === 'btw') index--;
  return index;
}

/** All views derive from the canonical wire projections, including historical tool ordering. */
export function reduceFrame(state: SessionState, frame: ProtocolEnvelope): SessionState {
  const p = record(frame.payload);
  if (
    frame.type !== 'session.start' &&
    typeof p.sessionId === 'string' &&
    state.id &&
    p.sessionId !== state.id
  )
    return state;
  const streamActivity = reduceStreamActivity(state.streamActivity ?? null, frame);
  if (streamActivity !== state.streamActivity) state = { ...state, streamActivity };
  const session = projectSessionMessage(frame);
  if (session?.id) {
    const changed = state.id !== session.id || session.reset;
    const timeline = session.replayMessages
      ? projectSessionTimeline({
          messages: session.replayMessages.filter((m): m is Message =>
            ['user', 'assistant', 'system'].includes(text(record(m).role)),
          ),
          markers: (session.replayMarkers ?? []) as SessionMarker[],
          toolMeta: (session.replayToolMeta ?? []) as SessionToolMeta[],
          thinkingPlacement: 'inline',
          textSeparator: '\n\n',
          runtimeContextEntries: true,
        })
      : null;
    const messages: ChatEntry[] = [];
    const tools: ToolEntry[] = [];
    for (const [index, entry] of (timeline ?? []).entries()) {
      if (entry.kind === 'tool') {
        tools.push({
          id: entry.toolUseId || `replay-tool-${index}`,
          name: entry.name,
          input: entry.input,
          output: entry.output ?? '',
          status: entry.ok === undefined ? 'running' : entry.ok ? 'done' : 'error',
        });
      } else {
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
    }
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
      messages: timeline ? messages.slice(-500) : changed ? [] : state.messages,
      tools: timeline ? tools.slice(-200) : changed ? [] : state.tools,
      ...(changed
        ? {
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
          }
        : {}),
    };
    if (!Array.isArray(p.agentSessions)) return started;
    return rows(p.agentSessions).reduce<SessionState>(
      (s, agent) => {
        let next = updateAgent(s, agent, 'agent.status_changed');
        for (const entry of rows(agent.transcript).slice(-100))
          next = updateAgent(
            next,
            { ...entry, subagentId: agent.subagentId },
            'agent.timeline.message',
          );
        return next;
      },
      { ...started, agents: [] },
    );
  }
  const chat = projectChatMessage(frame);
  const id = liveEntryId(frame.type);
  if (chat?.kind === 'text-delta' || chat?.kind === 'thinking-delta')
    return {
      ...state,
      running: true,
      runOutcome: null,
      messages: appendDelta(
        state.messages,
        chat.kind === 'text-delta' ? 'assistant' : 'thinking',
        chat.text,
        id,
      ),
    };
  if (chat?.kind === 'response') {
    const response = bounded(contentText(chat.content));
    const lastIndex = conversationTail(state.messages);
    const last = state.messages[lastIndex];
    const finalized = state.messages.map((entry) =>
      entry.streaming ? { ...entry, streaming: false } : entry,
    );
    return {
      ...state,
      messages:
        last?.role === 'assistant' && last.streaming
          ? [
              ...finalized.slice(0, lastIndex),
              {
                ...last,
                text: response || last.text,
                streaming: false,
                final: isFinalTurnStopReason(chat.stopReason),
              },
              ...finalized.slice(lastIndex + 1),
            ]
          : response
            ? ([
                ...finalized,
                {
                  id,
                  role: 'assistant',
                  text: response,
                  streaming: false,
                  final: isFinalTurnStopReason(chat.stopReason),
                },
              ].slice(-500) as ChatEntry[])
            : finalized,
    };
  }
  if (chat?.kind === 'run-result' || (chat?.kind === 'error' && endsRun(p.phase))) {
    const failure =
      chat.kind === 'error'
        ? chat.message
        : chat.status === 'done'
          ? ''
          : chat.status === 'aborted'
            ? 'Run stopped. Queued messages are paused.'
            : 'Run did not complete. Review the result before continuing.';
    const tailIndex = conversationTail(state.messages);
    const prevTail = state.messages[tailIndex];
    const messages = state.messages.map((m, idx) =>
      chat.kind === 'run-result' && idx === tailIndex && m.role === 'assistant' && m.streaming
        ? {
            ...m,
            ...(chat.finalText ? { text: bounded(chat.finalText) } : {}),
            streaming: false,
            final: chat.status === 'done',
          }
        : { ...m, streaming: false },
    );
    if (chat.kind === 'error')
      messages.push({ id, role: 'system', text: chat.message, streaming: false });
    if (
      chat.kind === 'run-result' &&
      chat.finalText &&
      (prevTail?.role !== 'assistant' ||
        (!prevTail.streaming &&
          prevTail.final === false &&
          prevTail.text !== bounded(chat.finalText)))
    )
      messages.push({
        id,
        role: 'assistant',
        text: bounded(chat.finalText),
        streaming: false,
        final: chat.status === 'done',
      });
    if (chat.kind === 'run-result' && chat.status === 'done') {
      const tail = messages[conversationTail(messages)];
      if (tail?.role === 'assistant' && tail.final === true) tail.autoEligible = true;
    }
    return {
      ...state,
      running: false,
      runOutcome:
        chat.kind === 'run-result'
          ? chat.status === 'done'
            ? 'done'
            : chat.status === 'aborted'
              ? 'aborted'
              : 'error'
          : state.running
            ? 'error'
            : state.runOutcome,
      messages: messages.slice(-500),
      tools: state.tools.map((t) => (t.status === 'running' ? { ...t, status: 'interrupted' } : t)),
      notice: failure || state.notice,
      runFailure: failure,
    };
  }
  const tool = projectToolMessage(frame);
  if (tool) {
    const artifact =
      tool.kind === 'executed' && tool.ok && tool.output
        ? parseArtifact(tool.output, state.id)
        : null;
    const existing = state.tools.find((t) => t.id === tool.id);
    const next: ToolEntry =
      tool.kind === 'started'
        ? { id: tool.id, name: tool.name, input: tool.input, output: '', status: 'running' }
        : {
            id: tool.id,
            name: tool.name || existing?.name || 'tool',
            input: existing?.input,
            output: bounded(
              tool.kind === 'progress'
                ? (existing?.output ?? '') + tool.text
                : (tool.output ?? existing?.output ?? ''),
            ),
            status: tool.kind === 'executed' ? (tool.ok ? 'done' : 'error') : 'running',
          };
    return {
      ...state,
      tools: [...state.tools.filter((t) => t.id !== tool.id), next].slice(-200),
      ...(artifact
        ? {
            artifacts: [...state.artifacts.filter((a) => a.id !== artifact.id), artifact].slice(
              -30,
            ),
          }
        : {}),
    };
  }
  switch (frame.type) {
    case 'files.tree':
      return {
        ...state,
        fileTree: parseFileTree(p.tree),
        treeLoading: false,
        treeLoaded: true,
        treeError: text(p.error),
      };
    case 'files.read':
    case 'files.image': {
      const preview = state.preview;
      if (!preview || p.requestId !== preview.requestId || p.filePath !== preview.artifact.path)
        return state;
      const content = text(frame.type === 'files.image' ? p.dataUrl : p.content);
      const error =
        text(p.error) ||
        (p.binary || p.tooLarge || p.notImage ? 'Preview unavailable for this file.' : '');
      const invalidImage =
        frame.type === 'files.image' &&
        !/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z\d+/=]+$/i.test(content);
      return {
        ...state,
        preview: {
          ...preview,
          content: frame.type === 'files.image' ? content : bounded(content),
          error: error || (invalidImage ? 'Image preview unavailable.' : ''),
          loading: false,
        },
      };
    }
    case 'sessions.list':
      return {
        ...state,
        sessions: rows(p.sessions)
          .filter((s) => text(s.id))
          .map((s) => ({
            id: text(s.id),
            title: text(s.name) || text(s.title) || 'Untitled session',
            startedAt: text(s.startedAt),
          })),
      };
    case 'modes.list':
      return {
        ...state,
        mode: text(p.activeId) || state.mode,
        modes: rows(p.modes)
          .filter((m) => text(m.id))
          .map((m) => ({
            id: text(m.id),
            name: text(m.name) || text(m.id),
            description: text(m.description),
          })),
      };
    case 'mode.switched':
      return { ...state, mode: text(p.id) || text(p.mode) || state.mode };
    case 'context.compacted':
      return {
        ...state,
        notice: `Context compacted: ${number(p.before).toLocaleString()} → ${number(p.after).toLocaleString()} tokens.`,
        tokens: number(p.after),
        load: state.maxContext > 0 ? number(p.after) / state.maxContext : 0,
      };
    case 'provider.catalog':
      return {
        ...state,
        providers: rows(p.providers).map((v) => ({
          id: text(v.id),
          name: text(v.name) || text(v.id),
          configured: v.hasApiKey === true,
          family: text(v.family),
          baseUrl: text(v.apiBase),
        })),
      };
    case 'provider.models':
      return {
        ...state,
        models: {
          ...state.models,
          [text(p.provider)]: rows(p.models)
            .filter((m) => text(m.id))
            .map((m) => ({
              id: text(m.id),
              name: text(m.name) || text(m.id),
              contextWindow: number(m.contextWindow),
            })),
        },
      };
    case 'provider.model_switched':
    case 'model.switch_result': {
      const target = frame.type === 'provider.model_switched' ? record(p.to) : p;
      if (p.success === false)
        return { ...state, notice: text(p.message) || 'Model switch failed.' };
      return {
        ...state,
        provider: text(target.provider) || state.provider,
        model: text(target.model) || state.model,
      };
    }
    case 'ctx.pct':
      return {
        ...state,
        load: Math.max(0, number(p.load)),
        tokens: number(p.tokens),
        maxContext: number(p.maxContext) || state.maxContext,
      };
    case 'ctx.max_context':
      return { ...state, maxContext: number(p.maxContext) };
    case 'iteration.started':
      return { ...state, running: true, runOutcome: null };
    case 'session.run_state':
      return {
        ...state,
        running: p.isRunning === true,
        runOutcome: p.isRunning === true ? null : state.runOutcome,
      };
    case 'provider.retry':
      return {
        ...state,
        messages: state.messages.filter((m) => !m.streaming),
        notice: 'The provider is retrying the response.',
      };
    case 'prefs.updated':
      return { ...state, prefs: { ...state.prefs, ...p } };
    case 'stats.get': {
      const usage = record(p.usage);
      const next = {
        ...state,
        usage: {
          input: number(usage.input),
          output: number(usage.output),
          total: number(usage.total),
        },
      };
      if (!p.cache || typeof p.cache !== 'object') return next;
      const cache = record(p.cache);
      return {
        ...next,
        cache: {
          readTokens: number(cache.readTokens),
          writeTokens: number(cache.writeTokens),
          hitRatio: Math.max(0, Math.min(1, number(cache.hitRatio))),
          lastHitRatio:
            typeof record(cache.last).hitRatio === 'number'
              ? Math.max(0, Math.min(1, number(record(cache.last).hitRatio)))
              : null,
          coverageTokens: Math.max(
            0,
            Math.min(state.tokens, number(record(p.currentRequest).cacheRead)),
          ),
          capturedAt: Date.now(),
        },
      };
    }
    case 'key.operation_result':
      return {
        ...state,
        notice:
          text(p.message) ||
          (p.success ? 'Provider connected.' : 'Provider could not be connected.'),
      };
    case 'files.list':
      return {
        ...state,
        matches: Array.isArray(p.files)
          ? p.files.filter((v): v is string => typeof v === 'string').slice(0, 30)
          : [],
      };
    case 'git.changes':
      return {
        ...state,
        files: rows(p.files).map((f) => ({
          path: text(f.path),
          status: text(f.status),
          additions: number(f.added),
          deletions: number(f.deleted),
        })),
        notice: text(p.error) || state.notice,
      };
    case 'git.diff':
      return {
        ...state,
        diff: {
          path: text(p.path),
          oldText: text(p.oldText),
          newText: text(p.newText),
          error:
            text(p.error) ||
            (p.binary
              ? 'Binary file — preview unavailable.'
              : p.tooLarge
                ? 'File exceeds the preview limit.'
                : ''),
        },
      };
    case 'todos.updated':
      return {
        ...state,
        todos: rows(p.todos).map((t) => ({
          id: text(t.id),
          title: text(t.content),
          status: text(t.status),
        })),
      };
    case 'todos.cleared':
      return { ...state, todos: [] };
    case 'tasks.updated':
      return {
        ...state,
        tasks: rows(p.tasks).map((t) => ({
          id: text(t.id),
          title: text(t.title),
          status: text(t.status),
        })),
      };
    case 'plan.updated': {
      const plan = record(p.plan);
      return {
        ...state,
        plan: rows(Array.isArray(p.plan) ? p.plan : plan.items).map((t) => ({
          id: text(t.id),
          title: text(t.title),
          status: text(t.status),
        })),
      };
    }
    case 'agent.status_changed':
    case 'subagent.event':
    case 'agent.timeline.message':
      return updateAgent(state, p, frame.type);
    case 'coordinator.stats':
      return rows(p.subagentStatuses).reduce(
        (s, agent) =>
          updateAgent(
            s,
            {
              ...agent,
              subagentId: agent.id,
              agentName: agent.name,
              description: s.agents.find((item) => item.id === agent.id)?.task || agent.currentTask,
            },
            'agent.status_changed',
          ),
        state,
      );
    case 'sessions.status_update': {
      const own = rows(p.sessions).find((s) => s.sessionId === state.id);
      if (!own || !Array.isArray(own.agents)) return state;
      const ids = new Set(rows(own.agents).map((agent) => text(agent.id)));
      const reconciled: SessionState = {
        ...state,
        agents: state.agents.map((agent) =>
          isActiveAgent(agent.status) && !ids.has(agent.id)
            ? { ...agent, status: 'stopped', currentTool: '' }
            : agent,
        ),
      };
      return rows(own.agents).reduce<SessionState>(
        (s, agent) =>
          updateAgent(
            s,
            {
              ...agent,
              subagentId: agent.id,
              agentName: agent.name,
              description: text(agent.currentTask),
              partialText: agent.partialText,
            },
            'agent.status_changed',
          ),
        reconciled,
      );
    }
    case 'tool.confirm_needed': {
      const confirm = {
        id: text(p.id),
        tool: text(p.toolName),
        input: JSON.stringify(p.input, null, 2) ?? '',
        deadlineAt: number(p.deadlineAt),
      };
      if (!confirm.id) return state;
      if (!state.confirm || state.confirm.id === confirm.id) return { ...state, confirm };
      return {
        ...state,
        confirmQueue: [...state.confirmQueue.filter((c) => c.id !== confirm.id), confirm].slice(
          -50,
        ),
      };
    }
    case 'tool.confirm_resolved':
      return resolveConfirmation(state, text(p.id));
    case 'user.input_requested': {
      const r = record(p.request);
      if (!text(r.id) || state.inputs.some((i) => i.id === r.id)) return state;
      const questions = rows(r.tabs)
        .flatMap((tab) => rows(tab.questions))
        .map((q) => ({
          id: text(q.id),
          prompt: text(q.prompt),
          kind: text(q.kind),
          required: q.required === true,
          allowCustom: q.allowCustomResponse !== false || q.kind === 'text',
          options: rows(q.options).map((o) => ({ id: text(o.id), label: text(o.label) })),
        }));
      return {
        ...state,
        inputs: [...state.inputs, { id: text(r.id), title: text(r.title), questions }],
      };
    }
    case 'user.input_resolved':
      return { ...state, inputs: state.inputs.filter((r) => r.id !== p.requestId) };
    case 'chimera.report_available': {
      const reportSessionId = text(p.sessionId);
      if (reportSessionId && state.id && reportSessionId !== state.id) return state;
      if (p.hasActionableFindings === false) return state;
      return {
        ...state,
        notice: text(p.message) || 'A review report is ready. Open WebUI to inspect it.',
      };
    }
    default: // An `error` outside a run phase refused another request; the run goes on.
      return chat?.kind === 'error' ? { ...state, notice: chat.message } : state;
  }
}

export function draftKey(sessionId: string): string {
  return `wrongstack.vibeui.draft.v1:${sessionId}`;
}

/**
 * Drops approval prompts when the connection ends. The server re-sends every
 * still-pending `tool.confirm_needed` to each new socket, so the live ones
 * come back immediately after a reconnect while prompts the server already
 * resolved or timed out no longer linger on screen.
 *
 * Input requests are kept: the server does not re-send them, so clearing one
 * would lose a question that is still waiting; a stale one can be cancelled.
 */
export function dropConnectionScopedPrompts(state: SessionState): SessionState {
  if (!state.confirm && !state.confirmQueue.length) return state;
  return { ...state, confirm: null, confirmQueue: [] };
}

export function resolveConfirmation(state: SessionState, id: string): SessionState {
  return state.confirm?.id === id
    ? {
        ...state,
        confirm: state.confirmQueue[0] ?? null,
        confirmQueue: state.confirmQueue.slice(1),
      }
    : { ...state, confirmQueue: state.confirmQueue.filter((c) => c.id !== id) };
}
export function composeMessage(draft: string, references: string[]): string {
  return [draft.trim(), ...[...new Set(references)].map((path) => `@${path}`)]
    .filter(Boolean)
    .join('\n');
}
