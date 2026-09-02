/**
 * Labels and clocks for the Control plane.
 *
 * A command is dispatched at a *client*, but operators think in terms of
 * "which machine, which project, which terminal" — `controlClientLabel`
 * reconstructs that path from the snapshot so the target picker reads like the
 * fleet, not like a list of opaque ids.
 */
import type { HqClientRecord, HqSnapshot } from '@wrongstack/core/hq';

export function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
}

export function controlClientLabel(client: HqClientRecord, snapshot: HqSnapshot | null): string {
  const project = snapshot?.projects.find((candidate) => candidate.projectId === client.projectId);
  const session = (snapshot?.liveSessions ?? []).find(
    (candidate) =>
      candidate.clientId === client.clientId ||
      (candidate.machineId === client.machineId &&
        candidate.projectId === client.projectId &&
        candidate.pid !== undefined &&
        candidate.pid === client.pid),
  );
  const host = client.hostname ?? client.machineId;
  const projectName = project?.projectName ?? client.projectId;
  const process = `${client.kind.toUpperCase()}${client.pid !== undefined ? ` · pid ${client.pid}` : ''}`;
  const identity = session?.sessionId ?? client.clientId;
  return `${host} › ${projectName} › ${process} › ${shortId(identity)}`;
}

/**
 * "12s ago" / "3m ago", falling back to a clock time past the hour. Audit rows
 * are about recency; an absolute timestamp forces the reader to subtract.
 *
 * The unix epoch is a "never happened" sentinel, not a 1970 event — the HQ
 * kanban store returns `new Date(0).toISOString()` for a project that has
 * never published a board, and rendering that as a wall clock claimed the
 * board had just synced at 03:00.
 */
export function relativeTime(timestamp: string, now = Date.now()): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  if (date.getTime() <= 0) return 'never';
  const delta = Math.max(0, now - date.getTime());
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return date.toLocaleTimeString();
}
