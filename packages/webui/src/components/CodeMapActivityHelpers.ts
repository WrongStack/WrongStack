import type { FileActivity } from '@/stores/codemap-activity-store';
import type { CodeMapGraphResponse, GraphNodeData } from './codemap-model';
import { normalizedPath } from './codemap-model';

/** Stable, allocation-light fingerprint for fitView — avoids joining every id. */
export function hashGraphStructure(graph: CodeMapGraphResponse): string {
  let h = 2166136261;
  const mix = (value: string): void => {
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  };
  for (const node of graph.nodes) mix(node.id);
  for (const edge of graph.edges) {
    mix(edge.source);
    mix(edge.target);
    mix(edge.refType);
    h ^= edge.weight | 0;
    h = Math.imul(h, 16777619);
  }
  return `${graph.nodes.length}:${graph.edges.length}:${h >>> 0}`;
}

export function touchClientGraphCache(
  cache: Map<string, CodeMapGraphResponse>,
  key: string,
  graph: CodeMapGraphResponse,
  maxEntries: number,
): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, graph);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function sameFile(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = normalizedPath(left);
  const b = normalizedPath(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function packageForFile(filePath: string): string {
  const normalized = normalizedPath(filePath);
  const packageMatch = normalized.match(/\/packages\/([^/]+)\//);
  if (packageMatch?.[1]) return `@wrongstack/${packageMatch[1]}`;
  const appMatch = normalized.match(/\/apps\/([^/]+)\//);
  if (appMatch?.[1]) return `app:${appMatch[1]}`;
  return '(root)';
}

export function activityMatchesNode(activity: FileActivity, node: GraphNodeData): boolean {
  if (node.kind === 'package') {
    return packageForFile(activity.filePath) === (node.package ?? node.label);
  }
  if (!sameFile(activity.filePath, node.file)) return false;
  if (node.kind !== 'symbol') return true;
  return activity.symbol?.id === node.id;
}

function groupActivitiesByNormalizedPath(activities: FileActivity[]): Map<string, FileActivity[]> {
  const map = new Map<string, FileActivity[]>();
  for (const activity of activities) {
    const key = normalizedPath(activity.filePath);
    const list = map.get(key);
    if (list) list.push(activity);
    else map.set(key, [activity]);
  }
  return map;
}

/**
 * Map node id → matching live activities without O(nodes × activities) path
 * scans on every rebuild. Exact path hits are O(1); package nodes and path
 * suffix mismatches fall back to a smaller scan.
 */
export function indexActivitiesByNode(
  nodes: GraphNodeData[],
  activities: FileActivity[],
): Map<string, FileActivity[]> {
  const result = new Map<string, FileActivity[]>();
  if (activities.length === 0 || nodes.length === 0) return result;

  const byPath = groupActivitiesByNormalizedPath(activities);
  const packageCache = new Map<string, FileActivity[]>();

  for (const node of nodes) {
    let matched: FileActivity[];
    if (node.kind === 'package') {
      const pkg = node.package ?? node.label;
      let cached = packageCache.get(pkg);
      if (!cached) {
        cached = activities.filter((activity) => packageForFile(activity.filePath) === pkg);
        packageCache.set(pkg, cached);
      }
      matched = cached;
    } else if (node.file) {
      const nodeNorm = normalizedPath(node.file);
      let fileActs = byPath.get(nodeNorm);
      if (!fileActs) {
        fileActs = [];
        for (const [path, acts] of byPath) {
          if (path.endsWith(`/${nodeNorm}`) || nodeNorm.endsWith(`/${path}`)) {
            fileActs.push(...acts);
          }
        }
      }
      matched =
        node.kind === 'symbol'
          ? fileActs.filter((activity) => activity.symbol?.id === node.id)
          : fileActs;
    } else {
      matched = [];
    }
    if (matched.length > 0) result.set(node.id, matched);
  }
  return result;
}

export function activityFingerprint(activities: FileActivity[]): string {
  if (activities.length === 0) return '';
  // Stable, cheap signature for throttle decisions — not a full deep hash.
  let out = `${activities.length}`;
  for (let i = 0; i < activities.length; i++) {
    const a = activities[i]!;
    out += `|${a.id ?? ''}:${a.toolUseId ?? ''}:${a.filePath}:${a.type}:${a.status ?? ''}:${a.symbol?.id ?? ''}:${a.timestamp}`;
  }
  return out;
}

export function resolveSymbolForActivity(
  activity: FileActivity,
  nodes: GraphNodeData[],
): GraphNodeData | undefined {
  const localSymbols = nodes.filter(
    (node) => node.kind === 'symbol' && !node.external && sameFile(node.file, activity.filePath),
  );
  if (localSymbols.length === 0) return undefined;
  if (activity.line) {
    return (
      [...localSymbols]
        .sort((left, right) => (right.line ?? 0) - (left.line ?? 0))
        .find((node) => (node.line ?? 0) <= activity.line!) ?? localSymbols[0]
    );
  }
  const summary = activity.summary.toLocaleLowerCase();
  return localSymbols.find(
    (node) =>
      node.label.length > 2 &&
      (summary.includes(node.label.toLocaleLowerCase()) ||
        Boolean(node.signature && summary.includes(node.signature.toLocaleLowerCase()))),
  );
}
