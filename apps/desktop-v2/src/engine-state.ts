import type { UserInputRequest } from '@wrongstack/contracts/types';
import {
  type ParsedNextStep,
  parseNextSteps,
  projectNextStepsToolInput,
} from '@wrongstack/webui-protocol';
import { type ComposerAttachment, transcriptAttachments } from './composer-attachments.js';
import {
  appendNotice,
  type ConversationNotice,
  conversationNotice,
} from './conversation-notices.js';
import { contentText, entries, record } from './engine-values.js';
import { parseInputRequest } from './input-form-model.js';
import {
  appendMemoryRun,
  type MemoryContext,
  type MemoryInjectorRun,
  memoryContextSnapshot,
  memoryInjectorRun,
} from './memory-injections.js';

export { contentText, entries, record } from './engine-values.js';
export interface EngineEvent {
  type: string;
  payload: Record<string, unknown>;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  attachments?: ComposerAttachment[];
  streamId?: string;
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
  approvals: Record<string, unknown>[];
  inputs: UserInputRequest[];
  providerTests: Record<string, ProviderTestRun>;
  goalStates: Record<string, Record<string, unknown>>;
  goalErrors: Record<string, Record<string, unknown>>;
  sddInterviewId: string;
  sddAgentText: string;
  specDetails: Record<string, Record<string, unknown>>;
  activity: EngineEvent[];
  /** Each finished turn's tool events, by the id of the assistant message that ended it. */
  turnActivity: Record<string, EngineEvent[]>;
  /** This conversation's SAGE injector runs, newest last, and the latest request's memories. */
  memoryRuns: MemoryInjectorRun[];
  memoryContext: MemoryContext | null;
  /** Engine reports about this conversation that need the user's attention, newest last. */
  notices: ConversationNotice[];
  /** Notices seen, so each gets a distinct id after older ones fall out of the list. */
  noticeCount: number;
  nextSteps: ParsedNextStep[];
  results: Record<string, Record<string, unknown>>;
  error: string;
}
/** Tool events kept per finished turn for the inline record. */
export const TURN_ACTIVITY_LIMIT = 120;
export const emptyEngineState: EngineState = {
  hydrating: false,
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
  approvals: [],
  inputs: [],
  providerTests: {},
  goalStates: {},
  goalErrors: {},
  sddInterviewId: '',
  sddAgentText: '',
  specDetails: {},
  activity: [],
  turnActivity: {},
  memoryRuns: [],
  memoryContext: null,
  notices: [],
  noticeCount: 0,
  nextSteps: [],
  results: {},
  error: '',
};
/** Normalize journal input before it reaches operations or React's state updater. */
export function engineEvent(value: unknown): EngineEvent | null {
  const row = record(value);
  if (typeof row['type'] !== 'string' || !row['type']) return null;
  return { type: row['type'], payload: record(row['payload']) };
}
/** A partial native journal page is not yet authoritative for delivery mode. */
export function replayEngineBatch(
  state: EngineState,
  events: readonly EngineEvent[],
  hasMore: boolean,
): EngineState {
  return { ...events.reduce(reduceEngine, state), hydrating: hasMore };
}
export function reduceEngine(state: EngineState, input: unknown): EngineState {
  const event = engineEvent(input);
  if (!event) return state;
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
  if (event.type === 'prefs.updated')
    next.results['prefs.updated'] = { ...state.results['prefs.updated'], ...p };
  if (event.type === 'goal.state' && typeof p['goalId'] === 'string')
    next.goalStates = { ...state.goalStates, [p['goalId']]: p };
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
      next.nextSteps = [];
      next.turnActivity = {};
      next.memoryRuns = [];
      next.memoryContext = null;
      next.notices = [];
    }
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
  if (notice) {
    next.notices = appendNotice(state.notices, notice);
    next.noticeCount = state.noticeCount + 1;
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
      state.running && previous?.role === 'assistant' && previous.streamId === streamId
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
    const answer = next.messages.findLast((message) => message.role === 'assistant');
    const runStart = state.activity.findLastIndex((entry) => entry.type === 'run.result') + 1;
    const tools = state.activity
      .slice(runStart)
      .filter((entry) => entry.type.startsWith('tool.'))
      .slice(-TURN_ACTIVITY_LIMIT);
    if (answer && tools.length && !next.turnActivity[answer.id])
      next.turnActivity = { ...next.turnActivity, [answer.id]: tools };
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
  )
    next.activity = [...state.activity.slice(-199), event];
  return next;
}
