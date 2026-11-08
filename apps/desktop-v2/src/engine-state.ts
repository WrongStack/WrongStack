import type { UserInputRequest } from '@wrongstack/contracts/types';
import type { WorktreeTimelineEvent } from '@wrongstack/contracts/types/worktree-timeline';
import { stripNextStepsBlock } from '@wrongstack/core/utils/next-steps';
import {
  type CouncilLog,
  councilDecisionText,
  EMPTY_COUNCIL_LOG,
} from '@wrongstack/project-surfaces/council/panels';
import type { CouncilDecisionData } from '@wrongstack/project-surfaces/council/types';
import {
  applyFleetEvent,
  EMPTY_FLEET_FOLD,
  type FleetFold,
} from '@wrongstack/project-surfaces/office/fleet-fold';
import type { SubagentEvent } from '@wrongstack/project-surfaces/office/fleet-transcript';
import {
  type ParsedNextStep,
  parseNextSteps,
  projectNextStepsToolInput,
} from '@wrongstack/webui-protocol';
import {
  type AgentTranscripts,
  hydrateAgentTranscripts,
  reduceAgentTranscripts,
} from './agent-transcripts';
import { type ComposerAttachment, transcriptAttachments } from './composer-attachments.js';
import {
  type ContextUsage,
  emptyContextUsage,
  reduceContextUsage,
  type TokenTotals,
  type TurnStats,
  turnStats,
} from './context-usage.js';
import {
  appendNotice,
  type ConversationNotice,
  conversationNotice,
} from './conversation-notices.js';
import { reduceCouncil } from './council-decisions.js';
import { appendDelegation, type DelegationRecord, delegationRecord } from './delegations.js';
import { contentText, entries, record } from './engine-values.js';
import { parseInputRequest } from './input-form-model.js';
import {
  appendMemoryRun,
  type MemoryContext,
  type MemoryInjectorRun,
  memoryContextSnapshot,
  memoryInjectorRun,
} from './memory-injections.js';
import { emptyMemoryReviews, foldMemoryReviews, type MemoryReviews } from './memory-reviews.js';
import { reduceWaitingRoom, type WaitingRoom } from './provider-waiting.js';
import { appendRunEvent, isRunTimelineEvent } from './run-timeline.js';
import { reduceWorktreeEvents } from './worktree-history.js';

