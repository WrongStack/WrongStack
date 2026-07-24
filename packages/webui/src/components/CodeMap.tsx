/**
 * Code Atlas — persistent code tree, dependency canvas, and relation inspector.
 *
 * The explorer never disappears while the user moves package → file → symbol.
 * A graph click focuses relationships; explicit open actions change scope.
 *
 * Performance notes:
 * - Activity store is subscribed via selectors (not the whole store).
 * - React Flow rebuilds are immediate for structural changes and throttled for
 *   telemetry-only updates (see FLOW_ACTIVITY_THROTTLE_MS).
 * - SMART mode caps canvas nodes; MiniMap is gated by node count.
 */

import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeTypes,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import '@xyflow/react/dist/style.css';
import {
  Activity as ActivityIcon,
  ArrowLeft,
  Box,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileCode,
  Folder,
  FolderOpen,
  GitBranch,
  Home,
  Layers,
  Loader2,
  Network,
  Orbit,
  Package,
  Pause,
  Play,
  Radio,
  Search,
  ShieldCheck,
  Target,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '@/lib/utils';
import {
  type ActivityType,
  activityAgentKey,
  type FileActivity,
  groupAgentPresences,
  type LiveAgentPresence,
  useCodemapActivityStore,
} from '@/stores/codemap-activity-store';
import { useCodemapIndexStore } from '@/stores/codemap-index-store';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  buildDirectoryTree,
  type CodeMapGraphResponse,
  type CodeMapLayout,
  type CodeMapScope,
  connectedNodeIds,
  type DirectoryNode,
  type GraphNodeData,
  type GraphRefType,
  layoutGraph,
  relativeFilePath,
  type RelationItem,
  relationItems,
  scopeKey,
  scopeUrl,
  smartCanvasGraph,
} from './codemap-model';

const EMPTY_GRAPH: CodeMapGraphResponse = { nodes: [], edges: [] };

/** Hide MiniMap when the canvas is dense; it re-paints every node update. */
const MINIMAP_NODE_LIMIT = 48;
/** Virtualize search hits above this count. */
const SEARCH_VIRTUALIZE_THRESHOLD = 40;
/** Max animated SVG edges (live + trail). Animated paths are expensive. */
const MAX_ANIMATED_EDGES = 6;
/** Cap how many agents contribute temporal trail edges. */
const MAX_TRAIL_AGENTS = 4;
/** Cap hops per agent trail (N activities → N-1 edges). */
const MAX_TRAIL_HOPS = 6;
/** Telemetry-only React Flow rebuilds are coalesced to this cadence. */
const FLOW_ACTIVITY_THROTTLE_MS = 120;
/** Concurrent symbol-graph fetches for unresolved live tool ops. */
const MAX_SYMBOL_RESOLVE_INFLIGHT = 2;
/** Soft cap on client-side scope graphs (package/file/symbol). */
const MAX_CLIENT_GRAPH_CACHE = 48;
/** Debounce free-text search so typing does not re-scan every cached graph. */
const SEARCH_DEBOUNCE_MS = 150;
/** Cap tree rows per directory/file before a "show more" control. */
const MAX_TREE_FILES_VISIBLE = 80;
const MAX_TREE_SYMBOLS_VISIBLE = 40;

/** Stable, allocation-light fingerprint for fitView — avoids joining every id. */
function hashGraphStructure(graph: CodeMapGraphResponse): string {
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

function touchClientGraphCache(
  cache: Map<string, CodeMapGraphResponse>,
  key: string,
  graph: CodeMapGraphResponse,
): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, graph);
  while (cache.size > MAX_CLIENT_GRAPH_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

const NODE_STYLE: Record<
  GraphNodeData['kind'],
  { icon: typeof Package; accent: string; iconStyle: string }
> = {
  package: { icon: Package, accent: 'border-l-primary', iconStyle: 'bg-primary/12 text-primary' },
  file: { icon: FileCode, accent: 'border-l-info', iconStyle: 'bg-info/12 text-info' },
  symbol: { icon: Box, accent: 'border-l-success', iconStyle: 'bg-success/12 text-success' },
};

const EDGE_COLOR: Record<GraphRefType, string> = {
  call: 'hsl(var(--primary))',
  import: 'hsl(var(--info))',
  type_ref: 'hsl(var(--success))',
  inherit: 'hsl(var(--warning))',
  implement: 'hsl(var(--destructive))',
};

const ACTIVITY_GLOW: Record<ActivityType, string> = {
  read: 'ring-2 ring-info/60 shadow-info/20',
  write: 'ring-2 ring-warning/70 shadow-warning/30',
  edit: 'ring-2 ring-warning/80 shadow-warning/40',
  delete: 'ring-2 ring-destructive/70 shadow-destructive/30',
  search: 'ring-2 ring-primary/55 shadow-primary/20',
  memory: 'ring-2 ring-success/60 shadow-success/30',
  index: 'ring-2 ring-info/50 shadow-info/20',
  execute: 'ring-2 ring-primary/55 shadow-primary/25',
};

const AGENT_COLORS = [
  'bg-primary text-primary-foreground',
  'bg-info text-info-foreground',
  'bg-success text-success-foreground',
  'bg-warning text-warning-foreground',
  'bg-destructive text-destructive-foreground',
] as const;

/**
 * Module-level memo cache for `normalizedPath`. Path strings are stable
 * across renders — the same file path always normalizes to the same string —
 * so caching by the raw input is safe and eliminates the per-render regex
 * cost. `sameFile()` calls `normalizedPath` twice per comparison, and
 * `activityMatchesNode` invokes it once per activity × node pair, so the
 * total call count can reach 10K+ per render for medium graphs.
 */
const normalizedPathCache = new Map<string, string>();
function normalizedPath(filePath: string): string {
  const cached = normalizedPathCache.get(filePath);
  if (cached !== undefined) return cached;
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '').toLocaleLowerCase();
  normalizedPathCache.set(filePath, normalized);
  return normalized;
}

