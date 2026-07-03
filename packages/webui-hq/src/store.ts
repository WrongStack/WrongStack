/**
 * HQ dashboard store — a lightweight React-based global store (no zustand
 * dependency). Holds the latest snapshot, recent events, active alerts, and
 * UI state (selected node, active view). Subscribes to the WS client once.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { HqAlertMessage, HqEventEnvelope, HqSnapshot } from '@wrongstack/core';
import { getHqClient } from './lib/hq-ws-client.js';

export type ViewId =
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
  activeView: 'fleet',
  selectedSessionId: null,
  selectedClientId: null,
  connected: false,
};

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshotState(): HqState {
  return state;
}

function setState(patch: Partial<HqState>): void {
  state = { ...state, ...patch };
  notify();
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

export function useHqStore(): HqState {
  useEffect(() => {
    wireClient();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshotState, getSnapshotState);
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
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export async function postCommand(clientId: string, type: string, payload: unknown): Promise<{ commandId: string; queued: boolean }> {
  const res = await fetch('/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, type, payload }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `${res.status}`);
  }
  return (await res.json()) as { commandId: string; queued: boolean };
}
