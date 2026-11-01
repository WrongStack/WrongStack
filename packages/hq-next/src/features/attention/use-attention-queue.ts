'use client';

/**
 * The attention queue as a hook. The shell badge, the Overview and the Inbox
 * all call this, so the number on the rail is always the length of the list
 * the operator lands on.
 */
import { fetchJson } from '@hq/data/api';
import { useHqStore } from '@hq/data/store/index';
import { type PendingApproval, usePendingApprovals } from '@hq/domain/use-pending-approvals';
import { type PendingUserInput, usePendingUserInputs } from '@hq/domain/use-pending-user-inputs';
import type { HqAlert } from '@wrongstack/hq';
import { useMemo, useSyncExternalStore } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { inScope } from '../../lib/scope';
import { useFleetScope } from '../../lib/use-scope';
import { type AttentionItem, buildAttentionItems } from './model';

/** Alert rules are evaluated on the server's cadence; 15s is well inside it. */
const ACTIVE_ALERTS_POLL_MS = 15_000;

/**
 * One poller for `/api/alerts`, shared by every subscriber and stopped when
 * the last one unmounts — three mounted consumers must not mean three timers.
 */
const activeAlerts = (() => {
  let value: readonly HqAlert[] = [];
  let timer: number | undefined;
  const listeners = new Set<() => void>();
  const load = (): void => {
    fetchJson<{ active: HqAlert[] }>('/api/alerts')
      .then((response) => {
        value = response.active;
        for (const listener of listeners) listener();
      })
      .catch(() => {
        // Advisory: the live feed still carries new alerts; a 401 already
        // raised the auth gate inside fetchJson.
      });
  };
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) {
        load();
        timer = window.setInterval(load, ACTIVE_ALERTS_POLL_MS);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) window.clearInterval(timer);
      };
    },
    get: (): readonly HqAlert[] => value,
  };
})();

const NO_ALERTS: readonly HqAlert[] = [];

export interface AttentionQueue {
  /** Items inside the operator's scope (all of them when unscoped). */
  items: readonly AttentionItem[];
  /** Items the scope hides — counted so they are never silently missed. */
  outside: readonly AttentionItem[];
  approvals: readonly PendingApproval[];
  questions: readonly PendingUserInput[];
  approvalsLoading: boolean;
}

/**
 * `scoped: false` ignores the operator's scope; the phone has no scope picker,
 * so it must never inherit a narrowing chosen on the desktop.
 */
export function useAttentionQueue({ scoped = true }: { scoped?: boolean } = {}): AttentionQueue {
  const scope = useFleetScope();
  const { snapshot, alerts, commandStatuses } = useHqStore(
    useShallow((state) => ({
      snapshot: state.snapshot,
      alerts: state.alerts,
      commandStatuses: state.commandStatuses,
    })),
  );
  const { approvals, loading } = usePendingApprovals();
  const questions = usePendingUserInputs();
  const firing = useSyncExternalStore(activeAlerts.subscribe, activeAlerts.get, () => NO_ALERTS);

  const items = useMemo(
    () =>
      buildAttentionItems({
        snapshot,
        approvals,
        questions,
        alerts,
        activeAlerts: firing,
        commands: commandStatuses,
      }),
    [snapshot, approvals, questions, alerts, firing, commandStatuses],
  );
  const split = useMemo(() => {
    if (!scoped || scope.kind === 'all') return { inside: items, outside: [] };
    const inside: AttentionItem[] = [];
    const outside: AttentionItem[] = [];
    for (const item of items) {
      (inScope(item.origin ?? {}, scope, snapshot) ? inside : outside).push(item);
    }
    return { inside, outside };
  }, [items, scoped, scope, snapshot]);
  return {
    items: split.inside,
    outside: split.outside,
    approvals,
    questions,
    approvalsLoading: loading,
  };
}