function sameFile(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = normalizedPath(left);
  const b = normalizedPath(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function packageForFile(filePath: string): string {
  const normalized = normalizedPath(filePath);
  const packageMatch = normalized.match(/\/packages\/([^/]+)\//);
  if (packageMatch?.[1]) return `@wrongstack/${packageMatch[1]}`;
  const appMatch = normalized.match(/\/apps\/([^/]+)\//);
  if (appMatch?.[1]) return `app:${appMatch[1]}`;
  return '(root)';
}

function activityMatchesNode(activity: FileActivity, node: GraphNodeData): boolean {
  if (node.kind === 'package') {
    return packageForFile(activity.filePath) === (node.package ?? node.label);
  }
  if (!sameFile(activity.filePath, node.file)) return false;
  if (node.kind !== 'symbol') return true;
  return activity.symbol?.id === node.id;
}

function groupActivitiesByNormalizedPath(
  activities: FileActivity[],
): Map<string, FileActivity[]> {
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
function indexActivitiesByNode(
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
        cached = activities.filter(
          (activity) => packageForFile(activity.filePath) === pkg,
        );
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

function activityFingerprint(activities: FileActivity[]): string {
  if (activities.length === 0) return '';
  // Stable, cheap signature for throttle decisions — not a full deep hash.
  let out = `${activities.length}`;
  for (let i = 0; i < activities.length; i++) {
    const a = activities[i]!;
    out += `|${a.id ?? ''}:${a.toolUseId ?? ''}:${a.filePath}:${a.type}:${a.status ?? ''}:${a.symbol?.id ?? ''}:${a.timestamp}`;
  }
  return out;
}

function agentInitials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s:_-]+/)
    .filter(Boolean);
  return (
    parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : name.slice(0, 2)
  ).toLocaleUpperCase();
}

function agentColor(key: string): (typeof AGENT_COLORS)[number] {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length] ?? AGENT_COLORS[0];
}

function agentTrailColor(key: string): string {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 82% 58%)`;
}

function shortPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const packageIndex = normalized.lastIndexOf('/packages/');
  const appIndex = normalized.lastIndexOf('/apps/');
  const start = Math.max(packageIndex, appIndex);
  return start >= 0 ? normalized.slice(start + 1) : normalized.split('/').slice(-3).join('/');
}

function activityLabel(activity: FileActivity): string {
  const symbol = activity.symbol?.name;
  const line = activity.line ? `L${activity.line}` : undefined;
  return [symbol, line].filter(Boolean).join(' · ');
}

function resolveSymbolForActivity(
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

interface CodeMapNodeData extends Record<string, unknown> {
  graphNode: GraphNodeData;
  selected: boolean;
  dimmed: boolean;
  incoming: number;
  outgoing: number;
  isActive: boolean;
  activityType?: ActivityType;
  activeOperations: FileActivity[];
  onSelect: (node: GraphNodeData) => void;
  onOpen: (node: GraphNodeData) => void;
  onShowHistory: (filePath: string) => void;
}

function CodeMapNodeView({ data }: { data: CodeMapNodeData }): React.ReactElement {
  const {
    graphNode,
    selected,
    dimmed,
    incoming,
    outgoing,
    isActive,
    activityType,
    activeOperations,
  } = data;
  const style = NODE_STYLE[graphNode.kind];
  const Icon = style.icon;
  const canOpen = graphNode.kind !== 'symbol';
  const subtitle =
    graphNode.kind === 'symbol'
      ? `${graphNode.symbolKind ?? 'symbol'}${graphNode.line ? ` · L${graphNode.line}` : ''}`
      : graphNode.kind === 'file'
        ? relativeFilePath(graphNode)
        : `${graphNode.fileCount ?? 0} files · ${graphNode.symbolCount ?? 0} symbols`;

  return (
    <div
      className={cn(
        // Avoid animating `filter` (grayscale) — composite cost on large graphs.
        'group relative w-[236px] border border-l-[3px] bg-card text-card-foreground shadow-[0_8px_24px_hsl(var(--shadow-color)/0.08)] transition-[opacity,box-shadow,border-color,background-color]',
        style.accent,
        selected &&
          'border-primary bg-primary/5 shadow-[0_0_0_2px_hsl(var(--primary)/0.18),0_16px_36px_hsl(var(--shadow-color)/0.18)]',
        graphNode.external && 'border-dashed bg-muted/75',
        dimmed && 'opacity-25 grayscale',
        isActive && activityType && ACTIVITY_GLOW[activityType],
      )}
    >
      {activeOperations.length > 0 && (
        <div className="absolute -top-5 left-2 z-20 flex max-w-[210px] items-center gap-1">
          {activeOperations.slice(0, 4).map((activity) => {
            const name = activity.agentName ?? activity.agent ?? 'External';
            const key = `${activity.sessionId ?? 'none'}:${activity.agentId ?? name}`;
            return (
              <span
                key={activity.id ?? `${key}:${activity.filePath}`}
                className={cn(
                  'flex h-6 items-center gap-1 border-2 border-background px-1.5 font-mono text-[8px] font-bold shadow-md',
                  agentColor(key),
                )}
                title={`${name} · ${activity.type} ${activityLabel(activity)}`}
              >
                <span className="h-1.5 w-1.5 animate-pulse bg-current" />
                {agentInitials(name)}
                {activity.symbol && (
                  <span className="max-w-[80px] truncate">{activity.symbol.name}</span>
                )}
              </span>
            );
          })}
          {activeOperations.length > 4 && (
            <span className="border bg-card px-1 font-mono text-[8px] shadow">
              +{activeOperations.length - 4}
            </span>
          )}
        </div>
      )}
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-2 !border-card !bg-muted-foreground"
      />
      <button
        type="button"
        className="block w-full text-left"
        onClick={(event) => {
          if (event.shiftKey && graphNode.file) {
            data.onShowHistory(graphNode.file);
            return;
          }
          data.onSelect(graphNode);
        }}
        onDoubleClick={() => canOpen && data.onOpen(graphNode)}
        aria-label={`${graphNode.kind} ${graphNode.label}`}
      >
        <div className="flex items-start gap-3 p-3 pr-10">
          <span
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center border',
              style.iconStyle,
            )}
          >
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
              <span>{graphNode.kind}</span>
              {graphNode.external && (
                <span className="border border-border px-1 py-0.5 text-[8px] text-warning">
                  external
                </span>
              )}
              {graphNode.lang && (
                <span className="ml-auto font-mono normal-case tracking-normal">
                  {graphNode.lang}
                </span>
              )}
            </div>
            <div className="truncate font-mono text-[13px] font-semibold" title={graphNode.label}>
              {graphNode.label}
            </div>
            <div className="mt-1 truncate text-[10px] text-muted-foreground" title={subtitle}>
              {subtitle}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 border-t bg-muted/30 px-3 py-1.5 font-mono text-[9px] text-muted-foreground">
          <span title="Incoming relationships">← {incoming}</span>
          <span title="Outgoing relationships">→ {outgoing}</span>
          {graphNode.symbolCount !== undefined && graphNode.kind === 'file' && (
            <span className="ml-auto">{graphNode.symbolCount} sym</span>
          )}
          {isActive && (
            <span className="ml-auto flex items-center gap-1 font-bold text-warning">
              <Radio className="h-2.5 w-2.5 animate-pulse" /> LIVE
            </span>
          )}
        </div>
      </button>
      {canOpen && (
        <button
          type="button"
          className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center border border-transparent text-muted-foreground opacity-0 transition hover:border-border hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100"
          onClick={() => data.onOpen(graphNode)}
          title={graphNode.kind === 'package' ? 'Open file map' : 'Open symbol map'}
          aria-label={`Open ${graphNode.label} map`}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-2 !border-card !bg-muted-foreground"
      />
    </div>
  );
}

function sameNodeActivities(left: FileActivity[], right: FileActivity[]): boolean {
  return left.length === right.length && left.every((activity, index) => activity === right[index]);
}

function sameCodeMapNodeData(left: CodeMapNodeData, right: CodeMapNodeData): boolean {
  return (
    left.graphNode === right.graphNode &&
    left.selected === right.selected &&
    left.dimmed === right.dimmed &&
    left.incoming === right.incoming &&
    left.outgoing === right.outgoing &&
    left.isActive === right.isActive &&
    left.activityType === right.activityType &&
    left.onSelect === right.onSelect &&
    left.onOpen === right.onOpen &&
    left.onShowHistory === right.onShowHistory &&
    sameNodeActivities(left.activeOperations, right.activeOperations)
  );
}

const CodeMapNode = memo(CodeMapNodeView, (previous, next) =>
  sameCodeMapNodeData(previous.data, next.data),
);

const nodeTypes: NodeTypes = { codemap: CodeMapNode };

function preserveFlowNodes(previous: Node[], next: Node[]): Node[] {
  const previousById = new Map(previous.map((node) => [node.id, node]));
  let changed = previous.length !== next.length;
  const merged = next.map((node, index) => {
    const current = previousById.get(node.id);
    if (!current) {
      changed = true;
      return node;
    }
    const same =
      current.type === node.type &&
      current.position.x === node.position.x &&
      current.position.y === node.position.y &&
      sameCodeMapNodeData(current.data as CodeMapNodeData, node.data as CodeMapNodeData);
    if (same) {
      if (previous[index] !== current) changed = true;
      return current;
    }
    changed = true;
    return { ...current, ...node, measured: current.measured };
  });
  return changed ? merged : previous;
}

function edgeRenderKey(edge: Edge): string | undefined {
  return (edge.data as { renderKey?: string } | undefined)?.renderKey;
}

function preserveFlowEdges(previous: Edge[], next: Edge[]): Edge[] {
  const previousById = new Map(previous.map((edge) => [edge.id, edge]));
  let changed = previous.length !== next.length;
  const merged = next.map((edge, index) => {
    const current = previousById.get(edge.id);
    if (current && edgeRenderKey(current) === edgeRenderKey(edge)) {
      if (previous[index] !== current) changed = true;
      return current;
    }
    changed = true;
    return edge;
  });
  return changed ? merged : previous;
}

interface DirectoryBranchProps {
  directory: DirectoryNode;
  packageName: string;
  depth: number;
  expandedDirectories: Set<string>;
  expandedFiles: Set<string>;
  loadingBranches: Set<string>;
  graphForFile: (filePath: string) => CodeMapGraphResponse | undefined;
  onToggleDirectory: (key: string) => void;
  onToggleFile: (node: GraphNodeData) => void;
  onSelectFile: (node: GraphNodeData) => void;
  onOpenFile: (node: GraphNodeData) => void;
  onSelectSymbol: (node: GraphNodeData) => void;
  selectedId: string | null;
  /** Normalized paths with live ops — avoids per-row activity filter scans. */
  activeFileNorms: Set<string>;
  activeSymbolIds: Set<string>;
  revealAllKeys: Set<string>;
  onRevealAll: (key: string) => void;
}

function filePathIsLive(filePath: string | undefined, activeFileNorms: Set<string>): boolean {
  if (!filePath || activeFileNorms.size === 0) return false;
  const nodeNorm = normalizedPath(filePath);
  if (activeFileNorms.has(nodeNorm)) return true;
  for (const active of activeFileNorms) {
    if (active.endsWith(`/${nodeNorm}`) || nodeNorm.endsWith(`/${active}`)) return true;
  }
  return false;
}

const DirectoryBranch = memo(function DirectoryBranch(
  props: DirectoryBranchProps,
): React.ReactElement {
  const {
    directory,
    packageName,
    depth,
    expandedDirectories,
    expandedFiles,
    loadingBranches,
    graphForFile,
    onToggleDirectory,
    onToggleFile,
    onSelectFile,
    onOpenFile,
    onSelectSymbol,
    selectedId,
    activeFileNorms,
    activeSymbolIds,
    revealAllKeys,
    onRevealAll,
  } = props;
  const filesRevealKey = `files:${packageName}:${directory.path || '.'}`;
  const showAllFiles = revealAllKeys.has(filesRevealKey);
  const visibleFiles = showAllFiles
    ? directory.files
    : directory.files.slice(0, MAX_TREE_FILES_VISIBLE);
  const hiddenFileCount = directory.files.length - visibleFiles.length;

  return (
    <>
      {directory.directories.map((child) => {
        const key = `${packageName}:${child.path}`;
        const expanded = expandedDirectories.has(key);
        return (
          <div key={key}>
            <button
              type="button"
              className="flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => onToggleDirectory(key)}
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {expanded ? (
                <FolderOpen className="h-3.5 w-3.5 text-warning" />
              ) : (
                <Folder className="h-3.5 w-3.5 text-warning" />
              )}
              <span className="truncate">{child.name}</span>
            </button>
            {expanded && <DirectoryBranch {...props} directory={child} depth={depth + 1} />}
          </div>
        );
      })}
      {visibleFiles.map((file) => {
        const expanded = expandedFiles.has(file.file ?? file.id);
        const branchKey = scopeKey({ level: 'symbols', file: file.file ?? file.label });
        const symbolGraph = file.file ? graphForFile(file.file) : undefined;
        const symbols =
          symbolGraph?.nodes.filter(
            (node) => node.kind === 'symbol' && node.file === file.file && !node.external,
          ) ?? [];
        const symbolsRevealKey = `symbols:${file.file ?? file.id}`;
        const showAllSymbols = revealAllKeys.has(symbolsRevealKey);
        const visibleSymbols = showAllSymbols
          ? symbols
          : symbols.slice(0, MAX_TREE_SYMBOLS_VISIBLE);
        const hiddenSymbolCount = symbols.length - visibleSymbols.length;
        const fileLive = filePathIsLive(file.file, activeFileNorms);
        return (
          <div key={file.id}>
            <div
              className={cn(
                'group flex h-7 items-center pr-1 text-[11px] hover:bg-muted',
                selectedId === file.id && 'bg-primary/10 text-primary',
              )}
              style={{ paddingLeft: 8 + depth * 12 }}
            >
              <button
                type="button"
                className="flex h-6 w-4 shrink-0 items-center justify-center text-muted-foreground"
                onClick={() => onToggleFile(file)}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${file.label}`}
              >
                {loadingBranches.has(branchKey) ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : expanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </button>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => onSelectFile(file)}
                onDoubleClick={() => onOpenFile(file)}
              >
                <FileCode className="h-3.5 w-3.5 shrink-0 text-info" />
                {fileLive && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 animate-pulse bg-success"
                    title="Live operation"
                  />
                )}
                <span className="truncate font-mono" title={file.file}>
                  {file.label}
                </span>
                <span className="ml-auto text-[9px] text-muted-foreground">
                  {file.symbolCount ?? 0}
                </span>
              </button>
              <button
                type="button"
                className="ml-1 hidden h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground group-hover:flex"
                onClick={() => onOpenFile(file)}
                title="Open symbol map"
                aria-label={`Open ${file.label} map`}
              >
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>
            {expanded &&
              visibleSymbols.map((symbol) => (
                <button
                  type="button"
                  key={symbol.id}
                  className={cn(
                    'flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[10px] hover:bg-muted',
                    selectedId === symbol.id
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground',
                  )}
                  style={{ paddingLeft: 38 + depth * 12 }}
                  onClick={() => onSelectSymbol(symbol)}
                >
                  <Box className="h-3 w-3 shrink-0 text-success" />
                  {activeSymbolIds.has(symbol.id) && (
                    <Radio className="h-3 w-3 shrink-0 animate-pulse text-success" />
                  )}
                  <span className="truncate font-mono">{symbol.label}</span>
                  {symbol.line && (
                    <span className="ml-auto font-mono text-[8px] opacity-60">:{symbol.line}</span>
                  )}
                </button>
              ))}
            {expanded && hiddenSymbolCount > 0 && (
              <button
                type="button"
                className="flex h-7 w-full items-center text-left font-mono text-[9px] text-primary hover:bg-muted"
                style={{ paddingLeft: 38 + depth * 12 }}
                onClick={() => onRevealAll(symbolsRevealKey)}
              >
                Show {hiddenSymbolCount} more symbols
              </button>
            )}
          </div>
        );
      })}
      {hiddenFileCount > 0 && (
        <button
          type="button"
          className="flex h-7 w-full items-center text-left font-mono text-[9px] text-primary hover:bg-muted"
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => onRevealAll(filesRevealKey)}
        >
          Show {hiddenFileCount} more files
        </button>
      )}
    </>
  );
});

