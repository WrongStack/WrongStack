/**
 * Fleet & leader sub-reducer for the TUI.
 *
 * Handles all fleetSpawn / fleetToolStart / fleetToolEnd / fleetStart /
 * fleetDelta / fleetMessage / fleetTool / fleetUsage / fleetDone /
 * fleetBudgetWarning / fleetBudgetExtended / fleetCtxPct / fleetCost /
 * fleetConcurrency / fleetSeed / fleetBatch / leaderIterStart /
 * leaderIterEnd / leaderToolStart / leaderToolEnd / leaderCtxPct /
 * setFleetChat actions.
 *
 * Returns the new state when the action is fleet/leader-related, or
 * null when the action should fall through to the main reducer.
 */

import type { Action } from '../app-action-type.js';
import type { FleetEntry, State } from '../app-state.js';
import { clampContextLoad } from './helpers.js';

function isPlaceholderName(name: string, id: string): boolean {
  return (
    name === 'adhoc' ||
    name === 'subagent' ||
    name === 'generic' ||
    name.startsWith('slot-') ||
    name === id.slice(0, 8)
  );
}

export function reduceFleetState(state: State, action: Action): State | null {
  switch (action.type) {
    // ── Fleet ────────────────────────────────────────────────────────────
    case 'fleetSeed': {
      const seeded: Record<string, FleetEntry> = {};
      for (const e of action.entries) {
        seeded[e.id] = {
          ...e,
          recentTools: e.recentTools ?? [],
          recentMessages: e.recentMessages ?? [],
        };
      }
      return { ...state, fleet: seeded, fleetCost: action.cost };
    }

    case 'fleetSpawn': {
      const existing = state.fleet[action.id];
      const incomingName = action.name ?? action.id.slice(0, 8);
      if (existing) {
        if (
          isPlaceholderName(existing.name, action.id) &&
          !isPlaceholderName(incomingName, action.id) &&
          incomingName !== existing.name
        ) {
          return {
            ...state,
            fleet: {
              ...state.fleet,
              [action.id]: { ...existing, name: incomingName },
            },
          };
        }
        return state;
      }
      const entry: FleetEntry = {
        id: action.id,
        name: incomingName,
        provider: action.provider,
        model: action.model,
        status: 'idle',
        streamingText: '',
        iterations: 0,
        toolCalls: 0,
        recentTools: [],
        recentMessages: [],
        cost: 0,
        startedAt: Date.now(),
        lastEventAt: Date.now(),
        transcriptPath: action.transcriptPath,
      };
      return { ...state, fleet: { ...state.fleet, [action.id]: entry } };
    }

    case 'fleetToolStart': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            currentTool: { name: action.name, startedAt: Date.now() },
            lastEventAt: Date.now(),
          },
        },
      };
    }

    case 'fleetToolEnd': {
      const cur = state.fleet[action.id];
      if (!cur || cur.currentTool === undefined) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: { ...cur, currentTool: undefined, lastEventAt: Date.now() },
        },
      };
    }

    case 'fleetStart': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      if (cur.status === 'running' && cur.streamingText === '' && cur.budgetWarning === undefined) {
        return state;
      }
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            status: 'running' as const,
            streamingText: '',
            budgetWarning: undefined,
            startedAt: Date.now(),
          },
        },
      };
    }

    case 'fleetDelta': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      const appended = (cur.streamingText + action.text).slice(-500);
      if (appended === cur.streamingText) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: { ...cur, streamingText: appended, lastEventAt: Date.now() },
        },
      };
    }

    case 'fleetMessage': {
      const cur = state.fleet[action.id];
      const text = action.text.trim().replace(/\s+/g, ' ');
      if (!cur || !text) return state;
      const now = Date.now();
      const recentMessages = [...(cur.recentMessages ?? []), { text, at: now }].slice(-2);
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: { ...cur, recentMessages, lastEventAt: now },
        },
      };
    }

    case 'fleetTool': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      const now = Date.now();
      const recentTools =
        action.name !== undefined
          ? [
              ...(cur.recentTools ?? []),
              {
                name: action.name,
                ok: action.ok,
                durationMs: action.durationMs,
                outputBytes: action.outputBytes,
                outputLines: action.outputLines,
                at: now,
              },
            ].slice(-2)
          : (cur.recentTools ?? []);
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            toolCalls: cur.toolCalls + 1,
            recentTools,
            lastEventAt: now,
          },
        },
      };
    }

    case 'fleetUsage': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      // Usage heartbeats are diagnostic only. Updating the timestamp more
      // than once per second creates a new fleet/App tree without changing
      // anything visible.
      if (Date.now() - cur.lastEventAt < 1_000) return state;
      return {
        ...state,
        fleet: { ...state.fleet, [action.id]: { ...cur, lastEventAt: Date.now() } },
      };
    }

    case 'fleetDone': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            status: action.status,
            iterations: action.iterations,
            toolCalls: action.toolCalls,
            streamingText: '',
            currentTool: undefined,
            budgetWarning: undefined,
            lastEventAt: Date.now(),
            failureReason: action.failureReason,
          },
        },
      };
    }

    case 'fleetRemove': {
      if (!state.fleet[action.id]) return state;
      const fleet = { ...state.fleet };
      delete fleet[action.id];
      return { ...state, fleet };
    }

    case 'fleetBudgetWarning': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            budgetWarning: {
              kind: action.kind,
              used: action.used,
              limit: action.limit,
              at: Date.now(),
            },
            lastEventAt: Date.now(),
          },
        },
      };
    }

    case 'fleetBudgetExtended': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            extensions: action.totalExtensions,
            lastEventAt: Date.now(),
          },
        },
      };
    }

    case 'fleetCtxPct': {
      const cur = state.fleet[action.id];
      if (!cur) return state;
      const ctxPct = clampContextLoad(action.load);
      if (
        Object.is(cur.ctxPct, ctxPct) &&
        Object.is(cur.ctxTokens, action.tokens) &&
        Object.is(cur.ctxMaxTokens, action.maxContext) &&
        Object.is(cur.ctxCost, action.ctxCost)
      ) {
        return state;
      }
      return {
        ...state,
        fleet: {
          ...state.fleet,
          [action.id]: {
            ...cur,
            ctxPct,
            ctxTokens: action.tokens,
            ctxMaxTokens: action.maxContext,
            ctxCost: action.ctxCost,
            lastEventAt: Date.now(),
          },
        },
      };
    }

    case 'fleetCost': {
      const fcAction = action as Action & {
        id?: string;
        cost: number;
        input?: number;
        output?: number;
        perAgent?: Record<string, { cost: number }>;
      };
      const curId = fcAction.id;
      const perAgent = fcAction.perAgent;
      let fleet = state.fleet;
      let fleetChanged = false;
      const updateAgentCost = (agentId: string, cost: number): void => {
        const entry = fleet[agentId];
        if (!entry || Object.is(entry.cost, cost)) return;
        if (!fleetChanged) {
          fleet = { ...fleet };
          fleetChanged = true;
        }
        fleet[agentId] = { ...entry, cost, lastEventAt: Date.now() };
      };
      if (curId) updateAgentCost(curId, fcAction.cost);
      if (perAgent) {
        for (const [agentId, agentCost] of Object.entries(perAgent)) {
          updateAgentCost(agentId, agentCost.cost);
        }
      }
      const nextInput = fcAction.input ?? state.fleetTokens.input;
      const nextOutput = fcAction.output ?? state.fleetTokens.output;
      const tokensChanged =
        !Object.is(nextInput, state.fleetTokens.input) ||
        !Object.is(nextOutput, state.fleetTokens.output);
      if (!fleetChanged && !tokensChanged && Object.is(fcAction.cost, state.fleetCost)) {
        return state;
      }
      return {
        ...state,
        fleet,
        fleetCost: fcAction.cost,
        fleetTokens: tokensChanged ? { input: nextInput, output: nextOutput } : state.fleetTokens,
      };
    }

    case 'fleetConcurrency':
      return { ...state, fleetConcurrency: action.n };

    case 'fleetBatch':
      // fleetBatch is handled below — keep it here for grouping, no-op.
      return state;

    // ── Leader ────────────────────────────────────────────────────────────
    case 'leaderIterStart': {
      return {
        ...state,
        leader: {
          ...state.leader,
          iterations: state.leader.iterations + 1,
          iterating: true,
          lastEventAt: Date.now(),
        },
      };
    }

    case 'leaderIterEnd': {
      return {
        ...state,
        leader: { ...state.leader, iterating: false, lastEventAt: Date.now() },
      };
    }

    case 'leaderToolStart': {
      return {
        ...state,
        leader: {
          ...state.leader,
          currentTool: { name: action.name, startedAt: Date.now() },
          lastEventAt: Date.now(),
        },
      };
    }

    case 'leaderToolEnd': {
      const now = Date.now();
      const recentTools = [
        ...state.leader.recentTools,
        { name: action.name, ok: action.ok, durationMs: action.durationMs, at: now },
      ].slice(-8);
      return {
        ...state,
        leader: {
          ...state.leader,
          currentTool: undefined,
          toolCalls: state.leader.toolCalls + 1,
          recentTools,
          lastEventAt: now,
        },
      };
    }

    case 'leaderCtxPct': {
      const ctxPct = clampContextLoad(action.load);
      return {
        ...state,
        leader: {
          ...state.leader,
          ctxPct,
          ctxTokens: action.tokens,
          ctxMaxTokens: action.maxContext,
          lastEventAt: Date.now(),
        },
      };
    }

    case 'setFleetChat':
      return { ...state, fleetChat: action.mode };

    default:
      return null; // not a fleet/leader action
  }
}
