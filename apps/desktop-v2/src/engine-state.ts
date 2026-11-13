import { stripNextStepsBlock } from '@wrongstack/core/utils/next-steps';
import {
  councilDecisionText,
  EMPTY_COUNCIL_LOG,
} from '@wrongstack/project-surfaces/council/panels';
import { applyFleetEvent, EMPTY_FLEET_FOLD } from '@wrongstack/project-surfaces/office/fleet-fold';
import type { SubagentEvent } from '@wrongstack/project-surfaces/office/fleet-transcript';
import type { ParsedNextStep } from '@wrongstack/webui-protocol';
import { parseNextSteps, projectNextStepsToolInput } from '@wrongstack/webui-protocol';
import { hydrateAgentTranscripts, reduceAgentTranscripts } from './agent-transcripts';
import { brainMessage } from './brain-message';
import { transcriptAttachments } from './composer-attachments.js';
import { emptyContextUsage, reduceContextUsage, turnStats } from './context-usage.js';
import { appendNotice, conversationNotice } from './conversation-notices.js';
import { reduceCouncil } from './council-decisions.js';
import { appendDelegation, delegationRecord } from './delegations.js';
import type { ChatMessage, EngineEvent, EngineState } from './engine-state-types';
import { contentText, entries, record } from './engine-values.js';
import { fleetGauge } from './fleet-gauge.js';
import { parseInputRequest } from './input-form-model.js';
import { appendMemoryRun, memoryContextSnapshot, memoryInjectorRun } from './memory-injections.js';
import { emptyMemoryReviews, foldMemoryReviews } from './memory-reviews.js';
import { reduceWaitingRoom } from './provider-waiting.js';
import { appendRunEvent, isRunTimelineEvent } from './run-timeline.js';
import { serviceHealing } from './service-healing';
import { reduceWorktreeEvents } from './worktree-history.js';

