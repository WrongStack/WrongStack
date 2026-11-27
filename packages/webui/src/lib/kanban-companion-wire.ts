import { safeId } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useKanbanCompanionStore } from '@/stores/kanban-companion-store';

/**
 * Wire adapter for the project-wide Kanban Companion switch:
 * `kanban.companion.get` / `kanban.companion.set` → `kanban.companion.status`.
 *
 * The reply type differs from the request type and the server ALSO broadcasts
 * status frames with NO requestId after another client flips the switch, so
 * correlation works in two lanes:
 * - frames carrying our latest requestId (direct reply to get or set);
 * - requestId-less broadcasts, applied only once the CURRENT scope is
 *   hydrated — a broadcast from the previous project (each host process
 *   serves one workspace) must never seed the switch after a project switch.
 *
 * Non-optimistic by construction: nothing writes `enabled` ahead of a server
 * frame, and a second toggle while one write is in flight is ignored. Scope
 * keys come from `useKanbanCompanion` (connection generation + project root),
 * so a reconnect or a project switch re-syncs from the server.
 */

interface KanbanCompanionStatusPayload {
  success?: unknown;
  data?: { enabled?: unknown } | undefined;
  error?: unknown;
  requestId?: unknown;
}

let scopeEpoch = 0;
let activeScope: string | null = null;
let latestRequestId = '';
let pendingSetRequestId: string | null = null;
/** A successful status frame for the current scope has been applied. */
let hydrated = false;
/** A get is outstanding for the current scope (dedupes multi-component mounts). */
let awaitingGet = false;

function nextRequestId(): string {
  return `kanban-companion-${scopeEpoch}_${safeId()}`;
}

/**
 * Enter a scope: reset correlation state, clear the UI, and ask the server.
 * Re-entering the same scope is a no-op while its answer is awaited or its
 * state is already fresh — several surfaces share the hook and must not
 * stampede the server with duplicate gets.
 */
export function syncKanbanCompanionScope(scopeKey: string): void {
  if (scopeKey === activeScope && (hydrated || awaitingGet)) return;
  scopeEpoch += 1;
  activeScope = scopeKey;
  hydrated = false;
  awaitingGet = true;
  pendingSetRequestId = null;
  const store = useKanbanCompanionStore.getState();
  store.setEnabled(null);
  store.setPending(false);
  store.setError(null);
  latestRequestId = nextRequestId();
  getWSClient().send({ type: 'kanban.companion.get', payload: { requestId: latestRequestId } });
}

/** Non-optimistic write: request the flip, mirror the switch only on the reply. */
export function setKanbanCompanionEnabled(next: boolean): void {
  if (!activeScope || pendingSetRequestId) return;
  latestRequestId = nextRequestId();
  pendingSetRequestId = latestRequestId;
  const store = useKanbanCompanionStore.getState();
  store.setPending(true);
  store.setError(null);
  getWSClient().send({
    type: 'kanban.companion.set',
    payload: { enabled: next, requestId: latestRequestId },
  });
}

/** `kanban.companion.status` handler: correlated reply or scope-checked broadcast. */
export function handleKanbanCompanionStatus(payload: unknown): void {
  const p = (payload ?? {}) as KanbanCompanionStatusPayload;

  if (typeof p.requestId === 'string') {
    // A direct reply. Anything not matching the newest request is stale —
    // superseded by a later get/set, or answered by the previous scope.
    if (p.requestId !== latestRequestId) return;
    awaitingGet = false;
    // If a set was outstanding, this frame IS its reply: it settles the
    // blocked switch on success and failure alike.
    const settlesSet = pendingSetRequestId !== null;
    if (applySuccess(p)) {
      hydrated = true;
    }
    if (settlesSet) {
      pendingSetRequestId = null;
      useKanbanCompanionStore.getState().setPending(false);
    }
    // A failed get keeps `hydrated` false so a foreign broadcast cannot seed
    // an unknown scope; the next scope entry (remount, reconnect, project
    // switch) retries.
    return;
  }

  // requestId-less broadcast from the server. Only trust it for a hydrated
  // scope, otherwise a late frame from the previous project could overwrite
  // the new one before its first get replies.
  if (!hydrated) return;
  applySuccess(p);
}

/** Applies a success frame; false when success/data.enabled is malformed. */
function applySuccess(p: KanbanCompanionStatusPayload): boolean {
  const enabled = p.data?.['enabled'];
  if (p.success !== true || typeof enabled !== 'boolean') {
    useKanbanCompanionStore
      .getState()
      .setError(typeof p.error === 'string' && p.error ? p.error : '');
    return false;
  }
  const store = useKanbanCompanionStore.getState();
  store.setEnabled(enabled);
  store.setError(null);
  return true;
}
