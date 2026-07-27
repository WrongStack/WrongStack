import type { Action } from '../app-action-type.js';
import type { State } from '../app-state.js';
import { closePanels } from './helpers.js';

const activityActionTypes = [
  'setHistoryScrolled',
  'setViewportRows',
  'collabSubagentSpawned',
  'collabBugFound',
  'collabPlanEmitted',
  'collabEvalComplete',
  'collabSessionDone',
  'debugStreamStats',
  'debugStreamStatsClear',
  'toggleSessionsPanel',
  'sessionsPanelSet',
  'sessionsPanelMove',
  'sessionsPanelBusy',
  'sessionResumeConfirmSet',
  'sessionResumeConfirmClear',
  'countdownTick',
  'countdownEnded',
  'coordinatorEvent',
  'toggleAuditPanel',
  'toggleCoordinatorMonitor',
] as const satisfies readonly Action['type'][];

type ActivityAction = Extract<Action, { type: (typeof activityActionTypes)[number] }>;
const activityActionTypeSet = new Set<string>(activityActionTypes);

export function isActivityAction(action: Action): action is ActivityAction {
  return activityActionTypeSet.has(action.type);
}

/** Reduces viewport, collaboration, session, countdown, and coordinator activity. */
export function reduceActivity(state: State, action: ActivityAction): State {
  switch (action.type) {
    case 'setHistoryScrolled':
      if (action.scrolled === state.historyScrolled) return state;
      return { ...state, historyScrolled: action.scrolled };
    case 'setViewportRows': {
      if (action.rows === state.viewportRows) return state;
      return { ...state, viewportRows: action.rows };
    }
    case 'collabSubagentSpawned':
      if (state.collabSession) return state;
      return {
        ...state,
        collabSession: {
          sessionId: null,
          bugCount: 0,
          planCount: 0,
          evalCount: 0,
          overallVerdict: null,
          timeline: [{ at: Date.now(), icon: '⚡', color: 'cyan', text: `${action.role} spawned` }],
          startedAt: Date.now(),
        },
      };
    case 'collabBugFound': {
      const cs = state.collabSession;
      if (!cs) {
        return {
          ...state,
          collabSession: {
            sessionId: action.sessionId,
            bugCount: 1,
            planCount: 0,
            evalCount: 0,
            overallVerdict: null,
            timeline: [
              {
                at: Date.now(),
                icon: '🐛',
                color: 'red',
                text: `bug: ${action.description.slice(0, 60)}…`,
              },
            ],
            startedAt: Date.now(),
          },
        };
      }
      const entry = {
        at: Date.now(),
        icon: '🐛',
        color: 'red',
        text: `bug [${action.severity}]: ${action.description.slice(0, 55)}…`,
      };
      return {
        ...state,
        collabSession: {
          ...cs,
          sessionId: action.sessionId,
          bugCount: cs.bugCount + 1,
          timeline: [entry, ...cs.timeline].slice(0, 30),
        },
      };
    }
    case 'collabPlanEmitted': {
      const cs = state.collabSession;
      if (!cs) return state;
      const entry = {
        at: Date.now(),
        icon: '📐',
        color: 'yellow',
        text: `plan [${action.riskScore}]: ${action.phaseCount} phases`,
      };
      return {
        ...state,
        collabSession: {
          ...cs,
          sessionId: action.sessionId,
          planCount: cs.planCount + 1,
          timeline: [entry, ...cs.timeline].slice(0, 30),
        },
      };
    }
    case 'collabEvalComplete': {
      const cs = state.collabSession;
      if (!cs) return state;
      const entry = {
        at: Date.now(),
        icon: '⚖️',
        color:
          action.verdict === 'approve' ? 'green' : action.verdict === 'reject' ? 'red' : 'yellow',
        text: `eval ${action.score}/10 → ${action.verdict}`,
      };
      return {
        ...state,
        collabSession: {
          ...cs,
          sessionId: action.sessionId,
          evalCount: cs.evalCount + 1,
          timeline: [entry, ...cs.timeline].slice(0, 30),
        },
      };
    }
    case 'collabSessionDone': {
      const cs = state.collabSession;
      if (!cs) return state;
      const entry = {
        at: Date.now(),
        icon: '🏁',
        color: 'green',
        text: `session done — ${action.verdict}`,
      };
      return {
        ...state,
        collabSession: {
          ...cs,
          overallVerdict: action.verdict,
          timeline: [entry, ...cs.timeline].slice(0, 30),
        },
      };
    }
    case 'debugStreamStats':
      return {
        ...state,
        debugStreamStats: {
          chunkCount: action.chunkCount,
          lastChunkSize: action.lastChunkSize,
          lastDeltaMs: action.lastDeltaMs,
          totalBytes: action.totalBytes,
          lastChunkAt: action.lastChunkAt,
        },
      };
    case 'debugStreamStatsClear':
      return state.debugStreamStats === null ? state : { ...state, debugStreamStats: null };
    case 'toggleSessionsPanel': {
      const opening = !state.sessionsPanelOpen;
      return opening
        ? { ...state, ...closePanels(state), sessionsPanelOpen: true, sessionResumeConfirm: null }
        : { ...state, sessionsPanelOpen: false, sessionResumeConfirm: null };
    }
    case 'sessionsPanelSet': {
      const sessions = Array.isArray(action.sessions) ? action.sessions : [];
      return {
        ...state,
        sessionsPanel: { sessions, busy: false, selected: sessions.length > 0 ? 0 : -1 },
      };
    }
    case 'sessionsPanelMove': {
      const cur = state.sessionsPanel;
      if (cur.sessions.length === 0) return state;
      const next = (cur.selected + action.delta + cur.sessions.length) % cur.sessions.length;
      return { ...state, sessionsPanel: { ...cur, selected: next } };
    }
    case 'sessionsPanelBusy':
      return { ...state, sessionsPanel: { ...state.sessionsPanel, busy: action.on } };
    case 'sessionResumeConfirmSet':
      return {
        ...state,
        sessionResumeConfirm: { sessionId: action.sessionId, sessionName: action.sessionName },
      };
    case 'sessionResumeConfirmClear':
      return { ...state, sessionResumeConfirm: null };
    case 'countdownTick':
      if (action.remainingSeconds <= 0) {
        return state.countdown ? { ...state, countdown: null } : state;
      }
      return { ...state, countdown: { remainingSeconds: action.remainingSeconds } };
    case 'countdownEnded':
      return state.countdown === null ? state : { ...state, countdown: null };
    case 'coordinatorEvent': {
      const { event } = action;
      let kind: State['coordinator']['timeline'][0]['kind'];
      let icon: string;
      switch (event.type) {
        case 'goal:added':
          kind = 'goal';
          icon = '🎯';
          break;
        case 'goal:completed':
          kind = 'goal';
          icon = '✅';
          break;
        case 'goal:failed':
          kind = 'goal';
          icon = '❌';
          break;
        case 'task:ready':
          kind = 'task';
          icon = '⚡';
          break;
        case 'task:completed':
          kind = 'task';
          icon = '✓';
          break;
        case 'knowledge:added':
          kind = 'knowledge';
          icon = '💡';
          break;
        case 'consensus:reached':
          kind = 'consensus';
          icon = '🤝';
          break;
        case 'deadlock:detected':
          kind = 'deadlock';
          icon = '⚠️';
          break;
        default:
          kind = 'goal';
          icon = '•';
      }
      const timelineEntry = {
        at: Date.now(),
        kind,
        icon,
        text: event.text ?? event.type,
      };
      return {
        ...state,
        coordinator: {
          ...state.coordinator,
          healthy: true,
          knowledgeCount:
            event.type === 'knowledge:added'
              ? state.coordinator.knowledgeCount + 1
              : state.coordinator.knowledgeCount,
          timeline: [timelineEntry, ...state.coordinator.timeline].slice(0, 50),
        },
      };
    }
    case 'toggleAuditPanel': {
      const opening = !state.auditPanelOpen;
      return opening
        ? { ...state, ...closePanels(state), auditPanelOpen: true }
        : { ...state, auditPanelOpen: false };
    }
    case 'toggleCoordinatorMonitor': {
      const opening = !state.coordinator.monitorOpen;
      return opening
        ? {
            ...state,
            ...closePanels(state),
            coordinator: { ...state.coordinator, monitorOpen: true },
          }
        : { ...state, coordinator: { ...state.coordinator, monitorOpen: false } };
    }
    default:
      void (action satisfies never);
      return state;
  }
}