interface RelationSectionProps {
  title: string;
  subtitle: string;
  items: RelationItem[];
  graph: CodeMapGraphResponse;
  selectedId: string;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  onSelect: (node: GraphNodeData) => void;
}

function RelationSection(props: RelationSectionProps): React.ReactElement {
  const { title, subtitle, items, graph, selectedId, expanded, onToggle, onSelect } = props;
  return (
    <section className="border-b py-3">
      <div className="mb-2 flex items-end justify-between px-3">
        <div>
          <h3 className="text-[10px] font-bold uppercase tracking-[0.16em]">{title}</h3>
          <p className="mt-0.5 text-[9px] text-muted-foreground">{subtitle}</p>
        </div>
        <span className="border bg-muted px-1.5 py-0.5 font-mono text-[9px]">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="px-3 py-2 text-[10px] text-muted-foreground">
          No relationships in this view.
        </p>
      ) : (
        items.map((item) => {
          const key = `${title}:${item.node.id}`;
          const isExpanded = expanded.has(key);
          const nested = [
            ...relationItems(graph, item.node.id, 'incoming'),
            ...relationItems(graph, item.node.id, 'outgoing'),
          ]
            .filter(
              (relation, index, all) =>
                relation.node.id !== selectedId &&
                all.findIndex((candidate) => candidate.node.id === relation.node.id) === index,
            )
            .slice(0, 8);
          return (
            <div key={key}>
              <div className="group flex min-h-9 items-center gap-1 px-2 hover:bg-muted/70">
                <button
                  type="button"
                  className="flex h-6 w-5 shrink-0 items-center justify-center text-muted-foreground"
                  onClick={() => nested.length > 0 && onToggle(key)}
                  aria-label={`${isExpanded ? 'Collapse' : 'Expand'} relation ${item.node.label}`}
                >
                  {nested.length > 0 ? (
                    isExpanded ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )
                  ) : (
                    <span className="h-px w-2 bg-border" />
                  )}
                </button>
                <button
                  type="button"
                  className="min-w-0 flex-1 py-1 text-left"
                  onClick={() => onSelect(item.node)}
                >
                  <span
                    className="block truncate font-mono text-[10px] font-semibold"
                    title={item.node.label}
                  >
                    {item.node.label}
                  </span>
                  <span className="block truncate text-[9px] text-muted-foreground">
                    {item.node.package ?? item.node.symbolKind ?? item.node.kind}
                  </span>
                </button>
                <span className="border px-1 py-0.5 font-mono text-[8px] text-muted-foreground">
                  {item.edge.refType}
                </span>
                <span className="w-5 text-right font-mono text-[9px] text-muted-foreground">
                  ×{item.edge.weight}
                </span>
              </div>
              {isExpanded &&
                nested.map((relation) => (
                  <button
                    type="button"
                    key={`${key}:${relation.node.id}`}
                    className="relative flex h-7 w-full items-center gap-2 border-l border-border pl-11 pr-3 text-left text-[9px] text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={() => onSelect(relation.node)}
                  >
                    <span className="absolute left-7 top-1/2 h-px w-3 bg-border" />
                    <GitBranch className="h-3 w-3 shrink-0" />
                    <span className="truncate font-mono">{relation.node.label}</span>
                    <span className="ml-auto font-mono opacity-70">{relation.edge.refType}</span>
                  </button>
                ))}
            </div>
          );
        })
      )}
    </section>
  );
}

function OperationBadge({ activity }: { activity: FileActivity }): React.ReactElement {
  return (
    <span
      className={cn(
        'shrink-0 border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase',
        activity.type === 'delete'
          ? 'border-destructive/50 bg-destructive/10 text-destructive'
          : activity.type === 'read'
            ? 'border-info/50 bg-info/10 text-info'
            : activity.type === 'search' || activity.type === 'index'
              ? 'border-primary/50 bg-primary/10 text-primary'
              : 'border-warning/50 bg-warning/10 text-warning',
      )}
    >
      {activity.filePath.startsWith('(tool:') ? activity.toolName : activity.type}
    </span>
  );
}

