import {
  reduceStreamActivity,
  type StreamActivity,
  startStreamActivity,
} from '@wrongstack/contracts/types/stream-activity';
import { createContext, type Dispatch, useContext, useEffect, useReducer, useRef } from 'react';
import type { Action } from './app-action-type.js';
import {
  MAX_ASSISTANT_STREAM_RETAINED_CHARS,
  MAX_TOOL_STREAM_RETAINED_CHARS,
  retainStreamTail,
} from './reducers/helpers.js';

/** Live tail of the tool whose output is streaming right now. */
export interface LiveToolStream {
  toolUseId: string;
  name: string;
  text: string;
  startedAt: number;
}

/**
 * The per-flush slice of TUI state: the assistant's live tail, the streaming
 * tool's live tail, and the activity line's counters.
 *
 * These change many times a second while a model writes. They used to live in
 * the root reducer, so every stream flush re-rendered the whole App: the
 * controller hooks, the composer, the status bar and every panel. Here they
 * sit beside the root state, and only the components that draw them subscribe.
 */
export interface LiveStreamState {
  streamingText: string;
  streamActivity: StreamActivity | null;
  toolStream: LiveToolStream | null;
  /** Mirror of the run status, kept only to tell a run's first status apart. */
  status: 'idle' | 'running' | 'streaming' | 'aborting';
}

export const EMPTY_LIVE_STREAM: LiveStreamState = Object.freeze({
  streamingText: '',
  streamActivity: null,
  toolStream: null,
  status: 'idle',
});

/**
 * Actions the root reducer never needs to see. Everything else the live
 * reducer handles (`status`, `toolStarted`, `clearHistory`) changes root state
 * too and goes to both.
 */
const LIVE_ONLY_ACTION_TYPES: ReadonlySet<Action['type']> = new Set<Action['type']>([
  'streamDelta',
  'streamReset',
  'streamActivityFrame',
  'toolStreamAppend',
  'toolStreamClear',
]);

export function isLiveStreamOnlyAction(action: Action): boolean {
  return LIVE_ONLY_ACTION_TYPES.has(action.type);
}

/** Pure transition for the live slice. Returns the same object when nothing changed. */
export function reduceLiveStream(state: LiveStreamState, action: Action): LiveStreamState {
  switch (action.type) {
    case 'streamDelta':
      return {
        ...state,
        streamActivity: reduceStreamActivity(state.streamActivity, {
          type: 'provider.text_delta',
          payload: { text: action.delta },
        }),
        streamingText: retainStreamTail(
          state.streamingText,
          action.delta,
          MAX_ASSISTANT_STREAM_RETAINED_CHARS,
        ),
      };
    case 'streamReset':
      return state.streamingText === '' ? state : { ...state, streamingText: '' };
    case 'streamActivityFrame':
      return {
        ...state,
        streamActivity: reduceStreamActivity(state.streamActivity, action.frame),
      };
    case 'status':
      // Going idle means the stream has finished: stamp the activity line's
      // end and drop the tool tail. A tool cancelled mid-flight never emits
      // `tool.executed`, so nothing else would clear it.
      if (action.status === 'idle') {
        const activity = state.streamActivity;
        const ended = activity ? { ...activity, endedAt: activity.endedAt ?? Date.now() } : null;
        if (state.status === 'idle' && state.toolStream === null && activity?.endedAt != null) {
          return state;
        }
        return { ...state, status: 'idle', streamActivity: ended, toolStream: null };
      }
      return {
        ...state,
        status: action.status,
        streamActivity:
          state.status === 'idle' ? startStreamActivity(Date.now()) : state.streamActivity,
      };
    case 'toolStarted':
      // Surface the call immediately; partial output may never be emitted.
      return {
        ...state,
        toolStream: { toolUseId: action.id, name: action.name, text: '', startedAt: Date.now() },
      };
    case 'toolStreamAppend': {
      // Only one tool's stream is shown at a time. If a different tool is
      // currently streaming, switch: whatever just produced output is what
      // is visible.
      const cur = state.toolStream;
      if (cur && cur.toolUseId === action.toolUseId) {
        // Keep only the tail: the live box renders just the last few lines,
        // and a chatty long-running command would otherwise grow the string
        // into the tens of MB.
        return {
          ...state,
          toolStream: {
            ...cur,
            text: retainStreamTail(cur.text, action.text, MAX_TOOL_STREAM_RETAINED_CHARS),
          },
        };
      }
      return {
        ...state,
        toolStream: {
          toolUseId: action.toolUseId,
          name: action.name,
          // The first partial-output event can itself be an oversized chunk.
          text: retainStreamTail('', action.text, MAX_TOOL_STREAM_RETAINED_CHARS),
          startedAt: action.startedAt,
        },
      };
    }
    case 'toolStreamClear': {
      const cur = state.toolStream;
      if (cur === null) return state;
      // Clear only when the finishing tool matches the streaming one. A stale
      // `tool.executed` for a different tool must not blank the visible stream.
      if (action.toolUseId !== undefined && action.toolUseId !== cur.toolUseId) return state;
      if (action.name !== undefined && action.toolUseId === undefined && action.name !== cur.name)
        return state;
      return { ...state, toolStream: null };
    }
    case 'clearHistory':
      return state === EMPTY_LIVE_STREAM ? state : EMPTY_LIVE_STREAM;
    case 'fleetBatch':
      return action.actions.reduce(reduceLiveStream, state);
    default:
      return state;
  }
}