export { contentText, entries, record } from './engine-values.js';
export interface EngineEvent {
  type: string;
  payload: Record<string, unknown>;
  /** When the desktop received the frame (epoch ms); token deltas and older journals have none. */
  at?: number;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** When it was written, from the frame that added it (epoch ms); unknown in older journals. */
  at?: number;
  attachments?: ComposerAttachment[];
  streamId?: string;
  /** Work that happened after this message, before the next message began. */
  activityAfter?: EngineEvent[];
  /** A Brain council's decision, drawn as the WebUI's council card. */
  council?: CouncilDecisionData;
}
export interface ProviderTestRun {
  id: string;
  provider: string;
  total: number;
  results: Record<string, Record<string, unknown>>;
  complete: Record<string, unknown> | null;
}
export interface EngineState {
  hydrating: boolean;
  /** False until a reader first reaches the end of the journal; views wait for it. */
  synced: boolean;
  pendingUserMessages: Record<string, ChatMessage>;
  queue: Array<{ id: string; text: string; addedAt: number; imageCount: number }>;
  drainedPromptIds: string[];
  assists: Record<
    string,
    {
      text: string;
      status: string;
      error?: string;
      appliedEdits?: boolean;
      /** Files the engine captured before an editing run wrote them (null = created). */
      edits?: { path: string; before: string | null }[];
      /** Tools or files whose changes the engine could not capture. */
      uncaptured?: string[];
    }
  >;
  sessionId: string;
  provider: string;
  model: string;
  connected: boolean;
  running: boolean;
  needsSetup: boolean;
  messages: ChatMessage[];
  /** Work before the first visible message (e.g. a resumed engine-only run). */
  leadingActivity: EngineEvent[];
  /** Only this message may still receive text deltas from the current response. */
  activeTextMessageId: string | null;
  approvals: Record<string, unknown>[];
  inputs: UserInputRequest[];
  providerTests: Record<string, ProviderTestRun>;
  goalStates: Record<string, Record<string, unknown>>;
  goalErrors: Record<string, Record<string, unknown>>;
  sddInterviewId: string;
  sddAgentText: string;
  specDetails: Record<string, Record<string, unknown>>;
  activity: EngineEvent[];
  /** How full the conversation's context window is. */
  context: ContextUsage;
  /** The running turn's tool calls, thinking and retries, every one of them, oldest first. */
  runTimeline: EngineEvent[];
  /** Each finished turn's tool events, by the id of the assistant message that ended it. */
  turnActivity: Record<string, EngineEvent[]>;
  /** Each finished turn's iterations and token use, by the id of its answer. */
  turnStats: Record<string, TurnStats>;
  /** Session token totals when the running turn started. */
  runStartTotals: TokenTotals | null;
  /** When the running turn's first iteration started (frame time), for its duration. */
  runStartAt: number | null;
  /** This conversation's SAGE injector runs, newest last, and the latest request's memories. */
  memoryRuns: MemoryInjectorRun[];
  memoryContext: MemoryContext | null;
  /** The latest validity check and companion review of each memory, from every conversation. */
  memoryReviews: MemoryReviews;
  /** Engine reports about this conversation that need the user's attention, newest last. */
  notices: ConversationNotice[];
  /** Notices seen, so each gets a distinct id after older ones fall out of the list. */
  noticeCount: number;
  /** Worker delegations this conversation finished, as the engine reported them. */
  delegations: DelegationRecord[];
  /** This conversation's Brain council panels, folded from `brain.event` frames. */
  council: CouncilLog;
  /** This conversation's subagent fleet, folded from `subagent.event` frames as the WebUI does. */
  fleet: FleetFold;
  nextSteps: ParsedNextStep[];
  /** The engine's worktree lifecycle log, oldest first, for the worktree timeline. */
  worktreeEvents: WorktreeTimelineEvent[];
  results: Record<string, Record<string, unknown>>;
  error: string;
  /** The latest frame time seen, for messages a token delta starts. */
  lastAt: number;
  /** Each subagent's own transcript in this conversation. */
  agents: AgentTranscripts;
  /** Provider/model pairs the engine's health tracker holds back until their limit resets. */
  waiting: WaitingRoom;
  /** How much of the journal a first read has replayed, while it is still replaying. */
  replay: { read: number; total: number } | null;
}
/** Recent activity frames kept for the Activity view; streamed deltas are merged first. */
export const ACTIVITY_LIMIT = 400;
export const emptyEngineState: EngineState = {
  lastAt: 0,
  agents: {},
  waiting: {},
  replay: null,
  hydrating: false,
  synced: true,
  pendingUserMessages: {},
  queue: [],
  drainedPromptIds: [],
  assists: {},
  sessionId: '',
  provider: '',
  model: '',
  connected: false,
  running: false,
  needsSetup: true,
  messages: [],
  leadingActivity: [],
  activeTextMessageId: null,
  approvals: [],
  inputs: [],
  providerTests: {},
  goalStates: {},
  goalErrors: {},
  sddInterviewId: '',
  sddAgentText: '',
  specDetails: {},
  activity: [],
  context: emptyContextUsage,
  runTimeline: [],
  turnActivity: {},
  turnStats: {},
  runStartTotals: null,
  runStartAt: null,
  memoryRuns: [],
  memoryContext: null,
  memoryReviews: emptyMemoryReviews,
  notices: [],
  noticeCount: 0,
  delegations: [],
  council: EMPTY_COUNCIL_LOG,
  fleet: EMPTY_FLEET_FOLD,
  nextSteps: [],
  worktreeEvents: [],
  results: {},
  error: '',
};
/** Normalize journal input before it reaches operations or React's state updater. */
export function engineEvent(value: unknown): EngineEvent | null {
  const row = record(value);
  if (typeof row['type'] !== 'string' || !row['type']) return null;
  const at = row['at'];
  return {
    type: row['type'],
    payload: record(row['payload']),
    ...(typeof at === 'number' && at > 0 ? { at } : {}),
  };
}
/** A partial native journal page is not yet authoritative for delivery mode. */
export function replayEngineBatch(
  state: EngineState,
  events: readonly EngineEvent[],
  hasMore: boolean,
  position?: { read: number; total: number },
): EngineState {
  return {
    ...events.reduce(reduceEngine, state),
    hydrating: hasMore,
    synced: state.synced || !hasMore,
    replay: hasMore && position && position.total > 0 ? position : null,
  };
}
/** Applies one frame; messages it adds take the frame's time, or the latest time seen. */
export function reduceEngine(state: EngineState, input: unknown): EngineState {
  const event = engineEvent(input);
  if (!event) return state;
  const next = reduceFrame(state, event);
  if (next === state) return state;
  const at = event.at ?? state.lastAt;
  if (at && next.messages.length > state.messages.length)
    next.messages = next.messages.map((message, index) =>
      index < state.messages.length || message.at ? message : { ...message, at },
    );
  if (event.at) next.lastAt = event.at;
  return next;
}
function reduceFrame(state: EngineState, event: EngineEvent): EngineState {
  const p = event.payload;
  // Each native engine is bound to one registered project. Project workflows may
  // be owned by another core session; conversation/permission frames remain lane-scoped.
  const projectFrame = [
    'goal.',
    'goal-state.',
    'sdd.',
    'specs.',
    'kanban.',
    'agent-roster.',
    'chronicle.',
    'memory.',
    'mcp.',
    'techstack.',
    'prompts.',
  ].some((prefix) => event.type.startsWith(prefix));
  if (
    event.type !== 'session.start' &&
    !projectFrame &&
    typeof p['sessionId'] === 'string' &&
    state.sessionId &&
    p['sessionId'] !== state.sessionId
  )
    return state;
  let next = { ...state, results: { ...state.results, [event.type]: p } };
  next.context = reduceContextUsage(state.context, event);
  if (event.type === 'prefs.updated')
    next.results['prefs.updated'] = { ...state.results['prefs.updated'], ...p };
  if (event.type === 'goal.state' && typeof p['goalId'] === 'string')
    next.goalStates = { ...state.goalStates, [p['goalId']]: p };
  const worktreeEvents = reduceWorktreeEvents(
    state.worktreeEvents,
    event.type,
    p,
    event.at ?? (state.lastAt || Date.now()),
  );
  if (worktreeEvents) next.worktreeEvents = worktreeEvents;
  if (event.type === 'goal.error' && typeof p['goalId'] === 'string')
    next.goalErrors = { ...state.goalErrors, [p['goalId']]: p };
  if (event.type === 'specs.detail' && typeof p['specId'] === 'string')
    next.specDetails = { ...state.specDetails, [p['specId']]: p };
  if (event.type === 'sdd.spec.snapshot') {
    const id = typeof p['sessionId'] === 'string' && p['discarded'] !== true ? p['sessionId'] : '';
    next.sddInterviewId = id;
    next.sddAgentText =
      typeof p['lastAgentText'] === 'string'
        ? p['lastAgentText']
        : id === state.sddInterviewId
          ? state.sddAgentText
          : '';
  }
  if (event.type === 'sdd.spec.agent_text' && state.sddInterviewId && typeof p['text'] === 'string')
    next.sddAgentText = p['text'];
  if (event.type.startsWith('code.assist.') && typeof p['requestId'] === 'string') {
    const id = p['requestId'];
    const previous = state.assists[id] ?? { text: '', status: 'running' };
    const run = { ...previous };
    if (event.type === 'code.assist.started') run.status = 'running';
    if (event.type === 'code.assist.delta') run.text += String(p['text'] ?? '');
    if (event.type === 'code.assist.result') {
      run.status = String(p['status']);
      if (typeof p['text'] === 'string') run.text = p['text'];
      if (typeof p['error'] === 'string') run.error = p['error'];
      run.appliedEdits = p['appliedEdits'] === true;
      if (Array.isArray(p['edits']))
        run.edits = p['edits'].flatMap((item) => {
          const edit = record(item);
          return typeof edit['path'] === 'string' &&
            (typeof edit['before'] === 'string' || edit['before'] === null)
            ? [{ path: edit['path'], before: edit['before'] as string | null }]
            : [];
        });
      if (Array.isArray(p['uncaptured'])) run.uncaptured = p['uncaptured'].map(String);
    }
    next.assists = { ...Object.fromEntries(Object.entries(state.assists).slice(-19)), [id]: run };
  }
  if (event.type.startsWith('provider.test.') && typeof p['requestId'] === 'string') {
    const id = p['requestId'];
    const previous = state.providerTests[id] ?? {
      id,
      provider: String(p['providerId'] ?? ''),
      total: Number(p['total'] ?? 0),
      results: {},
      complete: null,
    };
    const run = { ...previous };
    if (event.type === 'provider.test.started') {
      run.provider = String(p['providerId'] ?? '');
      run.total = Number(p['total'] ?? 0);
    }
    if (event.type === 'provider.test.result' && typeof p['modelId'] === 'string')
      run.results = { ...run.results, [p['modelId']]: p };
    if (event.type === 'provider.test.complete') run.complete = p;
    next.providerTests = { ...state.providerTests, [id]: run };
  }
  if (event.type === 'session.start') {
    const id = String(p['sessionId'] ?? '');
    if (state.sessionId && state.sessionId !== id) return state;
    next = {
      ...next,
      sessionId: id,
      provider: String(p['provider'] ?? ''),
      model: String(p['model'] ?? ''),
      connected: true,
      needsSetup:
        typeof p['needsSetup'] === 'boolean'
          ? p['needsSetup']
          : !p['provider'] || p['provider'] === 'unconfigured' || !p['model'],
    };
    if (p['reset'] === true) {
      next.leadingActivity = [];
      next.activeTextMessageId = null;
      next.nextSteps = [];
      next.runTimeline = [];
      next.turnActivity = {};
      next.turnStats = {};
      next.runStartTotals = null;
      next.runStartAt = null;
      next.agents = {};
      next.memoryRuns = [];
      next.memoryContext = null;
      next.notices = [];
      next.delegations = [];
    }
    // A reopened conversation brings its subagents' transcripts back with its replay.
    next.agents = hydrateAgentTranscripts(next.agents, p['agentSessions']);
    if ((!state.messages.length || p['reset'] === true) && Array.isArray(p['replayMessages'])) {
      if (p['reset'] === true) {
        next.running = false;
        next.pendingUserMessages = {};
      }
      next.messages = entries(p['replayMessages'])
        .filter((m) => m['role'] === 'user' || m['role'] === 'assistant')
        .map((m, i) => ({
          id: `replay-${i}`,
          role: m['role'] as ChatMessage['role'],
          text: contentText(m['content']),
          attachments: transcriptAttachments(m['content']),
        }));
    }
  }
  if (
    event.type === 'model.switch_result' &&
    p['success'] === true &&
    typeof p['provider'] === 'string' &&
    typeof p['model'] === 'string'
  ) {
    next.provider = p['provider'];
    next.model = p['model'];
    next.needsSetup = false;
    next.error = '';
  }
  // The fallback chain moved the conversation to another model, or back to its primary: show
  // the model that actually serves the next request.
  const notice = conversationNotice(event.type, p, `${event.type}:${state.noticeCount}`);
  // A passing notice belongs to the moment it happened; a replayed journal does not show it.
  if (notice && !(notice.transient && !state.synced)) {
    next.notices = appendNotice(state.notices, notice);
    next.noticeCount = state.noticeCount + 1;
  }
  if (event.type === 'delegate.completed') {
    const delegation = delegationRecord(p, String(state.delegations.length));
    if (delegation) next.delegations = appendDelegation(state.delegations, delegation);
  }
  // Brain frames reach every conversation of the project; keep this one's councils.
  if (event.type === 'brain.event' && next.sessionId && p['sessionId'] === next.sessionId) {
    const fold = reduceCouncil(state.council, p);
    next.council = fold.log;
    if (fold.decision) {
      const id = `council:${fold.decision.requestId}:${fold.decision.resolvedAt ?? state.messages.length}`;
      next.messages = [
        ...next.messages,
        { id, role: 'assistant', text: councilDecisionText(fold.decision), council: fold.decision },
      ];
    }
  }
  // A memory's reviews are the project's, whichever conversation produced them.
  if (event.type === 'memory.event') {
    const reviews = foldMemoryReviews(state.memoryReviews, p);
    if (reviews !== state.memoryReviews) next.memoryReviews = reviews;
  }
  // Memory frames are project-scoped; keep only this conversation's own.
  if (
    event.type === 'memory.event' &&
    (typeof p['sessionId'] !== 'string' || p['sessionId'] === next.sessionId)
  ) {
    const run = memoryInjectorRun(p);
    if (run) next.memoryRuns = appendMemoryRun(state.memoryRuns, run);
    const context = memoryContextSnapshot(p);
    if (context) next.memoryContext = context;
  }
  if (event.type === 'provider.fallback' || event.type === 'provider.primary_restored') {
    const to = p['to'] as Record<string, unknown> | undefined;
    if (to && typeof to['providerId'] === 'string' && typeof to['model'] === 'string') {
      next.provider = to['providerId'];
      next.model = to['model'];
    }
  }
  // A user-run MCP tool's result, added to the conversation by the engine.
  if (event.type === 'mcp.tool.result' && p['addedToConversation'] === true) {
    const id = `mcp-tool:${String(p['requestId'])}`;
    if (typeof p['note'] === 'string' && !state.messages.some((m) => m.id === id))
      next.messages = [...state.messages, { id, role: 'user', text: p['note'] }];
  }
  if (event.type === 'desktop.user_message') {
    const id = String(p['id']);
    if (typeof p['requestId'] === 'string') {
      next.pendingUserMessages = {
        ...Object.fromEntries(Object.entries(state.pendingUserMessages).slice(-19)),
        [p['requestId']]: {
          id,
          role: 'user',
          text: contentText(p['content']),
          attachments: transcriptAttachments(p['images']),
        },
      };
      return next;
    }
    if (!state.messages.some((m) => m.id === id))
      next.messages = [
        ...state.messages,
        {
          id,
          role: 'user',
          text: contentText(p['content']),
          attachments: transcriptAttachments(p['images']),
        },
      ];
    next.running = true;
    next.nextSteps = [];
    next.error = '';
  }
  if (
    typeof p['requestId'] === 'string' &&
    state.pendingUserMessages[p['requestId']] &&
    (event.type === 'error' ||
      (event.type === 'key.operation_result' && p['phase'] === 'user_message'))
  ) {
    const pending = state.pendingUserMessages[p['requestId']]!;
    next.pendingUserMessages = { ...state.pendingUserMessages };
    delete next.pendingUserMessages[p['requestId']];
    if (event.type !== 'error' && p['success'] === true) {
      if (!state.messages.some((message) => message.id === pending.id))
        next.messages = [...state.messages, pending];
      next.running = true;
      next.nextSteps = [];
      next.error = '';
    }
  }
  if (event.type === 'queue.state')
    next.queue = entries(p['items'])
      .filter(
        (item) => typeof item['id'] === 'string' && !state.drainedPromptIds.includes(item['id']),
      )
      .map((item) => ({
        id: String(item['id']),
        text: String(item['text'] ?? ''),
        addedAt: Number(item['addedAt'] ?? 0),
        imageCount: Number(item['imageCount'] ?? 0),
      }));
  if (event.type === 'queue.drained') {
    const item = record(p['item']);
    if (typeof item['id'] === 'string') {
      const id = item['id'];
      next.drainedPromptIds = [
        ...state.drainedPromptIds.filter((value) => value !== id).slice(-199),
        id,
      ];
      next.queue = state.queue.filter((value) => value.id !== id);
      if (!state.messages.some((message) => message.id === `queue:${id}`))
        next.messages = [
          ...state.messages,
          {
            id: `queue:${id}`,
            role: 'user',
            text: String(item['text'] ?? ''),
            attachments: transcriptAttachments(item['images']),
          },
        ];
      next.running = true;
      next.nextSteps = [];
      next.error = '';
    }
  }
  if (event.type === 'provider.text_delta') {
    const streamId = String(p['messageId'] ?? 'current');
    const text = contentText(p['text']);
    const previous = state.messages.at(-1);
    // A wire stream ID can be reused after a completed turn. Only append to
    // the active trailing assistant, never to a historical message with that ID.
    next.messages =
      state.running &&
      previous?.role === 'assistant' &&
      previous.streamId === streamId &&
      state.activeTextMessageId === previous.id
        ? [...state.messages.slice(0, -1), { ...previous, text: previous.text + text }]
        : [
            ...state.messages,
            {
              id: `assistant:${streamId}:${state.messages.length}`,
              streamId,
              role: 'assistant',
              text,
            },
          ];
    next.activeTextMessageId = next.messages.at(-1)!.id;
    next.running = true;
  }
  if (event.type === 'tool.confirm_needed')
    next.approvals = [...state.approvals.filter((a) => a['id'] !== p['id']), p];
  if (event.type === 'tool.confirm_resolved' || event.type === 'tool.confirm_result')
    next.approvals = state.approvals.filter((a) => a['id'] !== p['id']);
  if (event.type === 'user.input_requested') {
    const request = parseInputRequest(p['request']);
    if (request) next.inputs = [...state.inputs.filter((item) => item.id !== request.id), request];
    else next.error = 'The engine sent an invalid question form. Stop the run or ask it to retry.';
  }
  if (event.type === 'user.input_resolved')
    next.inputs = state.inputs.filter((item) => item.id !== p['requestId']);
  if (event.type === 'run.result') {
    next.running = false;
    next.activeTextMessageId = null;
    const answer = next.messages.findLast((message) => message.role === 'assistant');
    // Every tool call of the turn stays with its answer, not only those still in the
    // Activity view's recent window.
    const tools = state.runTimeline.filter((entry) => entry.type.startsWith('tool.'));
    if (answer && tools.length && !next.turnActivity[answer.id])
      next.turnActivity = { ...next.turnActivity, [answer.id]: tools };
    if (answer && !next.turnStats[answer.id])
      next.turnStats = {
        ...next.turnStats,
        [answer.id]: turnStats(
          state.runStartTotals,
          next.context.totals,
          p['iterations'],
          state.runStartAt && event.at ? event.at - state.runStartAt : undefined,
        ),
      };
    next.runTimeline = [];
    next.runStartTotals = null;
    next.runStartAt = null;
    if (p['status'] === 'done') {
      const parsed = parseNextSteps(contentText(p['finalText'])).steps;
      const start = state.activity.findLastIndex((entry) => entry.type === 'run.result') + 1;
      const inputs = new Map<string, ParsedNextStep[]>();
      let toolSteps: ParsedNextStep[] = [];
      for (const entry of state.activity.slice(start)) {
        if (
          entry.type === 'tool.started' &&
          entry.payload['name'] === 'nextsteps' &&
          typeof entry.payload['id'] === 'string'
        )
          inputs.set(entry.payload['id'], projectNextStepsToolInput(entry.payload['input']));
        if (
          entry.type === 'tool.executed' &&
          entry.payload['name'] === 'nextsteps' &&
          entry.payload['ok'] === true &&
          typeof entry.payload['id'] === 'string'
        )
          toolSteps =
            inputs.get(entry.payload['id']) ?? projectNextStepsToolInput(entry.payload['input']);
      }
      next.nextSteps = parsed.length ? parsed : toolSteps;
    } else next.nextSteps = [];
    if (p['status'] === 'failed')
      next.error = String(record(p['error'])['message'] ?? 'Agent run failed');
  }
  if (
    event.type === 'error' ||
    event.type === 'provider.error' ||
    event.type.endsWith('.error') ||
    event.type.endsWith('_error')
  )
    next.error = String(p['message'] ?? p['description'] ?? 'Engine request failed');
  if (event.type === 'desktop.disconnected') {
    next.connected = false;
    next.running = false;
    // Scheduled jobs live in the engine's memory; a new engine starts with none.
    delete next.results['cron.snapshot'];
    next.error = String(p['message'] ?? 'Engine disconnected');
  }
  if (
    event.type.startsWith('tool.') ||
    event.type.startsWith('codemap.') ||
    event.type.startsWith('iteration.') ||
    event.type === 'provider.thinking_delta' ||
    event.type === 'provider.retry' ||
    event.type === 'user.input_resolved' ||
    event.type === 'run.result'
  ) {
    const activity = appendRunEvent(state.activity, event);
    next.activity =
      activity.length > ACTIVITY_LIMIT
        ? activity.slice(activity.length - ACTIVITY_LIMIT)
        : activity;
  }
  if (isRunTimelineEvent(event.type)) {
    next.runTimeline = appendRunEvent(state.runTimeline, event);
    next.activeTextMessageId = null;
    const previous = next.messages.at(-1);
    if (previous) {
      next.messages = [
        ...next.messages.slice(0, -1),
        { ...previous, activityAfter: appendRunEvent(previous.activityAfter ?? [], event) },
      ];
    } else next.leadingActivity = appendRunEvent(state.leadingActivity, event);
  }
  if (event.type === 'provider.response') next.activeTextMessageId = null;
  next.agents = reduceAgentTranscripts(next.agents, event.type, p);
  if (event.type === 'subagent.event') {
    const options = {
      now: event.at ?? (state.lastAt || Date.now()),
      cleanFinalText: stripNextStepsBlock,
    };
    next.fleet = {
      ...state.fleet,
      ...applyFleetEvent(state.fleet, p as unknown as SubagentEvent, options),
    };
  }
  next.waiting = reduceWaitingRoom(state.waiting, event.type, p);
  if (event.type === 'iteration.started' && !state.runStartTotals) {
    next.runStartTotals = state.context.totals;
    next.runStartAt = event.at ?? null;
  }
  return next;
}