function LiveOperationRow({
  activity,
  onLocate,
  showAgent = false,
}: {
  activity: FileActivity;
  onLocate: (activity: FileActivity) => void;
  showAgent?: boolean;
}): React.ReactElement {
  const name = activity.agentName ?? activity.agent ?? 'External process';
  const key = `${activity.sessionId ?? 'none'}:${activity.agentId ?? name}`;
  return (
    <button
      type="button"
      className="group flex w-full items-start gap-2 border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted/70"
      onClick={() => !activity.filePath.startsWith('(') && onLocate(activity)}
      title={`Locate ${activity.filePath}`}
    >
      {showAgent && (
        <span
          className={cn(
            'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center font-mono text-[8px] font-black',
            agentColor(key),
          )}
        >
          {agentInitials(name)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <OperationBadge activity={activity} />
          {showAgent && <span className="truncate text-[9px] font-semibold">{name}</span>}
          {activity.status === 'active' && (
            <span className="ml-auto flex items-center gap-1 font-mono text-[8px] font-bold text-success">
              <span className="h-1.5 w-1.5 animate-pulse bg-success" /> LIVE
            </span>
          )}
          {activity.watcherConfirmed && (
            <ShieldCheck
              className="ml-auto h-3 w-3 text-success"
              aria-label="Filesystem confirmed"
            />
          )}
          {activity.attribution === 'correlated' && !activity.watcherConfirmed && (
            <span
              className="ml-auto font-mono text-[7px] uppercase text-warning"
              title="Correlated from the only active tool"
            >
              ~ correlated
            </span>
          )}
          {activity.attribution === 'external' && (
            <span className="ml-auto font-mono text-[7px] uppercase text-destructive">
              external
            </span>
          )}
        </div>
        <div className="mt-1 truncate font-mono text-[9px] font-semibold" title={activity.filePath}>
          {shortPath(activity.filePath)}
        </div>
        {(activity.symbol || activity.line) && (
          <div className="mt-0.5 flex items-center gap-1 truncate font-mono text-[8px] text-success">
            <Target className="h-2.5 w-2.5 shrink-0" />
            {activity.symbol?.name ?? `line ${activity.line}`}
            {activity.symbol?.kind && (
              <span className="text-muted-foreground">· {activity.symbol.kind}</span>
            )}
          </div>
        )}
        {activity.change && (
          <div className="mt-1 flex items-center gap-1 font-mono text-[8px]">
            <span className="border border-success/40 bg-success/10 px-1 text-success">
              +{activity.change.added}
            </span>
            <span className="border border-destructive/40 bg-destructive/10 px-1 text-destructive">
              −{activity.change.removed}
            </span>
            {activity.durationMs !== undefined && (
              <span className="ml-auto text-muted-foreground">{activity.durationMs}ms</span>
            )}
          </div>
        )}
        {activity.summary && activity.summary !== activity.toolName && (
          <div className="mt-1 line-clamp-2 text-[8px] leading-3 text-muted-foreground">
            {activity.summary}
          </div>
        )}
      </div>
      {!activity.filePath.startsWith('(') && (
        <ExternalLink className="mt-1 h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
      )}
    </button>
  );
}

function LiveAgentsHud({
  presences,
  onLocate,
}: {
  presences: LiveAgentPresence[];
  onLocate: (activity: FileActivity) => void;
}): React.ReactElement | null {
  if (presences.length === 0) return null;
  return (
    <section className="pointer-events-auto absolute left-3 top-14 z-20 w-[304px] border bg-card/95 shadow-xl backdrop-blur">
      <div className="flex h-9 items-center gap-2 border-b px-3">
        <Radio className="h-3.5 w-3.5 animate-pulse text-success" />
        <h2 className="text-[9px] font-black uppercase tracking-[0.18em]">Live agent operations</h2>
        <span className="ml-auto bg-success px-1.5 py-0.5 font-mono text-[8px] font-bold text-success-foreground">
          {presences.length} ONLINE
        </span>
      </div>
      <div className="max-h-[330px] overflow-y-auto">
        {presences.map((presence) => (
          <div key={presence.key} className="border-b last:border-b-0">
            <div className="flex items-center gap-2 bg-muted/35 px-3 py-1.5">
              <span
                className={cn(
                  'flex h-6 w-6 items-center justify-center font-mono text-[8px] font-black',
                  agentColor(presence.key),
                )}
              >
                {agentInitials(presence.agentName)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[9px] font-bold">{presence.agentName}</div>
                <div className="truncate font-mono text-[7px] text-muted-foreground">
                  session {presence.sessionId.slice(0, 12)} · agent {presence.agentId.slice(0, 12)}
                </div>
              </div>
              <span className="font-mono text-[8px] text-success">
                {presence.operations.length} op
              </span>
            </div>
            {presence.operations.map((activity) => (
              <LiveOperationRow
                key={activity.id ?? `${activity.toolUseId}:${activity.filePath}`}
                activity={activity}
                onLocate={onLocate}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function LiveControlBar({
  paused,
  followLive,
  agentFilter,
  agents,
  onTogglePaused,
  onToggleFollow,
  onAgentFilter,
}: {
  paused: boolean;
  followLive: boolean;
  agentFilter: string;
  agents: LiveAgentPresence[];
  onTogglePaused: () => void;
  onToggleFollow: () => void;
  onAgentFilter: (key: string) => void;
}): React.ReactElement {
  return (
    <div className="pointer-events-auto absolute right-3 top-14 z-20 flex h-9 items-center border bg-card/95 shadow-lg backdrop-blur">
      <button
        type="button"
        className={cn(
          'flex h-full items-center gap-1.5 border-r px-2.5 text-[8px] font-bold uppercase tracking-wider',
          followLive
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-muted',
        )}
        onClick={onToggleFollow}
        title="Automatically enter the file/function used by the newest visible agent"
      >
        <Target className="h-3 w-3" /> Follow
      </button>
      <button
        type="button"
        className={cn(
          'flex h-full items-center gap-1.5 border-r px-2.5 text-[8px] font-bold uppercase tracking-wider',
          paused ? 'bg-warning text-warning-foreground' : 'text-success hover:bg-success/10',
        )}
        onClick={onTogglePaused}
        title={paused ? 'Resume the live telemetry stream' : 'Freeze the current telemetry frame'}
      >
        {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
        {paused ? 'Resume' : 'Live'}
      </button>
      <label className="flex h-full items-center gap-1.5 px-2 text-[8px] uppercase text-muted-foreground">
        Agent
        <select
          aria-label="Filter CodeMap by agent and session"
          className="h-6 max-w-[170px] border bg-background px-1.5 font-mono text-[8px] text-foreground outline-none focus:border-primary"
          value={agentFilter}
          onChange={(event) => onAgentFilter(event.target.value)}
        >
          <option value="all">ALL AGENTS</option>
          {agents.map((agent) => (
            <option key={agent.key} value={agent.key}>
              {agent.agentName} · {agent.sessionId.slice(0, 10)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function CodeMapInner(): React.ReactElement {
  const [scope, setScope] = useState<CodeMapScope>({ level: 'packages' });
  const currentScopeKey = scopeKey(scope);
  const [graph, setGraph] = useState<CodeMapGraphResponse>(EMPTY_GRAPH);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [layout, setLayout] = useState<CodeMapLayout>('layers');
  const [canvasMode, setCanvasMode] = useState<'smart' | 'all'>('smart');
  const [edgeFilter, setEdgeFilter] = useState<'all' | GraphRefType>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [expandedPackages, setExpandedPackages] = useState<Set<string>>(new Set());
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [expandedRelations, setExpandedRelations] = useState<Set<string>>(new Set());
  const [revealAllKeys, setRevealAllKeys] = useState<Set<string>>(new Set());
  const [loadingBranches, setLoadingBranches] = useState<Set<string>>(new Set());
  const [cacheRevision, setCacheRevision] = useState(0);
  const [historyFile, setHistoryFile] = useState<string | null>(null);
  const [followLive, setFollowLive] = useState(false);
  const [agentFilter, setAgentFilter] = useState('all');
  const [pausedOperations, setPausedOperations] = useState<FileActivity[] | null>(null);
  const [pausedRecent, setPausedRecent] = useState<FileActivity[] | null>(null);
  const [agentTrailCount, setAgentTrailCount] = useState(0);
  const cache = useRef(new Map<string, CodeMapGraphResponse>());
  const pendingSelection = useRef<string | null>(null);
  const lastFollowedActivity = useRef<string | null>(null);
  const lastFitSignature = useRef('');
  const lastFlowStructuralKey = useRef('');
  const flowRebuildTimer = useRef<number | null>(null);
  const symbolResolveInflight = useRef(new Set<string>());
  // Selective store slice — bare useCodemapActivityStore() re-renders on every
  // method-stable set(); selectors keep App-style isolation for telemetry maps.
  const {
    history: activityHistory,
    pulses: activityPulses,
    activeOperationsMap,
    activityTotalCount,
    resolveActivitySymbol,
    getActivityForFile,
    sweepActivity,
  } = useCodemapActivityStore(
    useShallow((state) => ({
      history: state.history,
      pulses: state.pulses,
      activeOperationsMap: state.activeOperations,
      activityTotalCount: state.totalCount,
      resolveActivitySymbol: state.resolveActivitySymbol,
      getActivityForFile: state.getActivityForFile,
      sweepActivity: state._sweep,
    })),
  );
  const activeOperations = useMemo(
    () => [...activeOperationsMap.values()].flat(),
    [activeOperationsMap],
  );
  const pulseActivities = useMemo(
    () =>
      [...activityPulses.keys()]
        .map((filePath) => activityHistory.get(filePath)?.[0])
        .filter((activity): activity is FileActivity => Boolean(activity)),
    [activityHistory, activityPulses],
  );
  const recentActivities = useMemo(() => {
    const candidates: FileActivity[] = [];
    for (const history of activityHistory.values()) {
      // Each per-file history is newest-first. A single file cannot
      // contribute more than the global result size, so avoid sorting the
      // entire (potentially 100k-entry) telemetry archive on every event.
      candidates.push(...history.slice(0, 16));
    }
    return candidates.sort((left, right) => right.timestamp - left.timestamp).slice(0, 16);
  }, [activityHistory]);
  const allKnownAgents = useMemo(
    () => groupAgentPresences([...activeOperations, ...recentActivities]),
    [activeOperations, recentActivities],
  );
  const displayedActiveOperations = useMemo(() => {
    const source = pausedOperations ?? activeOperations;
    return agentFilter === 'all'
      ? source
      : source.filter((activity) => activityAgentKey(activity) === agentFilter);
  }, [activeOperations, agentFilter, pausedOperations]);
  const displayedRecentActivities = useMemo(() => {
    const source = pausedRecent ?? recentActivities;
    return agentFilter === 'all'
      ? source
      : source.filter((activity) => activityAgentKey(activity) === agentFilter);
  }, [agentFilter, pausedRecent, recentActivities]);
  // Defer telemetry-driven canvas work under React concurrent rendering so
  // selection / navigation stays snappy while agents spam tools.
  const deferredActiveOperations = useDeferredValue(displayedActiveOperations);
  const deferredRecentActivities = useDeferredValue(displayedRecentActivities);
  const deferredPulseActivities = useDeferredValue(pulseActivities);
  const agentPresences = useMemo(
    () => groupAgentPresences(displayedActiveOperations),
    [displayedActiveOperations],
  );
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<Node>([]);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView } = useReactFlow();

  const fetchGraph = useCallback(
    async (targetScope: CodeMapScope, force = false): Promise<CodeMapGraphResponse> => {
      const key = scopeKey(targetScope);
      const existing = cache.current.get(key);
      if (existing && !force) {
        // LRU touch on hit so hot scopes survive eviction.
        touchClientGraphCache(cache.current, key, existing);
        return existing;
      }
      const response = await fetch(scopeUrl(targetScope));
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      const nextGraph = (await response.json()) as CodeMapGraphResponse;
      touchClientGraphCache(cache.current, key, nextGraph);
      setCacheRevision((revision) => revision + 1);
      return nextGraph;
    },
    [],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const indexGeneration = useCodemapIndexStore((state) => state.generation);
  const lastSeenIndexGeneration = useRef(0);
  const treeScrollRef = useRef<HTMLDivElement | null>(null);

  // Single load path for scope changes and index invalidation — avoids racing
  // two parallel fetches that both call setGraph when an index run finishes.
  useEffect(() => {
    let cancelled = false;
    const forceRefresh = indexGeneration > lastSeenIndexGeneration.current;
    if (forceRefresh) {
      lastSeenIndexGeneration.current = indexGeneration;
      cache.current.clear();
      setCacheRevision((revision) => revision + 1);
      setExpandedPackages(new Set());
      setExpandedDirectories(new Set());
      setExpandedFiles(new Set());
      setRevealAllKeys(new Set());
    }
    setLoading(true);
    setError(null);
    void fetchGraph(scope, forceRefresh)
      .then((nextGraph) => {
        if (cancelled) return;
        setGraph(nextGraph);
        if (!forceRefresh) {
          const requested = pendingSelection.current;
          pendingSelection.current = null;
          setSelectedId(
            requested && nextGraph.nodes.some((node) => node.id === requested)
              ? requested
              : null,
          );
        }
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setGraph(EMPTY_GRAPH);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentScopeKey, fetchGraph, indexGeneration, scope]);

  const navigate = useCallback(
    (nextScope: CodeMapScope, preferredSelection?: string): void => {
      pendingSelection.current = preferredSelection ?? null;
      if (scopeKey(nextScope) === currentScopeKey) {
        setSelectedId(preferredSelection ?? null);
        pendingSelection.current = null;
        return;
      }
      setScope(nextScope);
    },
    [currentScopeKey],
  );

  const ensureBranch = useCallback(
    async (targetScope: CodeMapScope): Promise<void> => {
      const key = scopeKey(targetScope);
      if (cache.current.has(key) || loadingBranches.has(key)) return;
      setLoadingBranches((current) => new Set(current).add(key));
      try {
        await fetchGraph(targetScope);
      } finally {
        setLoadingBranches((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [fetchGraph, loadingBranches],
  );

  useEffect(() => {
    let cancelled = false;
    let started = 0;
    for (const activity of activeOperations) {
      if (started >= MAX_SYMBOL_RESOLVE_INFLIGHT) break;
      if (activity.symbol || !activity.toolUseId || activity.filePath.startsWith('(')) continue;
      const filePath = activity.filePath;
      if (symbolResolveInflight.current.has(filePath)) continue;
      symbolResolveInflight.current.add(filePath);
      started += 1;
      void fetchGraph({ level: 'symbols', file: filePath })
        .then((symbolGraph) => {
          if (cancelled) return;
          const symbol = resolveSymbolForActivity(activity, symbolGraph.nodes);
          if (!symbol) return;
          resolveActivitySymbol(activity.toolUseId!, filePath, {
            id: symbol.id,
            name: symbol.label,
            ...(symbol.symbolKind ? { kind: symbol.symbolKind } : {}),
            ...(symbol.line ? { line: symbol.line } : {}),
          });
        })
        .catch(() => undefined)
        .finally(() => {
          symbolResolveInflight.current.delete(filePath);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [activeOperations, fetchGraph, resolveActivitySymbol]);

  const filteredGraph = useMemo<CodeMapGraphResponse>(
    () => ({
      nodes: graph.nodes,
      edges:
        edgeFilter === 'all'
          ? graph.edges
          : graph.edges.filter((edge) => edge.refType === edgeFilter),
    }),
    [graph, edgeFilter],
  );
  const selectedNode = graph.nodes.find((node) => node.id === selectedId);
  const canvasGraph = useMemo(
    () => smartCanvasGraph(filteredGraph, selectedId, canvasMode),
    [canvasMode, filteredGraph, selectedId],
  );
  const connected = useMemo(
    () => (selectedId ? connectedNodeIds(filteredGraph, selectedId) : new Set<string>()),
    [filteredGraph, selectedId],
  );
  const { incomingCounts, outgoingCounts } = useMemo(() => {
    const incoming = new Map<string, number>();
    const outgoing = new Map<string, number>();
    for (const edge of filteredGraph.edges) {
      outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    }
    return { incomingCounts: incoming, outgoingCounts: outgoing };
  }, [filteredGraph]);
  const layoutFocusId = layout === 'orbit' ? (selectedId ?? undefined) : undefined;
  const positionedNodes = useMemo(
    () => layoutGraph(canvasGraph, layout, layoutFocusId),
    [canvasGraph, layout, layoutFocusId],
  );
  const fitSignature = useMemo(
    () =>
      [
        currentScopeKey,
        layout,
        layout === 'orbit' ? (selectedId ?? '') : '',
        hashGraphStructure(canvasGraph),
      ].join('\u001e'),
    [canvasGraph, currentScopeKey, layout, selectedId],
  );

  const handleSelectNode = useCallback((node: GraphNodeData): void => {
    setSelectedId(node.id);
    setExpandedRelations(new Set());
  }, []);
  const handleOpenNode = useCallback(
    (node: GraphNodeData): void => {
      if (node.kind === 'package')
        navigate({ level: 'files', package: node.package ?? node.label });
      if (node.kind === 'file' && node.file)
        navigate({ level: 'symbols', file: node.file, package: node.package });
    },
    [navigate],
  );

  const activityFlowKey = useMemo(
    () =>
      [
        activityFingerprint(deferredActiveOperations),
        activityFingerprint(deferredPulseActivities),
        activityFingerprint(deferredRecentActivities),
      ].join('\u001e'),
    [deferredActiveOperations, deferredPulseActivities, deferredRecentActivities],
  );

  const activeFileNorms = useMemo(() => {
    const norms = new Set<string>();
    for (const activity of displayedActiveOperations) {
      norms.add(normalizedPath(activity.filePath));
    }
    return norms;
  }, [displayedActiveOperations]);

  const activeSymbolIds = useMemo(() => {
    const ids = new Set<string>();
    for (const activity of displayedActiveOperations) {
      if (activity.symbol?.id) ids.add(activity.symbol.id);
    }
    return ids;
  }, [displayedActiveOperations]);

  useEffect(() => {
    const rebuildFlow = (): void => {
      const nodes = positionedNodes.map(({ node }) => node);
      const activeByNode = indexActivitiesByNode(nodes, deferredActiveOperations);
      const pulseByNode = indexActivitiesByNode(nodes, deferredPulseActivities);
      const activeNodeIds = new Set(activeByNode.keys());

      const nextFlowNodes = positionedNodes.map(({ node, position }) => {
        const matchingActive = activeByNode.get(node.id) ?? [];
        const pulse = matchingActive[0] ?? pulseByNode.get(node.id)?.[0];
        return {
          id: node.id,
          type: 'codemap',
          position,
          data: {
            graphNode: node,
            selected: node.id === selectedId,
            dimmed: Boolean(selectedId) && !connected.has(node.id),
            incoming: incomingCounts.get(node.id) ?? 0,
            outgoing: outgoingCounts.get(node.id) ?? 0,
            isActive: Boolean(pulse),
            ...(pulse ? { activityType: pulse.type } : {}),
            activeOperations: matchingActive,
            onSelect: handleSelectNode,
            onOpen: handleOpenNode,
            onShowHistory: setHistoryFile,
          } satisfies CodeMapNodeData,
        };
      });
      setFlowNodes((current) => preserveFlowNodes(current, nextFlowNodes));

      let animatedBudget = MAX_ANIMATED_EDGES;
      const codeEdges = canvasGraph.edges.map((edge, index) => {
        const focused =
          Boolean(selectedId) && (edge.source === selectedId || edge.target === selectedId);
        const live = activeNodeIds.has(edge.source) || activeNodeIds.has(edge.target);
        // Prefer animating focused live edges; otherwise spend a small budget.
        const animate = live && (focused || animatedBudget > 0);
        if (animate) animatedBudget -= 1;
        const color = EDGE_COLOR[edge.refType] ?? 'hsl(var(--muted-foreground))';
        // Dimmed edges use cheaper bezier; focused/live keep smoothstep readability.
        const edgeType = focused || live ? 'smoothstep' : 'default';
        return {
          id: `edge:${edge.source}:${edge.target}:${index}`,
          source: edge.source,
          target: edge.target,
          type: edgeType,
          animated: animate,
          label: focused
            ? `${edge.refType}${edge.weight > 1 ? ` ×${edge.weight}` : ''}`
            : undefined,
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
          style: {
            stroke: color,
            strokeWidth: live
              ? Math.min(2.5 + Math.log2(edge.weight + 1) * 0.65, 5)
              : focused
                ? Math.min(1.25 + Math.log2(edge.weight + 1) * 0.65, 4)
                : 1,
            opacity: live ? 1 : selectedId ? (focused ? 0.88 : 0.08) : 0.52,
          },
          labelStyle: {
            fontSize: 9,
            fontFamily: 'var(--font-mono)',
            fill: 'hsl(var(--muted-foreground))',
          },
          labelBgStyle: { fill: 'hsl(var(--card))', fillOpacity: 0.92 },
          labelBgPadding: [4, 2] as [number, number],
          zIndex: live ? 4 : focused ? 2 : 0,
          data: {
            renderKey: `${edge.refType}:${edge.weight}:${selectedId ? (focused ? 'focused' : 'dimmed') : 'idle'}:${live ? 'live' : 'still'}:${animate ? 'anim' : 'still'}:${edgeType}`,
          },
        } satisfies Edge;
      });

      const recentByAgent = new Map<string, FileActivity[]>();
      const liveAgentKeys = new Set(deferredActiveOperations.map(activityAgentKey));
      for (const activity of [...deferredRecentActivities].sort(
        (left, right) => left.timestamp - right.timestamp,
      )) {
        const key = activityAgentKey(activity);
        const list = recentByAgent.get(key);
        if (list) list.push(activity);
        else recentByAgent.set(key, [activity]);
      }
      // Prefer live agents, then newest, then cap — trails are visual sugar.
      const rankedAgents = [...recentByAgent.entries()]
        .map(([agentKey, activities]) => ({
          agentKey,
          activities,
          live: liveAgentKeys.has(agentKey),
          latest: activities[activities.length - 1]?.timestamp ?? 0,
        }))
        .sort(
          (left, right) =>
            Number(right.live) - Number(left.live) || right.latest - left.latest,
        )
        .slice(0, MAX_TRAIL_AGENTS);

      const trailEdges: Edge[] = [];
      for (const { agentKey, activities, live: trailIsLive } of rankedAgents) {
        // Keep the newest hops only so long agent sessions don't spam edges.
        const recentSlice = activities.slice(-(MAX_TRAIL_HOPS + 1));
        const nodeTrail = recentSlice
          .map((activity) => ({
            activity,
            node: canvasGraph.nodes.find((node) => activityMatchesNode(activity, node)),
          }))
          .filter((entry): entry is { activity: FileActivity; node: GraphNodeData } =>
            Boolean(entry.node),
          )
          .filter((entry, index, all) => index === 0 || entry.node.id !== all[index - 1]?.node.id);
        const color = agentTrailColor(agentKey);
        for (let index = 1; index < nodeTrail.length; index++) {
          const previous = nodeTrail[index - 1]!;
          const current = nodeTrail[index]!;
          const animateTrail = trailIsLive && animatedBudget > 0;
          if (animateTrail) animatedBudget -= 1;
          trailEdges.push({
            id: `trail:${agentKey}:${previous.activity.timestamp}:${current.activity.timestamp}`,
            source: previous.node.id,
            target: current.node.id,
            type: 'smoothstep',
            animated: animateTrail,
            label:
              index === nodeTrail.length - 1
                ? `${agentInitials(current.activity.agentName ?? current.activity.agent ?? 'agent')} TRAIL`
                : undefined,
            markerEnd: { type: MarkerType.ArrowClosed, color, width: 13, height: 13 },
            style: { stroke: color, strokeWidth: 2.5, strokeDasharray: '7 5', opacity: 0.9 },
            labelStyle: { fontSize: 8, fontWeight: 700, fill: color },
            labelBgStyle: { fill: 'hsl(var(--card))', fillOpacity: 0.94 },
            labelBgPadding: [4, 2] as [number, number],
            zIndex: 6,
            data: {
              renderKey: `${color}:${index === nodeTrail.length - 1 ? 'label' : 'plain'}:${trailIsLive ? 'live' : 'still'}:${animateTrail ? 'anim' : 'still'}`,
            },
          });
        }
      }
      setAgentTrailCount(trailEdges.length);
      setFlowEdges((current) => preserveFlowEdges(current, [...codeEdges, ...trailEdges]));
    };

    const structuralKey = fitSignature;
    const structuralChanged = lastFlowStructuralKey.current !== structuralKey;
    lastFlowStructuralKey.current = structuralKey;

    if (flowRebuildTimer.current !== null) {
      window.clearTimeout(flowRebuildTimer.current);
      flowRebuildTimer.current = null;
    }

    if (structuralChanged) {
      rebuildFlow();
    } else {
      // Telemetry-only: coalesce rapid tool/watcher pulses.
      flowRebuildTimer.current = window.setTimeout(() => {
        flowRebuildTimer.current = null;
        rebuildFlow();
      }, FLOW_ACTIVITY_THROTTLE_MS);
    }

    let fitTimer: number | undefined;
    if (lastFitSignature.current !== fitSignature) {
      fitTimer = window.setTimeout(() => {
        lastFitSignature.current = fitSignature;
        // Dense canvases skip animated fit — less main-thread work mid-session.
        const duration = canvasGraph.nodes.length > 48 ? 0 : 240;
        void fitView({ padding: 0.2, duration, maxZoom: 1.25 });
      }, 20);
    }

    return () => {
      if (flowRebuildTimer.current !== null) {
        window.clearTimeout(flowRebuildTimer.current);
        flowRebuildTimer.current = null;
      }
      if (fitTimer !== undefined) window.clearTimeout(fitTimer);
    };
  }, [
    activityFlowKey,
    canvasGraph,
    selectedId,
    deferredActiveOperations,
    deferredRecentActivities,
    deferredPulseActivities,
    fitSignature,
    connected,
    fitView,
    handleOpenNode,
    handleSelectNode,
    incomingCounts,
    outgoingCounts,
    positionedNodes,
    setFlowEdges,
    setFlowNodes,
  ]);

  // Expire activity pulses without requiring another WebSocket event.
  useEffect(() => {
    const interval = window.setInterval(() => {
      sweepActivity();
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [sweepActivity]);

  const rootGraph =
    cache.current.get('packages') ?? (scope.level === 'packages' ? graph : EMPTY_GRAPH);
  const packageGraph = useCallback(
    (packageName: string): CodeMapGraphResponse | undefined =>
      cache.current.get(scopeKey({ level: 'files', package: packageName })),
    [cacheRevision],
  );
  const graphForFile = useCallback(
    (filePath: string): CodeMapGraphResponse | undefined =>
      cache.current.get(scopeKey({ level: 'symbols', file: filePath })),
    [cacheRevision],
  );

  const locateActivity = useCallback(
    (activity: FileActivity): void => {
      let indexedFile = activity.filePath;
      let indexedPackage = packageForFile(activity.filePath);
      let fileId = `file:${activity.filePath}`;
      for (const cachedGraph of cache.current.values()) {
        const match = cachedGraph.nodes.find(
          (node) =>
            node.kind === 'file' && !node.external && sameFile(node.file, activity.filePath),
        );
        if (!match) continue;
        indexedFile = match.file ?? indexedFile;
        indexedPackage = match.package ?? indexedPackage;
        fileId = match.id;
        break;
      }
      if (activity.symbol) {
        navigate(
          { level: 'symbols', file: indexedFile, package: indexedPackage },
          activity.symbol.id,
        );
        return;
      }
      navigate({ level: 'files', package: indexedPackage }, fileId);
    },
    [navigate],
  );

  useEffect(() => {
    if (!followLive || pausedOperations) return;
    const latest = [...displayedActiveOperations]
      .filter((activity) => !activity.filePath.startsWith('('))
      .sort((left, right) => right.timestamp - left.timestamp)[0];
    if (!latest) return;
    const followKey = `${latest.id ?? latest.toolUseId}:${latest.filePath}:${latest.symbol?.id ?? 'file'}`;
    if (lastFollowedActivity.current === followKey) return;
    lastFollowedActivity.current = followKey;
    locateActivity(latest);
  }, [displayedActiveOperations, followLive, locateActivity, pausedOperations]);

  const toggleTelemetryPaused = useCallback((): void => {
    if (pausedOperations) {
      setPausedOperations(null);
      setPausedRecent(null);
      return;
    }
    setPausedOperations([...activeOperations]);
    setPausedRecent([...recentActivities]);
  }, [activeOperations, pausedOperations, recentActivities]);

  const togglePackage = useCallback(
    (node: GraphNodeData): void => {
      const packageName = node.package ?? node.label;
      const opening = !expandedPackages.has(packageName);
      setExpandedPackages((current) => {
        const next = new Set(current);
        opening ? next.add(packageName) : next.delete(packageName);
        return next;
      });
      if (opening) {
        void ensureBranch({ level: 'files', package: packageName })
          .then(() => {
            const branch = cache.current.get(scopeKey({ level: 'files', package: packageName }));
            const tree = branch ? buildDirectoryTree(branch.nodes) : undefined;
            if (tree?.directories.length === 1 && tree.directories[0]) {
              setExpandedDirectories((current) =>
                new Set(current).add(`${packageName}:${tree.directories[0]!.path}`),
              );
            }
          })
          .catch(() => undefined);
      }
    },
    [ensureBranch, expandedPackages],
  );

  const toggleFile = useCallback(
    (node: GraphNodeData): void => {
      if (!node.file) return;
      const opening = !expandedFiles.has(node.file);
      setExpandedFiles((current) => {
        const next = new Set(current);
        opening ? next.add(node.file!) : next.delete(node.file!);
        return next;
      });
      if (opening)
        void ensureBranch({ level: 'symbols', file: node.file, package: node.package }).catch(
          () => undefined,
        );
    },
    [ensureBranch, expandedFiles],
  );

  const toggleDirectory = useCallback((key: string): void => {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  const revealAllTree = useCallback((key: string): void => {
    setRevealAllKeys((current) => new Set(current).add(key));
  }, []);

  const selectFileFromTree = useCallback(
    (node: GraphNodeData): void => {
      navigate({ level: 'files', package: node.package ?? '(root)' }, node.id);
    },
    [navigate],
  );
  const selectSymbolFromTree = useCallback(
    (node: GraphNodeData): void => {
      if (node.file)
        navigate({ level: 'symbols', file: node.file, package: node.package }, node.id);
    },
    [navigate],
  );

  const searchResults = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return [];
    const unique = new Map<string, GraphNodeData>();
    for (const cachedGraph of cache.current.values()) {
      for (const node of cachedGraph.nodes) {
        const haystack =
          `${node.label} ${node.file ?? ''} ${node.signature ?? ''} ${node.package ?? ''}`.toLocaleLowerCase();
        if (haystack.includes(query)) unique.set(node.id, node);
      }
    }
    return [...unique.values()]
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label))
      .slice(0, 80);
  }, [search, cacheRevision]);

  const virtualizeSearch = searchResults.length > SEARCH_VIRTUALIZE_THRESHOLD;
  const searchVirtualizer = useVirtualizer({
    count: searchResults.length,
    getScrollElement: () => treeScrollRef.current,
    estimateSize: () => 40,
    overscan: 8,
    enabled: virtualizeSearch,
  });

  const selectSearchResult = useCallback(
    (node: GraphNodeData): void => {
      if (node.kind === 'package') navigate({ level: 'packages' }, node.id);
      else if (node.kind === 'file')
        navigate({ level: 'files', package: node.package ?? '(root)' }, node.id);
      else if (node.file)
        navigate({ level: 'symbols', file: node.file, package: node.package }, node.id);
    },
    [navigate],
  );

  const { incoming, outgoing } = useMemo(
    () => ({
      incoming: selectedNode ? relationItems(filteredGraph, selectedNode.id, 'incoming') : [],
      outgoing: selectedNode ? relationItems(filteredGraph, selectedNode.id, 'outgoing') : [],
    }),
    [filteredGraph, selectedNode],
  );
  const { edgeWeight, connectedNodeCount } = useMemo(() => {
    let totalWeight = 0;
    const nodeIds = new Set<string>();
    for (const edge of filteredGraph.edges) {
      totalWeight += edge.weight;
      nodeIds.add(edge.source);
      nodeIds.add(edge.target);
    }
    return { edgeWeight: totalWeight, connectedNodeCount: nodeIds.size };
  }, [filteredGraph]);
  const selectedActivities = selectedNode
    ? displayedActiveOperations.filter((activity) => activityMatchesNode(activity, selectedNode))
    : [];
  const fileHistory: FileActivity[] = historyFile ? getActivityForFile(historyFile) : [];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex h-[62px] shrink-0 items-center gap-4 border-b bg-card px-4">
        <div className="flex min-w-[220px] items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center border border-primary bg-primary/10 text-primary">
            <Network className="h-4 w-4" />
          </span>
          <div>
            <h1 className="font-display text-sm font-semibold tracking-tight">Code Atlas</h1>
            <p className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
              Architecture intelligence
            </p>
          </div>
        </div>
        <nav
          className="flex min-w-0 flex-1 items-center gap-1 font-mono text-[10px]"
          aria-label="Code map breadcrumb"
        >
          {scope.level !== 'packages' && (
            <button
              type="button"
              className="mr-1 flex h-7 w-7 items-center justify-center border text-muted-foreground hover:bg-muted"
              onClick={() => {
                if (scope.level === 'symbols')
                  navigate({ level: 'files', package: scope.package ?? '(root)' });
                else navigate({ level: 'packages' });
              }}
              aria-label="Back"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            className="flex items-center gap-1.5 px-1.5 py-1 text-muted-foreground hover:text-foreground"
            onClick={() => navigate({ level: 'packages' })}
          >
            <Home className="h-3 w-3" /> workspace
          </button>
          {scope.level !== 'packages' && (
            <>
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <button
                type="button"
                className="max-w-[220px] truncate px-1.5 py-1 hover:text-primary"
                onClick={() => navigate({ level: 'files', package: scope.package ?? '(root)' })}
              >
                {scope.package ?? '(root)'}
              </button>
            </>
          )}
          {scope.level === 'symbols' && (
            <>
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <span className="truncate px-1.5 py-1 text-primary">
                {relativeFilePath({
                  id: '',
                  label: scope.file,
                  kind: 'file',
                  file: scope.file,
                  package: scope.package,
                })}
              </span>
            </>
          )}
        </nav>
        <div className="hidden items-center gap-5 xl:flex">
          <div
            className={cn(
              'flex h-8 items-center gap-2 border px-2.5',
              agentPresences.length > 0
                ? 'border-success/50 bg-success/10 text-success'
                : 'text-muted-foreground',
            )}
          >
            <Radio className={cn('h-3 w-3', agentPresences.length > 0 && 'animate-pulse')} />
            <div>
              <div className="font-mono text-[10px] font-bold">{agentPresences.length} LIVE</div>
              <div className="text-[7px] uppercase tracking-wider">agents</div>
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-sm font-semibold">{graph.nodes.length}</div>
            <div className="text-[8px] uppercase tracking-wider text-muted-foreground">nodes</div>
          </div>
          <div className="text-right">
            <div className="font-mono text-sm font-semibold">{graph.edges.length}</div>
            <div className="text-[8px] uppercase tracking-wider text-muted-foreground">links</div>
          </div>
          <div className="text-right">
            <div className="font-mono text-sm font-semibold">{edgeWeight}</div>
            <div className="text-[8px] uppercase tracking-wider text-muted-foreground">
              references
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-sm font-semibold">{connectedNodeCount}</div>
            <div className="text-[8px] uppercase tracking-wider text-muted-foreground">
              connected
            </div>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[286px] shrink-0 flex-col border-r bg-card/70">
          <div className="border-b p-3">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[10px] font-bold uppercase tracking-[0.18em]">Code tree</h2>
              <span className="font-mono text-[9px] text-muted-foreground">
                {rootGraph.nodes.length} roots
              </span>
            </div>
            <label className="flex h-8 items-center gap-2 border bg-background px-2 focus-within:border-primary">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                className="min-w-0 flex-1 bg-transparent font-mono text-[10px] outline-none placeholder:text-muted-foreground"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Find package, file, symbol…"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput('');
                    setSearch('');
                  }}
                  aria-label="Clear search"
                >
                  <X className="h-3 w-3 text-muted-foreground" />
                </button>
              )}
            </label>
          </div>
          <div ref={treeScrollRef} className="min-h-0 flex-1 overflow-y-auto py-2">
            {search.trim() ? (
              <div>
                <div className="px-3 pb-2 text-[9px] text-muted-foreground">
                  {searchResults.length} loaded-map results
                </div>
                {searchResults.length === 0 ? (
                  <p className="px-3 py-8 text-center text-[10px] text-muted-foreground">
                    No match in loaded branches.
                    <br />
                    Expand a package to search its files.
                  </p>
                ) : virtualizeSearch ? (
                  <div
                    style={{
                      height: `${searchVirtualizer.getTotalSize()}px`,
                      width: '100%',
                      position: 'relative',
                    }}
                  >
                    {searchVirtualizer.getVirtualItems().map((virtualRow) => {
                      const node = searchResults[virtualRow.index];
                      if (!node) return null;
                      const Icon = NODE_STYLE[node.kind].icon;
                      return (
                        <button
                          type="button"
                          key={node.id}
                          data-index={virtualRow.index}
                          ref={searchVirtualizer.measureElement}
                          className="absolute left-0 flex min-h-8 w-full items-center gap-2 px-3 py-1 text-left hover:bg-muted"
                          style={{ transform: `translateY(${virtualRow.start}px)` }}
                          onClick={() => selectSearchResult(node)}
                        >
                          <Icon
                            className={cn(
                              'h-3.5 w-3.5 shrink-0',
                              node.kind === 'package'
                                ? 'text-primary'
                                : node.kind === 'file'
                                  ? 'text-info'
                                  : 'text-success',
                            )}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-[10px]">
                              {node.label}
                            </span>
                            <span className="block truncate text-[8px] text-muted-foreground">
                              {node.file ?? node.package ?? node.symbolKind}
                            </span>
                          </span>
                          <span className="text-[8px] uppercase text-muted-foreground">
                            {node.kind.slice(0, 3)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  searchResults.map((node) => {
                    const Icon = NODE_STYLE[node.kind].icon;
                    return (
                      <button
                        type="button"
                        key={node.id}
                        className="flex min-h-8 w-full items-center gap-2 px-3 py-1 text-left hover:bg-muted"
                        onClick={() => selectSearchResult(node)}
                      >
                        <Icon
                          className={cn(
                            'h-3.5 w-3.5 shrink-0',
                            node.kind === 'package'
                              ? 'text-primary'
                              : node.kind === 'file'
                                ? 'text-info'
                                : 'text-success',
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-[10px]">{node.label}</span>
                          <span className="block truncate text-[8px] text-muted-foreground">
                            {node.file ?? node.package ?? node.symbolKind}
                          </span>
                        </span>
                        <span className="text-[8px] uppercase text-muted-foreground">
                          {node.kind.slice(0, 3)}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            ) : (
              rootGraph.nodes.map((packageNode) => {
                const packageName = packageNode.package ?? packageNode.label;
                const expanded = expandedPackages.has(packageName);
                const branchKey = scopeKey({ level: 'files', package: packageName });
                const filesGraph = packageGraph(packageName);
                const tree = filesGraph ? buildDirectoryTree(filesGraph.nodes) : undefined;
                return (
                  <div key={packageNode.id}>
                    <div
                      className={cn(
                        'group flex h-8 items-center px-2 hover:bg-muted',
                        selectedId === packageNode.id && 'bg-primary/10 text-primary',
                      )}
                    >
                      <button
                        type="button"
                        className="flex h-6 w-5 items-center justify-center text-muted-foreground"
                        onClick={() => togglePackage(packageNode)}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${packageName}`}
                      >
                        {loadingBranches.has(branchKey) ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : expanded ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                      </button>
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => navigate({ level: 'packages' }, packageNode.id)}
                        onDoubleClick={() => navigate({ level: 'files', package: packageName })}
                      >
                        <Package className="h-3.5 w-3.5 shrink-0 text-primary" />
                        <span className="truncate font-mono text-[10px] font-semibold">
                          {packageNode.label}
                        </span>
                        <span className="ml-auto text-[9px] text-muted-foreground">
                          {packageNode.fileCount ?? 0}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="ml-1 hidden h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground group-hover:flex"
                        onClick={() => navigate({ level: 'files', package: packageName })}
                        title="Open file map"
                        aria-label={`Open ${packageName} map`}
                      >
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    </div>
                    {expanded && tree && (
                      <DirectoryBranch
                        directory={tree}
                        packageName={packageName}
                        depth={1}
                        expandedDirectories={expandedDirectories}
                        expandedFiles={expandedFiles}
                        loadingBranches={loadingBranches}
                        graphForFile={graphForFile}
                        onToggleDirectory={toggleDirectory}
                        onToggleFile={toggleFile}
                        onSelectFile={selectFileFromTree}
                        onOpenFile={handleOpenNode}
                        onSelectSymbol={selectSymbolFromTree}
                        selectedId={selectedId}
                        activeFileNorms={activeFileNorms}
                        activeSymbolIds={activeSymbolIds}
                        revealAllKeys={revealAllKeys}
                        onRevealAll={revealAllTree}
                      />
                    )}
                  </div>
                );
              })
            )}
          </div>
          <div className="border-t px-3 py-2 text-[9px] leading-relaxed text-muted-foreground">
            Click to focus · double-click to enter
            <br />
            Branches stay open while the map changes
          </div>
        </aside>

        <main className="relative min-w-0 flex-1 bg-[radial-gradient(circle_at_50%_0%,hsl(var(--primary)/0.055),transparent_38%)]">
          <div className="absolute left-3 right-3 top-3 z-10 flex items-center gap-2 pointer-events-none">
            <div className="pointer-events-auto flex border bg-card/95 shadow-md backdrop-blur">
              <button
                type="button"
                className={cn(
                  'flex h-8 items-center gap-1.5 border-r px-2.5 text-[9px] font-semibold uppercase tracking-wider',
                  layout === 'layers'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                )}
                onClick={() => setLayout('layers')}
              >
                <Layers className="h-3 w-3" /> Layers
              </button>
              <button
                type="button"
                className={cn(
                  'flex h-8 items-center gap-1.5 px-2.5 text-[9px] font-semibold uppercase tracking-wider',
                  layout === 'orbit'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                )}
                onClick={() => setLayout('orbit')}
              >
                <Orbit className="h-3 w-3" /> Relations
              </button>
            </div>
            <div className="pointer-events-auto flex border bg-card/95 shadow-md backdrop-blur">
              <button
                type="button"
                className={cn(
                  'h-8 border-r px-2.5 font-mono text-[9px] font-bold',
                  canvasMode === 'smart'
                    ? 'bg-success text-success-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                )}
                onClick={() => setCanvasMode('smart')}
                title="Keep the full tree, show the strongest relations and selected neighbourhood"
              >
                SMART {canvasGraph.nodes.length}/{graph.nodes.length}
              </button>
              <button
                type="button"
                className={cn(
                  'h-8 px-2.5 font-mono text-[9px] font-bold',
                  canvasMode === 'all'
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:bg-muted',
                )}
                onClick={() => setCanvasMode('all')}
                title="Render every node and relation in this scope"
              >
                ALL
              </button>
            </div>
            <div className="pointer-events-auto ml-auto flex max-w-[60%] overflow-x-auto border bg-card/95 shadow-md backdrop-blur">
              {(['all', 'import', 'call', 'type_ref', 'inherit', 'implement'] as const).map(
                (filter) => (
                  <button
                    type="button"
                    key={filter}
                    className={cn(
                      'h-8 whitespace-nowrap border-r px-2.5 font-mono text-[9px] last:border-r-0',
                      edgeFilter === filter
                        ? 'bg-foreground text-background'
                        : 'text-muted-foreground hover:bg-muted',
                    )}
                    onClick={() => setEdgeFilter(filter)}
                  >
                    {filter === 'all' ? 'ALL LINKS' : filter.replace('_', ' ').toUpperCase()}
                  </button>
                ),
              )}
            </div>
          </div>

          <LiveAgentsHud presences={agentPresences} onLocate={locateActivity} />
          <LiveControlBar
            paused={pausedOperations !== null}
            followLive={followLive}
            agentFilter={agentFilter}
            agents={allKnownAgents}
            onTogglePaused={toggleTelemetryPaused}
            onToggleFollow={() => {
              lastFollowedActivity.current = null;
              setFollowLive((current) => !current);
            }}
            onAgentFilter={(key) => {
              lastFollowedActivity.current = null;
              setAgentFilter(key);
            }}
          />

          {loading && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/75 backdrop-blur-sm">
              <Loader2 className="h-7 w-7 animate-spin text-primary" />
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Mapping relationships
              </span>
            </div>
          )}
          {error && !loading && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 p-8 text-center">
              <Network className="h-10 w-10 text-destructive" />
              <p className="font-mono text-sm text-destructive">{error}</p>
              <p className="max-w-md text-xs text-muted-foreground">
                The map needs a codebase index. Run{' '}
                <code className="border bg-muted px-1.5 py-0.5">codebase-index</code> once, then
                reopen this view.
              </p>
            </div>
          )}
          {!loading && !error && graph.nodes.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
              <Network className="h-8 w-8 opacity-40" />
              <p className="text-xs">No indexed nodes at this level.</p>
            </div>
          )}
          {!loading && !error && graph.nodes.length > 1 && graph.edges.length === 0 && (
            <div className="pointer-events-none absolute left-1/2 top-14 z-10 -translate-x-1/2 border border-warning/40 bg-warning/10 px-3 py-2 text-center shadow backdrop-blur">
              <div className="font-mono text-[9px] font-bold uppercase tracking-wider text-warning">
                No resolved relations in this scope
              </div>
              <div className="mt-0.5 text-[8px] text-muted-foreground">
                The upgraded index will rebuild and resolve call/import/type links automatically.
              </div>
            </div>
          )}
          {!error && graph.nodes.length > 0 && (
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              nodeTypes={nodeTypes}
              nodesConnectable={false}
              nodesDraggable={false}
              edgesFocusable={false}
              elementsSelectable={false}
              onlyRenderVisibleElements
              minZoom={0.08}
              maxZoom={2.2}
              proOptions={{ hideAttribution: true }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                // Wider gap on dense canvases — fewer SVG dots to paint.
                gap={canvasGraph.nodes.length > 60 ? 32 : 22}
                size={1}
                color="hsl(var(--muted-foreground))"
                className="!opacity-25"
              />
              <Controls
                position="bottom-left"
                showInteractive={false}
                className="!border !border-border !bg-card !shadow-md [&>button]:!border-border [&>button]:!bg-card [&>button]:!fill-foreground"
              />
              {canvasGraph.nodes.length <= MINIMAP_NODE_LIMIT && (
                <MiniMap
                  position="bottom-right"
                  pannable
                  zoomable
                  className="!h-[112px] !w-[180px] !border !border-border !bg-card !shadow-md"
                  maskColor="hsl(var(--background) / 0.72)"
                  nodeColor={(node) => {
                    const kind = (node.data as CodeMapNodeData | undefined)?.graphNode.kind;
                    return kind === 'package'
                      ? 'hsl(var(--primary))'
                      : kind === 'file'
                        ? 'hsl(var(--info))'
                        : 'hsl(var(--success))';
                  }}
                />
              )}
            </ReactFlow>
          )}
          <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 border bg-card/90 px-3 py-1.5 font-mono text-[8px] text-muted-foreground shadow backdrop-blur">
            {(Object.entries(EDGE_COLOR) as [GraphRefType, string][]).map(([kind, color]) => (
              <span key={kind} className="flex items-center gap-1">
                <span className="h-0.5 w-3" style={{ backgroundColor: color }} />
                {kind.replace('_', ' ')}
              </span>
            ))}
            <span className="flex items-center gap-1 text-primary" data-testid="agent-trail-count">
              <span className="w-4 border-t-2 border-dashed border-primary" />
              agent trail{agentTrailCount > 0 ? ` ×${agentTrailCount}` : ''}
            </span>
          </div>
        </main>

        <aside className="flex w-[326px] shrink-0 flex-col border-l bg-card/80">
          <div className="flex h-10 items-center justify-between border-b px-3">
            <h2 className="text-[10px] font-bold uppercase tracking-[0.18em]">
              Relation inspector
            </h2>
            {selectedNode && (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setSelectedId(null)}
                aria-label="Clear selection"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {!selectedNode ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {displayedActiveOperations.length > 0 && (
                <section className="border-b">
                  <div className="flex h-9 items-center gap-2 border-b bg-success/5 px-3">
                    <Radio className="h-3 w-3 animate-pulse text-success" />
                    <h3 className="text-[9px] font-bold uppercase tracking-[0.16em]">Active now</h3>
                    <span className="ml-auto font-mono text-[9px] text-success">
                      {displayedActiveOperations.length}
                    </span>
                  </div>
                  {displayedActiveOperations.map((activity) => (
                    <LiveOperationRow
                      key={activity.id ?? `${activity.toolUseId}:${activity.filePath}`}
                      activity={activity}
                      onLocate={locateActivity}
                      showAgent
                    />
                  ))}
                </section>
              )}
              <section>
                <div className="flex h-9 items-center gap-2 border-b px-3">
                  <ActivityIcon className="h-3 w-3 text-muted-foreground" />
                  <h3 className="text-[9px] font-bold uppercase tracking-[0.16em]">Event stream</h3>
                  <span className="ml-auto font-mono text-[8px] text-muted-foreground">
                    {activityTotalCount} total
                  </span>
                </div>
                {displayedRecentActivities.length > 0 ? (
                  displayedRecentActivities.map((activity, index) => (
                    <LiveOperationRow
                      key={activity.id ?? `${activity.timestamp}:${index}`}
                      activity={activity}
                      onLocate={locateActivity}
                      showAgent
                    />
                  ))
                ) : (
                  <div className="flex flex-col items-center justify-center px-7 py-16 text-center">
                    <span className="mb-4 flex h-12 w-12 items-center justify-center border bg-muted text-muted-foreground">
                      <GitBranch className="h-5 w-5" />
                    </span>
                    <h3 className="text-xs font-semibold">Select a node or wait for an agent</h3>
                    <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                      Relations appear on selection. Tool calls and external filesystem touches
                      stream here live.
                    </p>
                  </div>
                )}
              </section>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="border-b bg-muted/25 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span
                    className={cn(
                      'flex h-8 w-8 items-center justify-center border',
                      NODE_STYLE[selectedNode.kind].iconStyle,
                    )}
                  >
                    {(() => {
                      const Icon = NODE_STYLE[selectedNode.kind].icon;
                      return <Icon className="h-4 w-4" />;
                    })()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[8px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                      {selectedNode.external ? 'external ' : ''}
                      {selectedNode.kind}
                    </div>
                    <div
                      className="truncate font-mono text-xs font-semibold"
                      title={selectedNode.label}
                    >
                      {selectedNode.label}
                    </div>
                  </div>
                </div>
                <div className="break-all font-mono text-[9px] leading-relaxed text-muted-foreground">
                  {selectedNode.file ? relativeFilePath(selectedNode) : selectedNode.package}
                </div>
                {selectedNode.signature && (
                  <pre className="mt-3 overflow-x-auto border bg-background p-2 font-mono text-[9px] leading-relaxed text-foreground">
                    {selectedNode.signature}
                  </pre>
                )}
                <div className="mt-3 grid grid-cols-3 border">
                  <div className="border-r p-2 text-center">
                    <div className="font-mono text-sm font-semibold text-info">
                      {incoming.length}
                    </div>
                    <div className="text-[8px] uppercase text-muted-foreground">incoming</div>
                  </div>
                  <div className="border-r p-2 text-center">
                    <div className="font-mono text-sm font-semibold text-primary">
                      {outgoing.length}
                    </div>
                    <div className="text-[8px] uppercase text-muted-foreground">outgoing</div>
                  </div>
                  <div className="p-2 text-center">
                    <div className="font-mono text-sm font-semibold">
                      {selectedNode.symbolCount ??
                        selectedNode.fileCount ??
                        selectedNode.line ??
                        '—'}
                    </div>
                    <div className="text-[8px] uppercase text-muted-foreground">
                      {selectedNode.kind === 'package'
                        ? 'files'
                        : selectedNode.kind === 'file'
                          ? 'symbols'
                          : 'line'}
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex gap-2">
                  {selectedNode.kind !== 'symbol' && (
                    <button
                      type="button"
                      className="flex h-7 flex-1 items-center justify-center gap-1.5 border bg-foreground text-[9px] font-semibold uppercase tracking-wider text-background hover:opacity-90"
                      onClick={() => handleOpenNode(selectedNode)}
                    >
                      <ExternalLink className="h-3 w-3" /> Open{' '}
                      {selectedNode.kind === 'package' ? 'files' : 'symbols'}
                    </button>
                  )}
                  {selectedNode.file && (
                    <button
                      type="button"
                      className="flex h-7 items-center justify-center gap-1.5 border px-2 text-[9px] uppercase text-muted-foreground hover:bg-muted"
                      onClick={() => setHistoryFile(selectedNode.file!)}
                    >
                      <ActivityIcon className="h-3 w-3" /> Activity
                    </button>
                  )}
                </div>
              </div>
              {selectedActivities.length > 0 && (
                <section className="border-b bg-success/5 py-2">
                  <div className="mb-1 flex items-center gap-2 px-3">
                    <Radio className="h-3 w-3 animate-pulse text-success" />
                    <h3 className="text-[9px] font-bold uppercase tracking-[0.16em]">
                      Agents on this node
                    </h3>
                    <span className="ml-auto font-mono text-[9px] text-success">
                      {selectedActivities.length}
                    </span>
                  </div>
                  {selectedActivities.map((activity) => (
                    <LiveOperationRow
                      key={activity.id ?? `${activity.toolUseId}:${activity.filePath}`}
                      activity={activity}
                      onLocate={locateActivity}
                      showAgent
                    />
                  ))}
                </section>
              )}
              <RelationSection
                title="Incoming"
                subtitle="Who depends on this"
                items={incoming}
                graph={filteredGraph}
                selectedId={selectedNode.id}
                expanded={expandedRelations}
                onToggle={(key) =>
                  setExpandedRelations((current) => {
                    const next = new Set(current);
                    next.has(key) ? next.delete(key) : next.add(key);
                    return next;
                  })
                }
                onSelect={handleSelectNode}
              />
              <RelationSection
                title="Outgoing"
                subtitle="What this depends on"
                items={outgoing}
                graph={filteredGraph}
                selectedId={selectedNode.id}
                expanded={expandedRelations}
                onToggle={(key) =>
                  setExpandedRelations((current) => {
                    const next = new Set(current);
                    next.has(key) ? next.delete(key) : next.add(key);
                    return next;
                  })
                }
                onSelect={handleSelectNode}
              />
            </div>
          )}
        </aside>
      </div>

      {historyFile && (
        <div className="absolute right-0 top-0 z-50 flex h-full w-[390px] max-w-[90%] flex-col border-l bg-card shadow-2xl">
          <div className="flex h-12 items-center justify-between border-b px-4">
            <div className="flex min-w-0 items-center gap-2">
              <ActivityIcon className="h-4 w-4 shrink-0 text-warning" />
              <span className="truncate font-mono text-[11px] font-semibold" title={historyFile}>
                {historyFile}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setHistoryFile(null)}
              className="flex h-7 w-7 items-center justify-center border text-muted-foreground hover:bg-muted"
              aria-label="Close activity"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {fileHistory.length === 0 ? (
              <p className="py-12 text-center text-[10px] text-muted-foreground">
                No activity recorded for this file yet.
              </p>
            ) : (
              fileHistory.map((activity, index) => (
                <div
                  key={`${activity.timestamp}-${index}`}
                  className="mb-1 flex items-start gap-2 border p-2 text-[10px]"
                >
                  <span
                    className={cn(
                      'border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase',
                      activity.type === 'delete'
                        ? 'border-destructive/40 text-destructive'
                        : activity.type === 'read'
                          ? 'border-info/40 text-info'
                          : 'border-warning/40 text-warning',
                    )}
                  >
                    {activity.type}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[9px] text-muted-foreground">
                      {new Date(activity.timestamp).toLocaleTimeString()}
                    </div>
                    {activity.toolName && <div className="mt-1">via {activity.toolName}</div>}
                    {activity.agent && (
                      <div className="text-muted-foreground">{activity.agent}</div>
                    )}
                    {activity.summary && (
                      <div className="mt-1 text-muted-foreground">{activity.summary}</div>
                    )}
                    {activity.change && (
                      <div className="mt-1 flex items-center gap-1 font-mono text-[8px]">
                        <span className="border border-success/40 bg-success/10 px-1 text-success">
                          +{activity.change.added}
                        </span>
                        <span className="border border-destructive/40 bg-destructive/10 px-1 text-destructive">
                          −{activity.change.removed}
                        </span>
                        {activity.change.before && (
                          <span
                            className="ml-1 truncate text-destructive/80"
                            title={activity.change.before}
                          >
                            {activity.change.before}
                          </span>
                        )}
                        {activity.change.after && (
                          <span className="truncate text-success/80" title={activity.change.after}>
                            → {activity.change.after}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="mt-1 flex gap-2 font-mono text-[8px] uppercase text-muted-foreground">
                      <span>{activity.status ?? 'observed'}</span>
                      <span>{activity.source ?? 'legacy'}</span>
                      {activity.durationMs !== undefined && <span>{activity.durationMs}ms</span>}
                      {activity.watcherConfirmed && (
                        <span className="text-success">fs verified</span>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="border-t px-4 py-2 font-mono text-[9px] text-muted-foreground">
            {fileHistory.length} events · newest first
          </div>
        </div>
      )}
    </div>
  );
}

export function CodeMap(): React.ReactElement {
  return (
    <ReactFlowProvider>
      <CodeMapInner />
    </ReactFlowProvider>
  );
}
