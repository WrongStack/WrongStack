/**
 * HQ dashboard store — a lightweight React-based global store (no zustand
 * dependency). Holds the latest snapshot, recent events, active alerts, and
 * UI state (selected node, active view). Subscribes to the WS client once.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { HqAlertMessage, HqEventEnvelope, HqSnapshot } from '@wrongstack/core';
import { getHqClient } from './lib/hq-ws-client.js';

export type ViewId =
  | 'cockpit'
  | 'fleet'
  | 'console'
  | 'mailbox'
  | 'cost'
  | 'brain'
  | 'worktree'
  | 'trends'
  | 'alerts'
  | 'control';

interface HqState {
  snapshot: HqSnapshot | null;
  events: HqEventEnvelope[];
  alerts: HqAlertMessage[];
  activeView: ViewId;
  selectedSessionId: string | null;
  selectedClientId: string | null;
  connected: boolean;
}

const MAX_EVENTS = 500;
const MAX_ALERTS = 100;

let state: HqState = {
  snapshot: null,
  events: [],
  alerts: [],
  activeView: 'cockpit',
  selectedSessionId: null,
  selectedClientId: null,
  connected: false,
};

const listeners = new Set<() => void>();
/** Maps each listener to the keys it cares about (null = all keys). */
const listenerKeys = new Map<() => void, string[] | null>();

function notify(changedKeys: string[]): void {
  // Only invoke listeners whose key filter intersects the changed keys.
  // Listeners registered without a filter (null) are always notified.
  for (const l of listeners) {
    const keys = listenerKeys.get(l);
    if (keys == null || keys.some((k) => changedKeys.includes(k))) {
      l();
    }
  }
}

function subscribe(listener: () => void, keys?: string[]): () => void {
  listeners.add(listener);
  listenerKeys.set(listener, keys ?? null);
  return () => {
    listeners.delete(listener);
    listenerKeys.delete(listener);
  };
}

function getSnapshotState(): HqState {
  return state;
}

function setState(patch: Partial<HqState>): void {
  state = { ...state, ...patch };
  notify(Object.keys(patch));
}

// ── WS wiring (once) ────────────────────────────────────────────────────────

let wired = false;
function wireClient(): void {
  if (wired) return;
  wired = true;
  const client = getHqClient();
  client.on((msg) => {
    if (msg.type === 'hq.snapshot') {
      setState({ snapshot: msg.snapshot, connected: true });
    } else if (msg.type === 'hq.event') {
      setState({ events: [...state.events, msg.event].slice(-MAX_EVENTS) });
    } else if (msg.type === 'hq.alert') {
      setState({ alerts: [...state.alerts, msg].slice(-MAX_ALERTS) });
    }
  });
}

// ── Hooks ───────────────────────────────────────────────────────────────────

export function useHqStore(keys?: string[]): HqState {
  useEffect(() => {
    wireClient();
  }, []);
  return useSyncExternalStore((cb) => subscribe(cb, keys), getSnapshotState, getSnapshotState);
}

export function setActiveView(view: ViewId): void {
  setState({ activeView: view });
}

export function selectSession(sessionId: string | null): void {
  setState({ selectedSessionId: sessionId });
}

export function selectClient(clientId: string | null): void {
  setState({ selectedClientId: clientId });
}

// ── API helpers ─────────────────────────────────────────────────────────────

export async function fetchJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path);
  } catch {
    throw new Error(`Network error fetching ${path}`);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`Invalid JSON response from ${path}: ${res.status}`);
  }
}

export async function postCommand(
  clientId: string,
  type: string,
  payload: unknown,
): Promise<{ commandId: string; queued: boolean }> {
  let res: Response;
  try {
    res = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, type, payload }),
    });
  } catch {
    throw new Error('Network error sending command');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = body?.error ?? (res.statusText || `HTTP ${res.status}`);
    throw new Error(msg);
  }
  try {
    return (await res.json()) as { commandId: string; queued: boolean };
  } catch {
    throw new Error('Invalid JSON response from command API');
  }
}
