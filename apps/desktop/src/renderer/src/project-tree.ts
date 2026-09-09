/**
 * The sidebar's Projects -> Sessions model.
 *
 * Kept as pure functions over a snapshot so the tree can be tested without
 * mounting anything. The shell previously had three competing panels
 * (workspace / projects / quick) each rendering its own slice of the same
 * data; this is the single list they collapse into.
 *
 * A project appears here if it is registered, recent, or has a runtime — one
 * row per project ROOT, not per runtime. Several runtimes on the same root
 * (the shell allows it) share a row and contribute their combined status.
 */
import type { DesktopRuntimeRecord, DesktopStateSnapshot } from '../../shared/types.js';

/** What the status dot on a project row means. */
export type ProjectStatus = 'running' | 'starting' | 'error' | 'stopped';

export interface ProjectNode {
  /** Absolute project root — the row's identity and the session-list key. */
  root: string;
  name: string;
  status: ProjectStatus;
  /** Runtimes on this root, newest first. Empty for a project that is not open. */
  runtimes: DesktopRuntimeRecord[];
  /** The runtime a click on the row should activate, if any. */
  primaryRuntimeId: string | null;
  /** True when one of this project's runtimes is the active one. */
  active: boolean;
  /** Registered in the global manifest, as opposed to merely recent. */
  registered: boolean;
}

/** Windows paths differ only by case and separator; compare on a normal form. */
function rootKey(root: string): string {
  return root
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

function displayName(root: string, fallback?: string): string {
  if (fallback?.trim()) return fallback;
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts.at(-1) || root;
}

/**
 * Combine several runtimes on one root into the row's status.
 *
 * Order matters and is deliberate: an error is the thing the user needs to
 * see, then work in progress, then a healthy runtime. A project whose only
 * runtime errored must not read as "stopped".
 */
function combineStatus(runtimes: readonly DesktopRuntimeRecord[]): ProjectStatus {
  if (runtimes.some((r) => r.status === 'error')) return 'error';
  if (runtimes.some((r) => r.status === 'starting')) return 'starting';
  if (runtimes.some((r) => r.status === 'running')) return 'running';
  return 'stopped';
}

/**
 * Build the project rows for a snapshot.
 *
 * Ordering: open projects first (a running project is what the user is working
 * in), then the rest by most recently seen. Within each group, name order, so
 * the list does not reshuffle as statuses change.
 */
export function buildProjectTree(snapshot: DesktopStateSnapshot): ProjectNode[] {
  const byRoot = new Map<string, ProjectNode>();

  const upsert = (root: string, name: string | undefined, registered: boolean): ProjectNode => {
    const key = rootKey(root);
    const existing = byRoot.get(key);
    if (existing) {
      if (registered) existing.registered = true;
      return existing;
    }
    const node: ProjectNode = {
      root,
      name: displayName(root, name),
      status: 'stopped',
      runtimes: [],
      primaryRuntimeId: null,
      active: false,
      registered,
    };
    byRoot.set(key, node);
    return node;
  };

  for (const project of snapshot.registeredProjects) upsert(project.root, project.name, true);
  for (const project of snapshot.recentProjects) upsert(project.root, project.name, false);

  for (const runtime of snapshot.runtimes) {
    // A runtime for a root nobody registered still deserves a row — otherwise
    // an ad-hoc "open folder" would start something the sidebar never shows.
    const node = upsert(runtime.root, runtime.name, false);
    node.runtimes.push(runtime);
    if (runtime.id === snapshot.activeRuntimeId) node.active = true;
  }

  const nodes = [...byRoot.values()];
  for (const node of nodes) {
    node.runtimes.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    node.status = combineStatus(node.runtimes);
    // Prefer the active runtime, then a running one, then whatever exists —
    // clicking a row should land on something usable.
    node.primaryRuntimeId =
      node.runtimes.find((r) => r.id === snapshot.activeRuntimeId)?.id ??
      node.runtimes.find((r) => r.status === 'running')?.id ??
      node.runtimes[0]?.id ??
      null;
  }

  const lastSeen = new Map<string, string>();
  for (const project of [...snapshot.registeredProjects, ...snapshot.recentProjects]) {
    const key = rootKey(project.root);
    const seen = project.lastSeen ?? '';
    if (seen > (lastSeen.get(key) ?? '')) lastSeen.set(key, seen);
  }

  return nodes.sort((a, b) => {
    const aOpen = a.runtimes.length > 0 ? 0 : 1;
    const bOpen = b.runtimes.length > 0 ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    const aSeen = lastSeen.get(rootKey(a.root)) ?? '';
    const bSeen = lastSeen.get(rootKey(b.root)) ?? '';
    if (aSeen !== bSeen) return bSeen.localeCompare(aSeen);
    return a.name.localeCompare(b.name);
  });
}

/**
 * Filter the tree by a free-text query over project name and path.
 *
 * An empty query returns the input unchanged (same array identity) so a
 * memoised list does not re-render when the filter is cleared.
 */
export function filterProjectTree(nodes: ProjectNode[], query: string): ProjectNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return nodes;
  return nodes.filter(
    (node) => node.name.toLowerCase().includes(q) || node.root.toLowerCase().includes(q),
  );
}

/** Short, locale-independent relative time for a session row. */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w`;
  return `${Math.round(days / 30)}mo`;
}