export type { ChatMessage, EngineEvent, EngineState, ProviderTestRun } from './engine-state-types';
export { contentText, entries, record } from './engine-values.js';
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
  eventEpoch: '',
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
  archivedInputs: [],
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
  serviceHealing: {},
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
/** Expire runtime controls without losing the original questions needed for answer recovery. */
export function expireEngineInteractions(
  state: EngineState,
): Pick<EngineState, 'inputs' | 'approvals' | 'archivedInputs' | 'running'> {
  return {
    inputs: [],
    approvals: [],
    running: false,
    archivedInputs: [
      ...new Map(
        [...state.archivedInputs, ...state.inputs].map((item) => [item.id, item] as const),
      ).values(),
    ],
  };
}
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
  if (
    event.type === 'connections.auto_heal_status' &&
    typeof p['serviceId'] === 'string' &&
    p['serviceId']
  ) {
    const healing = serviceHealing(p),
      previous = state.serviceHealing[p['serviceId']];
    if (healing && (!previous || healing.at >= previous.at))
      next.serviceHealing = { ...state.serviceHealing, [p['serviceId']]: healing };
  }
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
    const epoch =
      typeof p['eventEpoch'] === 'string' && p['eventEpoch'] ? p['eventEpoch'] : state.eventEpoch;
    const replaced = !!state.eventEpoch && epoch !== state.eventEpoch;
    next = {
      ...next,
      sessionId: id,
      eventEpoch: epoch,
      provider: String(p['provider'] ?? ''),
      model: String(p['model'] ?? ''),
      connected: true,
      needsSetup:
        typeof p['needsSetup'] === 'boolean'
          ? p['needsSetup']
          : !p['provider'] || p['provider'] === 'unconfigured' || !p['model'],
    };
    if (p['reset'] === true || replaced) {
      next = { ...next, ...expireEngineInteractions(state) };
      next.error = '';
      next.activeTextMessageId = null;
      next.runTimeline = [];
      next.runStartTotals = null;
      next.runStartAt = null;
      // A killed engine cannot emit a final tool result. Retain the observed process
      // boundary in presentation history, even after the original start frame is trimmed.
      next.activity = appendRunEvent(state.activity, {
        type: 'desktop.engine_boundary',
        payload: { sessionId: id },
      }).slice(-ACTIVITY_LIMIT);
    }
    if (p['reset'] === true) {
      next.leadingActivity = [];
      next.nextSteps = [];
      next.turnActivity = {};
      next.turnStats = {};
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
  if (
    event.type === 'chimera.report_available' &&
    state.sessionId &&
    p['sessionId'] === state.sessionId &&
    p['hasActionableFindings'] === true &&
    typeof p['reportId'] === 'string' &&
    p['reportId']
  ) {
    const id = `chimera:${p['reportId']}`;
    if (!next.messages.some((message) => message.id === id))
      next.messages = [
        ...next.messages,
        {
          id,
          role: 'assistant',
          text: typeof p['message'] === 'string' ? p['message'] : '',
          ...(event.at === undefined ? {} : { at: event.at }),
          chimera: { reportId: p['reportId'], sessionId: state.sessionId },
        },
      ];
  }
  // Brain frames reach every conversation of the project; keep this one's councils.
  if (event.type === 'brain.event' && next.sessionId && p['sessionId'] === next.sessionId) {
    const decision = brainMessage(p);
    if (decision) {
      const id = `brain:${decision.id}:${decision.kind}`;
      const message: ChatMessage = {
        id,
        role: 'assistant',
        text: decision.text ?? decision.reason ?? decision.question ?? '',
        brain: decision,
      };
      const previous = next.messages.findIndex((item) => item.id === id);
      next.messages =
        previous < 0
          ? [...next.messages, message]
          : next.messages.map((item, index) => (index === previous ? message : item));
    }
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
          ...(typeof p['journalRaw'] === 'string' ? { journalRaw: p['journalRaw'] } : {}),
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
          ...(typeof p['journalRaw'] === 'string' ? { journalRaw: p['journalRaw'] } : {}),
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
    if (request) {
      next.inputs = [...state.inputs.filter((item) => item.id !== request.id), request];
      next.archivedInputs = state.archivedInputs.filter((item) => item.id !== request.id);
      if (next.results['user.input_resolved']?.['requestId'] === request.id)
        delete next.results['user.input_resolved'];
    } else
      next.error = 'The engine sent an invalid question form. Stop the run or ask it to retry.';
  }
  if (event.type === 'user.input_resolved') {
    next.inputs = state.inputs.filter((item) => item.id !== p['requestId']);
    if (p['source'] === 'abort' || p['source'] === 'unattended')
      next.archivedInputs = [
        ...new Map(
          [
            ...state.archivedInputs,
            ...state.inputs.filter((item) => item.id === p['requestId']),
          ].map((item) => [item.id, item] as const),
        ).values(),
      ];
    else next.archivedInputs = state.archivedInputs.filter((item) => item.id !== p['requestId']);
  }
  if (event.type === 'run.result') {
    next = { ...next, ...expireEngineInteractions(state) };
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
    next = { ...next, ...expireEngineInteractions(state), connected: false };
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
  if (event.type === 'fleet.concurrency_update')
    next.fleetGauge = fleetGauge(p) ?? state.fleetGauge;
  if (event.type === 'subagent.event') {
    const options = {
      now: event.at ?? (state.lastAt || Date.now()),
      cleanFinalText: stripNextStepsBlock,
    };
    const fleetEvent = p as unknown as SubagentEvent;
    const departing = fleetEvent.subagentId
      ? state.fleet.agents.get(fleetEvent.subagentId)
      : undefined;
    // A conversation journal owns the bounded completed roster, not a mounted Office view.
    // Routine worker disposal can share a batch with completion, so a render-local cache
    // never sees the terminal entry. Explicit removal and session shutdown still clear it.
    const retainCompleted =
      fleetEvent.kind === 'removed' &&
      fleetEvent.reason === 'subagent lifecycle completed' &&
      departing &&
      !departing.isLeader &&
      ['completed', 'failed', 'timeout', 'stopped'].includes(departing.status);
    next.fleet = retainCompleted
      ? state.fleet
      : {
          ...state.fleet,
          ...applyFleetEvent(state.fleet, fleetEvent, options),
        };
  }
  next.waiting = reduceWaitingRoom(state.waiting, event.type, p);
  if (event.type === 'iteration.started' && !state.runStartTotals) {
    next.runStartTotals = state.context.totals;
    next.runStartAt = event.at ?? null;
  }
  return next;
}