/** Holds the live slice outside React and tells its readers when it changes. */
export class LiveStreamStore {
  private state: LiveStreamState = EMPTY_LIVE_STREAM;
  private readonly listeners = new Set<() => void>();

  get(): LiveStreamState {
    return this.state;
  }

  dispatch(action: Action): void {
    const next = reduceLiveStream(this.state, action);
    if (next === this.state) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** A store nothing ever writes to, for readers outside a mounted App. */
const DETACHED_STORE = new LiveStreamStore();

// The store rides on the dispatch function it was paired with, so code that
// already holds `dispatch` (key routes, activity sampling) reaches the live
// slice without another parameter threaded through every wiring hook.
const storeByDispatch = new WeakMap<Dispatch<Action>, LiveStreamStore>();

/**
 * Pair a root dispatch with a live store. The returned dispatch feeds every
 * action to the store and forwards to the root reducer only what the root
 * still owns, so a stream flush no longer schedules a root render.
 */
export function createLiveStreamDispatch(
  rootDispatch: Dispatch<Action>,
  store: LiveStreamStore,
): Dispatch<Action> {
  const dispatch: Dispatch<Action> = (action) => {
    store.dispatch(action);
    if (!isLiveStreamOnlyAction(action)) rootDispatch(action);
  };
  storeByDispatch.set(dispatch, store);
  return dispatch;
}

/** The live store paired with `dispatch`, or an always-empty one. */
export function liveStreamStoreOf(dispatch: Dispatch<Action>): LiveStreamStore {
  return storeByDispatch.get(dispatch) ?? DETACHED_STORE;
}

export const LiveStreamContext = createContext<LiveStreamStore>(DETACHED_STORE);

/**
 * Read a selected value from the live store and re-render when it changes.
 *
 * A plain state update rather than `useSyncExternalStore`: the bridge clears
 * the live tail and commits the finished entry to the root reducer in the
 * same tick, and both must land in one frame. Scheduling this update the same
 * way as the root dispatch keeps the two in one lane by construction, instead
 * of relying on how React interleaves a synchronous store update with it.
 * `live-stream-store.test.tsx` holds the single-frame handoff.
 */
export function useLiveStream<T>(selector: (state: LiveStreamState) => T): T {
  return useLiveStreamFrom(useContext(LiveStreamContext), selector);
}

/** `useLiveStream` against an explicit store instead of the context one. */
export function useLiveStreamFrom<T>(
  store: LiveStreamStore,
  selector: (state: LiveStreamState) => T,
): T {
  const [, rerender] = useReducer((tick: number) => tick + 1, 0);
  const value = selector(store.get());
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    const check = (): void => {
      if (!Object.is(selectorRef.current(store.get()), valueRef.current)) rerender();
    };
    // The store may have moved between this render and the subscription.
    check();
    return store.subscribe(check);
  }, [store]);
  return value;
}
